import { describe, expect, it } from 'vitest';
import { detectPlatform, getAdapter } from './index.js';

describe('getAdapter platform aliases', () => {
  it('returns undefined for unknown platforms', () => {
    expect(getAdapter('unknown-platform')).toBeUndefined();
  });

  it('does not expose removed upstream adapters', () => {
    for (const platform of ['new-api', 'one-api', 'onehub', 'donehub', 'veloera', 'anyrouter', 'sub2api', 'orcarouter', 'cliproxyapi', 'codex', 'gemini-cli', 'antigravity']) {
      expect(getAdapter(platform)).toBeUndefined();
    }
  });

  it('supports canonical openai/claude/gemini adapters', () => {
    expect(getAdapter('openai')?.platformName).toBe('openai');
    expect(getAdapter('claude')?.platformName).toBe('claude');
    expect(getAdapter('gemini')?.platformName).toBe('gemini');
  });

  it('does not detect removed platform URLs', async () => {
    expect(await detectPlatform('https://anyrouter.top')).toBeUndefined();
    expect(await detectPlatform('https://api.orcarouter.ai')).toBeUndefined();
    expect(await detectPlatform('https://demo.donehub.example')).toBeUndefined();
  });

  it('detects official openai/claude/gemini upstream URLs', async () => {
    const openai = await detectPlatform('https://api.openai.com');
    const claude = await detectPlatform('https://api.anthropic.com');
    const gemini = await detectPlatform('https://generativelanguage.googleapis.com');

    expect(openai?.platformName).toBe('openai');
    expect(claude?.platformName).toBe('claude');
    expect(gemini?.platformName).toBe('gemini');
  });

});
