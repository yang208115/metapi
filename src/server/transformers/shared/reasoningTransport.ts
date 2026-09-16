const PROVIDER_PREFIX = 'metapi';

export const ANTHROPIC_REASONING_SIGNATURE_PREFIX = `${PROVIDER_PREFIX}:anthropic-signature:`;
export const GEMINI_THOUGHT_SIGNATURE_PREFIX = `${PROVIDER_PREFIX}:gemini-thought-signature:`;
export const OPENAI_ENCRYPTED_REASONING_PREFIX = `${PROVIDER_PREFIX}:openai-encrypted-reasoning:`;

function stripPrefix(value: string, prefix: string): string | null {
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

export function isAnthropicReasoningSignature(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(ANTHROPIC_REASONING_SIGNATURE_PREFIX);
}

export function encodeAnthropicReasoningSignature(signature: string | null | undefined): string | null {
  if (!signature) return null;
  return isAnthropicReasoningSignature(signature) ? signature : `${ANTHROPIC_REASONING_SIGNATURE_PREFIX}${signature}`;
}

export function decodeAnthropicReasoningSignature(signature: string | null | undefined): string | null {
  if (!signature) return null;
  return stripPrefix(signature, ANTHROPIC_REASONING_SIGNATURE_PREFIX);
}

export function isGeminiThoughtSignature(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(GEMINI_THOUGHT_SIGNATURE_PREFIX);
}

export function encodeGeminiThoughtSignature(signature: string | null | undefined): string | null {
  if (!signature) return null;
  return isGeminiThoughtSignature(signature) ? signature : `${GEMINI_THOUGHT_SIGNATURE_PREFIX}${signature}`;
}

export function decodeGeminiThoughtSignature(signature: string | null | undefined): string | null {
  if (!signature) return null;
  return stripPrefix(signature, GEMINI_THOUGHT_SIGNATURE_PREFIX);
}

export function isOpenAiEncryptedReasoning(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(OPENAI_ENCRYPTED_REASONING_PREFIX);
}

export function encodeOpenAiEncryptedReasoning(encryptedContent: string | null | undefined): string | null {
  if (!encryptedContent) return null;
  return isOpenAiEncryptedReasoning(encryptedContent)
    ? encryptedContent
    : `${OPENAI_ENCRYPTED_REASONING_PREFIX}${encryptedContent}`;
}

export function decodeOpenAiEncryptedReasoning(signature: string | null | undefined): string | null {
  if (!signature) return null;
  return stripPrefix(signature, OPENAI_ENCRYPTED_REASONING_PREFIX);
}

export function isSafeAnthropicRedactedReasoningCarrier(value: string | null | undefined): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !isAnthropicReasoningSignature(value)
    && !isGeminiThoughtSignature(value)
    && !isOpenAiEncryptedReasoning(value);
}
