/**
 * 余额显示（PRD R6.1）：读取 /api/v1/auth/me 的 balance；任务结束后刷新，
 * 并通知父页 nova:balance-changed 同步控制台侧余额。
 */
import { getCurrentUser } from '@/lib/embed/sub2api-client';
import { postToParent } from '@/lib/embed/session';

export interface BalanceState {
  balance: number | null;
  loading: boolean;
  error: string | null;
}

let state: BalanceState = { balance: null, loading: false, error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const settledTasks = new Set<string>();

function setState(patch: Partial<BalanceState>): void {
  state = { ...state, ...patch };
  for (const listener of Array.from(listeners)) {
    try { listener(); } catch { /* ignore */ }
  }
}

export function subscribeBalance(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getBalanceState(): BalanceState {
  return state;
}

export function setBalanceFromUser(balance: number | null | undefined): void {
  setState({ balance: typeof balance === 'number' && Number.isFinite(balance) ? balance : null, error: null });
}

export function refreshBalance(): Promise<void> {
  if (inflight) return inflight;
  setState({ loading: true });
  inflight = getCurrentUser()
    .then((user) => setState({ balance: Number(user.balance), loading: false, error: null }))
    .catch((error: unknown) => setState({ loading: false, error: error instanceof Error ? error.message : '余额读取失败' }))
    .finally(() => { inflight = null; });
  return inflight;
}

/** 计费可能稍晚于任务结束落库：合并 1.5 秒内的多次结束事件，只刷新一次并通知父页一次。 */
export function scheduleBalanceRefresh(delayMs = 1500): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshBalance();
    postToParent({ type: 'nova:balance-changed' });
  }, delayMs);
}

/** 任务进入终态：每个任务只触发一次。 */
export function notifyTaskSettled(taskId: string): void {
  if (!taskId || settledTasks.has(taskId)) return;
  settledTasks.add(taskId);
  if (settledTasks.size > 2000) settledTasks.clear();
  scheduleBalanceRefresh();
}

export function resetBalanceForTests(): void {
  state = { balance: null, loading: false, error: null };
  settledTasks.clear();
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  inflight = null;
}
