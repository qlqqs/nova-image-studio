/**
 * 嵌入模式的全局提示（例如余额不足时的「去充值」）。由 EmbedNoticeHost 渲染。
 */
import type { GatewayErrorKind } from '@/lib/embed/gateway-errors';

export interface EmbedNotice {
  id: number;
  kind: GatewayErrorKind | 'info';
  message: string;
  /** 「去充值」等站内跳转（父页白名单路径） */
  action?: { label: string; path: string };
}

let seq = 0;
let current: EmbedNotice | null = null;
let lastShownAt = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of Array.from(listeners)) {
    try { listener(); } catch { /* ignore */ }
  }
}

export function subscribeEmbedNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getEmbedNotice(): EmbedNotice | null {
  return current;
}

export function showEmbedNotice(notice: Omit<EmbedNotice, 'id'>): void {
  // 同类提示 3 秒内不重复刷新（批量任务同时失败时只提示一次）
  const now = Date.now();
  if (current && current.kind === notice.kind && now - lastShownAt < 3000) return;
  lastShownAt = now;
  current = { ...notice, id: ++seq };
  emit();
}

export function dismissEmbedNotice(): void {
  current = null;
  emit();
}

export function noticeForGatewayError(kind: GatewayErrorKind, message: string): Omit<EmbedNotice, 'id'> | null {
  if (kind === 'insufficient_balance') return { kind, message, action: { label: '去充值', path: '/purchase' } };
  if (kind === 'key_quota_exhausted' || kind === 'key_expired' || kind === 'invalid_key') {
    return { kind, message, action: { label: '管理密钥', path: '/keys' } };
  }
  return null;
}
