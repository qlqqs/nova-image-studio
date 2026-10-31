'use client';

import { useEffect, useRef, useState, type VideoHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthedVideoSrc } from '@/lib/embed/authed-video';
import { cn } from '@/lib/utils';

/**
 * <video> 的替身：嵌入模式下插件结果视频进入视口后才经带会话鉴权的 fetch 取成 blob 播放，
 * 卸载时回收（contract C4）；其他地址与独立模式下行为与 <video> 一致。
 */
export function AuthedVideo({ src, className, ...rest }: Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'> & { src?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || visible) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  const state = useAuthedVideoSrc(src, visible);
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <video ref={ref} src={state.url} className={className} {...rest} />
      {(state.loading || state.error) && (
        <span className={cn('absolute inset-0 flex items-center justify-center gap-2 text-xs', state.error ? 'text-destructive' : 'text-white/70')}>
          {state.loading && <Loader2 className="size-4 animate-spin" />}
          {state.error || '正在加载视频…'}
        </span>
      )}
    </div>
  );
}
