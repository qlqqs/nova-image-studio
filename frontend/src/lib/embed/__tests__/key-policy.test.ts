import { describe, expect, it } from 'vitest';
import {
  classifyModel,
  classifyModelByName,
  deriveImageProtocol,
  deriveTextProtocol,
  filterGroupsForPurpose,
  filterKeysForPurpose,
  findPlazaModel,
  formatBalance,
  formatModelPrice,
  isHiddenModel,
  keyUnavailableReason,
  modelsForPurpose,
  pickDefaultModel,
  studioKeyName,
} from '@/lib/embed/key-policy';
import { makeKey, PLAZA } from './fixtures';

const NOW = Date.parse('2026-10-24T00:00:00Z');

describe('Key 可用性', () => {
  it('禁用 / 过期 / 额度用完 / 未绑定分组给出原因', () => {
    expect(keyUnavailableReason(makeKey(1, 'openai'), NOW)).toBe('');
    expect(keyUnavailableReason(makeKey(1, 'openai', { status: 'inactive' }), NOW)).toBe('已禁用');
    expect(keyUnavailableReason(makeKey(1, 'openai', { status: 'expired' }), NOW)).toBe('已过期');
    expect(keyUnavailableReason(makeKey(1, 'openai', { status: 'quota_exhausted' }), NOW)).toBe('额度已用完');
    expect(keyUnavailableReason(makeKey(1, 'openai', { expires_at: '2026-10-01T00:00:00Z' }), NOW)).toBe('已过期');
    expect(keyUnavailableReason(makeKey(1, 'openai', { quota: 5, quota_used: 5 }), NOW)).toBe('额度已用完');
    expect(keyUnavailableReason(makeKey(1, 'openai', { quota: 5, quota_used: 1 }), NOW)).toBe('');
    expect(keyUnavailableReason(makeKey(1, 'openai', { group_id: null, group: null }), NOW)).toBe('未绑定分组');
  });
});

describe('Key 按用途过滤', () => {
  const keys = [
    makeKey(1, 'openai', {}, { allow_image_generation: true }),
    makeKey(2, 'openai'),
    makeKey(3, 'anthropic'),
    makeKey(4, 'gemini'),
    makeKey(5, 'antigravity'),
    makeKey(6, 'grok', {}, { allow_image_generation: true }),
    makeKey(7, 'grok', { status: 'inactive' }, { allow_image_generation: true }),
    makeKey(8, 'deepseek'),
  ];

  it('生图：openai / grok 需开启生图，gemini / antigravity 走 generateContent，其他平台不列出', () => {
    const options = filterKeysForPurpose(keys, 'image', NOW);
    const byId = new Map(options.map((option) => [option.key.id, option.disabledReason]));
    expect(byId.get(1)).toBe('');
    expect(byId.get(2)).toBe('分组未开启生图');
    expect(byId.has(3)).toBe(false);
    expect(byId.get(4)).toBe('');
    expect(byId.get(5)).toBe('');
    expect(byId.get(6)).toBe('');
    expect(byId.get(7)).toBe('已禁用');
    expect(byId.has(8)).toBe(false);
    // 可用的排在前面
    expect(options.findIndex((option) => option.disabledReason)).toBeGreaterThan(options.filter((option) => !option.disabledReason).length - 1);
  });

  it('对话：不限平台，只置灰不可用的', () => {
    const options = filterKeysForPurpose(keys, 'text', NOW);
    expect(options).toHaveLength(keys.length);
    expect(options.find((option) => option.key.id === 7)?.disabledReason).toBe('已禁用');
    expect(options.filter((option) => !option.disabledReason)).toHaveLength(7);
  });

  it('视频一期不列出任何 Key', () => {
    expect(filterKeysForPurpose(keys, 'video', NOW)).toEqual([]);
  });

  it('一键创建的分组同样按用途过滤', () => {
    const groups = keys.map((key) => key.group!).filter(Boolean);
    expect(filterGroupsForPurpose(groups, 'image').map((group) => group.platform).sort()).toEqual(['antigravity', 'gemini', 'grok', 'grok', 'openai']);
    expect(filterGroupsForPurpose([{ id: 1, name: 'x', platform: 'openai', status: 'inactive', allow_image_generation: true }], 'image')).toEqual([]);
  });

  it('一键创建：生图与对话都支持的分组排前面，只建一把通用的「创作工作台」', () => {
    const textOnly = { id: 1, name: 'claude', platform: 'anthropic', status: 'active' };
    const both = { id: 2, name: 'codex', platform: 'openai', status: 'active', allow_image_generation: true };
    expect(filterGroupsForPurpose([textOnly, both], 'text').map((group) => group.id)).toEqual([2, 1]);
    expect(studioKeyName(both, '生图')).toBe('创作工作台');
    expect(studioKeyName(textOnly, '对话')).toBe('创作工作台-对话');
    expect(studioKeyName({ ...both, allow_image_generation: false }, '对话')).toBe('创作工作台-对话');
  });
});

describe('模型用途分类', () => {
  it('按名称', () => {
    for (const name of ['gpt-image-2', 'gpt-image-1.5', 'dall-e-3', 'gemini-3-pro-image-preview', 'gemini-2.5-flash-image', 'grok-imagine-image', 'grok-imagine-image-quality', 'doubao-seedream-5.0-lite', 'imagen-4']) {
      expect(classifyModelByName(name)).toBe('image');
    }
    for (const name of ['gpt-5.4', 'claude-sonnet-4-20250514', 'gemini-2.5-flash', 'grok-4', 'deepseek-chat']) {
      expect(classifyModelByName(name)).toBe('text');
    }
    for (const name of ['veo-3', 'sora-2', 'grok-imagine-video']) {
      expect(classifyModelByName(name)).toBe('video');
    }
    for (const name of ['text-embedding-3-large', 'whisper-1', 'gpt-4o-mini-tts', 'omni-moderation-latest']) {
      expect(classifyModelByName(name)).toBe('other');
    }
  });

  it('模型广场计费模式优先；token 计费但名称是生图模型仍归生图', () => {
    expect(classifyModel('mystery-render', 'image')).toBe('image');
    expect(classifyModel('gemini-2.5-flash-image', 'token')).toBe('image');
    expect(classifyModel('some-model', 'video')).toBe('video');
    expect(classifyModel('gpt-5.4', 'token')).toBe('text');
  });

  it('modelsForPurpose = 网关模型 ∩ 用途', () => {
    const key = makeKey(1, 'openai', {}, { allow_image_generation: true });
    const gateway = ['gpt-5.4', 'gpt-image-2', 'mystery-render', 'text-embedding-3-small'];
    expect(modelsForPurpose(gateway, 'image', PLAZA, key)).toEqual(['gpt-image-2', 'mystery-render']);
    expect(modelsForPurpose(gateway, 'text', PLAZA, key)).toEqual(['gpt-5.4']);
    // 广场不可用时按名称：未知名称的 mystery-render 归为对话
    expect(modelsForPurpose(gateway, 'image', null, key)).toEqual(['gpt-image-2']);
  });

  it('对话隐藏 codex-auto-review，默认 gpt-6.1-sol；生图默认 gpt-image-2.5-sunburst', () => {
    const key = makeKey(1, 'openai', {}, { allow_image_generation: true });
    const gateway = ['codex-auto-review', 'gpt-5.4', 'gpt-6.1-sol', 'gpt-image-2'];
    const text = modelsForPurpose(gateway, 'text', null, key);
    expect(text).toEqual(['gpt-5.4', 'gpt-6.1-sol']);
    expect(isHiddenModel('codex-auto-review', 'text')).toBe(true);
    expect(isHiddenModel('codex-auto-review', 'image')).toBe(false);
    expect(pickDefaultModel(text, 'text')).toBe('gpt-6.1-sol');
    expect(pickDefaultModel(['gpt-5.4'], 'text')).toBe('gpt-5.4');
    expect(pickDefaultModel(['gpt-image-2'], 'image')).toBe('gpt-image-2');
    expect(pickDefaultModel(['gpt-image-1', 'gpt-image-2', 'gpt-image-2.5-sunburst'], 'image')).toBe('gpt-image-2.5-sunburst');
    expect(pickDefaultModel([], 'text')).toBeUndefined();
  });
});

describe('协议推导', () => {
  it('生图', () => {
    expect(deriveImageProtocol('openai', 'gpt-image-2')).toBe('openai');
    expect(deriveImageProtocol('grok', 'grok-imagine-image')).toBe('grok');
    expect(deriveImageProtocol('gemini', 'gemini-3-pro-image-preview')).toBe('google');
    expect(deriveImageProtocol('antigravity', 'gemini-3-pro-image-preview')).toBe('google');
    expect(deriveImageProtocol('anthropic', 'claude')).toBeNull();
  });

  it('对话', () => {
    expect(deriveTextProtocol('openai', 'gpt-5.4')).toBe('openai-responses');
    expect(deriveTextProtocol('anthropic', 'claude-sonnet-4')).toBe('anthropic-messages');
    expect(deriveTextProtocol('gemini', 'gemini-2.5-flash')).toBe('google-gemini');
    expect(deriveTextProtocol('antigravity', 'claude-sonnet-4-5')).toBe('anthropic-messages');
    expect(deriveTextProtocol('antigravity', 'gemini-3-pro')).toBe('google-gemini');
    expect(deriveTextProtocol('grok', 'grok-4')).toBe('openai-chat-completions');
    expect(deriveTextProtocol('deepseek', 'deepseek-chat')).toBe('openai-chat-completions');
  });
});

describe('单价与余额格式（与模型广场一致，不出现「倍率」）', () => {
  it('图片按张，图片独立倍率覆盖分组倍率', () => {
    const found = findPlazaModel(PLAZA, 101, 'gpt-image-2')!;
    expect(formatModelPrice(found.group, found.model)).toBe('¥0.20 / 张');
  });

  it('token 按 1M tokens，乘分组倍率', () => {
    const found = findPlazaModel(PLAZA, 101, 'gpt-5.4')!;
    const text = formatModelPrice(found.group, found.model);
    expect(text).toBe('输入 ¥1.00 · 输出 ¥4.00 / 1M tokens');
    expect(text).not.toContain('倍率');
  });

  it('余额', () => {
    expect(formatBalance(12.345)).toBe('¥12.35');
    expect(formatBalance(-1.234)).toBe('-¥1.23');
    expect(formatBalance(null)).toBe('¥0.00');
  });
});
