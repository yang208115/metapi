import { describe, expect, it } from 'vitest';
import { resolveInitialConnectionSegment } from './defaultConnectionSegment.js';

describe('defaultConnectionSegment', () => {
  it('maps supported upstream platforms to the apikey segment', () => {
    expect(resolveInitialConnectionSegment('openai')).toBe('apikey');
    expect(resolveInitialConnectionSegment('claude')).toBe('apikey');
    expect(resolveInitialConnectionSegment('gemini')).toBe('apikey');
  });

  it('falls back to the apikey segment for unknown platforms', () => {
    expect(resolveInitialConnectionSegment('')).toBe('apikey');
    expect(resolveInitialConnectionSegment('unknown-platform')).toBe('apikey');
  });
});
