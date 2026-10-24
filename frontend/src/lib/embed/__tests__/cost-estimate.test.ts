import { describe, expect, it } from 'vitest';
import { estimateImageCost, parseEmbedImageModelId } from '@/lib/embed/cost-estimate';
import { perImagePrice } from '@/lib/embed/key-policy';
import type { PlazaGroup } from '@/lib/embed/sub2api-client';
import { makeKey, PLAZA } from './fixtures';

const TIERED: PlazaGroup[] = [{
  id: 102, name: 'img', platform: 'openai', rate_multiplier: 2, models: [{
    name: 'gpt-image-1', platform: 'openai', pricing: {
      billing_mode: 'image', input_price: null, output_price: null, per_request_price: null,
      intervals: [
        { min_tokens: 0, max_tokens: null, tier_label: '1K', input_price: null, output_price: null, per_request_price: 0.1 },
        { min_tokens: 0, max_tokens: null, tier_label: '2K', input_price: null, output_price: null, per_request_price: 0.2 },
      ],
    },
  }],
}];

describe('提交前预估费用', () => {
  it('解析嵌入注册表的生图模型 ID', () => {
    expect(parseEmbedImageModelId('embed-img:69:gpt-image-1')).toEqual({ keyId: 69, model: 'gpt-image-1' });
    expect(parseEmbedImageModelId('embed-img:7:org/model:v2')).toEqual({ keyId: 7, model: 'org/model:v2' });
    expect(parseEmbedImageModelId('gemini-3-pro-image-preview')).toBeNull();
    expect(parseEmbedImageModelId(undefined)).toBeNull();
  });

  it('单价乘生效倍率；分档按尺寸匹配，匹配不到取第一档；token 计费不预估', () => {
    const group = PLAZA[0];
    expect(perImagePrice(group, group.models[0])).toBeCloseTo(0.2); // 0.25 × 图片独立倍率 0.8
    expect(perImagePrice(group, group.models[1])).toBeNull();
    const tiered = TIERED[0];
    expect(perImagePrice(tiered, tiered.models[0], '2k')).toBeCloseTo(0.4);
    expect(perImagePrice(tiered, tiered.models[0], 'auto')).toBeCloseTo(0.2);
  });

  it('按所选 Key 的分组 × 张数，文案不出现倍率', () => {
    const keys = [makeKey(1, 'openai'), makeKey(2, 'openai')];
    const one = estimateImageCost(PLAZA, keys, 'embed-img:1:gpt-image-2', '1K', 1);
    expect(one?.text).toBe('预计 ¥0.20');
    const four = estimateImageCost(TIERED, keys, 'embed-img:2:gpt-image-1', '2K', 4);
    expect(four?.total).toBeCloseTo(1.6);
    expect(four?.text).toBe('预计 ¥0.40 × 4 = ¥1.60');
    expect(four?.text).not.toContain('倍率');
  });

  it('无模型广场、未知 Key / 模型、非嵌入模型时不显示', () => {
    const keys = [makeKey(1, 'openai')];
    expect(estimateImageCost(null, keys, 'embed-img:1:gpt-image-2', '1K', 1)).toBeNull();
    expect(estimateImageCost(PLAZA, keys, 'embed-img:9:gpt-image-2', '1K', 1)).toBeNull();
    expect(estimateImageCost(PLAZA, keys, 'embed-img:1:unknown', '1K', 1)).toBeNull();
    expect(estimateImageCost(PLAZA, keys, 'gpt-image-2', '1K', 1)).toBeNull();
    expect(estimateImageCost(PLAZA, keys, 'embed-img:1:gpt-image-2', '1K', 0)).toBeNull();
  });
});
