import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyParentMessage,
  getEmbedSessionState,
  getSessionToken,
  handleParentMessageEvent,
  isTrustedParentEvent,
  parseParentMessage,
  postToParent,
  resetEmbedSessionForTests,
} from '@/lib/embed/session';

const SESSION = {
  type: 'sub2api:nova-studio-session',
  revision: 1,
  sessionToken: 'jwt-1',
  userId: 7,
  role: 'user',
  theme: 'dark',
};

/** 模拟 iframe 里的 window：parent 是另一个对象。 */
function fakeFrameWindow(origin = 'https://console.example.com') {
  const parent = { postMessage: vi.fn() } as unknown as Window;
  const win = { parent, location: { origin } } as unknown as Window;
  return { win, parent };
}

afterEach(() => resetEmbedSessionForTests());

describe('postMessage 来源校验', () => {
  it('只接受同源且来自 window.parent 的消息', () => {
    const { win, parent } = fakeFrameWindow();
    expect(isTrustedParentEvent({ origin: 'https://console.example.com', source: parent }, win)).toBe(true);
    expect(isTrustedParentEvent({ origin: 'https://evil.example.com', source: parent }, win)).toBe(false);
    expect(isTrustedParentEvent({ origin: 'https://console.example.com', source: {} as Window }, win)).toBe(false);
    expect(isTrustedParentEvent({ origin: 'https://console.example.com', source: null }, win)).toBe(false);
  });

  it('顶层窗口（不在 iframe 中）不接受任何消息', () => {
    const top = { location: { origin: 'https://console.example.com' } } as unknown as Window;
    (top as unknown as { parent: Window }).parent = top;
    expect(isTrustedParentEvent({ origin: 'https://console.example.com', source: top }, top)).toBe(false);
  });

  it('伪造来源的会话不会生效', () => {
    const { win } = fakeFrameWindow();
    const result = handleParentMessageEvent({ origin: 'https://evil.example.com', source: win.parent, data: SESSION } as MessageEvent, win);
    expect(result).toBe('ignored');
    expect(getSessionToken()).toBe('');
    const forged = handleParentMessageEvent({ origin: 'https://console.example.com', source: {} as Window, data: SESSION } as MessageEvent, win);
    expect(forged).toBe('ignored');
    expect(getEmbedSessionState().status).toBe('waiting');
  });

  it('合法来源的会话与撤销', () => {
    const { win, parent } = fakeFrameWindow();
    expect(handleParentMessageEvent({ origin: 'https://console.example.com', source: parent, data: SESSION } as MessageEvent, win)).toBe('session');
    expect(getSessionToken()).toBe('jwt-1');
    expect(getEmbedSessionState().session).toMatchObject({ userId: 7, role: 'user', theme: 'dark' });
    expect(handleParentMessageEvent({ origin: 'https://console.example.com', source: parent, data: { type: 'sub2api:nova-studio-revoke' } } as MessageEvent, win)).toBe('revoke');
    expect(getSessionToken()).toBe('');
    expect(getEmbedSessionState()).toEqual({ status: 'revoked', session: null });
  });
});

describe('会话解析', () => {
  it('拒绝缺 token / 非法 userId 的消息，未知角色降为 user', () => {
    expect(parseParentMessage({ ...SESSION, sessionToken: '' })).toBeNull();
    expect(parseParentMessage({ ...SESSION, userId: 0 })).toBeNull();
    expect(parseParentMessage({ ...SESSION, userId: '7' })).toBeNull();
    expect(parseParentMessage({ type: 'other' })).toBeNull();
    expect(parseParentMessage(null)).toBeNull();
    const parsed = parseParentMessage({ ...SESSION, role: 'superadmin', theme: 'blue' });
    expect(parsed && parsed.type === 'sub2api:nova-studio-session' && parsed.session).toMatchObject({ role: 'user', theme: 'light' });
  });

  it('同一用户的旧 revision 被忽略，新 revision 刷新令牌', () => {
    applyParentMessage(parseParentMessage({ ...SESSION, revision: 5, sessionToken: 'jwt-5' }));
    expect(applyParentMessage(parseParentMessage({ ...SESSION, revision: 3, sessionToken: 'jwt-3' }))).toBe('stale');
    expect(getSessionToken()).toBe('jwt-5');
    expect(applyParentMessage(parseParentMessage({ ...SESSION, revision: 6, sessionToken: 'jwt-6' }))).toBe('session');
    expect(getSessionToken()).toBe('jwt-6');
  });
});

describe('postToParent', () => {
  it('只向同源父页发送', () => {
    const { win, parent } = fakeFrameWindow('https://console.example.com');
    postToParent({ type: 'nova:ready' }, win);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'nova:ready' }, 'https://console.example.com');
  });
});
