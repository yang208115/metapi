import { describe, expect, it } from 'vitest';

import {
  anthropicMessagesUsage,
  extractAnthropicUsage,
  extractAnthropicUsageMetadata,
} from './usage.js';

describe('extractAnthropicUsage', () => {
  it('treats cached_tokens as already included in input_tokens for moonshot-style payloads', () => {
    expect(extractAnthropicUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        cached_tokens: 12,
      },
    })).toEqual({
      promptTokens: 100,
      completionTokens: 30,
      totalTokens: 130,
      cachedTokens: 12,
      cacheReadTokens: 12,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      audioInputTokens: 0,
      audioOutputTokens: 0,
      acceptedPredictionTokens: 0,
      rejectedPredictionTokens: 0,
      cacheReadInputTokens: 12,
      cacheCreationInputTokens: 0,
      ephemeral5mInputTokens: 0,
      ephemeral1hInputTokens: 0,
      promptTokensIncludingCache: 100,
      serviceTier: null,
      promptTokensIncludeCache: true,
    });
  });

  it('reports prompt tokens including cache without double-counting cached_tokens aliases', () => {
    expect(extractAnthropicUsageMetadata({
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        cached_tokens: 12,
      },
    })).toEqual({
      cacheReadInputTokens: 12,
      cacheCreationInputTokens: 0,
      ephemeral5mInputTokens: 0,
      ephemeral1hInputTokens: 0,
      promptTokensIncludingCache: 100,
      serviceTier: null,
      cachedTokens: 12,
      promptTokensIncludeCache: true,
    });
  });
});

describe('anthropicMessagesUsage.toPayload', () => {
  it('reconstructs anthropic cache breakdown for downstream responses', () => {
    const toPayload = (
      anthropicMessagesUsage as typeof anthropicMessagesUsage & {
        toPayload?: (usage: unknown) => unknown;
      }
    ).toPayload;

    expect(typeof toPayload).toBe('function');
    expect(toPayload?.({
      promptTokens: 100,
      completionTokens: 30,
      totalTokens: 150,
      cacheReadInputTokens: 12,
      cacheCreationInputTokens: 8,
      ephemeral5mInputTokens: 5,
      ephemeral1hInputTokens: 3,
      promptTokensIncludingCache: 120,
    })).toEqual({
      input_tokens: 100,
      output_tokens: 30,
      cache_read_input_tokens: 12,
      cache_creation_input_tokens: 8,
      cache_creation: {
        ephemeral_5m_input_tokens: 5,
        ephemeral_1h_input_tokens: 3,
      },
    });
  });
});
