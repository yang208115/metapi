import { createEmptyNormalizedUsage, mergeNormalizedUsage, type NormalizedUsage } from '../../shared/normalized.js';
import { type GeminiGenerateContentAggregateState } from './aggregator.js';

type GeminiRecord = Record<string, unknown>;

function isRecord(value: unknown): value is GeminiRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAggregateState(value: unknown): value is GeminiGenerateContentAggregateState {
  return isRecord(value) && Array.isArray(value.parts) && isRecord(value.usage);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function extractGeminiUsage(payload: unknown): NormalizedUsage {
  const usageMetadata = isAggregateState(payload)
    ? payload.usage
    : (isRecord(payload) && isRecord(payload.usageMetadata) ? payload.usageMetadata : null);

  if (!usageMetadata) {
    return createEmptyNormalizedUsage();
  }

  const promptTokens = finiteNumber(usageMetadata.promptTokenCount) ?? 0;
  const candidatesTokenCount = finiteNumber(usageMetadata.candidatesTokenCount) ?? 0;
  const thoughtsTokenCount = finiteNumber(usageMetadata.thoughtsTokenCount) ?? 0;
  const completionTokens = candidatesTokenCount + thoughtsTokenCount;
  const totalTokens = finiteNumber(usageMetadata.totalTokenCount) ?? (promptTokens + completionTokens);
  const cachedTokens = finiteNumber(usageMetadata.cachedContentTokenCount) ?? 0;
  const reasoningTokens = thoughtsTokenCount;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheReadTokens: cachedTokens,
    cacheCreationTokens: 0,
    reasoningTokens,
  };
}

export const geminiGenerateContentUsage = {
  empty: createEmptyNormalizedUsage,
  fromPayload: extractGeminiUsage,
  merge: mergeNormalizedUsage,
};
