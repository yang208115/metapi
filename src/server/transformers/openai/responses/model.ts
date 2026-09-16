import type { ProtocolRequestEnvelope } from '../../shared/protocolModel.js';

export type OpenAiResponsesParsedRequest = {
  normalizedBody: Record<string, unknown>;
};

export type OpenAiResponsesRequestEnvelope = ProtocolRequestEnvelope<
  'openai/responses',
  OpenAiResponsesParsedRequest
>;
