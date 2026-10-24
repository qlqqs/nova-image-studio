import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthFetch, shouldAttachSessionToken, withSessionToken } from '@/lib/embed/auth-fetch';

const ORIGIN = window.location.origin;

describe('会话令牌附加规则', () => {
  it('只附加到同源 /api/nova/* 与 /api/v1/*', () => {
    expect(shouldAttachSessionToken('/api/nova/tasks')).toBe(true);
    expect(shouldAttachSessionToken('/api/nova')).toBe(true);
    expect(shouldAttachSessionToken('/api/nova/images/t1/0')).toBe(true);
    expect(shouldAttachSessionToken(`${ORIGIN}/api/v1/keys?page=1`)).toBe(true);
    expect(shouldAttachSessionToken(new URL('/api/v1/auth/me', ORIGIN))).toBe(true);
    expect(shouldAttachSessionToken(new Request(`${ORIGIN}/api/nova/ws-ticket`, { method: 'POST' }))).toBe(true);
  });

  it('绝不附加到网关 /v1、/v1beta 与其他路径', () => {
    expect(shouldAttachSessionToken('/v1/models')).toBe(false);
    expect(shouldAttachSessionToken('/v1/images/generations')).toBe(false);
    expect(shouldAttachSessionToken('/v1beta/models/gemini:generateContent')).toBe(false);
    expect(shouldAttachSessionToken('/api/novax/tasks')).toBe(false);
    expect(shouldAttachSessionToken('/api/v1')).toBe(false);
    expect(shouldAttachSessionToken('/_nova/index.html')).toBe(false);
    expect(shouldAttachSessionToken('/api/nova-other')).toBe(false);
  });

  it('不附加到跨域地址（即使路径相同）', () => {
    expect(shouldAttachSessionToken('https://evil.example.com/api/nova/tasks')).toBe(false);
    expect(shouldAttachSessionToken('https://api.openai.com/api/v1/keys')).toBe(false);
    expect(shouldAttachSessionToken('//evil.example.com/api/v1/keys')).toBe(false);
  });

  it('不覆盖已有 Authorization', () => {
    const next = withSessionToken('/api/nova/tasks', { headers: { Authorization: 'Bearer other' } }, 'jwt');
    expect(new Headers(next.init?.headers).get('Authorization')).toBe('Bearer other');
  });
});

describe('createAuthFetch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('给 /api/nova 加 Bearer 会话令牌，网关 /v1 只保留调用方自带的 API Key', async () => {
    const base = vi.fn(async () => new Response('{}'));
    const authed = createAuthFetch(base as unknown as typeof fetch, () => 'jwt-token');

    await authed('/api/nova/tasks', { method: 'POST' });
    await authed('/v1/models', { headers: { Authorization: 'Bearer sk-user-key' } });
    await authed('/v1beta/models/x:generateContent');

    const headersOf = (index: number) => new Headers((base.mock.calls[index] as unknown as [unknown, RequestInit | undefined])[1]?.headers);
    expect(headersOf(0).get('Authorization')).toBe('Bearer jwt-token');
    expect(headersOf(1).get('Authorization')).toBe('Bearer sk-user-key');
    expect(headersOf(2).get('Authorization')).toBeNull();
  });

  it('没有会话令牌时原样透传', async () => {
    const base = vi.fn(async () => new Response('{}'));
    const authed = createAuthFetch(base as unknown as typeof fetch, () => '');
    await authed('/api/nova/tasks');
    expect((base.mock.calls[0] as unknown as [unknown, RequestInit | undefined])[1]).toBeUndefined();
  });
});
