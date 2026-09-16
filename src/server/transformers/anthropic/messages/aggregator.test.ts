import { describe, expect, it } from 'vitest';

import { applyAnthropicMessagesAggregateEvent, createAnthropicMessagesAggregateState } from './aggregator.js';

describe('applyAnthropicMessagesAggregateEvent', () => {
  it('buffers signature deltas until the thinking block stops', () => {
    const state = createAnthropicMessagesAggregateState();

    applyAnthropicMessagesAggregateEvent(state, {
      anthropic: {
        startBlock: {
          kind: 'thinking',
          index: 0,
        },
      },
    } as any);
    applyAnthropicMessagesAggregateEvent(state, { reasoningDelta: 'step-1' });
    applyAnthropicMessagesAggregateEvent(state, {
      anthropic: {
        signatureDelta: 'sig-buffered',
      },
    } as any);
    applyAnthropicMessagesAggregateEvent(state, { reasoningDelta: 'step-2' });

    expect(state.pendingSignature).toBe('sig-buffered');
    expect((state as any).contentBlocks).toEqual([
      {
        type: 'thinking',
        thinking: 'step-1step-2',
        signature: '',
      },
    ]);

    applyAnthropicMessagesAggregateEvent(state, {
      anthropic: {
        stopBlockIndex: 0,
      },
    } as any);

    expect(state.pendingSignature).toBeNull();
    expect((state as any).contentBlocks).toEqual([
      {
        type: 'thinking',
        thinking: 'step-1step-2',
        signature: 'sig-buffered',
      },
    ]);
  });

  it('keeps thinking signatures and redacted_thinking blocks in content order', () => {
    const state = createAnthropicMessagesAggregateState();

    applyAnthropicMessagesAggregateEvent(state, {
      anthropic: {
        startBlock: {
          kind: 'thinking',
          index: 0,
        },
      },
    } as any);
    applyAnthropicMessagesAggregateEvent(state, { reasoningDelta: 'internal-step' });
    applyAnthropicMessagesAggregateEvent(state, {
      anthropic: {
        signatureDelta: 'sig-1',
      },
    } as any);
    applyAnthropicMessagesAggregateEvent(state, {
      anthropic: {
        stopBlockIndex: 0,
      },
    } as any);
    applyAnthropicMessagesAggregateEvent(state, {
      anthropic: {
        startBlock: {
          kind: 'redacted_thinking',
          index: 1,
        },
        redactedThinkingData: 'ciphertext',
      },
    } as any);
    applyAnthropicMessagesAggregateEvent(state, {
      anthropic: {
        stopBlockIndex: 1,
      },
    } as any);

    expect((state as any).contentBlocks).toEqual([
      {
        type: 'thinking',
        thinking: 'internal-step',
        signature: 'sig-1',
      },
      {
        type: 'redacted_thinking',
        data: 'ciphertext',
      },
    ]);
    expect(state.blockLifecycle).toEqual([
      { kind: 'thinking', phase: 'start', index: 0 },
      { kind: 'thinking', phase: 'stop', index: 0 },
      { kind: 'redacted_thinking', phase: 'start', index: 1 },
      { kind: 'redacted_thinking', phase: 'stop', index: 1 },
    ]);
  });

  it('accumulates tool_use JSON on one block and preserves block order after thinking', () => {
    const state = createAnthropicMessagesAggregateState();

    applyAnthropicMessagesAggregateEvent(state, {
      anthropic: {
        startBlock: {
          kind: 'thinking',
          index: 0,
        },
      },
    } as any);
    applyAnthropicMessagesAggregateEvent(state, { reasoningDelta: 'plan' });
    applyAnthropicMessagesAggregateEvent(state, {
      anthropic: {
        stopBlockIndex: 0,
      },
    } as any);
    applyAnthropicMessagesAggregateEvent(state, {
      toolCallDeltas: [{
        index: 0,
        id: 'call_1',
        name: 'lookup_city',
        argumentsDelta: '{"city":"par',
      }],
    });
    applyAnthropicMessagesAggregateEvent(state, {
      toolCallDeltas: [{
        index: 0,
        argumentsDelta: 'is"}',
      }],
    });

    expect((state as any).contentBlocks).toEqual([
      {
        type: 'thinking',
        thinking: 'plan',
        signature: '',
      },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'lookup_city',
        inputJson: '{"city":"paris"}',
      },
    ]);
    expect(state.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'lookup_city',
      arguments: '{"city":"paris"}',
    });
  });
});
