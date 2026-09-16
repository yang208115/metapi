export const PLATFORM_ALIASES = Object.assign(Object.create(null), {
  openai: 'openai',
  anthropic: 'claude',
  claude: 'claude',
  gemini: 'gemini',
  google: 'gemini',
});

function getPlatformAlias(raw) {
  return Object.prototype.hasOwnProperty.call(PLATFORM_ALIASES, raw)
    ? PLATFORM_ALIASES[raw]
    : undefined;
}

function normalizeUrlCandidate(url) {
  return typeof url === 'string' ? url.trim() : '';
}

function parseUrlCandidate(url) {
  const normalized = normalizeUrlCandidate(url);
  if (!normalized) return null;

  const candidates = normalized.includes('://')
    ? [normalized]
    : [`https://${normalized}`];
  for (const candidate of candidates) {
    try {
      return new URL(candidate);
    } catch {}
  }
  return null;
}

export function normalizePlatformAlias(platform) {
  const raw = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  if (!raw) return '';
  return getPlatformAlias(raw) ?? raw;
}

export function detectPlatformByUrlHint(url) {
  const normalized = normalizeUrlCandidate(url).toLowerCase();
  if (!normalized) return undefined;
  const parsed = parseUrlCandidate(normalized);
  const host = parsed?.hostname?.trim().toLowerCase() || '';
  const path = parsed?.pathname?.trim().toLowerCase() || '';

  if (host === 'api.openai.com') return 'openai';
  if (host === 'api.anthropic.com' || (host === 'anthropic.com' && path.startsWith('/v1'))) return 'claude';
  if (
    host === 'generativelanguage.googleapis.com'
    || host === 'gemini.google.com'
    || ((host === 'googleapis.com' || host.endsWith('.googleapis.com')) && path.startsWith('/v1beta/openai'))
  ) {
    return 'gemini';
  }
  return undefined;
}
