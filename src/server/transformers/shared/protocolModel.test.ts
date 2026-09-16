import { describe, expect, it } from 'vitest';

import {
  createProtocolRequestEnvelope,
  createProtocolResponseEnvelope,
  createProtocolStreamEnvelope,
} from './protocolModel.js';

describe('protocolModel', () => {
  it('creates protocol request envelopes with shared top-level fields', () => {
    const envelope = createProtocolRequestEnvelope({
      protocol: 'openai/chat',
      model: 'gpt-5',
      stream: true,
      rawBody: { model: 'gpt-5', stream: true },
      parsed: { requestedModel: 'gpt-5', isStream: true },
      metadata: { serviceTier: 'priority' },
    });

    expect(envelope).toEqual({
      protocol: 'openai/chat',
      model: 'gpt-5',
      stream: true,
      rawBody: { model: 'gpt-5', stream: true },
      parsed: { requestedModel: 'gpt-5', isStream: true },
      metadata: { serviceTier: 'priority' },
    });
  });

  it('creates protocol response and stream envelopes without losing metadata', () => {
    const response = createProtocolResponseEnvelope({
      protocol: 'openai/responses',
      model: 'gpt-5',
      final: {
        id: 'resp_1',
        model: 'gpt-5',
        created: 123,
        content: 'done',
        reasoningContent: 'think',
        finishReason: 'stop',
        toolCalls: [],
      },
      metadata: { citations: ['https://example.com'] },
    });
    const stream = createProtocolStreamEnvelope({
      protocol: 'openai/responses',
      model: 'gpt-5',
      event: {
        contentDelta: 'done',
        finishReason: 'stop',
      },
      metadata: { citations: ['https://example.com'] },
    });

    expect(response.metadata).toEqual({ citations: ['https://example.com'] });
    expect(stream.metadata).toEqual({ citations: ['https://example.com'] });
  });
});
