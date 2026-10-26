/**
 * Nova 前端调用的 sub2api 用户接口（docs/sub2api-embed.md §10）。
 * 响应外层统一为 { code, message, data }，code 非 0 视为错误。
 * 类型只取 Nova 用得到的字段，完整定义见 sub2api frontend/src/api/*.ts。
 */
import { getSessionToken } from '@/lib/embed/session';

export interface Sub2ApiGroup {
  id: number;
  name: string;
  description?: string | null;
  platform: string;
  status?: string;
  rate_multiplier?: number;
  allow_image_generation?: boolean;
  is_exclusive?: boolean;
  subscription_type?: string;
}

export type Sub2ApiKeyStatus = 'active' | 'inactive' | 'quota_exhausted' | 'expired' | string;

export interface Sub2ApiKey {
  id: number;
  key: string;
  name: string;
  group_id: number | null;
  status: Sub2ApiKeyStatus;
  quota: number;
  quota_used: number;
  expires_at: string | null;
  group?: Sub2ApiGroup | null;
}

export interface Sub2ApiUser {
  id: number;
  role: string;
  balance: number;
  frozen_balance?: number;
  email?: string;
  username?: string;
}

export interface PlazaPricingInterval {
  min_tokens: number;
  max_tokens: number | null;
  tier_label?: string;
  input_price: number | null;
  output_price: number | null;
  per_request_price: number | null;
}

export interface PlazaPricing {
  billing_mode: 'token' | 'per_request' | 'image' | 'video' | string;
  input_price: number | null;
  output_price: number | null;
  cache_write_price?: number | null;
  cache_read_price?: number | null;
  image_output_price?: number | null;
  per_request_price: number | null;
  intervals?: PlazaPricingInterval[] | null;
}

export interface PlazaModel {
  name: string;
  platform: string;
  pricing: PlazaPricing | null;
  rate_multiplier?: number;
  user_rate_multiplier?: number | null;
}

export interface PlazaGroup {
  id: number;
  name: string;
  platform: string;
  rate_multiplier: number;
  user_rate_multiplier?: number;
  image_rate_independent?: boolean;
  image_rate_multiplier?: number;
  video_rate_independent?: boolean;
  video_rate_multiplier?: number;
  models: PlazaModel[];
}

export interface ModelPlazaResponse {
  description?: string;
  groups: PlazaGroup[];
}

export class Sub2ApiError extends Error {
  status: number;
  code?: number | string;

  constructor(message: string, status: number, code?: number | string) {
    super(message);
    this.name = 'Sub2ApiError';
    this.status = status;
    this.code = code;
  }
}

type FetchFn = typeof fetch;

function getFetch(): FetchFn {
  return (input, init) => fetch(input, init);
}

/** 解包 { code, message, data }。 */
export async function unwrapEnvelope<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  const record = (body && typeof body === 'object' ? body : {}) as { code?: unknown; message?: unknown; data?: unknown };
  const message = typeof record.message === 'string' && record.message ? record.message : `请求失败（HTTP ${response.status}）`;
  if (!response.ok) throw new Sub2ApiError(message, response.status, record.code as number | string | undefined);
  if (record.code !== undefined && record.code !== 0) {
    throw new Sub2ApiError(message, response.status, record.code as number | string);
  }
  return record.data as T;
}

async function call<T>(path: string, init: RequestInit = {}, fetchFn: FetchFn = getFetch()): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getSessionToken();
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetchFn(`/api/v1${path}`, { cache: 'no-store', ...init, headers });
  return unwrapEnvelope<T>(response);
}

export function getCurrentUser(fetchFn?: FetchFn): Promise<Sub2ApiUser> {
  return call<Sub2ApiUser>('/auth/me', {}, fetchFn);
}

export async function listKeys(fetchFn?: FetchFn): Promise<Sub2ApiKey[]> {
  const data = await call<{ items?: Sub2ApiKey[] } | Sub2ApiKey[]>('/keys?page=1&page_size=100', {}, fetchFn);
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.items) ? data.items : [];
}

export async function listAvailableGroups(fetchFn?: FetchFn): Promise<Sub2ApiGroup[]> {
  const data = await call<Sub2ApiGroup[] | null>('/groups/available', {}, fetchFn);
  return Array.isArray(data) ? data : [];
}

export function createKey(input: { name: string; groupId: number }, fetchFn?: FetchFn): Promise<Sub2ApiKey> {
  return call<Sub2ApiKey>('/keys', {
    method: 'POST',
    body: JSON.stringify({ name: input.name, group_id: input.groupId }),
  }, fetchFn);
}

/** 模型广场可能被管理员关闭（404），此时返回 null，调用方退回按名称分类、不显示单价。 */
export async function getModelPlaza(fetchFn?: FetchFn): Promise<ModelPlazaResponse | null> {
  try {
    const data = await call<ModelPlazaResponse>('/model-plaza', {}, fetchFn);
    return data && Array.isArray(data.groups) ? data : null;
  } catch (error) {
    if (error instanceof Sub2ApiError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

/**
 * 用所选 API Key 调网关 GET /v1/models，得到该 Key 实际可用的模型。
 * 只带 API Key，不带会话令牌（auth-fetch 规则同样不会给 /v1/* 附加令牌）。
 */
export async function listGatewayModels(apiKey: string, fetchFn: FetchFn = getFetch()): Promise<string[]> {
  const response = await fetchFn('/v1/models', {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const err = (body as { error?: { message?: string } | string } | null)?.error;
    const message = typeof err === 'string' ? err : err?.message || `获取模型列表失败（HTTP ${response.status}）`;
    throw new Sub2ApiError(message, response.status);
  }
  const record = (body || {}) as { data?: Array<{ id?: unknown }>; models?: Array<{ name?: unknown; id?: unknown }> };
  const ids = new Set<string>();
  for (const item of record.data || []) {
    if (typeof item?.id === 'string' && item.id.trim()) ids.add(item.id.trim());
  }
  for (const item of record.models || []) {
    const raw = typeof item?.id === 'string' ? item.id : typeof item?.name === 'string' ? item.name : '';
    const name = raw.replace(/^models\//, '').trim();
    if (name) ids.add(name);
  }
  return Array.from(ids);
}

export interface WorkbenchDefaults {
  eligible: boolean;
  initialized: boolean;
  group_id: number;
  group_name: string;
  preferences: import('./embed-registry').StudioPrefs;
  text_model: string;
  image_model: string;
  reasoning_effort: string;
  reasoning_allowed?: boolean;
}
export const getWorkbenchDefaults = () => call<WorkbenchDefaults>('/user/workbench/studio');
export const saveWorkbenchPrefs = (preferences: import('./embed-registry').StudioPrefs, initialize = false) =>
  call<import('./embed-registry').StudioPrefs>('/user/workbench/studio', {
    method: initialize ? 'POST' : 'PUT', body: JSON.stringify({ preferences }),
  });
