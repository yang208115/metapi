import type { PlatformAdapter } from './base.js';
import { OpenAiAdapter } from './openai.js';
import { ClaudeAdapter } from './claude.js';
import { GeminiAdapter } from './gemini.js';
import { detectPlatformByUrlHint, normalizePlatformAlias } from '../../../shared/platformIdentity.js';
import { logOperationalEvent, operationalErrorFields, operationalUrlHost } from '../../shared/operationalLog.js';

const adapters: PlatformAdapter[] = [
  new OpenAiAdapter(),
  new ClaudeAdapter(),
  new GeminiAdapter(),
];

function normalizePlatform(platform: string): string {
  return normalizePlatformAlias(platform);
}

export function getAdapter(platform: string): PlatformAdapter | undefined {
  const normalized = normalizePlatform(platform);
  return adapters.find((a) => a.platformName === normalized);
}

export async function detectPlatform(url: string): Promise<PlatformAdapter | undefined> {
  const host = operationalUrlHost(url);
  const urlHint = detectPlatformByUrlHint(url);
  if (urlHint) {
    const adapter = getAdapter(urlHint);
    logOperationalEvent(adapter ? 'info' : 'warn', 'site.detect.url_hint', {
      host, platform: urlHint, matched: !!adapter,
    });
    return adapter;
  }

  for (const adapter of adapters) {
    const startedAt = performance.now();
    try {
      const matched = await adapter.detect(url);
      logOperationalEvent('info', 'site.detect.adapter_result', {
        host, platform: adapter.platformName, matched, durationMs: Math.round(performance.now() - startedAt),
      });
      if (matched) return adapter;
    } catch (error) {
      logOperationalEvent('warn', 'site.detect.adapter_failed', {
        host, platform: adapter.platformName, ...operationalErrorFields(error),
        durationMs: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
  }
  return undefined;
}
