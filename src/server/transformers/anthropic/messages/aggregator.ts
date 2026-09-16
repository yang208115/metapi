import { type NormalizedStreamEvent } from '../../shared/normalized.js';

export type AnthropicAggregatedContentBlock =
  | {
    type: 'text';
    text: string;
  }
  | {
    type: 'thinking';
    thinking: string;
    signature: string;
  }
  | {
    type: 'redacted_thinking';
    data: string;
  }
  | {
    type: 'tool_use';
    id: string;
    name: string;
    inputJson: string;
  };

export type AnthropicStreamExtension = {
  signatureDelta?: string;
  redactedThinkingData?: string;
  startBlock?: {
    kind: 'thinking' | 'text' | 'tool_use' | 'redacted_thinking';
    index?: number;
  };
  stopBlockIndex?: number | null;
};

export type AnthropicExtendedStreamEvent = NormalizedStreamEvent & {
  anthropic?: AnthropicStreamExtension;
};

export type AnthropicBlockLifecycleEntry = {
  kind: 'thinking' | 'redacted_thinking';
  phase: 'start' | 'stop';
  index?: number;
};

export type AnthropicMessagesAggregateState = {
  text: string[];
  reasoning: string[];
  redactedReasoning: string[];
  signatures: string[];
  toolCalls: Record<number, { id: string; name: string; arguments: string }>;
  finishReason: string | null;
  pendingSignature: string | null;
  thinkingBlockIndex: number | null;
  redactedBlockIndexes: number[];
  blockLifecycle: AnthropicBlockLifecycleEntry[];
  contentBlocks: AnthropicAggregatedContentBlock[];
  textBlockOrder: number | null;
  thinkingBlockOrder: number | null;
  redactedBlockOrders: Record<number, number>;
  toolBlockOrders: Record<number, number>;
};

export function createAnthropicMessagesAggregateState(): AnthropicMessagesAggregateState {
  return {
    text: [],
    reasoning: [],
    redactedReasoning: [],
    signatures: [],
    toolCalls: {},
    finishReason: null,
    pendingSignature: null,
    thinkingBlockIndex: null,
    redactedBlockIndexes: [],
    blockLifecycle: [],
    contentBlocks: [],
    textBlockOrder: null,
    thinkingBlockOrder: null,
    redactedBlockOrders: {},
    toolBlockOrders: {},
  };
}

function appendContentBlock(
  state: AnthropicMessagesAggregateState,
  block: AnthropicAggregatedContentBlock,
): number {
  state.contentBlocks.push(block);
  return state.contentBlocks.length - 1;
}

function ensureThinkingContentBlock(
  state: AnthropicMessagesAggregateState,
): Extract<AnthropicAggregatedContentBlock, { type: 'thinking' }> {
  const order = state.thinkingBlockOrder;
  if (order !== null && state.contentBlocks[order]?.type === 'thinking') {
    return state.contentBlocks[order] as Extract<AnthropicAggregatedContentBlock, { type: 'thinking' }>;
  }

  const created: Extract<AnthropicAggregatedContentBlock, { type: 'thinking' }> = {
    type: 'thinking',
    thinking: '',
    signature: '',
  };
  state.thinkingBlockOrder = appendContentBlock(state, created);
  return created;
}

function ensureToolContentBlock(
  state: AnthropicMessagesAggregateState,
  index: number,
): Extract<AnthropicAggregatedContentBlock, { type: 'tool_use' }> {
  const existingOrder = state.toolBlockOrders[index];
  if (existingOrder !== undefined && state.contentBlocks[existingOrder]?.type === 'tool_use') {
    return state.contentBlocks[existingOrder] as Extract<AnthropicAggregatedContentBlock, { type: 'tool_use' }>;
  }

  const created: Extract<AnthropicAggregatedContentBlock, { type: 'tool_use' }> = {
    type: 'tool_use',
    id: `toolu_${index}`,
    name: '',
    inputJson: '',
  };
  state.toolBlockOrders[index] = appendContentBlock(state, created);
  return created;
}

function ensureRedactedContentBlock(
  state: AnthropicMessagesAggregateState,
  index: number,
): Extract<AnthropicAggregatedContentBlock, { type: 'redacted_thinking' }> {
  const existingOrder = state.redactedBlockOrders[index];
  if (existingOrder !== undefined && state.contentBlocks[existingOrder]?.type === 'redacted_thinking') {
    return state.contentBlocks[existingOrder] as Extract<AnthropicAggregatedContentBlock, { type: 'redacted_thinking' }>;
  }

  const created: Extract<AnthropicAggregatedContentBlock, { type: 'redacted_thinking' }> = {
    type: 'redacted_thinking',
    data: '',
  };
  state.redactedBlockOrders[index] = appendContentBlock(state, created);
  return created;
}

function ensureToolState(
  state: AnthropicMessagesAggregateState,
  index: number,
): { id: string; name: string; arguments: string } {
  if (!state.toolCalls[index]) {
    state.toolCalls[index] = {
      id: `toolu_${index}`,
      name: '',
      arguments: '',
    };
  }
  return state.toolCalls[index];
}

function applySignatureToThinkingBlock(
  state: AnthropicMessagesAggregateState,
  signature: string,
): void {
  const thinkingBlock = ensureThinkingContentBlock(state);
  thinkingBlock.signature += signature;
}

function bufferPendingSignature(
  state: AnthropicMessagesAggregateState,
  signature: string,
): void {
  state.pendingSignature = `${state.pendingSignature || ''}${signature}`;
}

function flushPendingSignature(state: AnthropicMessagesAggregateState): void {
  if (!state.pendingSignature) return;
  applySignatureToThinkingBlock(state, state.pendingSignature);
  state.signatures.push(state.pendingSignature);
  state.pendingSignature = null;
}

function recordBlockStart(
  state: AnthropicMessagesAggregateState,
  kind: AnthropicBlockLifecycleEntry['kind'],
  index?: number,
): void {
  state.blockLifecycle.push({ kind, phase: 'start', index });
  if (kind === 'thinking') {
    state.thinkingBlockIndex = typeof index === 'number' ? index : state.thinkingBlockIndex;
    ensureThinkingContentBlock(state);
    return;
  }
  if (kind === 'redacted_thinking' && typeof index === 'number') {
    state.redactedBlockIndexes.push(index);
    ensureRedactedContentBlock(state, index);
  }
}

function recordBlockStop(state: AnthropicMessagesAggregateState, index: number): void {
  if (state.thinkingBlockIndex === index) {
    state.blockLifecycle.push({ kind: 'thinking', phase: 'stop', index });
    flushPendingSignature(state);
    state.thinkingBlockIndex = null;
    state.thinkingBlockOrder = null;
    return;
  }

  const redactedIndex = state.redactedBlockIndexes.indexOf(index);
  if (redactedIndex >= 0) {
    state.blockLifecycle.push({ kind: 'redacted_thinking', phase: 'stop', index });
    state.redactedBlockIndexes.splice(redactedIndex, 1);
    delete state.redactedBlockOrders[index];
  }
}

function finalizeOpenBlocks(state: AnthropicMessagesAggregateState): void {
  if (state.thinkingBlockIndex !== null) {
    const thinkingIndex = state.thinkingBlockIndex;
    recordBlockStop(state, thinkingIndex);
  }

  if (state.pendingSignature) {
    if (state.thinkingBlockIndex === null && state.thinkingBlockOrder === null) {
      state.blockLifecycle.push({ kind: 'thinking', phase: 'start' });
    }
    flushPendingSignature(state);
    if (state.thinkingBlockIndex === null && state.thinkingBlockOrder !== null) {
      state.blockLifecycle.push({ kind: 'thinking', phase: 'stop' });
      state.thinkingBlockOrder = null;
    }
  }

  const openRedactedIndexes = [...state.redactedBlockIndexes];
  for (const redactedIndex of openRedactedIndexes) {
    recordBlockStop(state, redactedIndex);
  }
}

export function applyAnthropicMessagesAggregateEvent(
  state: AnthropicMessagesAggregateState,
  event: AnthropicExtendedStreamEvent,
): AnthropicMessagesAggregateState {
  if (event.anthropic?.startBlock?.kind === 'thinking') {
    recordBlockStart(state, 'thinking', event.anthropic.startBlock.index);
  }
  if (event.anthropic?.startBlock?.kind === 'redacted_thinking') {
    if (state.thinkingBlockIndex !== null) {
      recordBlockStop(state, state.thinkingBlockIndex);
    }
    recordBlockStart(state, 'redacted_thinking', event.anthropic.startBlock.index);
  }

  if (event.reasoningDelta) {
    state.reasoning.push(event.reasoningDelta);
    ensureThinkingContentBlock(state).thinking += event.reasoningDelta;
  }

  if (event.contentDelta) {
    state.text.push(event.contentDelta);
    if (state.textBlockOrder === null || state.contentBlocks[state.textBlockOrder]?.type !== 'text') {
      state.textBlockOrder = appendContentBlock(state, {
        type: 'text',
        text: '',
      });
    }
    const textBlock = state.contentBlocks[state.textBlockOrder] as Extract<AnthropicAggregatedContentBlock, { type: 'text' }>;
    textBlock.text += event.contentDelta;
  }

  if (Array.isArray(event.toolCallDeltas)) {
    for (const toolDelta of event.toolCallDeltas) {
      const toolState = ensureToolState(state, toolDelta.index);
      const toolBlock = ensureToolContentBlock(state, toolDelta.index);
      if (toolDelta.id) toolState.id = toolDelta.id;
      if (toolDelta.name) toolState.name = toolDelta.name;
      if (toolDelta.id) toolBlock.id = toolDelta.id;
      if (toolDelta.name) toolBlock.name = toolDelta.name;
      if (toolDelta.argumentsDelta) {
        toolState.arguments += toolDelta.argumentsDelta;
        toolBlock.inputJson += toolDelta.argumentsDelta;
      }
    }
  }

  if (event.anthropic?.signatureDelta) {
    bufferPendingSignature(state, event.anthropic.signatureDelta);
  }

  if (event.anthropic?.redactedThinkingData) {
    state.redactedReasoning.push(event.anthropic.redactedThinkingData);
    const redactedIndex = (
      typeof event.anthropic.startBlock?.index === 'number'
        ? event.anthropic.startBlock.index
        : state.redactedBlockIndexes[state.redactedBlockIndexes.length - 1]
    );
    if (typeof redactedIndex === 'number') {
      ensureRedactedContentBlock(state, redactedIndex).data = event.anthropic.redactedThinkingData;
    }
  }

  if (
    event.anthropic?.stopBlockIndex !== undefined
    && event.anthropic.stopBlockIndex !== null
  ) {
    recordBlockStop(state, event.anthropic.stopBlockIndex);
  }

  if (event.finishReason) {
    finalizeOpenBlocks(state);
    state.finishReason = event.finishReason;
  }

  if (event.done) {
    finalizeOpenBlocks(state);
  }

  return state;
}
