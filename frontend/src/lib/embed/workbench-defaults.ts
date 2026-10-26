import type { Sub2ApiKey, WorkbenchDefaults } from './sub2api-client';
import type { StudioPrefs } from './embed-registry';
import { keyUnavailableReason, modelsForPurpose, groupPurposeSupport } from './key-policy';

/** Match both the display name and the actual group, never an arbitrary same-name key. */
export function defaultWorkbenchKey(keys: Sub2ApiKey[], state: WorkbenchDefaults): Sub2ApiKey | undefined {
  if (!state.eligible || !state.group_id) return undefined;
  return keys.filter(k => k.group_id === state.group_id && k.name === state.group_name && !keyUnavailableReason(k))
    .sort((a, b) => a.id - b.id)[0];
}
export function defaultStudioPrefs(key: Sub2ApiKey, models: string[], state: WorkbenchDefaults): StudioPrefs {
  const prefs: StudioPrefs = {};
  if (groupPurposeSupport(key.group, 'image') === '' && modelsForPurpose(models, 'image', null, key).includes(state.image_model)) {
    prefs.image = { keyId: key.id, model: state.image_model };
  }
  if (state.reasoning_allowed !== false && modelsForPurpose(models, 'text', null, key).includes(state.text_model)) {
    prefs.text = { keyId: key.id, model: state.text_model };
  }
  return prefs;
}
// Runtime only, cleared on revoke. Never enable defaults for standalone or existing users.
let textDefault: string | null = null;
export function setWorkbenchTextDefault(model: string | null): void { textDefault = model; }
export function workbenchReasoningEffort(model: string): 'medium' | undefined {
  return model === textDefault ? 'medium' : undefined;
}
