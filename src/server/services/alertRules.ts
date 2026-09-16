export function isCloudflareChallenge(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return text.includes('cloudflare') || text.includes('cf challenge') || text.includes('challenge required');
}

const SESSION_TOKEN_REBIND_HINT = '请在中转站重新生成系统访问令牌后重新绑定账号';

function isEndpointDispatchDeniedMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i.test(message)
    || text.includes('dispatch denied')
  );
}

function containsHttpStatus(message: string | null | undefined, status: number): boolean {
  if (!message) return false;
  return new RegExp(`(?:^|\\b)(?:http\\s*)?${status}(?:\\b|:)`, 'i').test(message);
}

export function isTokenExpiredError(input: { status?: number; message?: string | null }): boolean {
  const rawMessage = input.message || '';
  const text = (input.message || '').toLowerCase();
  if (isEndpointDispatchDeniedMessage(rawMessage)) return false;
  if (input.status === 401 || containsHttpStatus(rawMessage, 401)) return true;
  if (!text) return false;

  // NewAPI-like sites may return this when session context is missing for an action,
  // which does not always mean the account token is expired.
  if (text.includes('未登录且未提供 access token')) return false;

  const tokenPhrase = text.includes('token') || text.includes('令牌') || text.includes('访问令牌');
  const hasInvalid = text.includes('invalid') || text.includes('无效');
  const hasExpired = text.includes('expired') || text.includes('过期');

  return (
    text.includes('jwt expired') ||
    text.includes('token expired') ||
    (tokenPhrase && (hasInvalid || hasExpired)) ||
    /invalid\s+access\s+token/.test(text) ||
    /access\s+token\s+is\s+invalid/.test(text)
  );
}

export function appendSessionTokenRebindHint(message?: string | null): string {
  const raw = String(message || '').trim();
  if (!raw) return raw;
  if (raw.includes(SESSION_TOKEN_REBIND_HINT)) return raw;

  const text = raw.toLowerCase();
  const looksLikeInvalidAccessToken = (
    raw.includes('无权进行此操作，access token 无效') ||
    /invalid\s+access\s+token/.test(text) ||
    /access\s+token\s+is\s+invalid/.test(text) ||
    /access\s+token.*无效/.test(raw)
  );
  if (!looksLikeInvalidAccessToken) return raw;

  return `${raw}，${SESSION_TOKEN_REBIND_HINT}`;
}
