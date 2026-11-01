/**
 * 提交前的费用预估（PRD R6.2）：单价取自模型广场（与控制台显示一致），× 张数。
 * 只是预估；实际扣费以网关按所选 Key 计费为准。
 */
import { findPlazaModel, formatScaled, perImagePrice, perSecondVideoPrice, VIDEO_PRICE_DECIMALS } from '@/lib/embed/key-policy';
import { getModelPlaza, type PlazaGroup, type Sub2ApiKey } from '@/lib/embed/sub2api-client';
import {
  buildScope,
  findField,
  isFieldVisible,
  resolvedMediaFields,
  visibleOptions,
  type FacetValues,
  type FieldValues,
  type InstalledPlugin,
} from '@/lib/plugin-schema';

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

/** 网关计费秒数上限：成片 30 + 参考视频 30。 */
const MAX_BILLED_SECONDS = 60;

export interface VideoCostInput {
  model: string;
  resolution?: string;
  /** 成片秒数；-1 为自动时长（按模型上限预估）；null 表示成片与参考视频等长（视频编辑） */
  duration: number | null;
  /** 模型最长成片秒数 */
  maxDuration: number;
  /** 每个参考视频的秒数，读不到时为 undefined；没有参考视频时为空数组 */
  referenceVideoSeconds: Array<number | undefined>;
  count?: number;
}

export interface VideoCostEstimate extends CostEstimate {
  seconds: number;
}

/**
 * 计费秒数（同 mmgate 规则）：成片秒数；有参考视频时再加 max(floor(参考总秒数), ceil(成片 × 2/3))，上限 60。
 * 读不到时长的参考视频不计入参考总秒数。
 */
export function billedVideoSeconds(input: Omit<VideoCostInput, 'model' | 'resolution' | 'count'>): number {
  const known = input.referenceVideoSeconds.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const referenceTotal = known.reduce((sum, value) => sum + value, 0);
  const allKnown = input.referenceVideoSeconds.length > 0 && known.length === input.referenceVideoSeconds.length;
  const output = input.duration === null
    ? (allKnown ? Math.min(input.maxDuration, Math.max(1, Math.round(referenceTotal))) : input.maxDuration)
    : input.duration === -1 ? input.maxDuration : input.duration;
  const reference = input.referenceVideoSeconds.length > 0 ? Math.max(Math.floor(referenceTotal), Math.ceil(output * 2 / 3)) : 0;
  return Math.min(MAX_BILLED_SECONDS, output + reference);
}

export function estimateVideoCost(plaza: PlazaGroup[] | null, key: Sub2ApiKey | null | undefined, input: VideoCostInput): VideoCostEstimate | null {
  if (!key) return null;
  const found = findPlazaModel(plaza, key.group_id ?? key.group?.id, input.model);
  // 有参考视频时整段计费秒数都按 -ref 档单价
  const unit = found ? perSecondVideoPrice(found.group, found.model, input.resolution, input.referenceVideoSeconds.length > 0) : null;
  if (unit == null) return null;
  const count = Math.max(1, input.count ?? 1);
  const seconds = billedVideoSeconds(input);
  const total = unit * seconds * count;
  // 单价与总额都按精确值算，显示时各自四舍五入到 4 位小数
  const show = (value: number) => formatScaled(value, 1, undefined, undefined, VIDEO_PRICE_DECIMALS);
  const text = `预计 ${show(total)}（${seconds} 秒 × ${show(unit)}${count > 1 ? ` × ${count}` : ''}）`;
  return { unit, count, total, seconds, text };
}

/**
 * 由插件表单求预估：时长取 priceQuantityField（不可见时视为与参考视频等长），
 * 模型上限取该字段在当前组合下可选的最大值，参考视频为可见的视频素材槽里的全部素材。
 */
export function estimatePluginVideoCost(
  plaza: PlazaGroup[] | null,
  key: Sub2ApiKey | null | undefined,
  plugin: InstalledPlugin,
  model: string,
  facets: FacetValues,
  fields: FieldValues,
  mediaSeconds: Record<string, Array<number | undefined>>,
  count = 1,
): VideoCostEstimate | null {
  const schema = plugin.uiSchema;
  const quantity = schema.priceQuantityField ? findField(schema, schema.priceQuantityField) : undefined;
  if (!quantity) return null;
  const scope = buildScope(facets, fields);
  const maxDuration = Math.max(0, ...visibleOptions(quantity, scope).map((option) => Number(option.value)).filter(Number.isFinite));
  const referenceVideoSeconds = resolvedMediaFields(schema, facets, fields)
    .filter((entry) => entry.field.kind === 'videos')
    .flatMap((entry) => mediaSeconds[entry.field.key] || []);
  return estimateVideoCost(plaza, key, {
    model,
    resolution: typeof fields.resolution === 'string' ? fields.resolution : undefined,
    duration: isFieldVisible(quantity, scope) ? Number(fields[quantity.key]) : null,
    maxDuration,
    referenceVideoSeconds,
    count,
  });
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
