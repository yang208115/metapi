import { createEmptyNormalizedUsage, mergeNormalizedUsage } from '../../shared/normalized.js';

export const openAiResponsesUsage = {
  empty: createEmptyNormalizedUsage,
  merge: mergeNormalizedUsage,
};
