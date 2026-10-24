/**
 * 嵌入模式备份导出剔除所有 Key（PRD R5A.3）。
 *
 * 递归清空 apiKey / api_key / authorization / secret / *_token 等字段的字符串值以及形如 sk-... 的值，
 * 值为 JSON 字符串（localStorage、zustand persist 的 localforage 值）时解析后同样处理。
 * 'nova-model-registry' 在嵌入模式下本就不写入，导出时也整体丢弃。
 */

// 注意不包含 key / token 这类通用字段名：IndexedDB store 的 keyPath（如 blobs.key）与 localforage 条目都用 key。
const SECRET_FIELD = /^(api[-_]?key|apikey|x-nova-api-key|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|session[-_]?token|authorization|password)$/i;

/** 导出时整体丢弃的 localStorage 键（即便存在也不导出）。 */
export const EMBED_BACKUP_DROPPED_KEYS = new Set(['nova-model-registry']);

/** 值看起来像 sub2api / OpenAI 等的 Key（sk-...）时也清掉，避免以未知字段名保存的 Key 漏出。 */
const KEY_LIKE_VALUE = /^(sk|ak|rk)-[A-Za-z0-9_-]{16,}$/;

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

/** 递归清理；未发生变化时返回原引用（JSON 字符串不会被重新格式化）。 */
export function stripSecretsDeep(value: unknown, depth = 0): unknown {
  if (depth > 64) return value;
  if (typeof value === 'string') {
    if (KEY_LIKE_VALUE.test(value.trim())) return '';
    if (looksLikeJson(value)) {
      try {
        const parsed = JSON.parse(value) as unknown;
        const cleaned = stripSecretsDeep(parsed, depth + 1);
        return cleaned === parsed ? value : JSON.stringify(cleaned);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const cleaned = stripSecretsDeep(item, depth + 1);
      if (cleaned !== item) changed = true;
      return cleaned;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [field, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(field) && typeof inner === 'string') {
        out[field] = '';
        if (inner !== '') changed = true;
      } else {
        const cleaned = stripSecretsDeep(inner, depth + 1);
        if (cleaned !== inner) changed = true;
        out[field] = cleaned;
      }
    }
    return changed ? out : value;
  }
  return value;
}

/** 处理导出的 localStorage 映射：丢弃注册表键，其余逐项清理。 */
export function sanitizeLocalStorageExport(data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (EMBED_BACKUP_DROPPED_KEYS.has(key)) continue;
    const cleaned = stripSecretsDeep(value);
    out[key] = typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned);
  }
  return out;
}
