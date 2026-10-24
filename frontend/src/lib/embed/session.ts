/**
 * 父页（sub2api /studio）↔ Nova 的会话桥（docs/sub2api-embed.md §9）。
 *
 * - 只接受同源、且来自 window.parent 的消息；
 * - 父页只传会话（token / userId / role / theme），Key 与模型在 Nova 设置页里选；
 * - 会话只放内存，不落任何存储。
 */

export const SESSION_MESSAGE_TYPE = 'sub2api:nova-studio-session' as const;
export const REVOKE_MESSAGE_TYPE = 'sub2api:nova-studio-revoke' as const;

export type EmbedRole = 'admin' | 'user';
export type EmbedTheme = 'light' | 'dark';

export interface EmbedSession {
  revision: number;
  token: string;
  userId: number;
  role: EmbedRole;
  theme: EmbedTheme;
}

export type EmbedSessionStatus = 'waiting' | 'active' | 'revoked';

export interface EmbedSessionState {
  status: EmbedSessionStatus;
  session: EmbedSession | null;
}

export type ParentMessage =
  | { type: typeof SESSION_MESSAGE_TYPE; session: EmbedSession }
  | { type: typeof REVOKE_MESSAGE_TYPE };

export type NovaToParentMessage =
  | { type: 'nova:ready' }
  | { type: 'nova:balance-changed' }
  | { type: 'nova:navigate'; path: string };

/** 校验 MessageEvent 来自同源父页（origin 与 source 双重校验）。 */
export function isTrustedParentEvent(
  event: Pick<MessageEvent, 'origin' | 'source'>,
  win: Window = window,
): boolean {
  if (!win || win.parent === win) return false;
  if (event.origin !== win.location.origin) return false;
  return event.source === win.parent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseParentMessage(data: unknown): ParentMessage | null {
  if (!isRecord(data)) return null;
  if (data.type === REVOKE_MESSAGE_TYPE) return { type: REVOKE_MESSAGE_TYPE };
  if (data.type !== SESSION_MESSAGE_TYPE) return null;

  const token = typeof data.sessionToken === 'string' ? data.sessionToken.trim() : '';
  const userId = typeof data.userId === 'number' ? data.userId : Number.NaN;
  const revision = typeof data.revision === 'number' && Number.isFinite(data.revision) ? data.revision : 0;
  if (!token || !Number.isSafeInteger(userId) || userId <= 0) return null;
  return {
    type: SESSION_MESSAGE_TYPE,
    session: {
      revision,
      token,
      userId,
      role: data.role === 'admin' ? 'admin' : 'user',
      theme: data.theme === 'dark' ? 'dark' : 'light',
    },
  };
}

let state: EmbedSessionState = { status: 'waiting', session: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // 订阅方异常不影响其他订阅方
    }
  }
}

export function subscribeEmbedSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getEmbedSessionState(): EmbedSessionState {
  return state;
}

export function getEmbedSession(): EmbedSession | null {
  return state.session;
}

export function getSessionToken(): string {
  return state.session?.token || '';
}

export function isEmbedAdmin(): boolean {
  return state.session?.role === 'admin';
}

export type ApplyResult = 'session' | 'revoke' | 'stale' | 'ignored';

/**
 * 应用一条已解析的父页消息。
 * 同一用户的会话按 revision 递增，较旧的重发（乱序）被忽略；换用户时一律接受（由上层决定是否重载）。
 */
export function applyParentMessage(message: ParentMessage | null): ApplyResult {
  if (!message) return 'ignored';
  if (message.type === REVOKE_MESSAGE_TYPE) {
    state = { status: 'revoked', session: null };
    emit();
    return 'revoke';
  }
  const prev = state.session;
  const next = message.session;
  if (prev && prev.userId === next.userId && next.revision < prev.revision) return 'stale';
  state = { status: 'active', session: next };
  emit();
  return 'session';
}

/** 处理 window 'message' 事件：校验来源后解析并应用。 */
export function handleParentMessageEvent(event: MessageEvent, win: Window = window): ApplyResult {
  if (!isTrustedParentEvent(event, win)) return 'ignored';
  return applyParentMessage(parseParentMessage(event.data));
}

export function postToParent(message: NovaToParentMessage, win: Window = window): void {
  if (!win || win.parent === win) return;
  try {
    win.parent.postMessage(message, win.location.origin);
  } catch {
    // 父页不可达时忽略
  }
}

export function resetEmbedSessionForTests(): void {
  state = { status: 'waiting', session: null };
  emit();
}
