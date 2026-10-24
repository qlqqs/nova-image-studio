const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPromptGallery, parseGalleryPath, isAllowedImageUrl } = require('../embed/prompt-gallery');

const P = '/api/nova/prompt-gallery/raw/';

function setup(overrides = {}) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-gallery-'));
  const calls = [];
  let time = 1000;
  let reply = () => new Response('{"ok":1}', { status: 200 });
  const gallery = createPromptGallery({
    cacheDir,
    now: () => time,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return reply(url); },
    ...overrides,
  });
  return {
    cacheDir, calls, gallery,
    setTime: (t) => { time = t; },
    setReply: (fn) => { reply = fn; },
  };
}

test('only fixed repos, safe segments and data/image types are accepted', () => {
  const ok = parseGalleryPath(`${P}ZeroLu/awesome-gpt-image/main/README.zh-CN.md`);
  assert.equal(ok.upstreamPath, 'ZeroLu/awesome-gpt-image/main/README.zh-CN.md');
  assert.equal(ok.contentType, 'text/markdown; charset=utf-8');
  assert.equal(parseGalleryPath(`${P}ZeroLu/awesome-gpt-image/main/assets/a%20b.PNG`).upstreamPath,
    'ZeroLu/awesome-gpt-image/main/assets/a%20b.PNG');
  for (const bad of [
    `${P}evil/repo/main/data.json`,
    `${P}ZeroLu/awesome-gpt-image/main/x.svg`,
    `${P}ZeroLu/awesome-gpt-image/main/x.html`,
    `${P}ZeroLu/awesome-gpt-image/main/../../evil/repo/main/a.json`,
    `${P}ZeroLu/awesome-gpt-image/main/%2e%2e/a.json`,
    `${P}ZeroLu/awesome-gpt-image/main/a%2Fb.json`,
    `${P}ZeroLu/awesome-gpt-image/main.json`,
    `${P}ZeroLu/awesome-gpt-image/main//a.json`,
    `${P}ZeroLu/awesome-gpt-image/main/%E0%A4%A.json`,
    '/api/nova/prompt-gallery/rawx/a',
  ]) {
    assert.throws(() => parseGalleryPath(bad), { statusCode: 404 }, bad);
  }
});

test('fetches from the fixed upstream with manual redirects, then serves from cache', async () => {
  const { gallery, calls, setTime } = setup();
  const file = `${P}unknowlei/nanobanana-website/refs/heads/main/public/data.json`;
  const first = await gallery.load(file);
  assert.equal(first.body.toString(), '{"ok":1}');
  assert.equal(first.contentType, 'application/json; charset=utf-8');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://raw.githubusercontent.com/unknowlei/nanobanana-website/refs/heads/main/public/data.json');
  assert.equal(calls[0].init.redirect, 'manual');

  await gallery.load(file);
  assert.equal(calls.length, 1, 'fresh cache hit');
  setTime(1000 + 7 * 3600 * 1000);
  await gallery.load(file);
  assert.equal(calls.length, 2, 'stale entry refreshed');
});

test('concurrent requests share one download; cache survives a restart', async () => {
  const { gallery, calls, cacheDir } = setup();
  const file = `${P}zerolu/awesome-gpt-image/main/README.zh-CN.md`;
  await Promise.all([gallery.load(file), gallery.load(file), gallery.load(file)]);
  assert.equal(calls.length, 1);

  const again = createPromptGallery({ cacheDir, now: () => 1000, fetchImpl: () => assert.fail('should hit disk cache') });
  assert.equal((await again.load(file)).body.toString(), '{"ok":1}');
});

test('stale copy is served when upstream fails; 404 and oversize are not cached', async () => {
  const { gallery, setTime, setReply } = setup({ maxFileBytes: 8 });
  const file = `${P}zerolu/awesome-gpt-image/main/a.json`;
  await gallery.load(file);
  setTime(10 ** 9);
  setReply(() => { throw new Error('offline'); });
  assert.equal((await gallery.load(file)).body.toString(), '{"ok":1}');

  setReply(() => new Response('nope', { status: 404 }));
  await assert.rejects(gallery.load(`${P}zerolu/awesome-gpt-image/main/b.json`), { statusCode: 404 });
  setReply(() => new Response('0123456789', { status: 200 }));
  await assert.rejects(gallery.load(`${P}zerolu/awesome-gpt-image/main/c.json`), { code: 'GALLERY_FILE_TOO_LARGE' });
  setReply(() => { throw new Error('offline'); });
  await assert.rejects(gallery.load(`${P}zerolu/awesome-gpt-image/main/d.json`), { statusCode: 502 });
});

test('cache is pruned oldest-first above the size cap', async () => {
  const { gallery, calls, setTime } = setup({ maxCacheBytes: 20 });
  for (const [i, name] of ['a', 'b', 'c'].entries()) {
    setTime(1000 + i);
    await gallery.load(`${P}zerolu/awesome-gpt-image/main/${name}.json`);
  }
  assert.equal(calls.length, 3);
  await gallery.load(`${P}zerolu/awesome-gpt-image/main/c.json`);
  await gallery.load(`${P}zerolu/awesome-gpt-image/main/b.json`);
  assert.equal(calls.length, 3, 'newest two kept');
  await gallery.load(`${P}zerolu/awesome-gpt-image/main/a.json`);
  assert.equal(calls.length, 4, 'oldest evicted');
});

test('handle serves with a fixed type and no-sniff / sandbox headers; GET only', async () => {
  const { gallery } = setup();
  const headers = {};
  let sent;
  const res = { writeHead: (status, h) => { headers.status = status; Object.assign(headers, h); }, end: (b) => { sent = b; } };
  await gallery.handle({ method: 'GET' }, res, `${P}zerolu/awesome-gpt-image/main/x.png`);
  assert.equal(headers.status, 200);
  assert.equal(headers['Content-Type'], 'image/png');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Content-Security-Policy'], /sandbox/);
  assert.equal(sent.toString(), '{"ok":1}');
  await assert.rejects(gallery.handle({ method: 'POST' }, res, `${P}zerolu/awesome-gpt-image/main/x.png`), { statusCode: 405 });
});

test('image proxy: fixed https hosts only, every redirect hop checked, image types only', async () => {
  for (const ok of ['https://i.ibb.co/x/a.jpg', 'https://pbs.twimg.com/media/A.jpg?name=large',
    'https://github.com/user-attachments/assets/39087148-9caa-4b37-8563-2da68df19713']) {
    assert.equal(isAllowedImageUrl(ok), true, ok);
  }
  for (const bad of ['http://i.ibb.co/a.jpg', 'https://evil.example/a.jpg', 'https://i.ibb.co:444/a.jpg',
    'https://u:p@i.ibb.co/a.jpg', 'https://github.com/evil/repo/raw/main/a.png', 'https://i.ibb.co.evil.example/a.jpg', 'nope']) {
    assert.equal(isAllowedImageUrl(bad), false, bad);
  }

  const { gallery, calls, setReply } = setup();
  const img = (u) => gallery.load('/api/nova/prompt-gallery/img', new URLSearchParams({ u }));
  await assert.rejects(img('https://evil.example/a.png'), { statusCode: 404 });
  assert.equal(calls.length, 0);

  setReply((url) => url.startsWith('https://github.com/')
    ? new Response(null, { status: 302, headers: { location: 'https://private-user-images.githubusercontent.com/1/a.png?jwt=x' } })
    : new Response('PNG', { status: 200, headers: { 'content-type': 'image/png' } }));
  const got = await img('https://github.com/user-attachments/assets/39087148-9caa-4b37-8563-2da68df19713');
  assert.equal(got.contentType, 'image/png');
  assert.equal(calls.length, 2);

  assert.equal(isAllowedImageUrl('https://github-production-user-asset-6210df.s3.amazonaws.com/a.png'), false, 'redirect-only host');
  setReply((url) => url.startsWith('https://github.com/')
    ? new Response(null, { status: 302, headers: { location: 'https://github-production-user-asset-6210df.s3.amazonaws.com/7/a.png?X-Amz-Signature=x' } })
    : new Response('PNG', { status: 200, headers: { 'content-type': 'image/png' } }));
  await img('https://github.com/user-attachments/assets/45e4f24f-4f73-4426-947d-e6ed51291956');
  await assert.rejects(img('https://github-production-user-asset-6210df.s3.amazonaws.com/7/a.png'), { statusCode: 404 });
  setReply(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
  await assert.rejects(img('https://i.ibb.co/redirect.png'), { code: 'GALLERY_REDIRECT_NOT_ALLOWED' });
  setReply(() => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }));
  await assert.rejects(img('https://i.ibb.co/x.svg'), { code: 'GALLERY_NOT_AN_IMAGE' });
  setReply(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(img('https://i.ibb.co/x.png'), { code: 'GALLERY_NOT_AN_IMAGE' });
});

test('source files never follow a redirect off the raw host', async () => {
  const { gallery, setReply } = setup();
  setReply(() => new Response(null, { status: 301, headers: { location: 'https://evil.example/data.json' } }));
  await assert.rejects(gallery.load(`${P}zerolu/awesome-gpt-image/main/a.json`), { code: 'GALLERY_REDIRECT_NOT_ALLOWED' });
});
