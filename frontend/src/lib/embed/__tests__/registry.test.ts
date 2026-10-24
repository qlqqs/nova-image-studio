import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setEmbedModeForTests } from '@/lib/embed/mode';
import { buildEmbedRegistry, parseStudioPrefs, saveStudioPrefs, loadStudioPrefs, STUDIO_PREFS_KEY } from '@/lib/embed/embed-registry';
import { clearEmbedRegistry, getEmbedRegistry, setEmbedRegistry } from '@/lib/embed/registry-store';
import { setStoragePartition } from '@/lib/embed/storage-partition';
import { getCompleteImageModels, getCompleteTextModels, loadRegistry, saveRegistry } from '@/lib/nova-models';
import { hasAnyApiKey } from '@/lib/settings-storage';
import { resolveImageTaskProvider, resolveTextTaskProvider } from '@/lib/ccode-task-client';
import { makeKey } from './fixtures';

const BASE = 'https://console.example.com';

describe('内存注册表生成', () => {
  it('由 { keyId, model } + Key 明文生成生图与对话模型，协议按平台推导', () => {
    const keys = [makeKey(1, 'openai', {}, { allow_image_generation: true }), makeKey(2, 'anthropic')];
    const registry = buildEmbedRegistry({ image: { keyId: 1, model: 'gpt-image-2' }, text: { keyId: 2, model: 'claude-sonnet-4' } }, keys, { baseUrl: BASE });
    expect(registry.imageModels).toHaveLength(1);
    expect(registry.imageModels[0]).toMatchObject({
      protocol: 'openai',
      modelId: 'gpt-image-2',
      apiKey: keys[0].key,
      baseUrl: BASE,
      builtinPreset: 'gpt-image-2',
      supportsAdvancedParams: true,
    });
    expect(registry.textModels[0]).toMatchObject({ protocol: 'anthropic-messages', modelId: 'claude-sonnet-4', apiKey: keys[1].key, baseUrl: BASE });
    const imageId = registry.imageModels[0].id;
    const textId = registry.textModels[0].id;
    expect(registry.defaults).toEqual({
      textToImage: imageId,
      imageToImage: imageId,
      reversePrompt: textId,
      agent: textId,
      promptOptimize: textId,
      imageDescribe: textId,
      sliceDecomposition: textId,
      sliceReconstruct: textId,
      sliceImageEdit: imageId,
    });
  });

  it('gemini 生图走 google 协议，grok 模型名规范化；切图编辑只给 openai 协议', () => {
    const gemini = buildEmbedRegistry({ image: { keyId: 4, model: 'gemini-3-pro-image-preview' } }, [makeKey(4, 'gemini')], { baseUrl: BASE });
    expect(gemini.imageModels[0]).toMatchObject({ protocol: 'google', builtinPreset: 'gemini-3-pro-image-preview', supportsAdvancedParams: false });
    expect(gemini.defaults.sliceImageEdit).toBe('');
    const grok = buildEmbedRegistry({ image: { keyId: 6, model: 'Grok Imagine' } }, [makeKey(6, 'grok', {}, { allow_image_generation: true })], { baseUrl: BASE });
    expect(grok.imageModels[0]).toMatchObject({ protocol: 'grok', modelId: 'grok-imagine-image-quality' });
  });

  it('所选 Key 已删除或不可用时该行视为未选择', () => {
    const keys = [makeKey(1, 'openai', { status: 'inactive' }, { allow_image_generation: true })];
    const registry = buildEmbedRegistry({ image: { keyId: 1, model: 'gpt-image-2' }, text: { keyId: 9, model: 'x' } }, keys, {
      baseUrl: BASE,
      isUsable: (key) => key.status === 'active',
    });
    expect(registry.imageModels).toEqual([]);
    expect(registry.textModels).toEqual([]);
    expect(registry.defaults.textToImage).toBe('');
  });

  it('选择只解析 { keyId, model }', () => {
    expect(parseStudioPrefs('{"image":{"keyId":3,"model":"gpt-image-2","apiKey":"sk-x"},"text":{"keyId":"bad"}}')).toEqual({ image: { keyId: 3, model: 'gpt-image-2' } });
    expect(parseStudioPrefs('not json')).toEqual({});
  });
});

describe('嵌入模式下 nova-models 改用内存注册表', () => {
  beforeEach(() => {
    localStorage.clear();
    setEmbedModeForTests(true);
    setStoragePartition(7);
  });

  afterEach(() => {
    clearEmbedRegistry();
    setEmbedModeForTests(null);
    setStoragePartition(null);
    localStorage.clear();
  });

  it('loadRegistry 读内存、saveRegistry 不写 localStorage，Nova 的取用逻辑照常工作', () => {
    localStorage.setItem('nova-model-registry', JSON.stringify({ imageModels: [{ id: 'byok', apiKey: 'sk-byok' }], textModels: [], defaults: {} }));
    expect(loadRegistry().imageModels).toEqual([]);
    expect(hasAnyApiKey()).toBe(false);

    const keys = [makeKey(1, 'openai', {}, { allow_image_generation: true })];
    setEmbedRegistry(buildEmbedRegistry({ image: { keyId: 1, model: 'gpt-image-2' }, text: { keyId: 1, model: 'gpt-5.4' } }, keys, { baseUrl: BASE }));
    const registry = loadRegistry();
    expect(getCompleteImageModels(registry)).toHaveLength(1);
    expect(getCompleteTextModels(registry)).toHaveLength(1);
    expect(hasAnyApiKey()).toBe(true);

    const image = resolveImageTaskProvider(registry.imageModels[0].id);
    expect(image).toMatchObject({ apiKey: keys[0].key, protocol: 'openai', modelId: 'gpt-image-2' });
    expect(image.baseUrl.startsWith(BASE)).toBe(true);
    expect(resolveTextTaskProvider(registry.textModels[0].id)).toMatchObject({ apiKey: keys[0].key, protocol: 'openai-responses' });

    saveRegistry({ ...registry, imageModels: [...registry.imageModels, { ...registry.imageModels[0], id: 'injected', apiKey: 'sk-evil' }] });
    expect(getEmbedRegistry().imageModels.map((model) => model.id)).toEqual([registry.imageModels[0].id]);
    expect(localStorage.getItem('nova-model-registry')).toContain('sk-byok');
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)!;
      expect(localStorage.getItem(name)).not.toContain(keys[0].key);
    }
  });

  it('选择按用户分区保存，且不含 Key 明文', () => {
    saveStudioPrefs({ image: { keyId: 1, model: 'gpt-image-2' } });
    expect(localStorage.getItem(`u7:${STUDIO_PREFS_KEY}`)).toBe('{"image":{"keyId":1,"model":"gpt-image-2"}}');
    setStoragePartition(8);
    expect(loadStudioPrefs()).toEqual({});
    setStoragePartition(7);
    expect(loadStudioPrefs()).toEqual({ image: { keyId: 1, model: 'gpt-image-2' } });
  });
});
