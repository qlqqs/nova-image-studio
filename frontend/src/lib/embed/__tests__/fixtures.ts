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
