import { afterEach, describe, expect, it } from 'vitest';
import { localizeGatewayError } from '@/lib/embed/gateway-errors';
import { inspectEmbedTaskPayload } from '@/lib/embed/task-events';
import { dismissEmbedNotice, getEmbedNotice } from '@/lib/embed/notices';
import { setEmbedModeForTests } from '@/lib/embed/mode';
import { buildTicketSocketUrl } from '@/lib/embed/ws-ticket';

describe('网关错误转中文', () => {
  it.each([
    ['403 INSUFFICIENT_BALANCE Insufficient account balance', 'insufficient_balance'],
    ['{"error":{"type":"insufficient_quota","message":"x"}}', 'key_quota_exhausted'],
    ['429 API_KEY_QUOTA_EXHAUSTED', 'key_quota_exhausted'],
    ['401 INVALID_API_KEY Invalid API key', 'invalid_key'],
    ['API key is disabled', 'invalid_key'],
    ['API_KEY_EXPIRED API key 已过期', 'key_expired'],
    ['Your request was rejected as a result of our safety system (moderation_blocked)', 'moderation'],
    ['upstream returned 429 Too Many Requests', 'rate_limited'],
    ['Access denied. Your IP is 1.2.3.4', 'ip_denied'],
  ])('%s → %s', (raw, kind) => {
    expect(localizeGatewayError(raw)?.kind).toBe(kind);
  });

  it('无关错误原样', () => {
    expect(localizeGatewayError('图片尺寸不合法')).toBeNull();
  });
});

describe('任务响应钩子', () => {
  afterEach(() => {
    setEmbedModeForTests(null);
    dismissEmbedNotice();
  });

  it('独立模式原样返回', () => {
    setEmbedModeForTests(false);
    const task = { id: 't', status: 'failed', error: 'Insufficient account balance' };
    expect(inspectEmbedTaskPayload(task)).toBe(task);
  });

  it('嵌入模式把余额不足转中文并给出「去充值」', () => {
    setEmbedModeForTests(true);
    const task = inspectEmbedTaskPayload({ id: 't', status: 'failed', error: 'upstream 403: Insufficient account balance' });
    expect(task.error).toBe('账户余额不足，请充值后重试');
    expect(getEmbedNotice()?.action).toEqual({ label: '去充值', path: '/purchase' });
  });
});

describe('WebSocket ticket', () => {
  it('建连地址只带一次性 ticket', () => {
    expect(buildTicketSocketUrl('abc_123', 'https://console.example.com/_nova/?embedded=1')).toBe('wss://console.example.com/api/nova/ws?ticket=abc_123');
    expect(buildTicketSocketUrl('t', 'http://127.0.0.1:28080/_nova/')).toBe('ws://127.0.0.1:28080/api/nova/ws?ticket=t');
  });
});

it('structured 403 preserves balance code, unrelated 403 is not a recharge error', () => {
  setEmbedModeForTests(true);
  expect(inspectEmbedTaskPayload({ error: { code: 'INSUFFICIENT_BALANCE', message: 'Forbidden' } }).error)
    .toBe('账户余额不足，请充值后重试');
  expect(localizeGatewayError('HTTP 403')).toBeNull();
  expect(localizeGatewayError('HTTP 402')).toBeNull();
  const other = { error: { code: 'FORBIDDEN', message: 'No permission' } };
  expect(inspectEmbedTaskPayload(other)).toBe(other);
  setEmbedModeForTests(null);
});
