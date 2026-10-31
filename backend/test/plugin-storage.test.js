const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createMediaStore } = require('../plugin-runtime/media');
const { downloadResult, assertDownloadUrl, MAX_BYTES, TIMEOUT_MS } = require('../plugin-runtime/results');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-plugin-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mediaStore(t, env = {}) {
  const dir = tempDir(t);
  const db = new Database(':memory:');
  t.after(() => db.close());
  const deps = { db, dataDir: dir, getRuntimeEnv: () => env,
    parseIntegerEnv: (value, fallback) => value === undefined ? fallback : Number(value),
    createHttpError: (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code }),
    getClientIp: () => '127.0.0.1', normalizeBaseUrl: url => String(url || '').replace(/\/+$/, '') };
  const store = createMediaStore(deps);
  store.initSchema();
  return { dir, db, store, deps };
}

test('media HMAC matches C3, rejects altered/expired signatures, persists 600 key across restarts', t => {
  const { dir, store, deps } = mediaStore(t);
  const now = 1793404800000;
  const url = new URL(store.publicUrl('image.png', 'https://studio.test', now));
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  assert.equal(Number(exp), now / 1000 + 86400);
  const secret = fs.readFileSync(path.join(dir, 'media-signing.key'), 'utf8').trim();
  const expected = require('node:crypto').createHmac('sha256', secret).update(`image.png\n${exp}`).digest('hex');
  assert.equal(sig, expected);
  assert.equal(fs.statSync(path.join(dir, 'media-signing.key')).mode & 0o777, 0o600);
  assert.equal(store.verifySignature('image.png', exp, sig, now), true);
  assert.equal(store.verifySignature('other.png', exp, sig, now), false);
  assert.equal(store.verifySignature('image.png', exp, sig, now + 86400000), false);
  for (const bad of ['../image.png', 'a/b.png', 'a..png']) assert.equal(store.verifySignature(bad, exp, sig, now), false);
  const restarted = createMediaStore(deps);
  restarted.initSchema();
  assert.equal(restarted.verifySignature('image.png', exp, sig, now), true);
  assert.deepEqual(store.signedMedia({ image: ['/api/nova/plugin-media/image.png', 'https://media.test/a.png'] }, 'https://studio.test').image[1], 'https://media.test/a.png');
});

test('explicit signing secret avoids key file; 24h orphan cleanup retains task-bound material', t => {
  const { dir, db, store } = mediaStore(t, { NOVA_MEDIA_SIGNING_SECRET: 'test-signing-secret' });
  assert.equal(fs.existsSync(path.join(dir, 'media-signing.key')), false);
  fs.mkdirSync(store.MEDIA_DIR, { recursive: true });
  const insert = db.prepare('INSERT INTO plugin_media (file_name, hash, kind, bytes, task_id, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const old = new Date(Date.now() - 25 * 3600000);
  for (const [name, task] of [['orphan.png', null], ['bound.png', 'task']]) {
    fs.writeFileSync(path.join(store.MEDIA_DIR, name), 'image');
    fs.utimesSync(path.join(store.MEDIA_DIR, name), old, old);
    insert.run(name, name, 'images', 5, task, old.toISOString(), '1');
  }
  store.cleanupExpired();
  assert.equal(fs.existsSync(path.join(store.MEDIA_DIR, 'orphan.png')), false);
  assert.equal(fs.existsSync(path.join(store.MEDIA_DIR, 'bound.png')), true);
  assert.equal(store.canPreview('bound.png', { userId: '1' }), true);
  assert.equal(store.canPreview('bound.png', { userId: '2' }), false);
  store.deleteTaskMedia('task');
  assert.equal(fs.existsSync(path.join(store.MEDIA_DIR, 'bound.png')), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plugin_media').get().n, 0);
});

async function resultServer(t) {
  const server = http.createServer((req, res) => {
    if (req.url === '/large-header') { res.writeHead(200, { 'Content-Length': MAX_BYTES + 1 }); res.end(); return; }
    if (req.url === '/large-stream') { res.writeHead(200); res.end('123456789'); return; }
    if (req.url === '/slow') { res.writeHead(200); res.write('x'); return; }
    if (req.url === '/bad-redirect') { res.writeHead(302, { Location: 'file:///tmp/leak' }); res.end(); return; }
    if (req.url.startsWith('/redirect/')) {
      const n = Number(req.url.split('/').pop());
      res.writeHead(302, { Location: n === 1 ? '/video' : `/redirect/${n - 1}` }); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end('video-bytes');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('result download requires HTTPS by default and checks protocol at each redirect', async t => {
  assert.equal(MAX_BYTES, 1024 ** 3);
  assert.equal(TIMEOUT_MS, 600000);
  assert.equal(assertDownloadUrl('https://cdn.test/a').protocol, 'https:');
  for (const url of ['http://cdn.test/a', 'file:///tmp/a', 'data:text/plain,a', 'https://u:p@cdn.test/a']) {
    assert.throws(() => assertDownloadUrl(url), /HTTPS/);
  }
  const base = await resultServer(t);
  const file = path.join(tempDir(t), 'out.mp4');
  await assert.rejects(downloadResult(`${base}/video`, file), /HTTPS/);
  await assert.rejects(downloadResult(`${base}/bad-redirect`, file, { allowHttp: true }), /HTTPS/);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { Location: 'http://cdn.test/down.mp4' } }));
  await assert.rejects(downloadResult('https://cdn.test/redirect', file), /HTTPS/);
});

test('result download caps redirects at 3, streams with byte limit, times out and removes partial files', async t => {
  const base = await resultServer(t);
  const file = path.join(tempDir(t), 'out.mp4');
  const result = await downloadResult(`${base}/redirect/3`, file, { allowHttp: true });
  assert.equal(result.mime, 'video/mp4');
  assert.equal(fs.readFileSync(file, 'utf8'), 'video-bytes');
  fs.unlinkSync(file);
  await assert.rejects(downloadResult(`${base}/redirect/4`, file, { allowHttp: true }), /3 次/);
  await assert.rejects(downloadResult(`${base}/large-header`, file, { allowHttp: true }), /1GB/);
  await assert.rejects(downloadResult(`${base}/large-stream`, file, { allowHttp: true, maxBytes: 5 }), /1GB/);
  await assert.rejects(downloadResult(`${base}/slow`, file, { allowHttp: true, timeoutMs: 30 }), /abort/i);
  assert.equal(fs.existsSync(`${file}.part`), false);
  assert.equal(fs.existsSync(file), false);
});
