/**
 * 网关（sub2api）错误 → 中文提示（PRD R6.3）。
 * 匹配 sub2api 中间件的错误码 / 文案（backend/internal/server/middleware/api_key_auth*.go）
 * 与 OpenAI 兼容错误类型；未命中的原样返回。
 */
export type GatewayErrorKind =
  | 'insufficient_balance'
  | 'key_quota_exhausted'
  | 'rate_limited'
  | 'moderation'
  | 'invalid_key'
  | 'key_expired'
  | 'ip_denied'
  | 'group_denied';

export interface LocalizedGatewayError {
  kind: GatewayErrorKind;
  message: string;
}

const RULES: Array<{ kind: GatewayErrorKind; pattern: RegExp; message: string }> = [
  {
    kind: 'insufficient_balance',
    pattern: /insufficient[_ ]?(account[_ ]?)?balance|余额不足|balance (is )?(not enough|insufficient)/i,
    message: '账户余额不足，请充值后重试',
  },
  {
    kind: 'key_quota_exhausted',
    pattern: /api_key_quota_exhausted|insufficient_quota|key quota (has been )?exhausted|quota[_ ]exhausted|额度已用完/i,
    message: 'API 密钥额度已用完，请在「模型与密钥」中更换密钥或在控制台调整额度',
  },
  {
    kind: 'key_expired',
    pattern: /api_key_expired|api key (has )?expired|api key 已过期|密钥已过期/i,
    message: 'API 密钥已过期，请在「模型与密钥」中重新选择',
  },
  {
    kind: 'invalid_key',
    pattern: /invalid_api_key|invalid api key|api_key_disabled|api key is disabled|api_key_required|incorrect api key|user_inactive|user associated with api key/i,
    message: 'API 密钥无效或已禁用，请在「模型与密钥」中重新选择',
  },
  {
    kind: 'ip_denied',
    pattern: /access denied\. your ip|ip (is )?not allowed|ip whitelist/i,
    message: '当前 IP 不在该 API 密钥的允许范围内，请检查密钥的 IP 限制',
  },
  {
    kind: 'group_denied',
    pattern: /group_not_allowed|分组不再允许|subscription_not_found|no active subscription/i,
    message: '该 API 密钥所属分组当前不可用，请更换密钥',
  },
  {
    kind: 'moderation',
    pattern: /moderation|content[_ ]?policy|content_filter|safety (system|filter)|flagged|violat|prohibited content|blocked due to|内容审核|违规|敏感/i,
    message: '内容未通过安全审核，请调整提示词或参考图后重试',
  },
  {
    kind: 'rate_limited',
    pattern: /\b429\b|rate[_ ]?limit|too many requests|concurrency limit|并发|限流|请求过于频繁/i,
    message: '请求过于频繁或并发已满，请稍后重试',
  },
];

export function localizeGatewayError(raw: string | null | undefined): LocalizedGatewayError | null {
  const text = String(raw || '');
  if (!text.trim()) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { kind: rule.kind, message: rule.message };
  }
  return null;
}

/** 返回中文提示；未识别时返回原文。 */
export function localizeGatewayErrorText(raw: string): string {
  return localizeGatewayError(raw)?.message ?? raw;
}

/** Preserve structured gateway codes; a status alone is not a billing diagnosis. */
export function gatewayErrorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const row = value as Record<string, unknown>;
  return [row.code, row.type, row.message, row.detail, row.error]
    .map(v => typeof v === 'string' ? v : v && typeof v === 'object' ? gatewayErrorText(v) : '')
    .filter(Boolean).join(' ');
}
