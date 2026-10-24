/**
 * Prompt gallery fetched server-side (docs/sub2api-embed.md §8A).
 *
 * In embedded mode the browser may only talk to the site itself (CSP connect-src 'self'),
 * so the gallery goes through this server instead of a third-party proxy:
 *   GET /api/nova/prompt-gallery/raw/<owner>/<repo>/<ref>/<path>   source files (fixed repos)
 *   GET /api/nova/prompt-gallery/img?u=<https url>                 example images (fixed hosts)
 * Responses are cached on disk; a stale copy is served when the upstream is unreachable.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./security');

const RAW_PREFIX = '/api/nova/prompt-gallery/raw/';
const IMG_PATH = '/api/nova/prompt-gallery/img';

// Keep in sync with PROMPT_DATA_SOURCES in frontend/src/lib/prompt-gallery-data.ts.
const ALLOWED_REPOS = new Set([
  'unknowlei/nanobanana-website',
  'evolinkai/awesome-gpt-image-2-api-and-prompts',
  'zerolu/awesome-gpt-image',
  'imgedify/awesome-gpt4o-image-prompts',
  'youmind-openlab/awesome-gpt-image-2',
  'youmind-openlab/awesome-nano-banana-pro-prompts',
  'davidwuw0811-boop/awesome-gpt-image2-prompts',
]);

// Image hosts used by those sources.
// Keep in sync with GALLERY_IMAGE_HOSTS in frontend/src/lib/embed/prompt-gallery.ts.
const IMAGE_HOSTS = new Set([
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
// Only reachable as a redirect hop: github.com/user-attachments → signed S3 URL.
const REDIRECT_ONLY_HOSTS = new Set(['github-production-user-asset-6210df.s3.amazonaws.com']);

// Source files get a fixed type (raw.githubusercontent.com says text/plain for everything).
const FILE_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
// No SVG: it can carry script.
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

const DEFAULTS = {
  upstreamBase: 'https://raw.githubusercontent.com',
  ttlMs: 6 * 60 * 60 * 1000,
  maxFileBytes: 20 * 1024 * 1024,
  maxCacheBytes: 512 * 1024 * 1024,
  timeoutMs: 20000,
  maxRedirects: 3,
};

/** Source file path → { upstreamPath, contentType }; throws 404 for anything outside the fixed repos. */
function parseGalleryPath(pathname) {
  if (!pathname.startsWith(RAW_PREFIX)) throw httpError(404, 'NOT_FOUND');
  let segments;
  try {
    segments = pathname.slice(RAW_PREFIX.length).split('/').map(decodeURIComponent);
  } catch {
    throw httpError(404, 'NOT_FOUND');
  }
  // owner / repo / ref / at least one path segment
  if (segments.length < 4 || segments.some(s => !s || s === '.' || s === '..' || /[\\/\0]/.test(s))) {
    throw httpError(404, 'NOT_FOUND');
  }
  const repo = `${segments[0]}/${segments[1]}`.toLowerCase();
  const contentType = FILE_TYPES[path.extname(segments[segments.length - 1]).toLowerCase()];
  if (!ALLOWED_REPOS.has(repo) || !contentType) throw httpError(404, 'NOT_FOUND');
  return { upstreamPath: segments.map(encodeURIComponent).join('/'), contentType };
}

/** Whether an image URL may be requested (`hop`: also allow redirect-only hosts). */
function isAllowedImageUrl(raw, hop = false) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (url.hostname === 'github.com') return GITHUB_ATTACHMENTS.test(url.pathname);
  return IMAGE_HOSTS.has(url.hostname) || (hop && REDIRECT_ONLY_HOSTS.has(url.hostname));
}

function createPromptGallery(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const upstreamBase = String(opts.upstreamBase || DEFAULTS.upstreamBase).replace(/\/+$/, '');
  const upstreamOrigin = new URL(upstreamBase).origin;
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;
  const cacheDir = opts.cacheDir;
  fs.mkdirSync(cacheDir, { recursive: true });

  // hash -> { size, fetchedAt, contentType }
  const index = new Map();
  let totalBytes = 0;
  for (const name of fs.readdirSync(cacheDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8'));
      const hash = name.slice(0, -5);
      const size = fs.statSync(path.join(cacheDir, `${hash}.bin`)).size;
      index.set(hash, { size, fetchedAt: Number(meta.fetchedAt) || 0, contentType: meta.contentType });
      totalBytes += size;
    } catch { /* incomplete entry: refetched on demand */ }
  }

  function remove(hash) {
    const entry = index.get(hash);
    if (!entry) return;
    index.delete(hash);
    totalBytes -= entry.size;
    fs.rmSync(path.join(cacheDir, `${hash}.bin`), { force: true });
    fs.rmSync(path.join(cacheDir, `${hash}.json`), { force: true });
  }

  function prune() {
    if (totalBytes <= opts.maxCacheBytes) return;
    const oldest = [...index.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (const [hash] of oldest) {
      if (totalBytes <= opts.maxCacheBytes) break;
      remove(hash);
    }
  }

  // Redirects are followed by hand so that every hop passes the same allowlist.
  async function download(url, allowHop) {
    let response;
    for (let hops = 0; ; hops++) {
      response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: { 'user-agent': 'nova-studio-prompt-gallery' },
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      const next = location ? new URL(location, url).href : '';
      if (hops >= opts.maxRedirects || !next || !allowHop(next)) throw httpError(502, 'GALLERY_REDIRECT_NOT_ALLOWED');
      url = next;
    }
    if (!response.ok) throw httpError(response.status === 404 ? 404 : 502, 'GALLERY_UPSTREAM_FAILED');
    const declared = Number(response.headers.get('content-length'));
    if (declared > opts.maxFileBytes) throw httpError(502, 'GALLERY_FILE_TOO_LARGE');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > opts.maxFileBytes) throw httpError(502, 'GALLERY_FILE_TOO_LARGE');
      chunks.push(chunk);
    }
    return { body: Buffer.concat(chunks), contentType: response.headers.get('content-type') || '' };
  }

  const inflight = new Map();

  /** Cached fetch keyed by URL; `fixedType` overrides the upstream type, otherwise it must be an image type. */
  async function cachedFetch(url, allowHop, fixedType) {
    const hash = crypto.createHash('sha256').update(url).digest('hex');
    const cached = index.get(hash);
    const read = () => ({ body: fs.readFileSync(path.join(cacheDir, `${hash}.bin`)), contentType: cached.contentType });
    if (cached && now() - cached.fetchedAt < opts.ttlMs) return read();
    if (!inflight.has(hash)) {
      inflight.set(hash, download(url, allowHop).then(({ body, contentType: upstreamType }) => {
        const contentType = fixedType || upstreamType.split(';')[0].trim().toLowerCase();
        if (!fixedType && !IMAGE_TYPES.has(contentType)) throw httpError(502, 'GALLERY_NOT_AN_IMAGE');
        remove(hash);
        fs.writeFileSync(path.join(cacheDir, `${hash}.bin`), body);
        fs.writeFileSync(path.join(cacheDir, `${hash}.json`), JSON.stringify({ fetchedAt: now(), contentType, url }));
        index.set(hash, { size: body.length, fetchedAt: now(), contentType });
        totalBytes += body.length;
        prune();
        return { body, contentType };
      }).finally(() => inflight.delete(hash)));
    }
    try {
      return await inflight.get(hash);
    } catch (error) {
      if (cached && index.has(hash) && error.statusCode !== 404) return read();
      throw error.statusCode ? error : httpError(502, 'GALLERY_UPSTREAM_FAILED');
    }
  }

  /** Returns { body, contentType } for a gallery request path (+ query for images). */
  async function load(pathname, searchParams) {
    if (pathname === IMG_PATH) {
      const url = searchParams?.get('u') || '';
      if (!isAllowedImageUrl(url)) throw httpError(404, 'NOT_FOUND');
      return cachedFetch(new URL(url).href, (next) => isAllowedImageUrl(next, true));
    }
    const { upstreamPath, contentType } = parseGalleryPath(pathname);
    return cachedFetch(`${upstreamBase}/${upstreamPath}`, (next) => new URL(next).origin === upstreamOrigin, contentType);
  }

  async function handle(req, res, pathname, searchParams) {
    if (req.method !== 'GET') throw httpError(405, 'METHOD_NOT_ALLOWED');
    const { body, contentType } = await load(pathname, searchParams);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.end(body);
  }

  return {
    handle, load,
    isGalleryPath: (pathname) => pathname === IMG_PATH || pathname.startsWith(RAW_PREFIX),
  };
}

module.exports = { createPromptGallery, parseGalleryPath, isAllowedImageUrl, ALLOWED_REPOS, IMAGE_HOSTS };
