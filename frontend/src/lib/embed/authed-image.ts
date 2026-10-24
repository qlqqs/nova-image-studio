/**
 * 受保护的同源图片：任务结果图（docs/sub2api-embed.md §5）与提示词广场图（§8A）。
 *
 * /api/nova/images/... 在嵌入模式下需要会话鉴权，且响应为 private, no-store：
 * 必须用带会话令牌的 fetch 取成 blob 再生成 blob: URL，不能直接 <img src>，也不能把 JWT 放进 URL。
 *
 * - fetchAuthedImageObjectUrl：一次性取图，返回调用方自行 revoke 的 blob URL；
 * - acquireAuthedImageUrl / releaseAuthedImageUrl：带引用计数的共享缓存，最后一个使用者释放后
 *   延迟回收（保留少量空闲条目避免列表滚动时反复下载），revoke 掉对应的 blob URL；
 * - useAuthedImageSrc：React hook，非受保护地址或独立模式原样返回。
 */
import { useEffect, useState } from 'react';
import { isEmbedMode } from '@/lib/embed/mode';

// 任务结果图，以及经后端拉取的提示词广场图（docs/sub2api-embed.md §8A）
const PROTECTED_PATH = /^\/api\/nova\/(?:images\/|prompt-gallery\/(?:raw\/|img$))/;
const MAX_IDLE_ENTRIES = 24;

function currentOrigin(): string {
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
}

/** 去掉 Nova 的 URL: / MULTI_URL: 前缀，返回真实地址。 */
export function unwrapImageRef(ref: string): string {
  if (ref.startsWith('URL:')) return ref.slice(4);
  if (ref.startsWith('MULTI_URL:')) return ref.slice(10).split('|||')[0] || '';
  return ref;
}

/** 是否为需要会话鉴权的同源任务图片地址（只在嵌入模式下为 true）。 */
export function isProtectedImageUrl(src: string | null | undefined, embedded: boolean = isEmbedMode()): boolean {
  if (!embedded || !src) return false;
  const raw = unwrapImageRef(String(src));
  if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) return false;
  try {
    const url = new URL(raw, typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
    return url.origin === currentOrigin() && PROTECTED_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

function canonical(src: string): string {
  const raw = unwrapImageRef(src);
  try {
    const url = new URL(raw, typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
    return `${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
}

/** 用（已包装、会附加会话令牌的）fetch 取图，返回 Blob。 */
export async function fetchAuthedImageBlob(src: string, fetchFn: typeof fetch = (input, init) => fetch(input, init)): Promise<Blob> {
  const response = await fetchFn(canonical(src), { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(response.status === 404 ? '图片已过期或不存在' : `图片读取失败（HTTP ${response.status}）`);
  return response.blob();
}

/** 一次性取图：返回 blob URL，调用方负责 URL.revokeObjectURL。 */
export async function fetchAuthedImageObjectUrl(src: string, fetchFn?: typeof fetch): Promise<string> {
  const blob = await fetchAuthedImageBlob(src, fetchFn);
  return URL.createObjectURL(blob);
}

interface CacheEntry {
  promise: Promise<string>;
  objectUrl: string | null;
  refs: number;
  lastUsed: number;
  failed: boolean;
}

const cache = new Map<string, CacheEntry>();
let fetchOverride: typeof fetch | undefined;

function prune(): void {
  const idle = Array.from(cache.entries())
    .filter(([, entry]) => entry.refs <= 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  const excess = idle.length - MAX_IDLE_ENTRIES;
  for (let i = 0; i < idle.length; i++) {
    const [key, entry] = idle[i];
    if (i < excess || entry.failed) {
      if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
      cache.delete(key);
    }
  }
}

/** 取得（共享的）blob URL；与 releaseAuthedImageUrl 成对调用。 */
export function acquireAuthedImageUrl(src: string): Promise<string> {
  const key = canonical(src);
  let entry = cache.get(key);
  if (!entry) {
    const created: CacheEntry = { promise: Promise.resolve(''), objectUrl: null, refs: 0, lastUsed: Date.now(), failed: false };
    created.promise = fetchAuthedImageBlob(key, fetchOverride).then(
      (blob) => {
        const objectUrl = URL.createObjectURL(blob);
        // 取图期间已被 clear() 或剔除：直接回收
        if (cache.get(key) !== created) {
          URL.revokeObjectURL(objectUrl);
          return '';
        }
        created.objectUrl = objectUrl;
        return objectUrl;
      },
      (error) => {
        created.failed = true;
        if (created.refs <= 0) cache.delete(key);
        throw error;
      },
    );
    cache.set(key, created);
    entry = created;
  }
  entry.refs += 1;
  entry.lastUsed = Date.now();
  return entry.promise;
}

export function releaseAuthedImageUrl(src: string): void {
  const key = canonical(src);
  const entry = cache.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  entry.lastUsed = Date.now();
  if (entry.refs === 0) prune();
}

/** 会话撤销 / 换账号时回收全部 blob URL。 */
export function clearAuthedImageCache(): void {
  for (const entry of cache.values()) {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  }
  cache.clear();
}

export function getAuthedImageCacheSizeForTests(): number {
  return cache.size;
}

export function setAuthedImageFetchForTests(fn: typeof fetch | undefined): void {
  fetchOverride = fn;
}

/**
 * 渲染用：受保护地址返回加载完成的 blob URL（加载中 / 失败为 undefined）；
 * 其他地址（含独立模式下的一切地址）原样返回。
 */
export function useAuthedImageSrc(src: string | null | undefined): string | undefined {
  const needsAuth = isProtectedImageUrl(src);
  const [resolved, setResolved] = useState<{ src: string; url: string } | null>(null);

  useEffect(() => {
    if (!needsAuth || !src) return undefined;
    let active = true;
    acquireAuthedImageUrl(src).then(
      (url) => { if (active && url) setResolved({ src, url }); },
      () => { if (active) setResolved(null); },
    );
    return () => {
      active = false;
      releaseAuthedImageUrl(src);
    };
  }, [needsAuth, src]);

  if (!src) return undefined;
  if (!needsAuth) return src;
  return resolved && resolved.src === src ? resolved.url : undefined;
}
