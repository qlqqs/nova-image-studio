/**
 * 嵌入模式的用户态：Key 列表（内存）、设置页选择的应用、启动时生成注册表。
 * Key 明文只放在本模块与内存注册表里，revoke 时清空。
 */
import { getCurrentUser, listKeys, type Sub2ApiKey } from '@/lib/embed/sub2api-client';
import { keyUnavailableReason } from '@/lib/embed/key-policy';
import { buildEmbedRegistry, loadStudioPrefs, saveStudioPrefs, type StudioPrefs } from '@/lib/embed/embed-registry';
import { clearEmbedRegistry, setEmbedRegistry } from '@/lib/embed/registry-store';
import { setBalanceFromUser } from '@/lib/embed/balance';
import { clearPlazaCache } from '@/lib/embed/cost-estimate';

let keys: Sub2ApiKey[] = [];
let prefs: StudioPrefs = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of Array.from(listeners)) {
    try { listener(); } catch { /* ignore */ }
  }
}

export function subscribeStudioState(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getStudioKeys(): Sub2ApiKey[] {
  return keys;
}

export function getStudioPrefs(): StudioPrefs {
  return prefs;
}

export function isKeyUsable(key: Sub2ApiKey): boolean {
  return !keyUnavailableReason(key);
}

/** 用当前 Key 列表与选择重建内存注册表，并通知 Nova（与独立模式保存设置后的事件一致）。 */
async function rebuildRegistry(): Promise<void> {
  setEmbedRegistry(buildEmbedRegistry(prefs, keys, { isUsable: isKeyUsable }));
  // gemini-config 的动态模型导出依赖注册表；按需加载，避免会话到达前提前求值 Nova 模块
  const { syncDynamicModelExports } = await import('@/lib/gemini-config');
  syncDynamicModelExports();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nova-model-registry-updated'));
  emit();
}

export function setStudioKeys(next: Sub2ApiKey[]): Promise<void> {
  keys = next;
  return rebuildRegistry();
}

/** 设置页修改某一行（或清空）。只持久化 { keyId, model }。 */
export function applyStudioPrefs(next: StudioPrefs): Promise<void> {
  prefs = { ...next };
  saveStudioPrefs(prefs);
  return rebuildRegistry();
}

export async function refreshStudioKeys(): Promise<Sub2ApiKey[]> {
  const next = await listKeys();
  await setStudioKeys(next);
  return next;
}

/** 会话到达后：校验用户、读余额、读 Key、按已保存的选择生成注册表。 */
export async function bootstrapStudio(expectedUserId: number): Promise<void> {
  const [user, keyList] = await Promise.all([getCurrentUser(), listKeys()]);
  if (Number(user?.id) !== expectedUserId) throw new Error('登录状态已变化，请刷新页面');
  setBalanceFromUser(Number(user.balance));
  prefs = loadStudioPrefs();
  keys = keyList;
  await rebuildRegistry();
}

/** revoke：清空内存中的 Key 与注册表。 */
export function resetStudioState(): void {
  keys = [];
  prefs = {};
  clearEmbedRegistry();
  clearPlazaCache();
  emit();
}
