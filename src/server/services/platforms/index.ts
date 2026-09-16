import type { PlatformAdapter } from './base.js';
import { OpenAiAdapter } from './openai.js';
import { ClaudeAdapter } from './claude.js';
import { GeminiAdapter } from './gemini.js';
import { detectPlatformByUrlHint, normalizePlatformAlias } from '../../../shared/platformIdentity.js';

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
  const urlHint = detectPlatformByUrlHint(url);
  if (urlHint) {
    return getAdapter(urlHint);
  }

  for (const adapter of adapters) {
    if (await adapter.detect(url)) return adapter;
  }
  return undefined;
}
