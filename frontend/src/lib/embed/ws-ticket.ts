/**
 * 嵌入模式 WebSocket 建连（docs/sub2api-embed.md §4）：
 * 每次（重）连都先 POST /api/nova/ws-ticket（经 sub2api 校验会话）拿一次性 ticket，
 * 再连 /api/nova/ws?ticket=...。JWT 不进 URL。
 */
export async function fetchWsTicket(fetchFn: typeof fetch = (input, init) => fetch(input, init)): Promise<string> {
  const response = await fetchFn('/api/nova/ws-ticket', { method: 'POST', cache: 'no-store' });
  if (!response.ok) throw new Error(`ws-ticket HTTP ${response.status}`);
  const data = await response.json().catch(() => null) as { ticket?: unknown } | null;
  const ticket = typeof data?.ticket === 'string' ? data.ticket : '';
  if (!ticket) throw new Error('ws-ticket missing');
  return ticket;
}

export function buildTicketSocketUrl(ticket: string, href: string = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'): string {
  const url = new URL('/api/nova/ws', href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  url.searchParams.set('ticket', ticket);
  return url.toString();
}

export async function buildEmbedSocketUrl(): Promise<string> {
  return buildTicketSocketUrl(await fetchWsTicket());
}
