/**
 * 提交前的费用预估（PRD R6.2）：单价取自模型广场（与控制台显示一致），× 张数。
 * 只是预估；实际扣费以网关按所选 Key 计费为准。
 */
import { findPlazaModel, formatScaled, perImagePrice } from '@/lib/embed/key-policy';
import { getModelPlaza, type PlazaGroup, type Sub2ApiKey } from '@/lib/embed/sub2api-client';

const EMBED_IMAGE_MODEL = /^embed-img:(\d+):(.+)$/;
const PLAZA_TTL_MS = 5 * 60 * 1000;

/** 嵌入注册表里的生图模型 ID（embed-img:<keyId>:<model>）→ { keyId, model }。 */
export function parseEmbedImageModelId(id: string | null | undefined): { keyId: number; model: string } | null {
  const match = EMBED_IMAGE_MODEL.exec(String(id || ''));
  return match ? { keyId: Number(match[1]), model: match[2] } : null;
}

export interface CostEstimate {
  unit: number;
  count: number;
  total: number;
  text: string;
}

export function estimateImageCost(
  plaza: PlazaGroup[] | null,
  keys: Sub2ApiKey[],
  modelId: string,
  outputSize: string | undefined,
  count: number,
): CostEstimate | null {
  const parsed = parseEmbedImageModelId(modelId);
  if (!parsed || !(count > 0)) return null;
  const key = keys.find((item) => item.id === parsed.keyId);
  const found = findPlazaModel(plaza, key?.group_id ?? key?.group?.id, parsed.model);
  const unit = found ? perImagePrice(found.group, found.model, outputSize) : null;
  if (unit == null) return null;
  const total = unit * count;
  const text = count > 1
    ? `预计 ${formatScaled(unit, 1)} × ${count} = ${formatScaled(total, 1)}`
    : `预计 ${formatScaled(unit, 1)}`;
  return { unit, count, total, text };
}

// 模型广场含当前用户的专属倍率：按会话缓存，revoke / 换账号时清空。
let plazaCache: { at: number; promise: Promise<PlazaGroup[] | null> } | null = null;

export function loadPlazaGroups(now: number = Date.now()): Promise<PlazaGroup[] | null> {
  if (!plazaCache || now - plazaCache.at > PLAZA_TTL_MS) {
    const promise = getModelPlaza().then((data) => data?.groups ?? null, () => null);
    plazaCache = { at: now, promise };
  }
  return plazaCache.promise;
}

export function clearPlazaCache(): void {
  plazaCache = null;
}
