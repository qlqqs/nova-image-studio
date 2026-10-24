'use client';

import { forwardRef, type ImgHTMLAttributes } from 'react';
import { useAuthedImageSrc } from '@/lib/embed/authed-image';

/**
 * <img> 的替身：嵌入模式下 /api/nova/images/... 先经带会话鉴权的 fetch 取成 blob URL 再显示
 * （docs/sub2api-embed.md §5）；其他地址与独立模式下行为与 <img> 完全一致。
 */
export const AuthedImg = forwardRef<HTMLImageElement, ImgHTMLAttributes<HTMLImageElement>>(function AuthedImg({ src, alt, ...rest }, ref) {
  const resolved = useAuthedImageSrc(typeof src === 'string' ? src : undefined);
  return <img ref={ref} src={typeof src === 'string' ? resolved : src} alt={alt} {...rest} />;
});
