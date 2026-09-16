import { createEmptyNormalizedUsage, mergeNormalizedUsage } from '../../shared/normalized.js';

export const openAiChatUsage = {
  empty: createEmptyNormalizedUsage,
  merge: mergeNormalizedUsage,
};
