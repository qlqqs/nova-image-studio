/**
 * 嵌入模式运行时：安装存储分区 / 会话令牌 / 响应观察，供 EmbedRoot 在启动时调用。
 */
import { installAuthIntercept, setAuthFetchResponseObserver } from '@/lib/embed/auth-fetch';
import { installStoragePartition } from '@/lib/embed/storage-partition';
import { localizeGatewayError } from '@/lib/embed/gateway-errors';
import { noticeForGatewayError, showEmbedNotice } from '@/lib/embed/notices';
import { scheduleBalanceRefresh } from '@/lib/embed/balance';
import type { EmbedTheme } from '@/lib/embed/session';

function extractErrorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const error = parsed?.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const record = error as { message?: unknown; code?: unknown; type?: unknown };
      return [record.code, record.type, record.message].filter((item) => typeof item === 'string').join(' ');
    }
    if (typeof parsed?.message === 'string') return parsed.message;
  } catch {
    // 非 JSON
  }
  return body.slice(0, 2000);
}

/** 观察 Nova 代理与任务接口：网关错误弹出中文提示；文本类调用结束后刷新余额。 */
function observeResponse(url: URL, response: Response, init: RequestInit | undefined): void {
  const path = url.pathname;
  const isProxy = path.startsWith('/api/nova/proxy/');
  const isTaskCreate = path === '/api/nova/tasks' && String(init?.method || 'GET').toUpperCase() === 'POST';
  if (!isProxy && !isTaskCreate) return;

  if (!response.ok) {
    void response.clone().text().then((body) => {
      const localized = localizeGatewayError(`${response.status} ${extractErrorText(body)}`);
      if (!localized) return;
      const notice = noticeForGatewayError(localized.kind, localized.message);
      showEmbedNotice(notice ?? { kind: localized.kind, message: localized.message });
    }).catch(() => undefined);
    return;
  }

  if (isProxy && !path.startsWith('/api/nova/proxy/models')) {
    // 文本调用（含流式）读完后才计费完成：等克隆体读到结尾再刷新余额
    const clone = response.clone();
    const body = clone.body;
    if (!body) {
      scheduleBalanceRefresh();
      return;
    }
    const reader = body.getReader();
    const drain = (): Promise<void> => reader.read().then(({ done }) => (done ? undefined : drain()));
    void drain().then(() => scheduleBalanceRefresh(), () => scheduleBalanceRefresh());
  }
}

let installed: (() => void) | null = null;

export function installEmbedRuntime(): () => void {
  if (installed) return installed;
  const restoreStorage = installStoragePartition();
  const restoreAuth = installAuthIntercept();
  setAuthFetchResponseObserver(observeResponse);
  installed = () => {
    setAuthFetchResponseObserver(null);
    restoreAuth();
    restoreStorage();
    installed = null;
  };
  return installed;
}

/** 主题跟随父页：同时设置 data-theme（Nova 的 CSS 变量）与 .dark（tailwind dark: 变体）。 */
export function applyEmbedTheme(theme: EmbedTheme, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', theme);
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}
