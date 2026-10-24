/**
 * 嵌入模式的用户态：Key 列表（内存）、设置页选择的应用、启动时生成注册表。
 * Key 明文只放在本模块与内存注册表里，revoke 时清空。
 */
import { getCurrentUser, listGatewayModels, listKeys, type Sub2ApiKey } from '@/lib/embed/sub2api-client';
import { isHiddenModel, keyUnavailableReason, modelsForPurpose, pickDefaultModel } from '@/lib/embed/key-policy';
import { buildEmbedRegistry, loadStudioPrefs, saveStudioPrefs, type StudioPrefs } from '@/lib/embed/embed-registry';
import { clearEmbedRegistry, setEmbedRegistry } from '@/lib/embed/registry-store';
import { setBalanceFromUser } from '@/lib/embed/balance';
import { clearPlazaCache, loadPlazaGroups } from '@/lib/embed/cost-estimate';

let keys: Sub2ApiKey[] = [];
let prefs: StudioPrefs = {};
// 各 Key 在网关上的模型列表（/v1/models），按会话缓存；重新读取 Key 列表或 revoke 时清空
let keyModels = new Map<number, Promise<string[]>>();
let rebuildSeq = 0;
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

function modelsOfKey(key: Sub2ApiKey): Promise<string[]> {
  let models = keyModels.get(key.id);
  if (!models) {
    // 取不到时不缓存失败结果，注册表退化为只含选中的模型
    models = listGatewayModels(key.key).catch(() => {
      keyModels.delete(key.id);
      return [];
    });
    keyModels.set(key.id, models);
  }
  return models;
}

/**
 * 用当前 Key 列表与选择重建内存注册表，并通知 Nova（与独立模式保存设置后的事件一致）。
 * 所选 Key 下同用途的模型都注册进去，选中的为默认；并发重建时只应用最后一次。
 */
async function rebuildRegistry(): Promise<void> {
  const seq = ++rebuildSeq;
  const selected = [prefs.image?.keyId, prefs.text?.keyId]
    .map((id) => keys.find((key) => key.id === id))
    .filter((key): key is Sub2ApiKey => Boolean(key && isKeyUsable(key)));
  const [plaza, lists] = await Promise.all([
    loadPlazaGroups().catch(() => null),
    Promise.all(selected.map(async (key) => [key.id, await modelsOfKey(key)] as const)),
  ]);
  if (seq !== rebuildSeq) return;
  const listByKey = new Map(lists);
  setEmbedRegistry(buildEmbedRegistry(prefs, keys, {
    isUsable: isKeyUsable,
    modelsFor: (key, purpose) => modelsForPurpose(listByKey.get(key.id) || [], purpose, plaza, key),
  }));
  // gemini-config 的动态模型导出依赖注册表；按需加载，避免会话到达前提前求值 Nova 模块
  const { syncDynamicModelExports } = await import('@/lib/gemini-config');
  syncDynamicModelExports();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nova-model-registry-updated'));
  emit();
}

export function setStudioKeys(next: Sub2ApiKey[]): Promise<void> {
  keys = next;
  keyModels = new Map();
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
  keyModels = new Map();
  await replaceHiddenTextModel();
  await rebuildRegistry();
}

/** 之前保存的对话模型现已隐藏（如 codex-auto-review）时换成默认模型；取不到模型列表就清空这一行。 */
async function replaceHiddenTextModel(): Promise<void> {
  const row = prefs.text;
  if (!row || !isHiddenModel(row.model, 'text')) return;
  const key = keys.find((item) => item.id === row.keyId);
  const models = key ? await modelsOfKey(key) : [];
  const model = pickDefaultModel(modelsForPurpose(models, 'text', null, key), 'text');
  const next: StudioPrefs = { ...prefs };
  if (key && model) next.text = { keyId: key.id, model };
  else delete next.text;
  prefs = next;
  saveStudioPrefs(prefs);
}

/** revoke：清空内存中的 Key 与注册表。 */
export function resetStudioState(): void {
  keys = [];
  prefs = {};
  keyModels = new Map();
  rebuildSeq++;
  clearEmbedRegistry();
  clearPlazaCache();
  emit();
}
