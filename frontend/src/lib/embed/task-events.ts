/**
 * 任务响应的嵌入模式钩子：ccode-task-client 的 JSON 响应与 WebSocket 的 task 推送都经过这里。
 *   - error / warning 中的网关错误转为中文；余额不足等弹出全局提示（含「去充值」）；
 *   - 任务进入终态（completed / failed / expired）时刷新余额并通知父页。
 * 独立模式直接原样返回。
 */
import { isEmbedMode } from '@/lib/embed/mode';
import { localizeGatewayError } from '@/lib/embed/gateway-errors';
import { noticeForGatewayError, showEmbedNotice } from '@/lib/embed/notices';
import { notifyTaskSettled } from '@/lib/embed/balance';

const TERMINAL = new Set(['completed', 'failed', 'expired']);

export function localizeErrorField(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return value;
  const localized = localizeGatewayError(value);
  if (!localized) return value;
  const notice = noticeForGatewayError(localized.kind, localized.message);
  if (notice) showEmbedNotice(notice);
  return localized.message;
}

export function inspectEmbedTaskPayload<T>(payload: T): T {
  if (!isEmbedMode() || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  let next = record;
  if (typeof record.error === 'string') {
    const error = localizeErrorField(record.error);
    if (error !== record.error) next = { ...next, error };
  }
  if (typeof record.id === 'string' && typeof record.status === 'string' && TERMINAL.has(record.status)) {
    notifyTaskSettled(record.id);
  }
  return next as T;
}
