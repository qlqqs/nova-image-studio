/**
 * 静态资源前缀。嵌入构建时 next.config 注入 NEXT_PUBLIC_NOVA_BASE_PATH=/_nova；
 * 独立构建为空串，withBasePath 原样返回，行为不变。
 * 注意：API 仍在站点根（/api/nova、/api/v1），不要对 API 路径使用本函数。
 */
export const NOVA_BASE_PATH = (process.env.NEXT_PUBLIC_NOVA_BASE_PATH || '').replace(/\/+$/, '');

export function withBasePath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${NOVA_BASE_PATH}${normalized}`;
}
