import { randomUUID } from 'node:crypto';

type LogFields = Record<string, string | number | boolean | null | undefined>;
type LogLevel = 'info' | 'warn' | 'error';

// Only pass selected metadata here, never request bodies, credentials or upstream text.
export function logOperationalEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  console[level](`[${event}] ${JSON.stringify(fields)}`);
}

export function operationalErrorFields(error: unknown): LogFields {
  // Error messages and stacks can contain upstream bodies, signed URLs and tokens.
  const fields: LogFields = { errorType: 'unknown' };
  if (error instanceof Error) {
    fields.errorType = error instanceof TypeError ? 'TypeError'
      : error instanceof SyntaxError ? 'SyntaxError' : 'Error';
    const message = error.message.toLowerCase();
    fields.errorKind = /timeout|timed out|aborted/.test(message) ? 'timeout_or_abort'
      : /unauthorized|forbidden|401|403/.test(message) ? 'authentication'
        : /fetch failed|network|connect|socket/.test(message) ? 'network' : 'internal_or_upstream';
    for (const candidate of [error, error.cause]) {
      if (!candidate || typeof candidate !== 'object' || !('code' in candidate)) continue;
      const code = candidate.code;
      if (typeof code === 'string' && /^(?:E(?:CONNRESET|CONNREFUSED|TIMEDOUT|PIPE|NOTFOUND|AI_AGAIN)|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|SQLITE_(?:BUSY|LOCKED|CONSTRAINT))$/.test(code)) {
        fields.errorCode = code;
        break;
      }
    }
  }
  return fields;
}

export async function logOperation<T>(
  event: string,
  fields: LogFields,
  run: () => Promise<T>,
  summarize: (result: T) => LogFields = () => ({}),
): Promise<T> {
  const context = { ...fields, operationId: randomUUID() };
  const startedAt = performance.now();
  logOperationalEvent('info', `${event}.started`, context);
  try {
    const result = await run();
    const summary = summarize(result);
    logOperationalEvent(summary.status === 'failed' ? 'warn' : 'info', `${event}.completed`, {
      ...context, ...summary, durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    logOperationalEvent('error', `${event}.failed`, {
      ...context, ...operationalErrorFields(error), durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
}
