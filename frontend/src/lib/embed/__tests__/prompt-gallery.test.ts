import { describe, expect, it } from 'vitest';
import { embedGalleryImageUrl, embedGallerySourceUrl } from '@/lib/embed/prompt-gallery';
import { isProtectedImageUrl } from '@/lib/embed/authed-image';

const PROXY = 'https://proxy.ccode.vip/https/raw.githubusercontent.com/';

describe('提示词广场地址改写（嵌入模式）', () => {
  it('来源文件：第三方代理换成同源后端', () => {
    expect(embedGallerySourceUrl(`${PROXY}ZeroLu/awesome-gpt-image/main/README.zh-CN.md`))
      .toBe('/api/nova/prompt-gallery/raw/ZeroLu/awesome-gpt-image/main/README.zh-CN.md');
    expect(embedGallerySourceUrl('https://example.com/a.json')).toBe('https://example.com/a.json');
  });

  it('示例图：已知图床走后端，其他原样', () => {
    expect(embedGalleryImageUrl(`${PROXY}a/b/main/x.png`)).toBe('/api/nova/prompt-gallery/raw/a/b/main/x.png');
    expect(embedGalleryImageUrl('https://pbs.twimg.com/media/A.jpg?name=large'))
      .toBe(`/api/nova/prompt-gallery/img?u=${encodeURIComponent('https://pbs.twimg.com/media/A.jpg?name=large')}`);
    expect(embedGalleryImageUrl('https://github.com/user-attachments/assets/39087148-9caa-4b37-8563-2da68df19713'))
      .toMatch(/^\/api\/nova\/prompt-gallery\/img\?u=/);
    for (const keep of ['https://github.com/evil/x.png', 'http://i.ibb.co/a.jpg', 'https://other.example/a.jpg',
      '/api/nova/prompt-gallery/raw/a/b/main/x.png', '', 'not a url']) {
      expect(embedGalleryImageUrl(keep)).toBe(keep);
    }
  });

  it('改写后的地址按受保护图片处理（带会话取 blob）', () => {
    expect(isProtectedImageUrl('/api/nova/prompt-gallery/raw/a/b/main/x.png', true)).toBe(true);
    expect(isProtectedImageUrl('/api/nova/prompt-gallery/img?u=x', true)).toBe(true);
    expect(isProtectedImageUrl('/api/nova/prompt-gallery/verify', true)).toBe(false);
    expect(isProtectedImageUrl('/api/nova/prompt-gallery/img?u=x', false)).toBe(false);
  });
});
