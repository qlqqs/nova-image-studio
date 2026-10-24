const { randomBytes } = require('node:crypto');
const { BlockList, isIP } = require('node:net');

function httpError(statusCode, code) {
  return Object.assign(new Error(code), { statusCode, code });
}

// Startup-only policy: a request or hot-reloaded .env must not weaken this boundary.
function createEmbedSecurity(env = process.env, now = Date.now) {
  const enabled = env.NOVA_EMBED_MODE === '1';
  if (!enabled) return { enabled: false };

  let gateway;
  try {
    gateway = new URL(env.SUB2API_GATEWAY_URL);
  } catch {
    throw new Error('Embedded mode requires SUB2API_GATEWAY_URL');
  }
  if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password
    || gateway.search || gateway.hash || gateway.pathname !== '/') {
    throw new Error('SUB2API_GATEWAY_URL must be an HTTP(S) origin without credentials or a path');
  }
  const retentionDays = Number(env.NOVA_RETENTION_DAYS ?? 7);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 36500) {
    throw new Error('NOVA_RETENTION_DAYS must be a positive integer (at most 36500)');
  }

  const trusted = new BlockList();
  const cidrs = env.NOVA_TRUSTED_PROXY_CIDRS ?? '127.0.0.1/32,::1/128';
  for (const cidr of cidrs.split(',')) {
    const [address, prefix, extra] = cidr.trim().split('/');
    const family = isIP(address);
    if (!family || extra !== undefined || !/^\d+$/.test(prefix || '')
      || Number(prefix) > (family === 4 ? 32 : 128)) {
      throw new Error('Invalid NOVA_TRUSTED_PROXY_CIDRS');
    }
    trusted.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
  }

  function requireTrustedSource(req) {
    const address = req.socket?.remoteAddress;
    const family = isIP(address || '');
    if (!family || !trusted.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
      throw httpError(403, 'UNTRUSTED_SOURCE');
    }
  }

  function requireUser(req) {
    requireTrustedSource(req);
    const userId = req.headers['x-sub2api-user-id'];
    const role = req.headers['x-sub2api-user-role'];
    const clientIp = req.headers['x-forwarded-for'];
    if (typeof userId !== 'string' || !/^[1-9]\d{0,18}$/.test(userId)
      || !['admin', 'user'].includes(role)) {
      throw httpError(401, 'UNAUTHENTICATED');
    }
    // The proxy must replace the entire incoming chain with its resolved client IP.
    if (typeof clientIp !== 'string' || !isIP(clientIp)) {
      throw httpError(400, 'INVALID_CLIENT_IP');
    }
    return Object.freeze({ userId, role, clientIp });
  }

  const tickets = new Map();
  function pruneTickets() {
    for (const [ticket, value] of tickets) {
      if (value.expiresAt <= now()) tickets.delete(ticket);
    }
  }
  function issueTicket(user) {
    pruneTickets();
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, { user, expiresAt: now() + 60000 });
    return { ticket, expiresInSec: 60 };
  }
  function consumeTicket(req, ticket) {
    requireTrustedSource(req);
    pruneTickets();
    const value = tickets.get(ticket);
    tickets.delete(ticket);
    if (!value) throw httpError(401, 'INVALID_TICKET');
    return value.user;
  }

  function prepareFetch(url, init, clientIp) {
    const target = new URL(url);
    if (target.origin !== gateway.origin || target.username || target.password) {
      throw httpError(502, 'UPSTREAM_NOT_ALLOWED');
    }
    if (!isIP(clientIp || '')) throw httpError(500, 'MISSING_CLIENT_IP');
    const headers = new Headers(init.headers);
    headers.delete('forwarded');
    headers.set('x-forwarded-for', clientIp);
    headers.set('x-real-ip', clientIp);
    // Even a gateway response must not redirect API keys or POST bodies elsewhere.
    return { ...init, headers, redirect: 'error' };
  }

  return {
    enabled, gatewayUrl: gateway.origin, retentionMs: retentionDays * 86400000,
    requireUser, issueTicket, consumeTicket, prepareFetch, pruneTickets,
    ownsTask: (task, user) => !!task && !!user && task.user_id === user.userId,
    requireAdmin: (user) => {
      if (user?.role !== 'admin') throw httpError(403, 'ADMIN_REQUIRED');
    },
  };
}

module.exports = { createEmbedSecurity, httpError };
