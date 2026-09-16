import type { RequestInit as UndiciRequestInit } from 'undici';

const UPSTREAM_MODELS_TIMEOUT_MS = 8_000;
const UPSTREAM_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
const UPSTREAM_MODELS_FAILURE_TTL_MS = 60 * 1000;

const DEFAULT_UPSTREAM_MODELS_URLS = [
  'https://basellm.github.io/llm-metadata/api/i18n/en/newapi/models.json',
  'https://basellm.github.io/llm-metadata/api/newapi/models.json',
];

interface DescriptionCacheEntry {
  fetchedAt: number;
  ttlMs: number;
  descriptions: Map<string, string>;
}

let descriptionCache: DescriptionCacheEntry | null = null;

function normalizeModelKey(value: string): string {
  return value.trim().toLowerCase();
}

function unwrapArrayPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray((payload as any).data)) {
    return (payload as any).data;
  }
  return [];
}

function readStringField(raw: unknown, keys: string[]): string | null {
  if (!raw || typeof raw !== 'object') return null;
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

export function mapModelDescriptionsFromPayload(payload: unknown): Map<string, string> {
  const rows = unwrapArrayPayload(payload);
  const descriptions = new Map<string, string>();

  for (const row of rows) {
    const modelName = readStringField(row, ['model_name', 'id', 'name']);
    const description = readStringField(row, ['description', 'model_description', 'desc']);
    if (!modelName || !description) continue;
    descriptions.set(normalizeModelKey(modelName), description);
  }

  return descriptions;
}

function getUpstreamModelUrls(): string[] {
  const envValue = process.env.LLM_METADATA_MODELS_URLS;
  if (!envValue) return DEFAULT_UPSTREAM_MODELS_URLS;

  const values = envValue
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return values.length > 0 ? values : DEFAULT_UPSTREAM_MODELS_URLS;
}

async function fetchJson(url: string, options?: UndiciRequestInit): Promise<unknown> {
  const { fetch } = await import('undici');
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, UPSTREAM_MODELS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      body: options?.body ?? undefined,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`upstream metadata timeout (${Math.round(UPSTREAM_MODELS_TIMEOUT_MS / 1000)}s)`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
}

export async function getUpstreamModelDescriptionsCached(): Promise<Map<string, string>> {
  if (descriptionCache && Date.now() - descriptionCache.fetchedAt < descriptionCache.ttlMs) {
    return descriptionCache.descriptions;
  }

  let fetched: Map<string, string> = new Map();
  for (const url of getUpstreamModelUrls()) {
    try {
      const payload = await fetchJson(url);
      const mapped = mapModelDescriptionsFromPayload(payload);
      if (mapped.size > 0) {
        fetched = mapped;
        break;
      }
    } catch {}
  }

  descriptionCache = {
    fetchedAt: Date.now(),
    ttlMs: fetched.size > 0 ? UPSTREAM_MODELS_CACHE_TTL_MS : UPSTREAM_MODELS_FAILURE_TTL_MS,
    descriptions: fetched,
  };
  return fetched;
}
