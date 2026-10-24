'use client';

import { useEffect, useState } from 'react';
import { isEmbedMode } from '@/lib/embed/mode';
import { estimateImageCost, loadPlazaGroups } from '@/lib/embed/cost-estimate';
import type { PlazaGroup } from '@/lib/embed/sub2api-client';
import { useStudioKeys } from '@/components/embed/hooks';
import { cn } from '@/lib/utils';

/** 提交按钮旁的预估费用（PRD R6.2）；独立模式或无定价时不显示。 */
export function EmbedCostEstimate({ model, outputSize, count, className }: {
  model: string;
  outputSize?: string;
  count: number;
  className?: string;
}) {
  const embedded = isEmbedMode();
  const keys = useStudioKeys();
  const [plaza, setPlaza] = useState<PlazaGroup[] | null>(null);

  useEffect(() => {
    if (!embedded) return undefined;
    let active = true;
    void loadPlazaGroups().then((groups) => { if (active) setPlaza(groups); });
    return () => { active = false; };
  }, [embedded, model]);

  const estimate = embedded ? estimateImageCost(plaza, keys, model, outputSize, count) : null;
  if (!estimate) return null;
  return (
    <span
      className={cn('self-center whitespace-nowrap text-xs tabular-nums text-muted-foreground', className)}
      title="按模型广场单价预估，实际以扣费为准"
    >
      {estimate.text}
    </span>
  );
}
