import { parseDownstreamChatRequest } from '../../shared/normalized.js';
import { createProtocolRequestEnvelope } from '../../shared/protocolModel.js';
import { extractChatRequestMetadata } from './helpers.js';
import type { OpenAiChatParsedRequest, OpenAiChatRequestEnvelope } from './model.js';

export const openAiChatInbound = {
  parse(body: unknown): { value?: OpenAiChatRequestEnvelope; error?: { statusCode: number; payload: unknown } } {
    const parsed = parseDownstreamChatRequest(body, 'openai') as {
      value?: OpenAiChatParsedRequest;
      error?: { statusCode: number; payload: unknown };
    };
    if (parsed.error) {
      return { error: parsed.error };
    }
    if (!parsed.value) {
      return {
        error: {
          statusCode: 400,
          payload: {
            error: {
              message: 'invalid chat request',
              type: 'invalid_request_error',
            },
          },
        },
      };
    }

    const metadata = extractChatRequestMetadata(body);
    return {
      value: createProtocolRequestEnvelope({
        protocol: 'openai/chat',
        model: parsed.value.requestedModel,
        stream: parsed.value.isStream,
        rawBody: body,
        parsed: parsed.value,
        ...(metadata ? { metadata } : {}),
      }),
    };
  },
};
