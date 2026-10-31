import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  availableFacetValues,
  buildScope,
  checkSubmittable,
  coerceFacets,
  coerceFieldValues,
  defaultFacets,
  defaultFieldValues,
  estimateCost,
  facetsFromModel,
  isFieldRequired,
  isFieldVisible,
  matchCondition,
  resolveMaxCount,
  resolveMaxTotalSeconds,
  resolveModel,
  resolvedMediaFields,
  toolbarEntries,
  visibleOptions,
  type FacetValues,
  type FieldValues,
  type InstalledPlugin,
  type PluginUiSchema,
} from '@/lib/plugin-schema';

/**
 * 直接读随仓库分发的 qx-seedance 插件包，而不是在测试里另写一份 schema。
 * 这样插件包和宿主求解器一旦走偏，测试立刻会红——那正是最容易出问题的地方。
 */
function loadPlugin(id: string): InstalledPlugin {
  const dir = path.resolve(process.cwd(), '..', 'backend', 'plugins', id);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const uiSchema = JSON.parse(readFileSync(path.join(dir, 'ui.schema.json'), 'utf8')) as PluginUiSchema;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    description: manifest.description,
    author: manifest.author ?? '',
    homepage: manifest.homepage ?? '',
    outputs: manifest.outputs,
    credential: manifest.credential,
    media: manifest.media,
    models: manifest.models.map((model: Record<string, unknown>) => ({
      id: model.id,
      name: model.name,
      shortName: model.shortName ?? model.name,
      description: model.description ?? '',
      price: model.price ?? null,
    })),
    uiSchema,
  } as InstalledPlugin;
}

const plugin = loadPlugin('qx-seedance');
const schema = plugin.uiSchema;
const field = (key: string) => schema.fields.find(item => item.key === key)!;
const slotKeys = (facets: FacetValues) =>
  resolvedMediaFields(schema, facets, defaultFieldValues(schema, facets)).map(slot => slot.field.key);

/**
 * 通用求解规则用的最小 schema：后一个 facet 受前一个约束、requiredIf、maxCount / maxTotalSeconds 按 facet 映射。
 */
const generic: PluginUiSchema = {
  apiVersion: 1,
  modelSelector: {
    facets: [{ key: 'tier', label: '档位' }, { key: 'resolution', label: '分辨率' }],
    facetOptions: {
      tier: [{ value: 'pro', label: 'Pro' }, { value: 'lite', label: 'Lite' }],
      resolution: [{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }],
    },
    variants: [
      { model: 'pro-720', tier: 'pro', resolution: '720p' },
      { model: 'pro-1080', tier: 'pro', resolution: '1080p' },
      { model: 'lite-720', tier: 'lite', resolution: '720p' },
    ],
  },
  fields: [
    { key: 'prompt', type: 'textarea', label: '提示词', required: true },
    { key: 'hd', type: 'switch', label: '高清' },
    {
      key: 'images',
      type: 'media',
      kind: 'images',
      label: '参考图片',
      maxCount: { byFacet: 'tier', values: { pro: 9 }, default: 2 },
      requiredIf: { resolution: ['1080p'] },
    },
    {
      key: 'videos',
      type: 'media',
      kind: 'videos',
      label: '参考视频',
      maxCount: { byFacet: 'tier', values: { pro: 3 } },
      maxTotalSeconds: { byFacet: 'tier', values: { pro: 15 } },
    },
  ],
};

describe('条件求值', () => {
  it('所有键都要命中，键内任一命中即可', () => {
    expect(matchCondition({ mode: ['a'] }, { mode: 'a' })).toBe(true);
    expect(matchCondition({ mode: ['a', 'b'] }, { mode: 'b' })).toBe(true);
    expect(matchCondition({ mode: ['a'], tier: ['x'] }, { mode: 'a', tier: 'y' })).toBe(false);
    expect(matchCondition(undefined, {})).toBe(true);
  });

  it('比较按字符串进行，数字与数字字符串等价', () => {
    expect(matchCondition({ seconds: [4] }, { seconds: '4' })).toBe(true);
  });
});

describe('facet 与模型（通用规则）', () => {
  it('后续 facet 的可选值受前面的 facet 约束，反之不然', () => {
    expect(availableFacetValues(generic, 'resolution', { tier: 'pro' })).toEqual(['720p', '1080p']);
    expect(availableFacetValues(generic, 'resolution', { tier: 'lite' })).toEqual(['720p']);
    expect(availableFacetValues(generic, 'tier', { resolution: '1080p' })).toEqual(['pro', 'lite']);
  });

  it('切档位后把不存在的取值收敛到第一个可用值', () => {
    expect(coerceFacets(generic, { tier: 'lite', resolution: '1080p' })).toEqual({ tier: 'lite', resolution: '720p' });
    expect(resolveModel(generic, { tier: 'lite', resolution: '1080p' })).toBeNull();
  });

  it('unavailableWhen：命中条件的选项不可选，切过去时收敛', () => {
    const ratio = {
      key: 'ratio', type: 'select' as const,
      options: [
        { value: 'adaptive', label: '自动' },
        { value: '16:9', label: '16:9', unavailableWhen: { tier: ['pro'], resolution: ['1080p'] } },
      ],
    };
    const withRatio = { ...generic, fields: [...generic.fields, ratio] };
    expect(visibleOptions(ratio, buildScope({ tier: 'pro', resolution: '720p' }, {})).map(option => option.value)).toEqual(['adaptive', '16:9']);
    expect(visibleOptions(ratio, buildScope({ tier: 'pro', resolution: '1080p' }, {})).map(option => option.value)).toEqual(['adaptive']);
    expect(coerceFieldValues(withRatio, { tier: 'pro', resolution: '1080p' }, { ratio: '16:9' }).ratio).toBe('adaptive');
  });

  it('switch 缺省为 false', () => {
    expect(defaultFieldValues(generic, { tier: 'pro', resolution: '720p' }).hd).toBe(false);
  });

  it('maxCount / maxTotalSeconds 按 facet 映射，缺省落到 default', () => {
    const images = generic.fields.find(item => item.key === 'images')!;
    const videos = generic.fields.find(item => item.key === 'videos')!;
    expect(resolveMaxCount(images, { tier: 'pro' })).toBe(9);
    expect(resolveMaxCount(images, { tier: 'lite' })).toBe(2);
    expect(resolveMaxCount(videos, { tier: 'lite' })).toBe(0);
    expect(resolveMaxTotalSeconds(videos, { tier: 'pro' })).toBe(15);
    expect(resolveMaxTotalSeconds(images, { tier: 'pro' })).toBeNull();
  });

  it('requiredIf 让素材变必填', () => {
    const images = generic.fields.find(item => item.key === 'images')!;
    expect(isFieldRequired(images, buildScope({ resolution: '1080p' }, {}))).toBe(true);
    expect(isFieldRequired(images, buildScope({ resolution: '720p' }, {}))).toBe(false);
  });

  it('参考视频总时长超限不可提交，读不到时长的不计入', () => {
    const facets: FacetValues = { tier: 'pro', resolution: '720p' };
    const fields: FieldValues = { prompt: 'p', hd: false };
    expect(checkSubmittable(generic, facets, fields, { videos: 2 }, { videos: [8, 7] }).ok).toBe(true);
    const over = checkSubmittable(generic, facets, fields, { videos: 2 }, { videos: [8, 7.5] });
    expect(over.ok).toBe(false);
    expect(over.reason).toContain('最多 15 秒');
    expect(checkSubmittable(generic, facets, fields, { videos: 3 }, { videos: [8, 7, undefined] }).ok).toBe(true);
  });
});

describe('qx-seedance：模型与生成方式', () => {
  it('默认 Seedance 2.0 · 文生视频', () => {
    expect(defaultFacets(schema)).toEqual({ targetModel: 'seedance-2.0', mode: 't2v' });
  });

  it('模型 ID 即对外模型名，任何生成方式都可用', () => {
    for (const mode of ['t2v', 'i2v', 'firstlast', 'reference', 'edit', 'extend']) {
      expect(resolveModel(schema, { targetModel: 'seedance-2.5', mode })).toBe('seedance-2.5');
      expect(resolveModel(schema, { targetModel: 'seedance-2.0', mode })).toBe('seedance-2.0');
    }
    expect(facetsFromModel(schema, 'seedance-2.5')).toEqual({ targetModel: 'seedance-2.5', mode: 't2v' });
    expect(facetsFromModel(schema, 'not-a-model')).toBeNull();
  });

  it('各生成方式的素材槽', () => {
    expect(slotKeys({ targetModel: 'seedance-2.0', mode: 't2v' })).toEqual([]);
    expect(slotKeys({ targetModel: 'seedance-2.0', mode: 'i2v' })).toEqual(['firstFrame']);
    expect(slotKeys({ targetModel: 'seedance-2.0', mode: 'firstlast' })).toEqual(['firstFrame', 'lastFrame']);
    expect(slotKeys({ targetModel: 'seedance-2.0', mode: 'reference' })).toEqual(['referenceImages', 'referenceVideos', 'referenceAudios']);
    expect(slotKeys({ targetModel: 'seedance-2.0', mode: 'edit' })).toEqual(['sourceVideo']);
    expect(slotKeys({ targetModel: 'seedance-2.0', mode: 'extend' })).toEqual(['sourceVideo']);
  });

  it('参考素材名额：图 / 视频 / 音频 2.0 为 9 / 3 / 3，2.5 为 30 / 10 / 10', () => {
    const counts = (targetModel: string) => resolvedMediaFields(schema, { targetModel, mode: 'reference' }, {}).map(slot => slot.maxCount);
    expect(counts('seedance-2.0')).toEqual([9, 3, 3]);
    expect(counts('seedance-2.5')).toEqual([30, 10, 10]);
  });

  it('切到 2.0 时超出名额不可提交', () => {
    const facets = { targetModel: 'seedance-2.0', mode: 'reference' };
    const fields = { ...defaultFieldValues(schema, facets), prompt: 'p' };
    expect(checkSubmittable(schema, facets, fields, { referenceImages: 30 }).reason).toContain('最多 9');
    expect(checkSubmittable(schema, { ...facets, targetModel: 'seedance-2.5' }, fields, { referenceImages: 30, referenceAudios: 10 }).ok).toBe(true);
  });

  it('首尾帧两张都必填，素材槽都允许公网链接', () => {
    const facets = { targetModel: 'seedance-2.0', mode: 'firstlast' };
    const slots = resolvedMediaFields(schema, facets, defaultFieldValues(schema, facets));
    expect(slots.map(slot => slot.required)).toEqual([true, true]);
    expect(schema.fields.filter(item => item.type === 'media').every(item => item.allowRemoteUrl)).toBe(true);
  });
});

describe('qx-seedance：参数联动', () => {
  const at = (targetModel: string, mode = 't2v') => ({ targetModel, mode });

  it('默认参数', () => {
    expect(defaultFieldValues(schema, at('seedance-2.0'))).toMatchObject({
      resolution: '720p', ratio: 'adaptive', duration: 5, generate_audio: true, prompt: '',
    });
  });

  it('2.0 时长 4–15 秒，2.5 为 4–30 秒，两者都有自动', () => {
    const values = (targetModel: string) => visibleOptions(field('duration'), buildScope(at(targetModel), {})).map(option => option.value);
    expect(values('seedance-2.0')).toEqual([...Array.from({ length: 12 }, (_, i) => i + 4), -1]);
    expect(values('seedance-2.5')).toEqual([...Array.from({ length: 27 }, (_, i) => i + 4), -1]);
  });

  it('从 2.5 切回 2.0：自动时长保留，超过 15 秒的落回默认 5 秒', () => {
    const fromAuto = coerceFieldValues(schema, at('seedance-2.0'), { ...defaultFieldValues(schema, at('seedance-2.5')), duration: -1 });
    expect(fromAuto.duration).toBe(-1);
    const fromLong = coerceFieldValues(schema, at('seedance-2.0'), { ...defaultFieldValues(schema, at('seedance-2.5')), duration: 20 });
    expect(fromLong.duration).toBe(5);
    const kept = coerceFieldValues(schema, at('seedance-2.0'), { ...defaultFieldValues(schema, at('seedance-2.5')), duration: 12 });
    expect(kept.duration).toBe(12);
  });

  it('4k 只有 2.0 可选，切到 2.5 时落回默认 720p', () => {
    const resolutions = (targetModel: string) => visibleOptions(field('resolution'), buildScope(at(targetModel), {})).map(option => option.value);
    expect(resolutions('seedance-2.0')).toEqual(['480p', '720p', '1080p', '4k']);
    expect(resolutions('seedance-2.5')).toEqual(['480p', '720p', '1080p']);
    expect(coerceFieldValues(schema, at('seedance-2.5'), { ...defaultFieldValues(schema, at('seedance-2.0')), resolution: '4k' }).resolution).toBe('720p');
  });

  it('2.5 的图生视频 / 首尾帧只能自动比例，切过去时收敛为 adaptive', () => {
    const ratios = (targetModel: string, mode: string) => visibleOptions(field('ratio'), buildScope(at(targetModel, mode), {})).map(option => option.value);
    expect(ratios('seedance-2.5', 'i2v')).toEqual(['adaptive']);
    expect(ratios('seedance-2.5', 'firstlast')).toEqual(['adaptive']);
    expect(ratios('seedance-2.5', 't2v')).toHaveLength(7);
    expect(ratios('seedance-2.0', 'i2v')).toHaveLength(7);
    expect(coerceFieldValues(schema, at('seedance-2.5', 'i2v'), { ratio: '16:9' }).ratio).toBe('adaptive');
  });

  it('参考视频与原视频总时长上限 2.0 为 15 秒、2.5 为 30 秒', () => {
    for (const key of ['referenceVideos', 'sourceVideo']) {
      expect(resolveMaxTotalSeconds(field(key), { targetModel: 'seedance-2.0' })).toBe(15);
      expect(resolveMaxTotalSeconds(field(key), { targetModel: 'seedance-2.5' })).toBe(30);
    }
  });

  it('视频编辑不显示时长', () => {
    expect(isFieldVisible(field('duration'), buildScope(at('seedance-2.5', 'edit'), {}))).toBe(false);
    expect(isFieldVisible(field('duration'), buildScope(at('seedance-2.5', 'extend'), {}))).toBe(true);
  });
});

describe('qx-seedance：提交校验', () => {
  it('文生视频填了提示词即可提交', () => {
    const facets = { targetModel: 'seedance-2.0', mode: 't2v' };
    const fields = { ...defaultFieldValues(schema, facets), prompt: '一只猫' };
    expect(checkSubmittable(schema, facets, fields, {})).toEqual({ ok: true, reason: null });
    const empty = checkSubmittable(schema, facets, { ...fields, prompt: '  ' }, {});
    expect(empty.ok).toBe(false);
    expect(empty.reason).toContain('提示词');
  });

  it('图生视频缺首帧不可提交', () => {
    const facets = { targetModel: 'seedance-2.0', mode: 'i2v' };
    const fields = { ...defaultFieldValues(schema, facets), prompt: 'p' };
    expect(checkSubmittable(schema, facets, fields, {}).reason).toContain('首帧');
    expect(checkSubmittable(schema, facets, fields, { firstFrame: 1 }).ok).toBe(true);
  });

  it('参考视频超出名额不可提交', () => {
    const facets = { targetModel: 'seedance-2.0', mode: 'reference' };
    const fields = { ...defaultFieldValues(schema, facets), prompt: 'p' };
    expect(checkSubmittable(schema, facets, fields, { referenceVideos: 4 }).reason).toContain('最多 3');
  });
});

describe('计价与布局', () => {
  it('按秒计费时数量取 priceQuantityField', () => {
    expect(estimateCost(plugin, 'seedance-2.0', { duration: 10 })).toBe(7.5);
    expect(estimateCost(plugin, 'seedance-2.5', { duration: 4 })).toBe(4.5);
  });

  it('数量缺失或模型未申报价格时返回 null，而不是 0', () => {
    expect(estimateCost(plugin, 'seedance-2.0', {})).toBeNull();
    expect(estimateCost(plugin, 'unknown-model', { duration: 4 })).toBeNull();
  });

  it('工具栏顺序来自 layout.toolbar', () => {
    expect(toolbarEntries(schema)).toEqual(['$model', '$mode', 'resolution', 'ratio', 'duration', 'generate_audio']);
  });
});
