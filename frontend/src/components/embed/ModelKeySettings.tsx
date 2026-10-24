'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Loader2, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, type SelectOption } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  filterGroupsForPurpose,
  filterKeysForPurpose,
  findPlazaModel,
  formatModelPrice,
  groupPurposeSupport,
  isHiddenModel,
  keyUnavailableReason,
  modelsForPurpose,
  pickDefaultModel,
  studioKeyName,
  supportsImageAndText,
  type StudioPurpose,
} from '@/lib/embed/key-policy';
import {
  createKey,
  getModelPlaza,
  listAvailableGroups,
  listGatewayModels,
  type PlazaGroup,
  type Sub2ApiGroup,
  type Sub2ApiKey,
} from '@/lib/embed/sub2api-client';
import { applyStudioPrefs, getStudioKeys, getStudioPrefs, refreshStudioKeys } from '@/lib/embed/studio-state';
import type { StudioPrefs } from '@/lib/embed/embed-registry';
import { localizeGatewayErrorText } from '@/lib/embed/gateway-errors';
import { postToParent } from '@/lib/embed/session';
import { useStudioKeys, useStudioPrefs } from '@/components/embed/hooks';

type RowPurpose = Extract<StudioPurpose, 'image' | 'text'>;

interface ModelListState {
  status: 'loading' | 'ok' | 'error';
  models: string[];
  error?: string;
}

const ROW_LABEL: Record<RowPurpose, string> = { image: '生图', text: '对话' };
const ROW_HINT: Record<RowPurpose, string> = {
  image: '文生图、图生图、画布、动图、UI 设计模式的图片编辑',
  text: 'Agent、反推提示词、提示词优化、AI 拆图与网页复刻',
};
const NONE = '__none__';
// 触发器里的文字靠左、单行，过长截断（Select 默认继承按钮的居中并换行）
const TRIGGER_CLASS = 'min-w-0 text-left [&>:first-child]:min-w-0 [&>:first-child]:flex-1 [&>:first-child]:truncate';

/** 下拉里只显示 Key 名称；重名时追加编号区分，置灰的附上原因。 */
function keyLabel(key: Sub2ApiKey, reason: string, duplicated: boolean): string {
  const name = key.name || `密钥 #${key.id}`;
  return `${name}${duplicated && key.name ? ` #${key.id}` : ''}${reason ? `（${reason}）` : ''}`;
}

/**
 * 设置 →「模型与密钥」（PRD R5）：生图 / 对话 / 视频三行，每行「选 Key → 选模型」。
 * Key 来自 /api/v1/keys（按分组平台与生图开关过滤、置灰不可用的），模型来自网关 /v1/models，
 * 与模型广场的计费模式交叉得到用途与单价；协议按分组平台自动推导。只保存 { keyId, model }。
 */
export function ModelKeySettings() {
  const keys = useStudioKeys();
  const prefs = useStudioPrefs();
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plaza, setPlaza] = useState<PlazaGroup[] | null>(null);
  const [modelLists, setModelLists] = useState<Record<number, ModelListState>>({});
  const modelRequests = useRef(new Map<number, Promise<string[]>>());
  const [groups, setGroups] = useState<Sub2ApiGroup[] | null>(null);
  const [busyRow, setBusyRow] = useState<RowPurpose | null>(null);

  const reloadKeys = useCallback(async () => {
    setLoadingKeys(true);
    setError(null);
    try {
      await refreshStudioKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取密钥失败');
    } finally {
      setLoadingKeys(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 每次打开都从 sub2api 重新读取 Key（明文只在内存中）
    refreshStudioKeys().then(
      () => { if (!cancelled) setLoadingKeys(false); },
      (err: unknown) => {
        if (cancelled) return;
        setLoadingKeys(false);
        setError(err instanceof Error ? err.message : '读取密钥失败');
      },
    );
    getModelPlaza().then((data) => { if (!cancelled) setPlaza(data?.groups ?? null); }, () => undefined);
    listAvailableGroups().then((data) => { if (!cancelled) setGroups(data); }, () => { if (!cancelled) setGroups([]); });
    return () => { cancelled = true; };
  }, []);

  /** 读取（并缓存）某把 Key 在网关上可用的模型。 */
  const loadModels = useCallback((key: Sub2ApiKey): Promise<string[]> => {
    const existing = modelRequests.current.get(key.id);
    if (existing) return existing;
    setModelLists((prev) => ({ ...prev, [key.id]: { status: 'loading', models: prev[key.id]?.models || [] } }));
    const request = listGatewayModels(key.key).then(
      (models) => {
        setModelLists((prev) => ({ ...prev, [key.id]: { status: 'ok', models } }));
        return models;
      },
      (err: unknown) => {
        modelRequests.current.delete(key.id);
        const message = localizeGatewayErrorText(err instanceof Error ? err.message : '读取模型失败');
        setModelLists((prev) => ({ ...prev, [key.id]: { status: 'error', models: [], error: message } }));
        throw err;
      },
    );
    modelRequests.current.set(key.id, request);
    return request;
  }, []);

  // 已选中的 Key 自动加载模型列表；之前保存的模型已被隐藏时换成默认模型
  useEffect(() => {
    for (const purpose of ['image', 'text'] as const) {
      const row = prefs[purpose];
      const key = row ? keys.find((item) => item.id === row.keyId) : undefined;
      if (!row || !key || keyUnavailableReason(key)) continue;
      void loadModels(key).then((models) => {
        const current = getStudioPrefs()[purpose];
        if (!current || current.keyId !== key.id || !isHiddenModel(current.model, purpose)) return;
        const model = pickDefaultModel(modelsForPurpose(models, purpose, plaza, key), purpose);
        const next: StudioPrefs = { ...getStudioPrefs() };
        if (model) next[purpose] = { keyId: key.id, model };
        else delete next[purpose];
        return applyStudioPrefs(next);
      }).catch(() => undefined);
    }
  }, [keys, prefs, plaza, loadModels]);

  const selectKey = useCallback(async (purpose: RowPurpose, keyId: number | null) => {
    setError(null);
    const current = getStudioPrefs();
    if (keyId === null) {
      const next: StudioPrefs = { ...current };
      delete next[purpose];
      await applyStudioPrefs(next);
      return;
    }
    const key = getStudioKeys().find((item) => item.id === keyId);
    if (!key) return;
    setBusyRow(purpose);
    try {
      const models = await loadModels(key);
      const candidates = modelsForPurpose(models, purpose, plaza, key);
      if (candidates.length === 0) {
        setError(`「${key.name}」在网关上没有可用于${ROW_LABEL[purpose]}的模型，请换一个密钥`);
        return;
      }
      const keep = current[purpose]?.model;
      const model = keep && candidates.includes(keep) ? keep : pickDefaultModel(candidates, purpose) as string;
      const next: StudioPrefs = { ...current, [purpose]: { keyId: key.id, model } };
      // 另一行还没选、且这把 Key 也适用时一并选上（同一把 Key 可用于多行）
      const other: RowPurpose = purpose === 'image' ? 'text' : 'image';
      if (!next[other] && groupPurposeSupport(key.group, other) === '') {
        const otherCandidates = modelsForPurpose(models, other, plaza, key);
        if (otherCandidates.length > 0) next[other] = { keyId: key.id, model: pickDefaultModel(otherCandidates, other) as string };
      }
      await applyStudioPrefs(next);
    } catch (err) {
      setError(localizeGatewayErrorText(err instanceof Error ? err.message : '读取模型失败'));
    } finally {
      setBusyRow(null);
    }
  }, [loadModels, plaza]);

  const selectModel = useCallback(async (purpose: RowPurpose, model: string) => {
    const current = getStudioPrefs();
    const row = current[purpose];
    if (!row) return;
    await applyStudioPrefs({ ...current, [purpose]: { keyId: row.keyId, model } });
  }, []);

  const creating = useRef(false);
  /** 一键创建：同分组已有同名可用 Key 时直接复用；生图与对话都支持的分组只建一把，两行一起选上。 */
  const createAndSelect = useCallback(async (purpose: RowPurpose, groupId: number) => {
    if (creating.current) return;
    creating.current = true;
    setBusyRow(purpose);
    setError(null);
    try {
      const group = groups?.find((item) => item.id === groupId);
      const name = studioKeyName(group, ROW_LABEL[purpose]);
      const reusable = getStudioKeys().find((key) => key.name === name && key.group_id === groupId && !keyUnavailableReason(key));
      const keyId = reusable ? reusable.id : (await createKey({ name, groupId })).id;
      if (!reusable) await refreshStudioKeys();
      setBusyRow(null);
      await selectKey(purpose, keyId);
    } catch (err) {
      setError(err instanceof Error ? `创建密钥失败：${err.message}` : '创建密钥失败');
    } finally {
      creating.current = false;
      setBusyRow(null);
    }
  }, [groups, selectKey]);

  // 两行都没有可用 Key 时只在上方给一个创建入口，避免两行各建一把
  const noUsableKey = !loadingKeys
    && filterKeysForPurpose(keys, 'image').every((option) => option.disabledReason)
    && filterKeysForPurpose(keys, 'text').every((option) => option.disabledReason);
  const sharedGroupChoices = filterGroupsForPurpose(groups || [], 'text');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">模型与密钥</p>
          <p className="text-xs text-muted-foreground">
            使用你在本站的 API 密钥。请求协议按密钥所属分组自动选择，费用按所选密钥在网关计费，从账户余额扣除。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => postToParent({ type: 'nova:navigate', path: '/keys' })}>
            <KeyRound className="h-3.5 w-3.5" />
            管理密钥
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void reloadKeys()} disabled={loadingKeys}>
            <RefreshCw className={cn('h-3.5 w-3.5', loadingKeys && 'animate-spin')} />
            刷新
          </Button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      {noUsableKey && (
        <CreateKeyBar
          message="还没有可用的密钥，一键创建一把「创作工作台」密钥，生图与对话共用。"
          groups={groups}
          choices={sharedGroupChoices}
          busy={busyRow !== null}
          onCreate={(groupId) => {
            const group = groups?.find((item) => item.id === groupId);
            void createAndSelect(groupPurposeSupport(group, 'image') === '' ? 'image' : 'text', groupId);
          }}
        />
      )}

      <div className="divide-y divide-border rounded-lg border border-border">
        {(['image', 'text'] as const).map((purpose) => (
          <PurposeRow
            key={purpose}
            purpose={purpose}
            keys={keys}
            prefs={prefs}
            plaza={plaza}
            groups={groups}
            modelLists={modelLists}
            busy={busyRow === purpose}
            loadingKeys={loadingKeys}
            hideCreate={noUsableKey}
            onSelectKey={selectKey}
            onSelectModel={selectModel}
            onCreate={createAndSelect}
          />
        ))}
        <div className="grid gap-2 p-4 sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
          <div>
            <p className="text-sm font-medium">视频</p>
          </div>
          <Select value={NONE} onValueChange={() => undefined} options={[{ value: NONE, label: '即将上线' }]} disabled ariaLabel="视频密钥" className={TRIGGER_CLASS} />
          <Select value={NONE} onValueChange={() => undefined} options={[{ value: NONE, label: '即将上线' }]} disabled ariaLabel="视频模型" className={TRIGGER_CLASS} />
        </div>
      </div>
    </div>
  );
}

interface PurposeRowProps {
  purpose: RowPurpose;
  keys: Sub2ApiKey[];
  prefs: StudioPrefs;
  plaza: PlazaGroup[] | null;
  groups: Sub2ApiGroup[] | null;
  modelLists: Record<number, ModelListState>;
  busy: boolean;
  loadingKeys: boolean;
  onSelectKey: (purpose: RowPurpose, keyId: number | null) => Promise<void>;
  onSelectModel: (purpose: RowPurpose, model: string) => Promise<void>;
  onCreate: (purpose: RowPurpose, groupId: number) => Promise<void>;
  hideCreate: boolean;
}

function PurposeRow({ purpose, keys, prefs, plaza, groups, modelLists, busy, loadingKeys, onSelectKey, onSelectModel, onCreate, hideCreate }: PurposeRowProps) {
  const options = useMemo(() => filterKeysForPurpose(keys, purpose), [keys, purpose]);
  const usable = options.filter((option) => !option.disabledReason);
  const selection = prefs[purpose];
  const selectedKey = selection ? keys.find((key) => key.id === selection.keyId) : undefined;
  const selectedReason = selectedKey ? keyUnavailableReason(selectedKey) || groupPurposeSupport(selectedKey.group, purpose) || '' : '';
  const list = selectedKey ? modelLists[selectedKey.id] : undefined;
  const models = selectedKey && list ? modelsForPurpose(list.models, purpose, plaza, selectedKey) : [];
  const modelOptions: SelectOption<string>[] = models.map((model) => ({ value: model, label: model }));
  if (selection && !models.includes(selection.model)) modelOptions.unshift({ value: selection.model, label: selection.model });

  const nameCount = new Map<string, number>();
  for (const { key } of options) nameCount.set(key.name, (nameCount.get(key.name) || 0) + 1);
  const keyOptions: SelectOption<string>[] = [
    { value: NONE, label: '不使用' },
    ...options.map(({ key, disabledReason }) => ({
      value: String(key.id),
      label: keyLabel(key, disabledReason, (nameCount.get(key.name) || 0) > 1),
      disabled: Boolean(disabledReason),
    })),
  ];
  if (selection && !selectedKey) keyOptions.push({ value: String(selection.keyId), label: '已删除的密钥', disabled: true });

  const price = (() => {
    if (!selectedKey || !selection) return '';
    const found = findPlazaModel(plaza, selectedKey.group_id, selection.model);
    return found ? formatModelPrice(found.group, found.model) : '';
  })();

  const groupChoices = useMemo(() => filterGroupsForPurpose(groups || [], purpose), [groups, purpose]);
  const showCreate = !hideCreate && !loadingKeys && usable.length === 0;

  return (
    <div className="space-y-2 p-4">
      <div className="grid gap-2 sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
        <div>
          <p className="text-sm font-medium">{ROW_LABEL[purpose]}</p>
        </div>
        <Select
          value={selection ? String(selection.keyId) : NONE}
          onValueChange={(value) => void onSelectKey(purpose, value === NONE ? null : Number(value))}
          options={keyOptions}
          disabled={busy}
          ariaLabel={`${ROW_LABEL[purpose]}密钥`}
          placeholder="选择密钥"
          className={TRIGGER_CLASS}
        />
        <div className="flex min-w-0 items-center gap-2">
          <Select
            value={selection?.model || NONE}
            onValueChange={(value) => { if (value !== NONE) void onSelectModel(purpose, value); }}
            options={modelOptions.length > 0 ? modelOptions : [{ value: NONE, label: selection ? '加载中…' : '先选择密钥', disabled: true }]}
            disabled={busy || !selection || list?.status === 'loading'}
            ariaLabel={`${ROW_LABEL[purpose]}模型`}
            placeholder="选择模型"
            className={TRIGGER_CLASS}
          />
          {(busy || list?.status === 'loading') && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
        </div>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground sm:pl-[6.5rem]">
        <p>{ROW_HINT[purpose]}</p>
        {selection && price && <p className="text-foreground">单价：{price}</p>}
        {selection && !price && plaza === null && <p>单价见控制台「模型广场」</p>}
        {selectedReason && <p className="text-destructive">所选密钥{selectedReason}，请更换</p>}
        {list?.status === 'error' && <p className="text-destructive">读取模型失败：{list.error}</p>}
      </div>
      {showCreate && (
        <div className="sm:ml-[6.5rem]">
          <CreateKeyBar
            message={options.length === 0 ? `还没有可用于${ROW_LABEL[purpose]}的密钥。` : `现有密钥都不可用于${ROW_LABEL[purpose]}。`}
            groups={groups}
            choices={groupChoices}
            busy={busy}
            emptyText={`当前没有支持${ROW_LABEL[purpose]}的可用分组。`}
            onCreate={(groupId) => void onCreate(purpose, groupId)}
          />
        </div>
      )}
    </div>
  );
}

interface CreateKeyBarProps {
  message: string;
  groups: Sub2ApiGroup[] | null;
  choices: Sub2ApiGroup[];
  busy: boolean;
  emptyText?: string;
  onCreate: (groupId: number) => void;
}

/** 一键创建：选分组 → 创建并选用；生图与对话都支持的分组排在最前。 */
function CreateKeyBar({ message, groups, choices, busy, emptyText = '当前没有可用分组。', onCreate }: CreateKeyBarProps) {
  const [picked, setPicked] = useState<string>('');
  const groupId = picked || (choices[0] ? String(choices[0].id) : '');
  const label = (group: Sub2ApiGroup) => (supportsImageAndText(group) ? `${group.name} · 生图与对话` : group.name);
  return (
    <div className="space-y-2 rounded-md border border-dashed border-border p-3 text-xs">
      <p className="text-muted-foreground">{message}</p>
      {choices.length > 0 ? (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Select
              size="sm"
              value={groupId}
              onValueChange={setPicked}
              options={choices.map((group) => ({ value: String(group.id), label: label(group) }))}
              ariaLabel="选择分组"
              className={TRIGGER_CLASS}
            />
          </div>
          <Button size="sm" className="gap-1.5" disabled={busy || !groupId} onClick={() => onCreate(Number(groupId))}>
            <Plus className="h-3.5 w-3.5" />
            一键创建
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">{groups === null ? '正在读取可用分组…' : emptyText}</p>
      )}
    </div>
  );
}
