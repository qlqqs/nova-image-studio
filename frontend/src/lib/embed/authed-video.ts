/**
 * 受保护的插件任务结果视频（contract C4）：/api/nova/plugin-results/<taskId>/<n> 需要会话鉴权，
 * 响应为 private, no-store。用带会话令牌的 fetch 取成 blob 再播放 / 下载，不能直接 <video src>。
 * 视频体积大，只在需要时（进入视口、打开预览、点击下载）才取，使用方卸载时回收 blob URL。
 */
import { useEffect, useState } from 'react';
import { isEmbedMode } from '@/lib/embed/mode';

const PROTECTED_PATH = /^\/api\/nova\/plugin-results\//;

function resolve(src: string): URL | null {
  try {
    return new URL(src, typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
  } catch {
    return null;
  }
}

/** 是否为需要会话鉴权的同源结果视频地址（只在嵌入模式下为 true）。 */
export function isProtectedVideoUrl(src: string | null | undefined, embedded: boolean = isEmbedMode()): boolean {
  if (!embedded || !src) return false;
  const url = resolve(src);
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  return Boolean(url && url.origin === origin && PROTECTED_PATH.test(url.pathname));
}

/** 用（已包装、会附加会话令牌的）fetch 取视频。 */
export async function fetchAuthedVideoBlob(src: string, fetchFn: typeof fetch = (input, init) => fetch(input, init)): Promise<Blob> {
  const url = resolve(src);
  const response = await fetchFn(url ? `${url.pathname}${url.search}` : src, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(response.status === 404 ? '视频已过期或不存在' : `视频读取失败（HTTP ${response.status}）`);
  return response.blob();
}

export interface AuthedVideoState {
  /** 可播放的地址：受保护地址为 blob URL（加载中为 undefined），其他地址原样返回 */
  url?: string;
  loading: boolean;
  error: string | null;
}

/** active 为 true 时才开始取；src 变化或卸载时回收 blob URL。 */
export function useAuthedVideoSrc(
  src: string | null | undefined,
  active: boolean,
  fetchFn?: typeof fetch,
): AuthedVideoState {
  const needsAuth = isProtectedVideoUrl(src);
  const [loaded, setLoaded] = useState<{ src: string; url?: string; error?: string } | null>(null);

  useEffect(() => {
    if (!needsAuth || !src || !active) return undefined;
    let alive = true;
    let objectUrl: string | null = null;
    fetchAuthedVideoBlob(src, fetchFn).then(
      (blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (alive) setLoaded({ src, url: objectUrl });
        else URL.revokeObjectURL(objectUrl);
      },
      (error: unknown) => {
        if (alive) setLoaded({ src, error: error instanceof Error ? error.message : '视频读取失败' });
      },
    );
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [needsAuth, src, active, fetchFn]);

  if (!src) return { loading: false, error: null };
  if (!needsAuth) return { url: src, loading: false, error: null };
  const current = loaded && loaded.src === src ? loaded : null;
  return { url: current?.url, loading: active && !current, error: current?.error ?? null };
}
