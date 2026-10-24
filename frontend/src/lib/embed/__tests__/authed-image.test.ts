import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { setEmbedModeForTests } from '@/lib/embed/mode';
import { createAuthFetch } from '@/lib/embed/auth-fetch';
import {
  acquireAuthedImageUrl,
  clearAuthedImageCache,
  fetchAuthedImageObjectUrl,
  getAuthedImageCacheSizeForTests,
  isProtectedImageUrl,
  releaseAuthedImageUrl,
  setAuthedImageFetchForTests,
} from '@/lib/embed/authed-image';
import { AuthedImg } from '@/components/embed/AuthedImg';

const created: string[] = [];
const revoked: string[] = [];

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

function installObjectUrlSpies() {
  let seq = 0;
  // jsdom 没有实现 createObjectURL / revokeObjectURL
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test/${++seq}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
}

function restoreObjectUrl() {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
}

describe('受保护图片地址识别', () => {
  afterEach(() => setEmbedModeForTests(null));

  it('只有嵌入模式下同源 /api/nova/images/... 需要鉴权', () => {
    expect(isProtectedImageUrl('URL:/api/nova/images/t1/0', true)).toBe(true);
    expect(isProtectedImageUrl('/api/nova/images/t1/0', true)).toBe(true);
    expect(isProtectedImageUrl('MULTI_URL:/api/nova/images/t1/0|||/api/nova/images/t1/1', true)).toBe(true);
    expect(isProtectedImageUrl('/api/nova/images/t1/0', false)).toBe(false);
    expect(isProtectedImageUrl('blob:abc', true)).toBe(false);
    expect(isProtectedImageUrl('data:image/png;base64,AAA', true)).toBe(false);
    expect(isProtectedImageUrl('https://cdn.example.com/api/nova/images/t1/0', true)).toBe(false);
    expect(isProtectedImageUrl('/favicon.png', true)).toBe(false);
  });
});

describe('带会话鉴权的图片 blob 加载', () => {
  let base: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    installObjectUrlSpies();
    base = vi.fn(async () => new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 }));
    setAuthedImageFetchForTests(createAuthFetch(base as unknown as typeof fetch, () => 'jwt-token'));
    setEmbedModeForTests(true);
  });

  afterEach(() => {
    clearAuthedImageCache();
    setAuthedImageFetchForTests(undefined);
    setEmbedModeForTests(null);
    restoreObjectUrl();
  });

  it('经 fetch + Authorization 头取图，URL 里不带 JWT', async () => {
    const url = await acquireAuthedImageUrl('URL:/api/nova/images/t1/0');
    expect(url).toBe('blob:test/1');
    const [input, init] = base.mock.calls[0] as unknown as [string, RequestInit];
    expect(input).toBe('/api/nova/images/t1/0');
    expect(input).not.toContain('jwt');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer jwt-token');
    expect(init.cache).toBe('no-store');
  });

  it('共享缓存按引用计数，clear 时 revoke 全部 blob URL', async () => {
    const [a, b] = await Promise.all([
      acquireAuthedImageUrl('/api/nova/images/t1/0'),
      acquireAuthedImageUrl('URL:/api/nova/images/t1/0'),
    ]);
    expect(a).toBe(b);
    expect(base).toHaveBeenCalledTimes(1);
    releaseAuthedImageUrl('/api/nova/images/t1/0');
    releaseAuthedImageUrl('/api/nova/images/t1/0');
    expect(getAuthedImageCacheSizeForTests()).toBe(1);
    clearAuthedImageCache();
    expect(revoked).toEqual([a]);
    expect(getAuthedImageCacheSizeForTests()).toBe(0);
  });

  it('404 → 中文错误', async () => {
    const notFound = vi.fn(async () => new Response('', { status: 404 }));
    await expect(fetchAuthedImageObjectUrl('/api/nova/images/x/0', notFound as unknown as typeof fetch)).rejects.toThrow('图片已过期或不存在');
  });

  it('AuthedImg 先不渲染 src，取到 blob 后显示 blob URL，卸载时释放', async () => {
    const view = render(createElement(AuthedImg, { src: '/api/nova/images/t2/0', alt: 'result' }));
    const img = screen.getByAltText('result') as HTMLImageElement;
    expect(img.getAttribute('src')).toBeNull();
    await waitFor(() => expect(img.getAttribute('src')).toBe('blob:test/1'));
    await act(async () => view.unmount());
    expect(getAuthedImageCacheSizeForTests()).toBe(1); // 空闲条目保留在缓存里，clear / 超额时回收
  });

  it('AuthedImg 对普通地址与 <img> 一致', () => {
    render(createElement(AuthedImg, { src: 'blob:local/1', alt: 'local' }));
    expect(screen.getByAltText('local').getAttribute('src')).toBe('blob:local/1');
    expect(base).not.toHaveBeenCalled();
  });
});
