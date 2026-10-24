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
  const gateway = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    requests.push({ url: req.url, headers: req.headers, raw });
    if (req.headers.authorization === 'Bearer redirect-key') {
      res.writeHead(307, { Location: `${target}/leak` }); res.end(); return;
    }
    res.setHeader('Content-Type', 'application/json');
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
  seed.close();
  fs.mkdirSync(path.join(temp, 'images'));
  fs.writeFileSync(path.join(temp, 'images/expired-0-0.png'), 'expired image');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server.js')], {
    cwd: temp,
    env: {
      ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port),
      NOVA_EMBED_MODE: '1', SUB2API_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
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
  return { call, create, completed, dbPath, requests, target, base, temp,
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

test('embed proxies ignore official/attacker bases, reject redirects and external result URLs; video/CDP closed', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  for (const route of ['/cdp/status', '/plugin-media/anything', '/plugin-tasks/anything']) {
    assert.equal((await f.call(route)).status, 404);
  }
  assert.equal((await f.call('/plugin-tasks', '1', {})).status, 404);
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
