import { describe, expect, it } from 'vitest';

import {
  decodeAnthropicReasoningSignature,
  decodeGeminiThoughtSignature,
  decodeOpenAiEncryptedReasoning,
  encodeAnthropicReasoningSignature,
  encodeGeminiThoughtSignature,
  encodeOpenAiEncryptedReasoning,
  isAnthropicReasoningSignature,
  isGeminiThoughtSignature,
  isOpenAiEncryptedReasoning,
  isSafeAnthropicRedactedReasoningCarrier,
} from './reasoningTransport.js';

describe('reasoning transport codecs', () => {
  it('round-trips provider-tagged reasoning signatures', () => {
    const anthropic = encodeAnthropicReasoningSignature('anthropic-sig');
    const gemini = encodeGeminiThoughtSignature('gemini-sig');
    const openai = encodeOpenAiEncryptedReasoning('openai-enc');

    expect(isAnthropicReasoningSignature(anthropic)).toBe(true);
    expect(isGeminiThoughtSignature(gemini)).toBe(true);
    expect(isOpenAiEncryptedReasoning(openai)).toBe(true);

    expect(decodeAnthropicReasoningSignature(anthropic)).toBe('anthropic-sig');
    expect(decodeGeminiThoughtSignature(gemini)).toBe('gemini-sig');
    expect(decodeOpenAiEncryptedReasoning(openai)).toBe('openai-enc');
  });

  it('prevents prefixed signatures from being treated as anthropic redacted reasoning carriers', () => {
    expect(isSafeAnthropicRedactedReasoningCarrier('ciphertext')).toBe(true);
    expect(isSafeAnthropicRedactedReasoningCarrier(encodeAnthropicReasoningSignature('sig'))).toBe(false);
    expect(isSafeAnthropicRedactedReasoningCarrier(encodeGeminiThoughtSignature('sig'))).toBe(false);
    expect(isSafeAnthropicRedactedReasoningCarrier(encodeOpenAiEncryptedReasoning('enc'))).toBe(false);
  });
});
