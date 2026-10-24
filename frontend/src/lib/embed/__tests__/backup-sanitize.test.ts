import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';

const localForageStores = vi.hoisted(() => new Map<string, Record<string, unknown>>([
  ['canvas_app_state', {}],
  ['canvas_image_files', {}],
  ['canvas_media_files', {}],
]));

vi.mock('localforage', () => ({
  default: {
    createInstance: ({ storeName }: { storeName: string }) => ({
      iterate: async (callback: (value: unknown, key: string) => void) => {
        for (const [key, value] of Object.entries(localForageStores.get(storeName) ?? {})) callback(value, key);
      },
      clear: async () => localForageStores.set(storeName, {}),
      setItem: async () => undefined,
    }),
  },
}));

import { exportAllData } from '@/lib/backup-utils';
import { sanitizeLocalStorageExport, stripSecretsDeep } from '@/lib/embed/backup-sanitize';
import { setEmbedModeForTests } from '@/lib/embed/mode';

function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const SECRET = 'sk-0123456789abcdef0123456789abcdef';

describe('备份剔除 Key', () => {
  afterEach(() => {
    setEmbedModeForTests(null);
    localStorage.clear();
  });

  it('递归清空 apiKey 等字段与 sk- 形式的值，保留 IndexedDB 的 key 字段', () => {
    const cleaned = stripSecretsDeep({
      key: 'job-1:0',
      apiKey: SECRET,
      nested: [{ api_key: 'x', baseUrl: 'https://a' }, { authorization: 'Bearer t' }],
      raw: SECRET,
      json: JSON.stringify({ plugin: { apiKey: SECRET, baseUrl: 'b' } }),
    }) as Record<string, unknown>;
    expect(cleaned.key).toBe('job-1:0');
    expect(cleaned.apiKey).toBe('');
    expect(cleaned.raw).toBe('');
    expect(JSON.stringify(cleaned)).not.toContain(SECRET);
    expect(JSON.parse(cleaned.json as string)).toEqual({ plugin: { apiKey: '', baseUrl: 'b' } });
    expect((cleaned.nested as Array<Record<string, unknown>>)[0]).toEqual({ api_key: '', baseUrl: 'https://a' });
  });

  it('未变化的 JSON 字符串原样保留（不重新格式化用户内容）', () => {
    const text = '{ "a": 1,  "b": [1, 2] }';
    expect(stripSecretsDeep(text)).toBe(text);
  });

  it('localStorage 导出丢弃 nova-model-registry', () => {
    const out = sanitizeLocalStorageExport({
      'nova-model-registry': JSON.stringify({ imageModels: [{ apiKey: SECRET }] }),
      'nova-t2i-settings': '{"model":"gpt-image-2"}',
    });
    expect(out).toEqual({ 'nova-t2i-settings': '{"model":"gpt-image-2"}' });
  });

  it('嵌入模式 exportAllData 的 ZIP 里不含任何 Key', async () => {
    setEmbedModeForTests(true);
    localStorage.setItem('nova-model-registry', JSON.stringify({ imageModels: [{ id: 'm', apiKey: SECRET }], textModels: [], defaults: {} }));
    localStorage.setItem('nova-image:canvas_config', JSON.stringify({ state: { config: { apiKey: SECRET, model: 'gpt-image-2' } } }));
    localStorage.setItem('nova-t2i-settings', '{"model":"gpt-image-2"}');
    localForageStores.set('canvas_app_state', { 'canvas-store': JSON.stringify({ state: { credential: { apiKey: SECRET } } }) });

    const blob = await exportAllData(undefined, { includeImages: false });
    const files = unzipSync(await readBlob(blob));
    const all = Object.values(files).map((bytes) => strFromU8(bytes)).join('\n');
    expect(all).not.toContain(SECRET);
    const ls = JSON.parse(strFromU8(files['localStorage.json'])) as Record<string, string>;
    expect(ls['nova-model-registry']).toBeUndefined();
    expect(ls['nova-t2i-settings']).toBe('{"model":"gpt-image-2"}');
    expect(JSON.parse(ls['nova-image:canvas_config']).state.config).toEqual({ apiKey: '', model: 'gpt-image-2' });
  });

  it('独立模式导出保持原样（BYOK 用户自己的备份）', async () => {
    setEmbedModeForTests(false);
    localStorage.setItem('nova-model-registry', JSON.stringify({ imageModels: [{ id: 'm', apiKey: SECRET }], textModels: [], defaults: {} }));
    localForageStores.set('canvas_app_state', {});
    const blob = await exportAllData(undefined, { includeImages: false });
    const files = unzipSync(await readBlob(blob));
    expect(strFromU8(files['localStorage.json'])).toContain(SECRET);
  });
});
