import { beforeEach, expect, it, vi } from 'vitest';
import { makeKey } from './fixtures';
const mock = vi.hoisted(() => ({
 getCurrentUser: vi.fn(), listKeys: vi.fn(), getWorkbenchDefaults: vi.fn(), saveWorkbenchPrefs: vi.fn(), listGatewayModels: vi.fn(),
 local: {} as Record<string, unknown>,
}));
vi.mock('../sub2api-client', () => mock);
vi.mock('../embed-registry', () => ({ loadStudioPrefs: () => mock.local, saveStudioPrefs: vi.fn(p => { mock.local = p; }), buildEmbedRegistry: () => ({}) }));
vi.mock('../registry-store', () => ({ clearEmbedRegistry: vi.fn(), setEmbedRegistry: vi.fn() }));
vi.mock('../cost-estimate', () => ({ clearPlazaCache: vi.fn(), loadPlazaGroups: vi.fn().mockResolvedValue(null) }));
vi.mock('../balance', () => ({ setBalanceFromUser: vi.fn() }));
vi.mock('@/lib/gemini-config', () => ({ syncDynamicModelExports: vi.fn() }));
import { bootstrapStudio, applyStudioPrefs, getStudioPrefs, resetStudioState } from '../studio-state';
const defaults = { eligible: true, initialized: false, preferences: {}, group_id: 102, group_name: 'Codex 稳定分组',
 text_model: 'gpt-6.1-sol', image_model: 'gpt-image-2.5-sunburst', reasoning_effort: 'medium', reasoning_allowed: true };
beforeEach(() => {
 vi.clearAllMocks(); resetStudioState(); mock.local = {};
 mock.getCurrentUser.mockResolvedValue({ id: 8, balance: 0 });
 mock.listKeys.mockResolvedValue([makeKey(2, 'openai', { name: defaults.group_name }, { allow_image_generation: true })]);
 mock.getWorkbenchDefaults.mockResolvedValue({ ...defaults });
 mock.listGatewayModels.mockResolvedValue([defaults.text_model, defaults.image_model]);
 mock.saveWorkbenchPrefs.mockImplementation(async p => p);
});
it('initializes once, then persists a deliberate clear across a fresh session', async () => {
 await bootstrapStudio(8);
 expect(getStudioPrefs().text?.model).toBe(defaults.text_model);
 expect(mock.saveWorkbenchPrefs).toHaveBeenCalledWith(expect.any(Object), true);
 await applyStudioPrefs({});
 expect(mock.saveWorkbenchPrefs).toHaveBeenLastCalledWith({});
 resetStudioState(); mock.getWorkbenchDefaults.mockResolvedValue({ ...defaults, initialized: true, preferences: {} });
 await bootstrapStudio(8);
 expect(getStudioPrefs()).toEqual({});
 expect(mock.saveWorkbenchPrefs).toHaveBeenCalledTimes(2);
});
it('does not initialize an existing user', async () => {
 mock.getWorkbenchDefaults.mockResolvedValue({ ...defaults, eligible: false });
 await bootstrapStudio(8); expect(mock.saveWorkbenchPrefs).not.toHaveBeenCalled();
});
it('does not write old-user preferences after revoke during model discovery', async () => {
 let finish!: (models: string[]) => void;
 mock.listGatewayModels.mockImplementation(() => new Promise<string[]>(resolve => { finish = resolve; }));
 const run = bootstrapStudio(8);
 await vi.waitFor(() => expect(finish).toBeDefined());
 resetStudioState(); finish([defaults.text_model, defaults.image_model]); await run;
 expect(mock.saveWorkbenchPrefs).not.toHaveBeenCalled(); expect(getStudioPrefs()).toEqual({});
});
it('preserves a server-side manual choice racing with first initialization', async () => {
 const manual = { text: { keyId: 19, model: 'chosen-model' } };
 mock.saveWorkbenchPrefs.mockResolvedValue(manual);
 await bootstrapStudio(8); expect(getStudioPrefs()).toEqual(manual);
});
