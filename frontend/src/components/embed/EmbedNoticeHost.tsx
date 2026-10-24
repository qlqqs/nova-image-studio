'use client';

import { AlertCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { dismissEmbedNotice } from '@/lib/embed/notices';
import { postToParent } from '@/lib/embed/session';
import { useEmbedNotice } from '@/components/embed/hooks';

/** 网关错误的全局提示（余额不足 →「去充值」，Key 失效 →「管理密钥」）。 */
export function EmbedNoticeHost() {
  const notice = useEmbedNotice();
  if (!notice) return null;
  return (
    <div role="alert" className="fixed bottom-4 left-1/2 z-[10001] flex w-[min(92vw,30rem)] -translate-x-1/2 items-start gap-3 rounded-lg border border-destructive/30 bg-card px-4 py-3 text-sm shadow-lg">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 text-foreground">{notice.message}</p>
      {notice.action && (
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => {
            postToParent({ type: 'nova:navigate', path: notice.action!.path });
            dismissEmbedNotice();
          }}
        >
          {notice.action.label}
        </Button>
      )}
      <button type="button" aria-label="关闭" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={dismissEmbedNotice}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
