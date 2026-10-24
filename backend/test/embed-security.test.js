const assert = require('node:assert/strict');
const test = require('node:test');
const { createEmbedSecurity } = require('../embed/security');

const env = { NOVA_EMBED_MODE: '1', SUB2API_GATEWAY_URL: 'http://gateway:8080' };
const request = (headers = {}, address = '127.0.0.1') => ({
  socket: { remoteAddress: address }, headers: {
    'x-sub2api-user-id': '12', 'x-sub2api-user-role': 'user',
    'x-forwarded-for': '203.0.113.8', ...headers,
  },
});

test('standalone remains opt-in; embedded configuration fails closed', () => {
  assert.deepEqual(createEmbedSecurity({}), { enabled: false });
  for (const url of [undefined, '', 'file:///tmp/a', 'https://u:p@example.com', 'https://example.com/v1', 'https://example.com/?key=a']) {
    assert.throws(() => createEmbedSecurity({ ...env, SUB2API_GATEWAY_URL: url }));
  }
  for (const cidrs of ['', 'localhost/32', '127.0.0.1', '127.0.0.1/33', '::1/129', '::1/128/0']) {
    assert.throws(() => createEmbedSecurity({ ...env, NOVA_TRUSTED_PROXY_CIDRS: cidrs }));
  }
  for (const days of ['0', '-1', 'NaN', '0.5']) {
    assert.throws(() => createEmbedSecurity({ ...env, NOVA_RETENTION_DAYS: days }));
  }
  assert.equal(createEmbedSecurity(env).retentionMs, 7 * 86400000);
});

test('trust TCP source only; validate ID, role and single forwarded IP', () => {
  const security = createEmbedSecurity(env);
  const user = security.requireUser(request());
  assert.equal(user.userId, '12');
  assert.deepEqual(security.requireUser(request({}, '::ffff:127.0.0.1')), user);
  assert.throws(() => security.requireUser(request({}, '172.20.0.2')), { code: 'UNTRUSTED_SOURCE' });
  for (const id of [undefined, '', '0', '-1', '1, 2', '01', ['12']]) {
    assert.throws(() => security.requireUser(request({ 'x-sub2api-user-id': id })), { statusCode: 401 });
  }
  assert.throws(() => security.requireUser(request({ 'x-sub2api-user-role': 'owner' })), { statusCode: 401 });
  for (const ip of [undefined, '203.0.113.8, 127.0.0.1', 'localhost']) {
    assert.throws(() => security.requireUser(request({ 'x-forwarded-for': ip })), { code: 'INVALID_CLIENT_IP' });
  }
  assert.throws(() => security.requireAdmin(user), { statusCode: 403 });
  security.requireAdmin(security.requireUser(request({ 'x-sub2api-user-role': 'admin' })));
  assert.equal(security.ownsTask({ user_id: '12' }, user), true);
  assert.equal(security.ownsTask({ user_id: '13' }, user), false);
  assert.equal(security.ownsTask({ user_id: null }, user), false);
});

test('tickets expire, cannot replay, and cannot be consumed by an untrusted peer', () => {
  let time = 0;
  const security = createEmbedSecurity(env, () => time);
  const user = security.requireUser(request());
  const { ticket } = security.issueTicket(user);
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => security.consumeTicket(request({}, '192.0.2.1'), ticket), { statusCode: 403 });
  assert.deepEqual(security.consumeTicket(request(), ticket), user);
  assert.throws(() => security.consumeTicket(request(), ticket), { statusCode: 401 });
  const expired = security.issueTicket(user).ticket;
  time = 60000;
  assert.throws(() => security.consumeTicket(request(), expired), { statusCode: 401 });
});

test('outbound gate checks exact origin and refuses redirects; replaces spoofed IP headers', () => {
  const security = createEmbedSecurity(env);
  const init = security.prepareFetch('http://gateway:8080/v1/models', {
    headers: { Authorization: 'Bearer test-key', 'X-Forwarded-For': '127.0.0.1', Forwarded: 'for=127.0.0.1' },
  }, '203.0.113.8');
  assert.equal(init.headers.get('x-forwarded-for'), '203.0.113.8');
  assert.equal(init.headers.get('forwarded'), null);
  assert.equal(init.headers.get('authorization'), 'Bearer test-key');
  assert.equal(init.redirect, 'error');
  for (const url of ['http://gateway:8081/a', 'https://api.openai.com/v1/models', 'http://gateway:8080.evil/a', 'http://u:p@gateway:8080/a']) {
    assert.throws(() => security.prepareFetch(url, {}, '203.0.113.8'));
  }
  assert.throws(() => security.prepareFetch('http://gateway:8080/a', {}, undefined), { code: 'MISSING_CLIENT_IP' });
});
