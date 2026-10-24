/**
 * 嵌入模式的内存模型注册表（docs/sub2api-embed.md §11）。
 *
 * 由设置页的选择（只持久化 { keyId, model }）+ 内存中的 Key 明文生成 NovaModelRegistry，
 * 不读写 localStorage['nova-model-registry']。nova-models.ts 的 loadRegistry / saveRegistry
 * 在嵌入模式下改走这里，其余 Nova 代码无需改动。
 */
import {
  BUILTIN_IMAGE_PRESETS,
  DEFAULT_DEFAULTS,
  isSliceCapableImageModel,
  type BuiltinImagePresetId,
  type ImageModelConfig,
  type NovaModelRegistry,
  type ProviderProtocol,
  type TextModelConfig,
} from '@/lib/nova-models';
import { getTextProviderDescription } from '@/lib/nova-text-protocol';
import { deriveImageProtocol, deriveTextProtocol } from '@/lib/embed/key-policy';
import type { Sub2ApiKey } from '@/lib/embed/sub2api-client';
import { storageKey } from '@/lib/embed/storage-partition';

export interface RowSelection {
  keyId: number;
  model: string;
}

export interface StudioPrefs {
  image?: RowSelection;
  text?: RowSelection;
}

export const STUDIO_PREFS_KEY = 'studio-prefs';

function parseRow(raw: unknown): RowSelection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const keyId = Number(record.keyId);
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!Number.isSafeInteger(keyId) || keyId <= 0 || !model) return undefined;
  return { keyId, model };
}

export function parseStudioPrefs(raw: string | null | undefined): StudioPrefs {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const prefs: StudioPrefs = {};
    const image = parseRow(parsed?.image);
    const text = parseRow(parsed?.text);
    if (image) prefs.image = image;
    if (text) prefs.text = text;
    return prefs;
  } catch {
    return {};
  }
}

export function loadStudioPrefs(): StudioPrefs {
  if (typeof localStorage === 'undefined') return {};
  try {
    return parseStudioPrefs(localStorage.getItem(storageKey(STUDIO_PREFS_KEY)));
  } catch {
    return {};
  }
}

/** 只保存 { keyId, model }，不保存 Key 明文。 */
export function saveStudioPrefs(prefs: StudioPrefs): void {
  if (typeof localStorage === 'undefined') return;
  const clean: StudioPrefs = {};
  if (prefs.image) clean.image = { keyId: prefs.image.keyId, model: prefs.image.model };
  if (prefs.text) clean.text = { keyId: prefs.text.keyId, model: prefs.text.model };
  try {
    localStorage.setItem(storageKey(STUDIO_PREFS_KEY), JSON.stringify(clean));
  } catch {
    // 存储不可用时忽略，本次会话仍在内存中生效
  }
}

/** 发给 grok 生图接口的 model 需是官方 ID（移植自 sub2api-embed 远端）。 */
export function canonicalizeGrokModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const compact = trimmed.toLowerCase().replace(/_+/g, '-').replace(/[\s-]+/g, '-');
  if (compact === 'grok-imagine' || compact === 'grok-imagine-1' || compact === 'grok-imagine-edit') {
    return 'grok-imagine-image-quality';
  }
  if (compact.startsWith('grok-imagine-image')) return compact;
  return trimmed;
}

export function pickImagePreset(protocol: ProviderProtocol, modelId: string): BuiltinImagePresetId {
  if (modelId in BUILTIN_IMAGE_PRESETS) return modelId as BuiltinImagePresetId;
  const lowered = modelId.toLowerCase();
  if (protocol === 'google') {
    if (lowered.includes('flash-lite')) return 'gemini-3.1-flash-lite-image';
    if (lowered.includes('3.1-flash')) return 'gemini-3.1-flash-image-preview';
    if (lowered.includes('2.5-flash')) return 'gemini-2.5-flash-image';
    return 'gemini-3-pro-image-preview';
  }
  if (protocol === 'grok') {
    if (lowered.includes('edit')) return 'grok-imagine-image-edit';
    if (lowered.includes('quality')) return 'grok-imagine-image-quality';
    return 'grok-imagine-image';
  }
  return 'gpt-image-2';
}

export function gatewayBaseUrl(): string {
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
}

export function buildImageModel(key: Sub2ApiKey, model: string, baseUrl: string = gatewayBaseUrl()): ImageModelConfig | null {
  const platform = String(key.group?.platform || '');
  const protocol = deriveImageProtocol(platform, model);
  if (!protocol || !key.key) return null;
  const modelId = protocol === 'grok' ? canonicalizeGrokModelId(model) : model;
  const presetId = pickImagePreset(protocol, modelId);
  const preset = BUILTIN_IMAGE_PRESETS[presetId];
  const isGptImage = /gpt-image|dall-?e/i.test(modelId);
  return {
    id: `embed-img:${key.id}:${model}`,
    protocol,
    name: model,
    modelId,
    apiKey: key.key,
    // 后端嵌入模式固定走 SUB2API_GATEWAY_URL，这里只需非空且同源
    baseUrl,
    builtinPreset: presetId,
    maxRefImages: preset.maxRefImages,
    maxOutputSize: preset.maxOutputSize,
    supportsAdvancedParams: protocol === 'openai' && isGptImage ? preset.supportsAdvancedParams : false,
  };
}

export function buildTextModel(key: Sub2ApiKey, model: string, baseUrl: string = gatewayBaseUrl()): TextModelConfig | null {
  if (!key.key) return null;
  const protocol = deriveTextProtocol(String(key.group?.platform || ''), model);
  return {
    id: `embed-txt:${key.id}:${model}`,
    protocol,
    name: model,
    modelId: model,
    apiKey: key.key,
    baseUrl,
    note: getTextProviderDescription(protocol),
  };
}

export function emptyRegistry(): NovaModelRegistry {
  return { providers: [], imageModels: [], textModels: [], defaults: { ...DEFAULT_DEFAULTS } };
}

/** 选中的模型排第一，其余按网关返回顺序；去重。 */
function orderedModels(selected: string, others: string[]): string[] {
  return Array.from(new Set([selected, ...others]));
}

/**
 * 由选择 + Key 列表生成注册表。选中的 Key 不存在或不可用（调用方传入的 usable 判断）时该行视为未选择。
 *
 * modelsFor 给出该 Key 下某用途的全部可用模型（已按用途过滤、去掉隐藏模型），它们都写进注册表，
 * Nova 各功能里自带的模型选择器（生图、动图、反推、拆图、Agent 等）因此能选；设置页选中的模型是各功能的默认值。
 * 不传时只注册选中的那一个。
 */
export function buildEmbedRegistry(
  prefs: StudioPrefs,
  keys: Sub2ApiKey[],
  options: {
    baseUrl?: string;
    isUsable?: (key: Sub2ApiKey) => boolean;
    modelsFor?: (key: Sub2ApiKey, purpose: 'image' | 'text') => string[];
  } = {},
): NovaModelRegistry {
  const baseUrl = options.baseUrl ?? gatewayBaseUrl();
  const isUsable = options.isUsable ?? (() => true);
  const modelsFor = options.modelsFor ?? (() => []);
  const find = (row?: RowSelection) => {
    if (!row) return undefined;
    const key = keys.find((item) => item.id === row.keyId);
    return key && isUsable(key) ? key : undefined;
  };
  const imageKey = find(prefs.image);
  const textKey = find(prefs.text);
  const imageModels = imageKey && prefs.image
    ? orderedModels(prefs.image.model, modelsFor(imageKey, 'image'))
      .map((model) => buildImageModel(imageKey, model, baseUrl))
      .filter((model): model is ImageModelConfig => Boolean(model))
    : [];
  const textModels = textKey && prefs.text
    ? orderedModels(prefs.text.model, modelsFor(textKey, 'text'))
      .map((model) => buildTextModel(textKey, model, baseUrl))
      .filter((model): model is TextModelConfig => Boolean(model))
    : [];
  // 选中的模型在列表第一位；它建不出来（如协议不支持）时该行视为未选择
  const image = imageKey && prefs.image && imageModels[0]?.name === prefs.image.model ? imageModels[0] : undefined;
  const text = textKey && prefs.text && textModels[0]?.name === prefs.text.model ? textModels[0] : undefined;
  const imageId = image?.id || '';
  const textId = text?.id || '';
  const sliceImage = image && isSliceCapableImageModel(image) ? image : imageModels.find(isSliceCapableImageModel);
  return {
    providers: [],
    imageModels: image ? imageModels : [],
    textModels: text ? textModels : [],
    defaults: {
      textToImage: imageId,
      imageToImage: imageId,
      reversePrompt: textId,
      agent: textId,
      promptOptimize: textId,
      imageDescribe: textId,
      sliceDecomposition: textId,
      sliceReconstruct: textId,
      sliceImageEdit: image && sliceImage ? sliceImage.id : '',
    },
  };
}
