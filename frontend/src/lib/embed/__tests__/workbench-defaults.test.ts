import { afterEach, describe, expect, it } from 'vitest';
import { defaultWorkbenchKey, defaultStudioPrefs, setWorkbenchTextDefault } from '../workbench-defaults';
import { buildSimpleProxyTextRequestBody } from '../../nova-proxy-text';
import { makeKey } from './fixtures';
import type { WorkbenchDefaults } from '../sub2api-client';
const state: WorkbenchDefaults = { eligible: true, initialized: false, group_id: 102, group_name: 'Codex 稳定分组',
  preferences: {}, text_model: 'gpt-6.1-sol', image_model: 'gpt-image-2.5-sunburst', reasoning_effort: 'medium' };
const key = makeKey(2, 'openai', { name: state.group_name }, { allow_image_generation: true });
afterEach(() => setWorkbenchTextDefault(null));
describe('signup defaults', () => {
  it('requires actual group ID, same name and a usable key', () => {
    expect(defaultWorkbenchKey([makeKey(1, 'openai', { name: state.group_name }), key], state)?.id).toBe(2);
    expect(defaultWorkbenchKey([{ ...key, status: 'inactive' }], state)).toBeUndefined();
    expect(defaultWorkbenchKey([key], { ...state, eligible: false })).toBeUndefined();
  });
  it('uses exact defaults and never falls back to other available models', () => {
    expect(defaultStudioPrefs(key, [state.text_model, state.image_model], state)).toEqual({
      text: { keyId: 2, model: state.text_model }, image: { keyId: 2, model: state.image_model },
    });
    expect(defaultStudioPrefs(key, ['gpt-5.4', 'gpt-image-2'], state)).toEqual({});
    expect(defaultStudioPrefs({ ...key, group: { ...key.group!, allow_image_generation: false } }, [state.image_model], state)).toEqual({});
  });
  it('sends medium in real Responses and Chat Completions request bodies only in default workbench mode', () => {
    setWorkbenchTextDefault(state.text_model);
    expect(buildSimpleProxyTextRequestBody('openai-responses', state.text_model, [], { reasoningEffort: 'low' }))
      .toMatchObject({ reasoning: { effort: 'medium' } });
    expect(buildSimpleProxyTextRequestBody('openai-chat-completions', state.text_model, []))
      .toMatchObject({ reasoning_effort: 'medium' });
    setWorkbenchTextDefault(null);
    expect(buildSimpleProxyTextRequestBody('openai-chat-completions', state.text_model, [])).not.toHaveProperty('reasoning_effort');
  });
});
