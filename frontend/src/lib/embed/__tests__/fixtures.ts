import type { PlazaGroup, Sub2ApiKey } from '@/lib/embed/sub2api-client';

export function makeKey(id: number, platform: string, patch: Partial<Sub2ApiKey> = {}, groupPatch: Record<string, unknown> = {}): Sub2ApiKey {
  return {
    id,
    key: `sk-test-${id}-abcdefghijklmnop`,
    name: `key-${id}`,
    group_id: 100 + id,
    status: 'active',
    quota: 0,
    quota_used: 0,
    expires_at: null,
    group: { id: 100 + id, name: `${platform}-group`, platform, status: 'active', allow_image_generation: false, ...groupPatch },
    ...patch,
  };
}

export const PLAZA: PlazaGroup[] = [
  {
    id: 101,
    name: 'openai-group',
    platform: 'openai',
    rate_multiplier: 0.5,
    image_rate_independent: true,
    image_rate_multiplier: 0.8,
    models: [
      { name: 'gpt-image-2', platform: 'openai', pricing: { billing_mode: 'image', input_price: null, output_price: null, per_request_price: 0.25, intervals: [] } },
      { name: 'gpt-5.4', platform: 'openai', pricing: { billing_mode: 'token', input_price: 0.000002, output_price: 0.000008, per_request_price: null, intervals: [] } },
      { name: 'mystery-render', platform: 'openai', pricing: { billing_mode: 'image', input_price: null, output_price: null, per_request_price: 0.1, intervals: [] } },
    ],
  },
];

/** C6 格式的视频分档：基础价为 480p 普通价，其余每档一个 interval。 */
function videoTiers(tiers: Record<string, number>) {
  return Object.entries(tiers).map(([tier_label, per_request_price]) => ({
    min_tokens: 0, max_tokens: null, tier_label, input_price: null, output_price: null, per_request_price,
  }));
}

/** Seedance 视频分组（id 103）：change-01 的售价表，倍率 1。 */
export const VIDEO_PLAZA: PlazaGroup[] = [
  {
    id: 103,
    name: 'Seedance 视频',
    platform: 'openai',
    rate_multiplier: 1,
    models: [
      {
        name: 'seedance-2.0', platform: 'openai', pricing: {
          billing_mode: 'video', input_price: null, output_price: null, per_request_price: 0.5318,
          intervals: videoTiers({ '720p': 0.75, '1080p': 1.875, '4k': 3.75, '480p-ref': 0.5956, '720p-ref': 0.9075, '1080p-ref': 2.2575, '4k-ref': 4.665 }),
        },
      },
      {
        name: 'seedance-2.5', platform: 'openai', pricing: {
          billing_mode: 'video', input_price: null, output_price: null, per_request_price: 0.7446,
          intervals: videoTiers({ '720p': 1.125, '1080p': 2.775, '480p-ref': 0.8616, '720p-ref': 1.3575, '1080p-ref': 3.3525 }),
        },
      },
    ],
  },
];

/** change-02：渠道填 mmgate 原价，分组倍率 0.75（售价 = 原价 × 0.75，小数很长）。 */
export const VIDEO_PLAZA_LIST_PRICE: PlazaGroup[] = [
  {
    id: 103,
    name: 'Seedance 视频',
    platform: 'openai',
    rate_multiplier: 0.75,
    models: [
      {
        name: 'seedance-2.0', platform: 'openai', pricing: {
          billing_mode: 'video', input_price: null, output_price: null, per_request_price: 0.7091,
          intervals: videoTiers({ '720p': 1, '1080p': 2.5, '4k': 5, '480p-ref': 0.794191, '720p-ref': 1.21, '1080p-ref': 3.01, '4k-ref': 6.22 }),
        },
      },
      {
        name: 'seedance-2.5', platform: 'openai', pricing: {
          billing_mode: 'video', input_price: null, output_price: null, per_request_price: 0.992741,
          intervals: videoTiers({ '720p': 1.5, '1080p': 3.7, '480p-ref': 1.148742, '720p-ref': 1.81, '1080p-ref': 4.47 }),
        },
      },
    ],
  },
];
