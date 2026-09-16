export type InitialConnectionSegment = 'session' | 'apikey';

const SESSION_FIRST_PLATFORMS = new Set<string>();

const API_KEY_FIRST_PLATFORMS = new Set(['openai', 'claude', 'gemini']);

export function resolveInitialConnectionSegment(platform?: string | null): InitialConnectionSegment {
  const normalized = String(platform || '').trim().toLowerCase();
  if (SESSION_FIRST_PLATFORMS.has(normalized)) return 'session';
  if (API_KEY_FIRST_PLATFORMS.has(normalized)) return 'apikey';
  return 'apikey';
}
