/**
 * 会话令牌附加规则（docs/sub2api-embed.md §9）：
 *   - 只附加到同源 `/api/nova/*` 与 sub2api 用户接口 `/api/v1/*`；
 *   - 绝不附加到网关 `/v1/*`、`/v1beta/*`（网关只认 API Key），也不附加到任何外部地址；
 *   - 请求已自带 Authorization 时不覆盖。
 * 安装后包装 window.fetch 与 XMLHttpRequest；独立模式不安装。
 */
import { getSessionToken } from '@/lib/embed/session';

type FetchFn = typeof fetch;

function currentOrigin(): string {
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
}

function resolveUrl(input: RequestInfo | URL | string): URL | null {
  try {
    let href: string;
    if (typeof URL !== 'undefined' && input instanceof URL) href = input.href;
    else if (typeof Request !== 'undefined' && input instanceof Request) href = input.url;
    else href = String(input);
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
    return new URL(href, base);
  } catch {
    return null;
  }
}

export function isSessionApiPath(pathname: string): boolean {
  return pathname === '/api/nova'
    || pathname.startsWith('/api/nova/')
    || pathname.startsWith('/api/v1/');
}

export function shouldAttachSessionToken(input: RequestInfo | URL | string, origin: string = currentOrigin()): boolean {
  const url = resolveUrl(input);
  if (!url) return false;
  if (url.origin !== origin) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isSessionApiPath(url.pathname);
}

function hasAuthorization(headers: HeadersInit | undefined): boolean {
  if (!headers) return false;
  return new Headers(headers).has('Authorization');
}

export function withSessionToken(input: RequestInfo | URL, init: RequestInit | undefined, token: string): {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
} {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    if (input.headers.has('Authorization') || hasAuthorization(init?.headers)) return { input, init };
    const headers = new Headers(init?.headers ?? input.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return { input, init: { ...init, headers } };
  }
  if (hasAuthorization(init?.headers)) return { input, init };
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { input, init: { ...init, headers } };
}

/** 包装一个 fetch：满足规则时附加会话令牌。导出供测试与 sub2api 客户端直接使用。 */
export function createAuthFetch(base: FetchFn, getToken: () => string = getSessionToken): FetchFn {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const token = getToken();
    if (token && shouldAttachSessionToken(input)) {
      const next = withSessionToken(input, init, token);
      return base(next.input, next.init);
    }
    return base(input, init);
  }) as FetchFn;
}

let fetchRestore: (() => void) | null = null;
let xhrRestore: (() => void) | null = null;

export type ResponseObserver = (url: URL, response: Response, init: RequestInit | undefined) => void;
let responseObserver: ResponseObserver | null = null;

/** 观察同源 /api/nova/* 与 /api/v1/* 的响应（余额刷新、网关错误提示用）；不改变响应本身。 */
export function setAuthFetchResponseObserver(observer: ResponseObserver | null): void {
  responseObserver = observer;
}

export function installAuthFetch(): () => void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return () => undefined;
  if (fetchRestore) return fetchRestore;
  const original = window.fetch;
  const bound = original.bind(window) as FetchFn;
  const authed = createAuthFetch(bound);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await authed(input, init);
    const observer = responseObserver;
    if (observer && shouldAttachSessionToken(input)) {
      const url = resolveUrl(input);
      if (url) {
        try {
          observer(url, response, init);
        } catch {
          // 观察者异常不影响业务请求
        }
      }
    }
    return response;
  }) as FetchFn;
  fetchRestore = () => {
    window.fetch = original;
    fetchRestore = null;
  };
  return fetchRestore;
}

export function installAuthXhr(): () => void {
  if (typeof XMLHttpRequest === 'undefined') return () => undefined;
  if (xhrRestore) return xhrRestore;
  type TrackedXhr = XMLHttpRequest & { __novaUrl?: string; __novaHasAuth?: boolean };
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetHeader = proto.setRequestHeader;

  proto.open = function open(this: TrackedXhr, ...args: unknown[]) {
    this.__novaUrl = String(args[1] ?? '');
    this.__novaHasAuth = false;
    return (originalOpen as (...a: unknown[]) => void).apply(this, args);
  } as XMLHttpRequest['open'];
  proto.setRequestHeader = function setRequestHeader(this: TrackedXhr, name: string, value: string) {
    if (name.toLowerCase() === 'authorization') this.__novaHasAuth = true;
    return originalSetHeader.call(this, name, value);
  };
  proto.send = function send(this: TrackedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    const token = getSessionToken();
    if (token && !this.__novaHasAuth && shouldAttachSessionToken(this.__novaUrl || '')) {
      try {
        originalSetHeader.call(this, 'Authorization', `Bearer ${token}`);
      } catch {
        // 请求状态不允许设置头时忽略
      }
    }
    return originalSend.call(this, body);
  };

  xhrRestore = () => {
    proto.open = originalOpen;
    proto.send = originalSend;
    proto.setRequestHeader = originalSetHeader;
    xhrRestore = null;
  };
  return xhrRestore;
}

export function installAuthIntercept(): () => void {
  const restoreFetch = installAuthFetch();
  const restoreXhr = installAuthXhr();
  return () => {
    restoreFetch();
    restoreXhr();
  };
}
