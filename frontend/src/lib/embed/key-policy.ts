/**
 * 「模型与密钥」的纯函数：Key 按用途过滤、模型用途分类、Nova 协议推导、单价格式化。
 * 分组平台常量对应 sub2api backend/internal/domain/constants.go。
 */
import type { ProviderProtocol } from '@/lib/nova-models';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';
import type { PlazaGroup, PlazaModel, Sub2ApiGroup, Sub2ApiKey } from '@/lib/embed/sub2api-client';

export type StudioPurpose = 'image' | 'text' | 'video';
export type ModelKind = 'image' | 'text' | 'video' | 'other';

export const PLATFORM_OPENAI = 'openai';
export const PLATFORM_ANTHROPIC = 'anthropic';
export const PLATFORM_GEMINI = 'gemini';
export const PLATFORM_ANTIGRAVITY = 'antigravity';
export const PLATFORM_GROK = 'grok';
export const PLATFORM_COMPOSITE = 'composite';

/** 生图 Key 可用的分组平台。openai / grok 走 /v1/images/*，需分组开启 allow_image_generation；gemini / antigravity 走 generateContent。 */
const IMAGE_PLATFORMS_REQUIRING_FLAG = new Set([PLATFORM_OPENAI, PLATFORM_GROK]);
const IMAGE_PLATFORMS_GENERATE_CONTENT = new Set([PLATFORM_GEMINI, PLATFORM_ANTIGRAVITY]);

export interface KeyOption {
  key: Sub2ApiKey;
  /** 置灰原因；空表示可选 */
  disabledReason: string;
}

function normalizedPlatform(group: Sub2ApiGroup | null | undefined): string {
  return String(group?.platform || '').trim().toLowerCase();
}

/** Key 本身的可用性（与用途无关）：状态、过期、额度、分组。 */
export function keyUnavailableReason(key: Sub2ApiKey, now: number = Date.now()): string {
  switch (key.status) {
    case 'active':
      break;
    case 'inactive':
      return '已禁用';
    case 'expired':
      return '已过期';
    case 'quota_exhausted':
      return '额度已用完';
    default:
      return '不可用';
  }
  if (key.expires_at) {
    const expires = Date.parse(key.expires_at);
    if (Number.isFinite(expires) && expires <= now) return '已过期';
  }
  if (Number(key.quota) > 0 && Number(key.quota_used) >= Number(key.quota)) return '额度已用完';
  if (key.group_id == null || !key.group) return '未绑定分组';
  if (key.group.status && key.group.status !== 'active') return '分组已停用';
  return '';
}

/** 视频分组：模型广场里该分组有按视频计费或名为 seedance 的模型。 */
function isVideoGroup(group: Sub2ApiGroup, plaza: PlazaGroup[] | null | undefined): boolean {
  const found = plaza?.find((item) => item.id === group.id);
  return Boolean(found?.models.some((model) => model.pricing?.billing_mode === 'video' || /seedance/i.test(model.name)));
}

/**
 * 分组对该用途的支持情况：
 *   - null：该平台与用途无关，Key 不出现在下拉里；
 *   - ''：支持；
 *   - 其他字符串：可列出但置灰的原因。
 * 视频用途按模型广场判断，广场不可用时没有可选的视频分组。
 */
export function groupPurposeSupport(group: Sub2ApiGroup | null | undefined, purpose: StudioPurpose, plaza?: PlazaGroup[] | null): string | null {
  if (purpose === 'video') return group && isVideoGroup(group, plaza) ? '' : null;
  if (!group) return purpose === 'text' ? '' : null;
  const platform = normalizedPlatform(group);
  if (purpose === 'text') return '';
  if (IMAGE_PLATFORMS_REQUIRING_FLAG.has(platform)) {
    return group.allow_image_generation ? '' : '分组未开启生图';
  }
  if (IMAGE_PLATFORMS_GENERATE_CONTENT.has(platform)) return '';
  return null;
}

/** 按用途列出 Key：不相关平台过滤掉；禁用 / 过期 / 额度用完 / 分组不支持的置灰并给出原因。可用的排在前面。 */
export function filterKeysForPurpose(keys: Sub2ApiKey[], purpose: StudioPurpose, now: number = Date.now(), plaza?: PlazaGroup[] | null): KeyOption[] {
  const options: KeyOption[] = [];
  for (const key of keys) {
    const support = groupPurposeSupport(key.group, purpose, plaza);
    if (support === null && key.group) continue;
    const unavailable = keyUnavailableReason(key, now);
    if (unavailable === '未绑定分组' && purpose !== 'text') continue;
    options.push({ key, disabledReason: unavailable || support || '' });
  }
  return options.sort((a, b) => Number(Boolean(a.disabledReason)) - Number(Boolean(b.disabledReason)));
}

/** 一键创建时可选的分组（按用途），生图与对话都支持的分组排在前面。 */
export function filterGroupsForPurpose(groups: Sub2ApiGroup[], purpose: StudioPurpose, plaza?: PlazaGroup[] | null): Sub2ApiGroup[] {
  return groups
    .filter((group) => (!group.status || group.status === 'active') && groupPurposeSupport(group, purpose, plaza) === '')
    .sort((a, b) => Number(!supportsImageAndText(a)) - Number(!supportsImageAndText(b)));
}

export function supportsImageAndText(group: Sub2ApiGroup | null | undefined): boolean {
  return groupPurposeSupport(group, 'image') === '' && groupPurposeSupport(group, 'text') === '';
}

export const STUDIO_KEY_NAME = '创作工作台';

/**
 * 一键创建的 Key 名：生图 / 对话在分组两者都能用时只建一把通用的「创作工作台」，否则按用途加后缀。
 * 视频分组（网关要求开启生图）总是单独一把「创作工作台-视频」。
 */
export function studioKeyName(group: Sub2ApiGroup | null | undefined, purposeLabel: string, purpose?: StudioPurpose): string {
  return purpose !== 'video' && supportsImageAndText(group) ? STUDIO_KEY_NAME : `${STUDIO_KEY_NAME}-${purposeLabel}`;
}

const IMAGE_NAME_PATTERNS = [
  /gpt-image/,
  /dall-?e/,
  /(^|[-_/])image([-_.]|$)/,
  /-image\b/,
  /imagen/,
  /grok-imagine-image/,
  /seedream/,
  /qwen-image/,
  /^wan[\d.]*-?.*image/,
  /flux/,
  /midjourney/,
  /nano-?banana/,
];

const VIDEO_NAME_PATTERNS = [
  /\bveo/,
  /sora/,
  /grok-imagine-video/,
  /-video\b/,
  /seedance/,
  /kling/,
  /\bwan[\d.]*-?.*(t2v|i2v|video)/,
  /hailuo/,
];

const NON_CHAT_NAME_PATTERNS = [
  /embedding/,
  /\btts\b|-tts/,
  /whisper/,
  /moderation/,
  /transcri/,
  /realtime/,
  /\baudio\b|-audio/,
  /rerank/,
];

/** 按名称推断模型用途（模型广场计费模式缺失时的兜底）。 */
export function classifyModelByName(model: string): ModelKind {
  const name = model.trim().toLowerCase();
  if (!name) return 'other';
  if (VIDEO_NAME_PATTERNS.some((pattern) => pattern.test(name))) return 'video';
  if (IMAGE_NAME_PATTERNS.some((pattern) => pattern.test(name))) return 'image';
  if (NON_CHAT_NAME_PATTERNS.some((pattern) => pattern.test(name))) return 'other';
  return 'text';
}

/**
 * 模型用途：模型广场计费模式 image / video 优先；token 计费但名称明显是生图模型（如 gemini-*-image 按 token 计费）仍归为生图。
 */
export function classifyModel(model: string, billingMode?: string | null): ModelKind {
  const byName = classifyModelByName(model);
  if (billingMode === 'image') return 'image';
  if (billingMode === 'video') return 'video';
  return byName;
}

/** 网关会列出、但不适合在工作台对话里用的模型（Codex 内部审查模型、备用模型）。 */
const HIDDEN_TEXT_MODELS = [/^codex-auto-review/, /^gpt-reserve/];

/** 选 Key 后默认选中的模型（按顺序取第一个可用的），都不可用时取列表第一个。 */
const PREFERRED_MODELS: Partial<Record<StudioPurpose, string[]>> = {
  image: ['gpt-image-2.5-sunburst'],
  text: ['gpt-6.1-sol'],
};

export function isHiddenModel(model: string, purpose: StudioPurpose): boolean {
  const name = model.trim().toLowerCase();
  return purpose === 'text' && HIDDEN_TEXT_MODELS.some((pattern) => pattern.test(name));
}

export function pickDefaultModel(candidates: string[], purpose: StudioPurpose): string | undefined {
  const preferred = PREFERRED_MODELS[purpose] || [];
  return preferred.find((model) => candidates.includes(model)) ?? candidates[0];
}

/**
 * 该 Key 在网关上可用的模型中，属于某用途的部分（去掉隐藏的模型）。
 * 计费模式取自模型广场里该 Key 所属分组的同名模型；广场不可用时按名称分类。
 */
export function modelsForPurpose(models: string[], purpose: StudioPurpose, plazaGroups: PlazaGroup[] | null | undefined, key: Sub2ApiKey | undefined): string[] {
  return models.filter((model) => {
    if (isHiddenModel(model, purpose)) return false;
    const billing = key ? findPlazaModel(plazaGroups, key.group_id, model)?.model.pricing?.billing_mode : undefined;
    return classifyModel(model, billing) === purpose;
  });
}

/** 生图协议：openai → openai，grok → grok，gemini / antigravity → google（generateContent）。 */
export function deriveImageProtocol(platform: string, model: string): ProviderProtocol | null {
  const p = platform.trim().toLowerCase();
  if (p === PLATFORM_OPENAI) return 'openai';
  if (p === PLATFORM_GROK) return 'grok';
  if (p === PLATFORM_GEMINI || p === PLATFORM_ANTIGRAVITY) return 'google';
  if (p === PLATFORM_COMPOSITE) {
    const name = model.toLowerCase();
    if (name.startsWith('grok-imagine')) return 'grok';
    if (name.includes('gemini')) return 'google';
    return 'openai';
  }
  return null;
}

/**
 * 对话协议：openai → Responses；anthropic → Messages；gemini → Gemini v1beta；
 * antigravity 按模型（claude-* 走 Messages，其余走 Gemini）；其他 OpenAI 兼容平台走 Chat Completions。
 */
export function deriveTextProtocol(platform: string, model: string): TextProviderProtocol {
  const p = platform.trim().toLowerCase();
  const name = model.trim().toLowerCase();
  if (p === PLATFORM_OPENAI) return 'openai-responses';
  if (p === PLATFORM_ANTHROPIC) return 'anthropic-messages';
  if (p === PLATFORM_GEMINI) return 'google-gemini';
  if (p === PLATFORM_ANTIGRAVITY) return name.startsWith('claude') ? 'anthropic-messages' : 'google-gemini';
  if (p === PLATFORM_COMPOSITE && name.startsWith('claude')) return 'anthropic-messages';
  return 'openai-chat-completions';
}

// ==================== 单价（与模型广场一致：¥，保底 2 位小数，不出现「倍率」） ====================

const BALANCE_SYMBOL = '¥';
const PER_MILLION = 1_000_000;
const MIN_DECIMALS = 2;

/** 同 sub2api utils/pricing.ts formatScaled。 */
export function formatScaled(value: number | null | undefined, scale: number, minFractionDigits = MIN_DECIMALS, symbol = BALANCE_SYMBOL): string {
  if (value == null || !Number.isFinite(value)) return '-';
  let s = Number((value * scale).toPrecision(10)).toString();
  if (minFractionDigits > 0 && !s.includes('e')) {
    const dot = s.indexOf('.');
    const digits = dot === -1 ? 0 : s.length - dot - 1;
    if (digits < minFractionDigits) s = (dot === -1 ? `${s}.` : s) + '0'.repeat(minFractionDigits - digits);
  }
  return `${symbol}${s}`;
}

/** 同 sub2api utils/balanceCurrency.ts formatBalance（默认 2 位小数）。 */
export function formatBalance(amount: number | string | null | undefined): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (amount === null || amount === undefined || amount === '' || !Number.isFinite(n)) return `${BALANCE_SYMBOL}0.00`;
  const body = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(Math.abs(n));
  const isZero = Number(body) === 0;
  return `${n < 0 && !isZero ? '-' : ''}${BALANCE_SYMBOL}${body}`;
}

export function findPlazaModel(plazaGroups: PlazaGroup[] | null | undefined, groupId: number | null | undefined, model: string): { group: PlazaGroup; model: PlazaModel } | null {
  if (!plazaGroups || groupId == null) return null;
  const group = plazaGroups.find((item) => item.id === groupId);
  if (!group) return null;
  const found = group.models.find((item) => item.name === model)
    || group.models.find((item) => item.name.toLowerCase() === model.toLowerCase());
  return found ? { group, model: found } : null;
}

/** 生效倍率：模型行专属 ?? 模型行公开 ?? 分组专属 ?? 分组（同模型广场 rowRate）。 */
function rowRate(group: PlazaGroup, model: PlazaModel): number {
  return model.user_rate_multiplier ?? model.rate_multiplier ?? group.user_rate_multiplier ?? group.rate_multiplier ?? 1;
}

/** 非 token 计费的生效倍率：图片 / 视频独立倍率开启时覆盖（同模型广场 requestRate）。 */
function requestRate(group: PlazaGroup, model: PlazaModel): number {
  const mode = model.pricing?.billing_mode;
  if (mode === 'video' && group.video_rate_independent) return Math.max(0, group.video_rate_multiplier ?? 1);
  if (mode === 'image' && group.image_rate_independent) return group.image_rate_multiplier ?? 1;
  return rowRate(group, model);
}

/**
 * 每张图的单价（已乘生效倍率），用于提交前预估（PRD R6.2）；非按张 / 按次计费或无定价返回 null。
 * 分档定价按尺寸档位（1K / 2K / 4K，与网关计费一致）匹配，匹配不到取第一档。
 */
export function perImagePrice(group: PlazaGroup, model: PlazaModel, outputSize?: string): number | null {
  const pricing = model.pricing;
  if (!pricing || (pricing.billing_mode !== 'image' && pricing.billing_mode !== 'per_request')) return null;
  const rate = requestRate(group, model);
  const tiers = (pricing.intervals || []).filter((item) => item.per_request_price != null);
  if (tiers.length > 0) {
    const size = String(outputSize || '').toUpperCase();
    const tier = tiers.find((item) => String(item.tier_label || '').toUpperCase() === size) || tiers[0];
    return (tier.per_request_price as number) * rate;
  }
  const base = pricing.per_request_price ?? (pricing.billing_mode === 'image' ? pricing.image_output_price : null);
  return base == null ? null : base * rate;
}

/** 视频计费分辨率的写法归一（同 sub2api LookupVideoBillingResolution）：4k / 2160p / 2160 / uhd → 4k。 */
export function normalizeVideoResolution(resolution: string | undefined): string {
  const value = String(resolution || '').trim().toLowerCase();
  if (value === '2160p' || value === '2160' || value === 'uhd') return '4k';
  return value;
}

/**
 * 视频每秒单价（已乘生效倍率）；非按秒计费或无定价返回 null。
 * 分档按 intervals 的 tier_label（C6）：带参考视频取 `<分辨率>-ref`，没有时取同分辨率普通档，再没有取基础价 per_request_price。
 */
export function perSecondVideoPrice(group: PlazaGroup, model: PlazaModel, resolution?: string, withReference = false): number | null {
  const pricing = model.pricing;
  if (!pricing || pricing.billing_mode !== 'video') return null;
  const rate = requestRate(group, model);
  const tiers = (pricing.intervals || []).filter((item) => item.per_request_price != null);
  const tierOf = (label: string) => tiers.find((item) => String(item.tier_label || '').trim().toLowerCase() === label);
  const res = normalizeVideoResolution(resolution);
  const tier = (withReference ? tierOf(`${res}-ref`) : undefined) ?? tierOf(res);
  const price = tier ? tier.per_request_price : pricing.per_request_price;
  return price == null ? null : price * rate;
}

/** 所选模型在该分组下的单价文案；无定价返回空串。 */
export function formatModelPrice(group: PlazaGroup, model: PlazaModel): string {
  const pricing = model.pricing;
  if (!pricing) return '';
  const mode = pricing.billing_mode || 'token';
  if (mode === 'token') {
    const rate = rowRate(group, model);
    const parts: string[] = [];
    if (pricing.input_price != null) parts.push(`输入 ${formatScaled(pricing.input_price * rate, PER_MILLION)}`);
    if (pricing.output_price != null) parts.push(`输出 ${formatScaled(pricing.output_price * rate, PER_MILLION)}`);
    if (parts.length === 0 && pricing.intervals?.length) {
      const first = pricing.intervals[0];
      if (first.input_price != null) parts.push(`输入 ${formatScaled(first.input_price * rate, PER_MILLION)}`);
      if (first.output_price != null) parts.push(`输出 ${formatScaled(first.output_price * rate, PER_MILLION)}`);
    }
    return parts.length ? `${parts.join(' · ')} / 1M tokens` : '';
  }
  const rate = requestRate(group, model);
  const unit = mode === 'image' ? '张' : mode === 'video' ? '秒' : '次';
  const tiers = (pricing.intervals || []).filter((item) => item.per_request_price != null);
  if (mode === 'video' && tiers.length > 0) {
    // 视频分档多（分辨率 × 是否带参考视频），只显示最低价；具体单价在视频工作台按所选分辨率预估
    const lowest = Math.min(...[pricing.per_request_price, ...tiers.map((item) => item.per_request_price)].filter((value): value is number => value != null));
    return `${formatScaled(lowest * rate, 1)} 起 / 秒，按分辨率与参考视频分档`;
  }
  if (tiers.length > 0) {
    return tiers
      .map((item) => `${item.tier_label ? `${item.tier_label} ` : ''}${formatScaled((item.per_request_price as number) * rate, 1)}`)
      .join(' · ') + ` / ${unit}`;
  }
  if (pricing.per_request_price != null) return `${formatScaled(pricing.per_request_price * rate, 1)} / ${unit}`;
  if (mode === 'image' && pricing.image_output_price != null) return `${formatScaled(pricing.image_output_price * rate, 1)} / ${unit}`;
  return '';
}
