import { isTruthyFlag } from './accountConnection.js';

const FOCUS_SITE_ID_KEY = 'focusSiteId';
const FOCUS_ACCOUNT_ID_KEY = 'focusAccountId';
const OPEN_REBIND_KEY = 'openRebind';

function normalizePositiveId(input: unknown): number | null {
  const value = Number.parseInt(String(input ?? ''), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function buildSiteFocusPath(siteId: number): string {
  const normalizedId = normalizePositiveId(siteId);
  if (!normalizedId) return '/sites';
  return `/sites?${FOCUS_SITE_ID_KEY}=${normalizedId}`;
}

export function buildAccountFocusPath(
  accountId: number,
  options?: { openRebind?: boolean; segment?: 'session' | 'apikey' },
): string {
  const normalizedId = normalizePositiveId(accountId);
  if (!normalizedId) return '/accounts';
  const params = new URLSearchParams();
  if (options?.segment && options.segment !== 'session') params.set('segment', options.segment);
  params.set(FOCUS_ACCOUNT_ID_KEY, String(normalizedId));
  if (options?.openRebind) params.set(OPEN_REBIND_KEY, '1');
  return `/accounts?${params.toString()}`;
}

export function readFocusSiteId(search: string): number | null {
  const params = new URLSearchParams(search);
  return normalizePositiveId(params.get(FOCUS_SITE_ID_KEY));
}

export function readFocusAccountIntent(search: string): { accountId: number | null; openRebind: boolean } {
  const params = new URLSearchParams(search);
  return {
    accountId: normalizePositiveId(params.get(FOCUS_ACCOUNT_ID_KEY)),
    openRebind: isTruthyFlag(params.get(OPEN_REBIND_KEY)),
  };
}

export function clearFocusParams(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(FOCUS_SITE_ID_KEY);
  params.delete(FOCUS_ACCOUNT_ID_KEY);
  params.delete(OPEN_REBIND_KEY);
  params.delete('backPath');
  const next = params.toString();
  return next ? `?${next}` : '';
}

const BACK_PATH_KEY = 'backPath';

export function appendBackPath(path: string, currentBackPath: string): string {
  if (!currentBackPath) return path;
  const [base, search] = path.split('?');
  const params = new URLSearchParams(search || '');
  params.set(BACK_PATH_KEY, encodeURIComponent(currentBackPath));
  return `${base}?${params.toString()}`;
}

export function readBackPath(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get(BACK_PATH_KEY);
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith('/') && !decoded.startsWith('//')) {
      return decoded;
    }
  } catch {}
  return null;
}

export function buildEventNavigationPath(event: {
  relatedType?: string | null;
  relatedId?: number | null;
  type?: string | null;
}): string {
  const relatedType = (event.relatedType || '').toLowerCase();
  const relatedId = normalizePositiveId(event.relatedId);
  const eventType = (event.type || '').toLowerCase();

  if (relatedType === 'account' && relatedId) {
    return buildAccountFocusPath(relatedId, { openRebind: eventType === 'token' });
  }
  if (relatedType === 'site' && relatedId) {
    return buildSiteFocusPath(relatedId);
  }
  if (relatedType === 'route') {
    return '/routes';
  }
  if (eventType === 'proxy') {
    return '/logs';
  }
  return '/logs';
}
