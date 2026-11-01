import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { billedVideoSeconds, estimatePluginVideoCost, estimateVideoCost } from '@/lib/embed/cost-estimate';
import { formatModelPrice, formatScaled, perSecondVideoPrice } from '@/lib/embed/key-policy';
import type { InstalledPlugin } from '@/lib/plugin-schema';
import { makeKey, PLAZA, VIDEO_PLAZA, VIDEO_PLAZA_LIST_PRICE } from './fixtures';

const key = makeKey(3, 'openai'); // group 103
const base = { model: 'seedance-2.0', resolution: '720p', maxDuration: 15, referenceVideoSeconds: [] };

describe('视频每秒单价', () => {
  const group = VIDEO_PLAZA[0];
  const [sd20, sd25] = group.models;

  it('按分辨率取普通档，480p 没有单独档时取基础价；非视频计费返回 null', () => {
    expect(perSecondVideoPrice(group, sd20, '720p')).toBeCloseTo(0.75);
    expect(perSecondVideoPrice(group, sd20, '1080P')).toBeCloseTo(1.875);
    expect(perSecondVideoPrice(group, sd20, '480p')).toBeCloseTo(0.5318);
    expect(perSecondVideoPrice(group, sd25, '1080p')).toBeCloseTo(2.775);
    expect(perSecondVideoPrice(PLAZA[0], PLAZA[0].models[0])).toBeNull();
  });

  it('带参考视频取 <分辨率>-ref 档', () => {
    expect(perSecondVideoPrice(group, sd20, '480p', true)).toBeCloseTo(0.5956);
    expect(perSecondVideoPrice(group, sd20, '4k', true)).toBeCloseTo(4.665);
    expect(perSecondVideoPrice(group, sd25, '720p', true)).toBeCloseTo(1.3575);
  });

  it('4k 别名 4K / 2160p / 2160 / uhd', () => {
    for (const alias of ['4k', '4K', '2160p', '2160', 'uhd']) {
      expect(perSecondVideoPrice(group, sd20, alias)).toBeCloseTo(3.75);
      expect(perSecondVideoPrice(group, sd20, alias, true)).toBeCloseTo(4.665);
    }
  });

  it('缺 -ref 档时取同分辨率普通档，普通档也缺时取基础价', () => {
    const partial = { ...sd20, pricing: { ...sd20.pricing!, intervals: sd20.pricing!.intervals!.filter(item => item.tier_label !== '1080p-ref' && item.tier_label !== '4k' && item.tier_label !== '4k-ref') } };
    expect(perSecondVideoPrice(group, partial, '1080p', true)).toBeCloseTo(1.875);
    expect(perSecondVideoPrice(group, partial, '4k', true)).toBeCloseTo(0.5318);
    expect(perSecondVideoPrice(group, partial, '4k')).toBeCloseTo(0.5318);
  });

  it('视频独立倍率覆盖分组倍率；单价文案按秒', () => {
    const rated = { ...group, rate_multiplier: 2, video_rate_independent: true, video_rate_multiplier: 0.8 };
    expect(perSecondVideoPrice(rated, sd20, '720p')).toBeCloseTo(0.6);
    expect(formatModelPrice(group, sd20)).toBe('¥0.5318 起 / 秒，按分辨率与参考视频分档');
    const flat = { ...sd20, pricing: { ...sd20.pricing!, per_request_price: 0.75, intervals: [] } };
    expect(formatModelPrice(group, flat)).toBe('¥0.75 / 秒');
  });
});

describe('计费秒数', () => {
  it('普通：成片秒数', () => {
    expect(billedVideoSeconds({ duration: 5, maxDuration: 15, referenceVideoSeconds: [] })).toBe(5);
  });

  it('自动时长按模型上限', () => {
    expect(billedVideoSeconds({ duration: -1, maxDuration: 30, referenceVideoSeconds: [] })).toBe(30);
  });

  it('有参考视频：加 max(floor(参考总秒数), ceil(成片 × 2/3))', () => {
    expect(billedVideoSeconds({ duration: 10, maxDuration: 15, referenceVideoSeconds: [4.6, 8.9] })).toBe(10 + 13);
    expect(billedVideoSeconds({ duration: 10, maxDuration: 15, referenceVideoSeconds: [3] })).toBe(10 + 7);
    // 读不到时长的参考视频不计入参考总秒数
    expect(billedVideoSeconds({ duration: 9, maxDuration: 15, referenceVideoSeconds: [undefined] })).toBe(9 + 6);
  });

  it('视频编辑：成片与原视频等长，读不到时按模型上限', () => {
    expect(billedVideoSeconds({ duration: null, maxDuration: 15, referenceVideoSeconds: [8.2] })).toBe(8 + 8);
    expect(billedVideoSeconds({ duration: null, maxDuration: 30, referenceVideoSeconds: [undefined] })).toBe(30 + 20);
  });

  it('上限 60 秒', () => {
    expect(billedVideoSeconds({ duration: -1, maxDuration: 30, referenceVideoSeconds: [29, 12] })).toBe(60);
  });
});

describe('estimateVideoCost', () => {
  it('单价 × 计费秒数，文案带秒数与单价', () => {
    const estimate = estimateVideoCost(VIDEO_PLAZA, key, { ...base, duration: 5 });
    expect(estimate).toMatchObject({ unit: 0.75, seconds: 5, count: 1 });
    expect(estimate?.total).toBeCloseTo(3.75);
    expect(estimate?.text).toBe('预计 ¥3.75（5 秒 × ¥0.75）');
  });

  it('自动时长、并发数', () => {
    const estimate = estimateVideoCost(VIDEO_PLAZA, key, { ...base, model: 'seedance-2.5', resolution: '1080p', duration: -1, maxDuration: 30, count: 2 });
    expect(estimate?.total).toBeCloseTo(166.5);
    expect(estimate?.text).toBe('预计 ¥166.50（30 秒 × ¥2.775 × 2）');
  });

  it('有参考视频时整段计费秒数都按 -ref 档；只有图片 / 音频时用普通档', () => {
    const ref = estimateVideoCost(VIDEO_PLAZA, key, { ...base, resolution: '4k', duration: 10, referenceVideoSeconds: [6] });
    expect(ref).toMatchObject({ unit: 4.665, seconds: 10 + 7 });
    expect(ref?.text).toBe('预计 ¥79.305（17 秒 × ¥4.665）');
    expect(estimateVideoCost(VIDEO_PLAZA, key, { ...base, resolution: '4k', duration: 10 })?.text).toBe('预计 ¥37.50（10 秒 × ¥3.75）');
  });

  it('无广场、无 Key、分组没有该模型时不显示', () => {
    expect(estimateVideoCost(null, key, { ...base, duration: 5 })).toBeNull();
    expect(estimateVideoCost(VIDEO_PLAZA, null, { ...base, duration: 5 })).toBeNull();
    expect(estimateVideoCost(VIDEO_PLAZA, makeKey(1, 'openai'), { ...base, duration: 5 })).toBeNull();
  });
});

describe('estimatePluginVideoCost（由表单求输入）', () => {
  const plugin = {
    id: 'v', name: 'v', version: '1', kind: 'video', description: '', author: '', homepage: '', outputs: ['video'],
    credential: { source: 'client', label: 'k', defaultBaseUrl: '' }, media: {}, models: [],
    uiSchema: {
      apiVersion: 1,
      priceQuantityField: 'duration',
      modelSelector: {
        facets: [{ key: 'targetModel', label: '模型' }, { key: 'mode', label: '方式' }],
        facetOptions: {
          targetModel: [{ value: 'seedance-2.0', label: '2.0' }, { value: 'seedance-2.5', label: '2.5' }],
          mode: [{ value: 't2v', label: '文生' }, { value: 'edit', label: '编辑' }],
        },
        variants: ['seedance-2.0', 'seedance-2.5'].flatMap(model => ['t2v', 'edit'].map(mode => ({ model, targetModel: model, mode }))),
      },
      fields: [
        { key: 'resolution', type: 'select', options: [{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }] },
        {
          key: 'duration', type: 'select-grid', showIf: { mode: ['t2v'] },
          options: [{ value: 5, label: '5' }, { value: 15, label: '15' }, { value: 30, label: '30', availableWhen: { targetModel: ['seedance-2.5'] } }],
        },
        { key: 'sourceVideo', type: 'media', kind: 'videos', maxCount: 1, showIf: { mode: ['edit'] } },
      ],
    },
  } as InstalledPlugin;

  it('时长字段可见时按所选时长', () => {
    const estimate = estimatePluginVideoCost(VIDEO_PLAZA, key, plugin, 'seedance-2.0',
      { targetModel: 'seedance-2.0', mode: 't2v' }, { resolution: '720p', duration: 15 }, {});
    expect(estimate?.seconds).toBe(15);
  });

  it('时长字段隐藏（编辑）时按原视频时长；模型上限取当前组合可选的最大时长；隐藏槽里的视频不计入', () => {
    const edit = estimatePluginVideoCost(VIDEO_PLAZA, key, plugin, 'seedance-2.5',
      { targetModel: 'seedance-2.5', mode: 'edit' }, { resolution: '1080p', duration: 5 }, { sourceVideo: [undefined] });
    expect(edit?.seconds).toBe(30 + 20);
    expect(edit?.unit).toBeCloseTo(3.3525); // 原视频是参考视频：1080p-ref
    const t2v = estimatePluginVideoCost(VIDEO_PLAZA, key, plugin, 'seedance-2.0',
      { targetModel: 'seedance-2.0', mode: 't2v' }, { resolution: '720p', duration: 5 }, { sourceVideo: [10] });
    expect(t2v?.seconds).toBe(5);
  });
});

describe('estimatePluginVideoCost × qx-seedance 插件包', () => {
  const dir = path.resolve(process.cwd(), '..', 'backend', 'plugins', 'qx-seedance');
  const seedance = {
    ...JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')),
    uiSchema: JSON.parse(readFileSync(path.join(dir, 'ui.schema.json'), 'utf8')),
  } as InstalledPlugin;

  it('2.0 自动时长按 15 秒、2.5 按 30 秒', () => {
    const sd20 = estimatePluginVideoCost(VIDEO_PLAZA, key, seedance, 'seedance-2.0',
      { targetModel: 'seedance-2.0', mode: 't2v' }, { resolution: '720p', duration: -1 }, {});
    expect(sd20?.text).toBe('预计 ¥11.25（15 秒 × ¥0.75）');
    const sd25 = estimatePluginVideoCost(VIDEO_PLAZA, key, seedance, 'seedance-2.5',
      { targetModel: 'seedance-2.5', mode: 't2v' }, { resolution: '720p', duration: -1 }, {});
    expect(sd25?.seconds).toBe(30);
  });

  it('2.0 4k 带参考视频用 4k-ref；只有参考图时用 4k 普通档', () => {
    const facets = { targetModel: 'seedance-2.0', mode: 'reference' };
    const withVideo = estimatePluginVideoCost(VIDEO_PLAZA, key, seedance, 'seedance-2.0', facets,
      { resolution: '4k', duration: 5 }, { referenceVideos: [3], referenceImages: [undefined] });
    expect(withVideo?.text).toBe('预计 ¥41.985（9 秒 × ¥4.665）');
    const imagesOnly = estimatePluginVideoCost(VIDEO_PLAZA, key, seedance, 'seedance-2.0', facets,
      { resolution: '4k', duration: 5 }, { referenceImages: [undefined] });
    expect(imagesOnly?.text).toBe('预计 ¥18.75（5 秒 × ¥3.75）');
  });
});

describe('渠道原价 × 分组倍率 0.75：单价与总额最多显示 4 位小数', () => {
  const input = { model: 'seedance-2.0', resolution: '480p', maxDuration: 15, duration: 5 };

  it('formatScaled 的 maxFractionDigits 先四舍五入再补零', () => {
    expect(formatScaled(0.531825, 1, 2, '¥', 4)).toBe('¥0.5318');
    expect(formatScaled(0.59564325, 1, 2, '¥', 4)).toBe('¥0.5956');
    expect(formatScaled(0.5, 1, 2, '¥', 4)).toBe('¥0.50');
    expect(formatScaled(0.531825, 1)).toBe('¥0.531825');
  });

  it('2.0 / 480p / 5 秒普通档：总额按精确值算再舍入', () => {
    const estimate = estimateVideoCost(VIDEO_PLAZA_LIST_PRICE, key, { ...input, referenceVideoSeconds: [] });
    expect(estimate?.unit).toBeCloseTo(0.531825, 9);
    expect(estimate?.total).toBeCloseTo(2.659125, 9);
    expect(estimate?.text).toBe('预计 ¥2.6591（5 秒 × ¥0.5318）');
  });

  it('2.0 / 480p / 5 秒带 3 秒参考视频：-ref 档，9 秒', () => {
    const estimate = estimateVideoCost(VIDEO_PLAZA_LIST_PRICE, key, { ...input, referenceVideoSeconds: [3] });
    expect(estimate?.total).toBeCloseTo(0.794191 * 0.75 * 9, 9);
    // 9 × 显示单价 0.5956 = 5.3604；总额用精确值 5.36078925 舍入
    expect(estimate?.text).toBe('预计 ¥5.3608（9 秒 × ¥0.5956）');
  });

  it('设置页视频单价：最低价与无分档时都最多 4 位小数', () => {
    const [sd20, sd25] = VIDEO_PLAZA_LIST_PRICE[0].models;
    expect(formatModelPrice(VIDEO_PLAZA_LIST_PRICE[0], sd20)).toBe('¥0.5318 起 / 秒，按分辨率与参考视频分档');
    expect(formatModelPrice(VIDEO_PLAZA_LIST_PRICE[0], sd25)).toBe('¥0.7446 起 / 秒，按分辨率与参考视频分档');
    const flat = { ...sd20, pricing: { ...sd20.pricing!, intervals: [] } };
    expect(formatModelPrice(VIDEO_PLAZA_LIST_PRICE[0], flat)).toBe('¥0.5318 / 秒');
  });
});
