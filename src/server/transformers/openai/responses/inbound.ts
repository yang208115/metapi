import { createProtocolRequestEnvelope } from '../../shared/protocolModel.js';
import { sanitizeResponsesBodyForProxy } from './conversion.js';
import type {
  OpenAiResponsesParsedRequest,
  OpenAiResponsesRequestEnvelope,
} from './model.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalidRequest(message: string): { statusCode: number; payload: unknown } {
  return {
    statusCode: 400,
    payload: {
      error: {
        message,
        type: 'invalid_request_error',
      },
    },
  };
}

export const openAiResponsesInbound = {
  parse(
    body: unknown,
    options?: { defaultEncryptedReasoningInclude?: boolean },
  ): { value?: OpenAiResponsesRequestEnvelope; error?: { statusCode: number; payload: unknown } } {
    const rawBody = isRecord(body) ? body : {};
    const requestedModel = typeof rawBody.model === 'string' ? rawBody.model.trim() : '';
    if (!requestedModel) {
      return { error: invalidRequest('model is required') };
    }

    const isStream = rawBody.stream === true;
    const normalizedBody = sanitizeResponsesBodyForProxy(
      rawBody,
      requestedModel,
      isStream,
      { defaultEncryptedReasoningInclude: options?.defaultEncryptedReasoningInclude },
    );

    return {
      value: createProtocolRequestEnvelope({
        protocol: 'openai/responses',
        model: requestedModel,
        stream: isStream,
        rawBody: body,
        parsed: {
          normalizedBody,
        } satisfies OpenAiResponsesParsedRequest,
      }),
    };
  },
};
