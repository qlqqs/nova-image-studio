import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { setEmbedModeForTests } from '@/lib/embed/mode';
import { createAuthFetch } from '@/lib/embed/auth-fetch';
import { fetchAuthedVideoBlob, isProtectedVideoUrl } from '@/lib/embed/authed-video';
import { AuthedVideo } from '@/components/embed/AuthedVideo';

const created: string[] = [];
const revoked: string[] = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

/** jsdom 没有 IntersectionObserver：记下回调，由测试手动触发「进入视口」。 */
let intersect: (() => void) | null = null;
class FakeObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe() {
    intersect = () => this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  disconnect() {
    intersect = null;
  }
}

describe('受保护视频地址识别', () => {
  it('只有嵌入模式下同源 /api/nova/plugin-results/... 需要鉴权', () => {
    expect(isProtectedVideoUrl('/api/nova/plugin-results/t1/0', true)).toBe(true);
    expect(isProtectedVideoUrl('/api/nova/plugin-results/t1/0', false)).toBe(false);
    expect(isProtectedVideoUrl('https://cdn.example.com/api/nova/plugin-results/t1/0', true)).toBe(false);
    expect(isProtectedVideoUrl('/api/nova/plugin-media/a.mp4', true)).toBe(false);
  });

  it('404 → 中文错误', async () => {
    const notFound = vi.fn(async () => new Response('', { status: 404 }));
    await expect(fetchAuthedVideoBlob('/api/nova/plugin-results/x/0', notFound as unknown as typeof fetch)).rejects.toThrow('视频已过期或不存在');
  });
});

describe('AuthedVideo', () => {
  let base: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    let seq = 0;
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:video/${++seq}`;
      created.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
    base = vi.fn(async () => new Response(new Blob(['mp4'], { type: 'video/mp4' }), { status: 200 }));
    vi.stubGlobal('fetch', createAuthFetch(base as unknown as typeof fetch, () => 'jwt-token'));
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    setEmbedModeForTests(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setEmbedModeForTests(null);
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    intersect = null;
  });

  it('进入视口才带会话取 blob 播放，卸载时 revoke', async () => {
    const view = render(createElement(AuthedVideo, { src: '/api/nova/plugin-results/t1/0', controls: true }));
    const video = view.container.querySelector('video')!;
    expect(video.getAttribute('src')).toBeNull();
    expect(base).not.toHaveBeenCalled();

    await act(async () => intersect?.());
    await waitFor(() => expect(video.getAttribute('src')).toBe('blob:video/1'));
    const [input, init] = base.mock.calls[0] as unknown as [string, RequestInit];
    expect(input).toBe('/api/nova/plugin-results/t1/0');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer jwt-token');

    await act(async () => view.unmount());
    expect(revoked).toEqual(['blob:video/1']);
  });

  it('换地址时回收旧的 blob URL', async () => {
    const view = render(createElement(AuthedVideo, { src: '/api/nova/plugin-results/t1/0' }));
    await act(async () => intersect?.());
    const video = view.container.querySelector('video')!;
    await waitFor(() => expect(video.getAttribute('src')).toBe('blob:video/1'));
    view.rerender(createElement(AuthedVideo, { src: '/api/nova/plugin-results/t2/0' }));
    await waitFor(() => expect(video.getAttribute('src')).toBe('blob:video/2'));
    expect(revoked).toEqual(['blob:video/1']);
    await act(async () => view.unmount());
    expect(revoked).toEqual(['blob:video/1', 'blob:video/2']);
  });

  it('过期显示错误；普通地址与 <video> 一致', async () => {
    base.mockResolvedValueOnce(new Response('', { status: 404 }));
    const view = render(createElement(AuthedVideo, { src: '/api/nova/plugin-results/gone/0' }));
    await act(async () => intersect?.());
    await waitFor(() => expect(view.container.textContent).toContain('视频已过期或不存在'));
    view.rerender(createElement(AuthedVideo, { src: 'blob:local/1' }));
    expect(view.container.querySelector('video')!.getAttribute('src')).toBe('blob:local/1');
  });
});
