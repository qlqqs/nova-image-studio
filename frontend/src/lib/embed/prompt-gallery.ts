/**
 * 嵌入模式下的提示词广场地址改写（docs/sub2api-embed.md §8A）。
 *
 * CSP 只允许同源连接：来源文件与示例图都改为经 Nova 后端拉取并缓存，
 *   - 来源文件：https://proxy.ccode.vip/https/raw.githubusercontent.com/<repo>/... → /api/nova/prompt-gallery/raw/<repo>/...
 *   - 示例图：已知图床的 https 地址 → /api/nova/prompt-gallery/img?u=<原地址>
 * 两类地址都需要会话鉴权，由 AuthedImg / 包装后的 fetch 处理；其他地址原样保留。
 */

const THIRD_PARTY_RAW_PROXY = 'https://proxy.ccode.vip/https/raw.githubusercontent.com/';
const GALLERY_RAW_PREFIX = '/api/nova/prompt-gallery/raw/';
const GALLERY_IMG_PATH = '/api/nova/prompt-gallery/img';

// 与 backend/embed/prompt-gallery.js 的 IMAGE_HOSTS 保持一致。
const GALLERY_IMAGE_HOSTS = new Set([
  'raw.githubusercontent.com',
  'i.ibb.co',
  'files.catbox.moe',
  'pbs.twimg.com',
  'cdn.imgedify.com',
  'cms-assets.youmind.com',
  'marketing-assets.youmind.com',
  'private-user-images.githubusercontent.com',
  'user-images.githubusercontent.com',
]);
const GITHUB_ATTACHMENTS = /^\/user-attachments\/assets\/[0-9a-f-]+$/;

/** 来源文件地址：第三方代理前缀换成同源后端地址。 */
export function embedGallerySourceUrl(url: string): string {
  return url.startsWith(THIRD_PARTY_RAW_PROXY) ? GALLERY_RAW_PREFIX + url.slice(THIRD_PARTY_RAW_PROXY.length) : url;
}

/** 示例图地址：已知图床改走后端；其余（含已是同源的）原样返回。 */
export function embedGalleryImageUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith(THIRD_PARTY_RAW_PROXY)) return embedGallerySourceUrl(url);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return url;
  const allowed = parsed.hostname === 'github.com'
    ? GITHUB_ATTACHMENTS.test(parsed.pathname)
    : GALLERY_IMAGE_HOSTS.has(parsed.hostname);
  return allowed ? `${GALLERY_IMG_PATH}?u=${encodeURIComponent(parsed.href)}` : url;
}
