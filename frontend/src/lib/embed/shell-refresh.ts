/** 设置页关闭时请求 EmbedRoot 检查是否需要重新挂载工作区。 */
const listeners = new Set<() => void>();

export function subscribeShellRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function requestShellRefresh(): void {
  for (const listener of Array.from(listeners)) {
    try { listener(); } catch { /* ignore */ }
  }
}

let autoOpenedSettings = false;

/**
 * 首次进入且未选择生图密钥时自动打开设置页；每次页面加载最多一次
 * （设置页关闭后工作区可能重新挂载，不应再次弹出）。
 */
export function consumeAutoOpenSettings(hasImageSelection: boolean): boolean {
  if (autoOpenedSettings || hasImageSelection) return false;
  autoOpenedSettings = true;
  return true;
}
