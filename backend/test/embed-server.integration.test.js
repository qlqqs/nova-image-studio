const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { WebSocket } = require('ws');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function waitFor(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Condition timed out');
}

async function fixture(t, extraEnv = {}) {
  const requests = [];
  let forbiddenHits = 0;
  const held = [];
  let activeRequests = 0;
  let peakRequests = 0;
  const forbidden = http.createServer((_req, res) => { forbiddenHits++; res.end('{}'); });
  const forbiddenPort = await listen(forbidden);
  const target = `http://127.0.0.1:${forbiddenPort}`;
  const videoTasks = new Map();
  const gateway = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    requests.push({ url: req.url, headers: req.headers, raw });
    if (req.headers.authorization === 'Bearer redirect-key') {
      res.writeHead(307, { Location: `${target}/leak` }); res.end(); return;
    }
    if (req.url === '/video.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end('mock-video-bytes'); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v3/contents/generations/tasks' && req.method === 'POST') {
      const id = `up-video-${videoTasks.size}`;
      videoTasks.set(id, JSON.parse(raw));
      res.end(JSON.stringify({ id })); return;
    }
    if (req.url.startsWith('/api/v3/contents/generations/tasks/')) {
      const input = videoTasks.get(req.url.split('/').pop());
      const prompt = input.content[0].text;
      res.end(JSON.stringify(prompt === 'long-video' ? { status: 'running' } : { status: 'succeeded', duration: 5,
        content: { video_url: prompt === 'fail-download' ? 'http://invalid.test/video.mp4' : `http://127.0.0.1:${gatewayPort}/video.mp4` } }));
      return;
    }
    if (req.url === '/v1/images/generations') {
      const body = JSON.parse(raw);
      if (body.prompt === 'hold') {
        activeRequests++;
        peakRequests = Math.max(peakRequests, activeRequests);
        await new Promise(resolve => held.push(resolve));
        activeRequests--;
      }
      if (body.prompt === 'remote-image') {
        res.end(JSON.stringify({ data: [{ url: `${target}/result.png` }] })); return;
      }
      res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('image-bytes').toString('base64') }] }));
    } else {
      res.end(JSON.stringify({ data: [], ok: true }));
    }
  });
  const gatewayPort = await listen(gateway);
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-embed-test-'));
  const dbPath = path.join(temp, 'tasks.sqlite');
  // Seed an old standalone schema and an unowned task to exercise the migration.
  const seed = new Database(dbPath);
  seed.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, mode TEXT NOT NULL,
    request_json TEXT NOT NULL, result_json TEXT, error TEXT, warning TEXT, created_at TEXT NOT NULL,
    completed_at TEXT, expires_at TEXT);`);
  seed.prepare('INSERT INTO tasks (id,status,mode,request_json,created_at) VALUES (?,?,?,?,?)')
    .run('legacy', 'completed', 'text-to-image', '{}', new Date().toISOString());
  seed.prepare('INSERT INTO tasks (id,status,mode,request_json,created_at,expires_at) VALUES (?,?,?,?,?,?)')
    .run('expired', 'completed', 'text-to-image', '{}', '2000-01-01', '2000-01-02');
  seed.prepare('INSERT INTO tasks (id,status,mode,request_json,created_at) VALUES (?,?,?,?,?)')
    .run('interrupted-video', 'processing', 'plugin', JSON.stringify({ pluginId: 'qx-seedance', upstreamTaskId: 'up-before-restart' }), new Date().toISOString());
  seed.prepare('INSERT INTO tasks (id,status,mode,request_json,created_at,expires_at) VALUES (?,?,?,?,?,?)')
    .run('expired-video', 'completed', 'plugin', '{}', '2000-01-01', '2000-01-02');
  seed.exec('CREATE TABLE plugin_media (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, kind TEXT NOT NULL, bytes INTEGER NOT NULL, task_id TEXT, created_at TEXT NOT NULL)');
  seed.prepare('INSERT INTO plugin_media (file_name,hash,kind,bytes,task_id,created_at) VALUES (?,?,?,?,?,?)')
    .run('expired-ref.png', 'hash', 'images', 5, 'expired-video', '2000-01-01');
  for (const [directory, name] of [['videos', 'expired-video-0.mp4'], ['plugin-media', 'expired-ref.png']]) {
    fs.mkdirSync(path.join(temp, directory));
    fs.writeFileSync(path.join(temp, directory, name), 'expired-bytes');
  }
  seed.close();
  fs.mkdirSync(path.join(temp, 'images'));
  fs.writeFileSync(path.join(temp, 'images/expired-0-0.png'), 'expired image');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server.js')], {
    cwd: temp,
    env: {
      ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port),
      NOVA_EMBED_MODE: '1', NOVA_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, NOVA_VIDEO_RETENTION_DAYS: '3',
      SUB2API_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
      NOVA_TRUSTED_PROXY_CIDRS: '127.0.0.1/32', NOVA_RETENTION_DAYS: '7',
      NOVA_TASK_DB: dbPath, NOVA_IMAGE_DIR: path.join(temp, 'images'), NOVA_CDP_DIR: path.join(temp, 'cdp'),
      NOVA_IMAGE_STREAM: 'false', NOVA_CDP_ENABLED: 'true',
      NOVA_RATE_LIMIT_MAX_REQUESTS_PER_IP: '0', NOVA_MAX_QUEUE_SIZE: '0',
      NOVA_TASK_CONCURRENCY: '2', ...extraEnv,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    while (held.length) held.shift()();
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      await stopped;
      clearTimeout(kill);
    }
    for (const server of [gateway, forbidden]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await waitFor(() => {
    assert.equal(child.exitCode, null, logs);
    return logs.includes('server ready');
  });
  const base = `http://127.0.0.1:${port}`;
  async function call(route, user = '1', body, options = {}) {
    return fetch(`${base}/api/nova${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(user ? { 'X-Sub2API-User-Id': user, 'X-Sub2API-User-Role': 'user', 'X-Forwarded-For': `203.0.113.${user}` } : {}),
        ...options.headers,
      }, body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const taskBody = { apiKey: 'test-key', baseUrl: target, protocol: 'openai', mode: 'text-to-image',
    prompt: 'test', model: 'test-image', parallelCount: 1, outputSize: 'auto', aspectRatio: 'auto', images: [] };
  async function create(user = '1', overrides = {}) {
    const response = await call('/tasks', user, { ...taskBody, ...overrides });
    assert.equal(response.status, 202, await response.clone().text());
    return (await response.json()).taskId;
  }
  async function completed(id, user = '1') {
    return waitFor(async () => {
      const task = await (await call(`/tasks/${id}`, user)).json();
      return ['completed', 'failed'].includes(task.status) && task;
    });
  }
  return { call, create, completed, dbPath, requests, target, base, temp, child,
    heldCount: () => held.length, release: () => { while (held.length) held.shift()(); }, peakRequests: () => peakRequests, logs: () => logs, forbiddenHits: () => forbiddenHits };
}

test('embed HTTP ownership, retention, private images, gateway lock and IP per queued task', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/config', null)).status, 401);
  assert.equal((await f.call('/tasks/legacy')).status, 404);
  const [a, b] = await Promise.all([f.create('1', { parallelCount: 9 }), f.create('2')]);
  const [ta, tb] = await Promise.all([f.completed(a), f.completed(b, '2')]);
  assert.equal(ta.status, 'completed');
  assert.equal(tb.status, 'completed');
  assert.equal(f.requests.length, 10);
  assert.equal(f.requests.filter(r => r.headers['x-forwarded-for'] === '203.0.113.1').length, 9);
  assert.equal(f.requests.filter(r => r.headers['x-forwarded-for'] === '203.0.113.2').length, 1);
  for (const route of [`/tasks/${a}`, `/images/${a}/0`]) {
    const denied = await f.call(route, '2');
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).code, 'NOT_FOUND');
  }
  assert.equal((await f.call(`/tasks/${a}/ack`, '2', {})).status, 404);
  const image = await f.call(`/images/${a}/0`);
  assert.equal(image.status, 200);
  assert.equal(await image.text(), 'image-bytes');
  assert.match(image.headers.get('cache-control'), /no-store/);
  const db = new Database(f.dbPath);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT id FROM tasks WHERE id=?').get('expired'), undefined);
  assert.equal(fs.existsSync(path.join(f.temp, 'images/expired-0-0.png')), false);
  assert.equal(db.prepare('SELECT id FROM tasks WHERE id=?').get('expired-video'), undefined);
  assert.equal(fs.existsSync(path.join(f.temp, 'videos/expired-video-0.mp4')), false);
  assert.equal(fs.existsSync(path.join(f.temp, 'plugin-media/expired-ref.png')), false);
  const before = db.prepare('SELECT * FROM tasks WHERE id=?').get(a);
  assert.equal(before.user_id, '1');
  assert.doesNotMatch(before.request_json, /test-key|203\.0\.113/);
  assert.ok(Date.parse(before.expires_at) - Date.parse(before.completed_at) >= 7 * 86400000 - 10);
  await f.call(`/tasks/${a}/ack`, '1', {});
  assert.equal(db.prepare('SELECT expires_at FROM tasks WHERE id=?').get(a).expires_at, before.expires_at);
  db.prepare('UPDATE tasks SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', a);
  assert.equal((await f.call(`/images/${a}/0`)).status, 404);
  assert.equal((await f.call(`/tasks/${a}/ack`, '1', {})).status, 404);
  assert.equal(f.forbiddenHits(), 0);
});

test('embed proxies ignore official/attacker bases, reject redirects and external image URLs; CDP closed', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  for (const route of ['/cdp/status', '/plugin-media/anything', '/plugin-tasks/anything']) {
    assert.equal((await f.call(route)).status, 404);
  }
  assert.equal((await f.call('/plugin-tasks', '1', {})).status, 400);
  assert.equal((await f.call('/plugin-media/anything', null)).status, 404);
  assert.equal((await f.call('/plugins?reload=1')).status, 403);
  assert.equal((await f.call('/plugins?reload=1', '1', undefined, { headers: { 'X-Sub2API-User-Role': 'admin' } })).status, 200);
  for (const baseUrl of [f.target, 'https://api.openai.com', undefined]) {
    assert.equal((await f.call('/proxy/models', '1', { baseUrl, apiKey: 'test-key' })).status, 200);
    assert.equal((await f.call('/proxy/text', '1', { baseUrl, apiKey: 'test-key', protocol: 'openai-chat-completions', requestBody: { model: 'test', messages: [] } })).status, 200);
  }
  const edited = await fetch(`${f.base}/api/nova/proxy/image-edit`, {
    method: 'POST', headers: { 'X-Sub2API-User-Id': '1', 'X-Sub2API-User-Role': 'user', 'X-Forwarded-For': '203.0.113.1',
      'X-Nova-Base-Url': f.target, 'X-Nova-Api-Key': 'test-key', 'Content-Type': 'multipart/form-data; boundary=test' },
    body: '--test--\r\n',
  });
  assert.equal(edited.status, 200);
  assert.equal(f.requests.at(-1).url, '/v1/images/edits');
  assert.equal(f.requests.at(-1).headers['x-forwarded-for'], '203.0.113.1');
  assert.equal((await f.call('/proxy/models', '1', { apiKey: 'redirect-key', baseUrl: f.target })).status, 502);
  const id = await f.create('1', { prompt: 'remote-image' });
  const task = await f.completed(id);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /UPSTREAM_NOT_ALLOWED/);
  assert.equal(f.forbiddenHits(), 0);
  assert.doesNotMatch(f.logs(), /redirect-key|test-key/);
});

test('untrusted direct requests cannot supply identity headers', { timeout: 30000 }, async t => {
  const f = await fixture(t, { NOVA_TRUSTED_PROXY_CIDRS: '192.0.2.0/24' });
  assert.equal((await f.call('/config')).status, 403);
});

test('WebSocket uses one-time tickets and filters task subscriptions and queue events', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const [own, other] = await Promise.all([f.create(), f.create('2')]);
  await Promise.all([f.completed(own), f.completed(other, '2')]);
  const { ticket } = await (await f.call('/ws-ticket', '1', {})).json();
  const wsUrl = f.base.replace('http:', 'ws:') + `/api/nova/ws?ticket=${ticket}`;
  const ws = new WebSocket(wsUrl);
  t.after(() => ws.terminate());
  const received = [];
  ws.on('message', data => received.push(JSON.parse(data.toString())));
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'subscribeTasks', taskIds: [other, 'legacy', 'missing', own] }));
  ws.send(JSON.stringify({ type: 'subscribeQueue' }));
  ws.send(JSON.stringify({ type: 'ping' }));
  await waitFor(() => received.some(message => message.type === 'pong'));
  assert.deepEqual(received.filter(m => m.type === 'task').map(m => m.task.id), [own]);
  const stats = received.find(m => m.type === 'queueStatus').stats;
  assert.equal(stats.processingCount, 0);
  assert.equal(stats.queuedCount, 0);
  assert.equal('maxQueueSize' in stats, false);
  const replay = new WebSocket(wsUrl);
  const status = await new Promise(resolve => {
    replay.on('unexpected-response', (_req, response) => { response.resume(); replay.terminate(); resolve(response.statusCode); });
    replay.on('error', () => {});
  });
  assert.equal(status, 401);
});


test('oversized batches obey global concurrency while queue statistics remain per user', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const large = await f.create('1', { parallelCount: 5, prompt: 'hold' });
  await waitFor(() => f.heldCount() === 2);
  const other = await f.create('2');
  const [one, two] = await Promise.all([
    f.call('/queue-status', '1').then(r => r.json()), f.call('/queue-status', '2').then(r => r.json()),
  ]);
  assert.equal(one.processingCount, 1);
  assert.equal(one.queuedCount, 0);
  assert.equal(two.processingCount, 0);
  assert.equal(two.queuedCount, 1);
  assert.equal(one.busy, true);
  f.release();
  await waitFor(() => f.heldCount() === 2);
  f.release();
  await waitFor(() => f.heldCount() === 1);
  f.release();
  assert.equal((await f.completed(large)).status, 'completed');
  assert.equal((await f.completed(other, '2')).status, 'completed');
  assert.equal(f.peakRequests(), 2);
});

const videoBody = { pluginId: 'qx-seedance', apiKey: 'video-key',
  facets: { targetModel: 'seedance-2.5', mode: 't2v' }, fields: { prompt: 'video' }, media: {} };

async function videoTask(f, overrides = {}, user = '1') {
  const response = await f.call('/plugin-tasks', user, { ...videoBody, baseUrl: f.target, ...overrides });
  assert.equal(response.status, 202, await response.clone().text());
  return (await response.json()).taskId;
}

async function finishedVideo(f, id, user = '1') {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const task = await (await f.call(`/plugin-tasks/${id}`, user)).json();
    if (['completed', 'failed'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Video did not complete');
}

test('embed plugin ownership, gateway lock/XFF, signed media preview and private ranged video results', { timeout: 30000 }, async t => {
  const f = await fixture(t, { NOVA_RESULT_DOWNLOAD_ALLOW_HTTP: '1' });
  assert.equal((await f.call('/plugin-tasks', null, videoBody)).status, 401);
  assert.equal((await f.call('/plugin-media?pluginId=qx-seedance&kind=images', null, {})).status, 401);
  const db = new Database(f.dbPath);
  t.after(() => db.close());
  const upload = async user => {
    const response = await fetch(`${f.base}/api/nova/plugin-media?pluginId=qx-seedance&kind=images`, { method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-Sub2API-User-Id': user, 'X-Sub2API-User-Role': 'user', 'X-Forwarded-For': `203.0.113.${user}` },
      body: 'uploaded-image' });
    assert.equal(response.status, 200);
    return response.json();
  };
  const [media, otherMedia] = await Promise.all([upload('1'), upload('2')]);
  assert.notEqual(media.url, otherMedia.url);
  assert.equal((await f.call(new URL(media.url).pathname.replace('/api/nova', ''))).status, 404);
  assert.equal((await f.call(media.previewUrl.replace('/api/nova', ''), '2')).status, 404);
  const preview = await f.call(media.previewUrl.replace('/api/nova', ''), '1', undefined, { headers: { Range: 'bytes=0-3' } });
  assert.equal(preview.status, 206);
  assert.equal(preview.headers.get('cache-control'), 'private, no-store');
  assert.equal(await preview.text(), 'uplo');
  const denied = await f.call('/plugin-tasks', '2', { ...videoBody, facets: { targetModel: 'seedance-2.5', mode: 'i2v' }, media: { firstFrame: [media.url] } });
  assert.equal(denied.status, 404);
  const id = await videoTask(f, { facets: { targetModel: 'seedance-2.5', mode: 'reference' },
    media: { referenceImages: [media.url, 'https://media.test/external.png'] } });
  for (const route of [`/plugin-tasks/${id}`, `/plugin-results/${id}/0`]) assert.equal((await f.call(route, '2')).status, 404);
  assert.equal((await f.call(`/plugin-results/${id}/0`, null)).status, 401);
  assert.equal((await f.call(`/plugin-tasks/${id}/ack`, '2', {})).status, 404);
  await waitFor(() => f.requests.some(r => r.url === '/api/v3/contents/generations/tasks'));
  const submit = f.requests.find(r => r.url === '/api/v3/contents/generations/tasks');
  assert.equal(submit.headers['x-forwarded-for'], '203.0.113.1');
  const content = JSON.parse(submit.raw).content;
  const publicUrl = new URL(content[1].image_url.url);
  assert.match(publicUrl.pathname, /^\/api\/nova\/public-media\//);
  assert.equal(content[2].image_url.url, 'https://media.test/external.png');
  const publicResult = await fetch(publicUrl, { headers: { Range: 'bytes=2-5' } });
  assert.equal(publicResult.status, 206);
  assert.equal(await publicResult.text(), 'load');
  const head = await fetch(publicUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'image/png');
  for (const change of [url => url.searchParams.set('sig', '0'.repeat(64)), url => url.searchParams.set('exp', '1'), url => { url.pathname = url.pathname.replace(/[^/]+$/, 'missing.png'); }]) {
    const changed = new URL(publicUrl); change(changed);
    assert.equal((await fetch(changed)).status, 404);
  }
  const missingUrl = new URL(publicUrl);
  missingUrl.pathname = '/api/nova/public-media/missing.png';
  const missingSig = require('node:crypto').createHmac('sha256', fs.readFileSync(path.join(f.temp, 'media-signing.key'), 'utf8').trim())
    .update(`missing.png\n${missingUrl.searchParams.get('exp')}`).digest('hex');
  missingUrl.searchParams.set('sig', missingSig);
  assert.equal((await fetch(missingUrl)).status, 404);
  const done = await finishedVideo(f, id);
  assert.equal(done.status, 'completed', done.error);
  assert.deepEqual(done.result.assets[0], { kind: 'video', mime: 'video/mp4', url: `/api/nova/plugin-results/${id}/0`, durationSec: 5 });
  const result = await f.call(`/plugin-results/${id}/0`, '1', undefined, { headers: { Range: 'bytes=5-9' } });
  assert.equal(result.status, 206);
  assert.equal(await result.text(), 'video');
  assert.equal(result.headers.get('content-type'), 'video/mp4');
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  assert.equal(row.user_id, '1');
  assert.doesNotMatch(row.request_json, /video-key/);
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.completed_at), 3 * 86400000);
  await f.call(`/plugin-tasks/${id}/ack`, '1', {});
  assert.equal(db.prepare('SELECT expires_at FROM tasks WHERE id=?').get(id).expires_at, row.expires_at);
  const polls = f.requests.filter(r => r.url.endsWith('/up-video-0'));
  assert.ok(polls.length);
  assert.ok(polls.every(r => r.headers['x-forwarded-for'] === '203.0.113.1'));
  assert.equal(f.forbiddenHits(), 0);
  db.prepare('UPDATE tasks SET expires_at=? WHERE id=?').run('2000-01-01', id);
  for (const route of [`/plugin-tasks/${id}`, `/plugin-tasks/${id}/ack`, `/plugin-results/${id}/0`]) {
    assert.equal((await f.call(route, '1', route.endsWith('/ack') ? {} : undefined)).status, 404);
  }
});

test('video download protocol failure preserves accurate charged/task-ID message; API redirects do not leak', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const id = await videoTask(f, { fields: { prompt: 'fail-download' } });
  const done = await finishedVideo(f, id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /上游已生成并计费.*下载.*up-video-0/);
  const redirected = await videoTask(f, { apiKey: 'redirect-key' });
  assert.equal((await finishedVideo(f, redirected)).status, 'failed');
  assert.equal(f.forbiddenHits(), 0);
});

test('restart interrupts plugin tasks without persisted keys; processing video has no premature expiry', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const db = new Database(f.dbPath);
  t.after(() => db.close());
  const interrupted = db.prepare('SELECT * FROM tasks WHERE id=?').get('interrupted-video');
  assert.equal(interrupted.status, 'failed');
  assert.match(interrupted.error, /服务重启，任务中断.*up-before-restart/);
  assert.equal(Date.parse(interrupted.expires_at) - Date.parse(interrupted.completed_at), 3 * 86400000);
  const id = await videoTask(f, { fields: { prompt: 'long-video' } });
  await waitFor(() => db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status === 'processing');
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  assert.equal(row.expires_at, null);
  assert.doesNotMatch(row.request_json, /video-key/);
  const keyFile = path.join(f.temp, 'media-signing.key');
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
});
