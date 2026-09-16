import { describe, expect, it } from 'vitest';

import {
  applyGeminiGenerateContentAggregate,
  createGeminiGenerateContentAggregateState,
} from './aggregator.js';
import {
  extractTransformerMetadata,
  extractResponseMetadata,
  serializeGeminiAggregateResponse,
} from './outbound.js';
import { extractGeminiUsage } from './usage.js';

describe('Gemini aggregate/outbound/usage', () => {
  it('coalesces chunked text and thought parts per candidate while preserving tool thought signatures', () => {
    const state = createGeminiGenerateContentAggregateState();

    applyGeminiGenerateContentAggregate(state, [
      {
        responseId: 'resp-coalesce',
        modelVersion: 'gemini-3.1-pro-preview',
        candidates: [
          {
            index: 0,
            content: {
              parts: [
                { text: 'Think ', thought: true, thoughtSignature: 'sig-think-1' },
                { text: 'Hello ' },
              ],
            },
          },
          {
            index: 1,
            content: {
              parts: [
                { text: 'Alt ', thought: true, thoughtSignature: 'sig-think-2' },
              ],
            },
          },
        ],
      },
      {
        responseId: 'resp-coalesce',
        modelVersion: 'gemini-3.1-pro-preview',
        candidates: [
          {
            index: 0,
            finishReason: 'STOP',
            groundingMetadata: { webSearchQueries: ['cats'] },
            citationMetadata: { citations: [{ uri: 'https://example.com/cats' }] },
            content: {
              parts: [
                { text: 'deeply', thought: true, thoughtSignature: 'sig-think-1' },
                { text: 'world' },
                {
                  functionCall: {
                    id: 'tool-call-1',
                    name: 'lookupDocs',
                    args: { query: 'cats' },
                  },
                  thoughtSignature: 'sig-tool-1',
                },
              ],
            },
          },
          {
            index: 1,
            finishReason: 'MAX_TOKENS',
            groundingMetadata: { webSearchQueries: ['dogs'] },
            citationMetadata: { citations: [{ uri: 'https://example.com/dogs' }] },
            content: {
              parts: [
                { text: 'answer', thought: true, thoughtSignature: 'sig-think-2' },
                { text: 'candidate' },
              ],
            },
          },
        ],
      },
    ]);

    expect(serializeGeminiAggregateResponse(state)).toEqual({
      responseId: 'resp-coalesce',
      modelVersion: 'gemini-3.1-pro-preview',
      candidates: [
        {
          index: 0,
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              { text: 'Think deeply', thought: true, thoughtSignature: 'sig-think-1' },
              { text: 'Hello world' },
              {
                functionCall: {
                  id: 'tool-call-1',
                  name: 'lookupDocs',
                  args: { query: 'cats' },
                },
                thoughtSignature: 'sig-tool-1',
              },
            ],
          },
          groundingMetadata: { webSearchQueries: ['cats'] },
          citationMetadata: { citations: [{ uri: 'https://example.com/cats' }] },
        },
        {
          index: 1,
          finishReason: 'MAX_TOKENS',
          content: {
            role: 'model',
            parts: [
              { text: 'Alt answer', thought: true, thoughtSignature: 'sig-think-2' },
              { text: 'candidate' },
            ],
          },
          groundingMetadata: { webSearchQueries: ['dogs'] },
          citationMetadata: { citations: [{ uri: 'https://example.com/dogs' }] },
        },
      ],
    });
  });

  it('reflows preserved request metadata alongside aggregated grounding, citation, thought, and usage data', () => {
    const state = createGeminiGenerateContentAggregateState();
    applyGeminiGenerateContentAggregate(state, {
      responseId: 'resp-meta',
      modelVersion: 'gemini-3.1-pro-preview',
      candidates: [
        {
          index: 0,
          finishReason: 'STOP',
          groundingMetadata: { webSearchQueries: ['cats'] },
          citationMetadata: { citations: [{ uri: 'https://example.com/cats' }] },
          content: {
            parts: [
              { text: 'reasoning', thought: true, thoughtSignature: 'sig-think-1' },
              {
                functionCall: {
                  id: 'call_1',
                  name: 'lookupWeather',
                  args: { city: 'Paris' },
                },
                thoughtSignature: 'sig-tool-1',
              },
              { text: 'final answer' },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 5,
        totalTokenCount: 24,
        cachedContentTokenCount: 2,
        thoughtsTokenCount: 4,
      },
    });

    const metadata = extractResponseMetadata(state, {
      systemInstruction: { role: 'system', parts: [{ text: 'stay concise' }] },
      cachedContent: 'cached/item-1',
      safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: {
        stopSequences: ['END'],
        responseModalities: ['TEXT', 'AUDIO'],
        responseMimeType: 'application/json',
        responseSchema: { type: 'object', properties: { answer: { type: 'string' } } },
        candidateCount: 2,
        temperature: 0.3,
        topP: 0.8,
        topK: 20,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        seed: 42,
        responseLogprobs: true,
        logprobs: 5,
        thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
        imageConfig: { aspectRatio: '16:9' },
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'lookupWeather',
              description: 'Lookup weather',
            },
          ],
        },
        { googleSearch: {} },
        { urlContext: {} },
        { codeExecution: {} },
      ],
    });

    expect(metadata).toEqual({
      systemInstruction: { role: 'system', parts: [{ text: 'stay concise' }] },
      cachedContent: 'cached/item-1',
      safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      stopSequences: ['END'],
      responseModalities: ['TEXT', 'AUDIO'],
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      candidateCount: 2,
      temperature: 0.3,
      topP: 0.8,
      topK: 20,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      seed: 42,
      responseLogprobs: true,
      logprobs: 5,
      thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
      imageConfig: { aspectRatio: '16:9' },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'lookupWeather',
              description: 'Lookup weather',
            },
          ],
        },
        { googleSearch: {} },
        { urlContext: {} },
        { codeExecution: {} },
      ],
      citations: [{ citations: [{ uri: 'https://example.com/cats' }] }],
      groundingMetadata: [{ webSearchQueries: ['cats'] }],
      thoughtSignature: 'sig-think-1',
      thoughtSignatures: ['sig-think-1', 'sig-tool-1'],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 5,
        totalTokenCount: 24,
        cachedContentTokenCount: 2,
        thoughtsTokenCount: 4,
      },
    });
  });

  it('projects Gemini richer metadata into the shared transformer metadata contract', () => {
    const state = createGeminiGenerateContentAggregateState();
    applyGeminiGenerateContentAggregate(state, {
      responseId: 'resp-shared-meta',
      modelVersion: 'gemini-3.1-pro-preview',
      candidates: [
        {
          index: 0,
          finishReason: 'STOP',
          groundingMetadata: { webSearchQueries: ['cats'] },
          citationMetadata: { citations: [{ uri: 'https://example.com/cats' }] },
          content: {
            parts: [
              { text: 'reasoning', thought: true, thoughtSignature: 'sig-final' },
              { text: 'answer' },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 5,
        totalTokenCount: 24,
      },
    });

    const metadata = extractTransformerMetadata(state, {
      cachedContent: 'cached/item-1',
      safetySettings: [{ category: 'SAFE', threshold: 'BLOCK_NONE' }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: {
        imageConfig: { aspectRatio: '16:9' },
      },
    });

    expect(metadata).toEqual({
      citations: [{ citations: [{ uri: 'https://example.com/cats' }] }],
      groundingMetadata: [{ webSearchQueries: ['cats'] }],
      thoughtSignature: 'sig-final',
      thoughtSignatures: ['sig-final'],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 5,
        totalTokenCount: 24,
      },
      geminiSafetySettings: [{ category: 'SAFE', threshold: 'BLOCK_NONE' }],
      geminiImageConfig: { aspectRatio: '16:9' },
      passthrough: {
        cachedContent: 'cached/item-1',
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      },
    });
  });

  it('merges split candidate metadata and emits top-level metadata in candidate order', () => {
    const state = createGeminiGenerateContentAggregateState();
    applyGeminiGenerateContentAggregate(state, [
      {
        responseId: 'resp-metadata-merge',
        modelVersion: 'gemini-3.1-pro-preview',
        candidates: [
          {
            index: 1,
            groundingMetadata: {
              webSearchQueries: ['dogs'],
            },
            citationMetadata: {
              citations: [{ uri: 'https://example.com/dogs-1' }],
            },
            content: {
              parts: [{ text: 'candidate-1' }],
            },
          },
          {
            index: 0,
            groundingMetadata: {
              webSearchQueries: ['cats'],
            },
            citationMetadata: {
              citations: [{ uri: 'https://example.com/cats-1' }],
            },
            content: {
              parts: [{ text: 'candidate-0' }],
            },
          },
        ],
      },
      {
        responseId: 'resp-metadata-merge',
        modelVersion: 'gemini-3.1-pro-preview',
        candidates: [
          {
            index: 1,
            finishReason: 'STOP',
            groundingMetadata: {
              groundingChunks: [{ id: 'dogs-chunk' }],
            },
            citationMetadata: {
              citations: [{ uri: 'https://example.com/dogs-2' }],
            },
            content: {
              parts: [{ text: '-done' }],
            },
          },
          {
            index: 0,
            finishReason: 'STOP',
            groundingMetadata: {
              groundingChunks: [{ id: 'cats-chunk' }],
            },
            citationMetadata: {
              citations: [{ uri: 'https://example.com/cats-2' }],
            },
            content: {
              parts: [{ text: '-done' }],
            },
          },
        ],
      },
    ]);

    const response = serializeGeminiAggregateResponse(state);
    const metadata = extractResponseMetadata(state);

    expect(response.candidates).toEqual([
      {
        index: 0,
        finishReason: 'STOP',
        content: {
          role: 'model',
          parts: [{ text: 'candidate-0-done' }],
        },
        groundingMetadata: {
          webSearchQueries: ['cats'],
          groundingChunks: [{ id: 'cats-chunk' }],
        },
        citationMetadata: {
          citations: [
            { uri: 'https://example.com/cats-1' },
            { uri: 'https://example.com/cats-2' },
          ],
        },
      },
      {
        index: 1,
        finishReason: 'STOP',
        content: {
          role: 'model',
          parts: [{ text: 'candidate-1-done' }],
        },
        groundingMetadata: {
          webSearchQueries: ['dogs'],
          groundingChunks: [{ id: 'dogs-chunk' }],
        },
        citationMetadata: {
          citations: [
            { uri: 'https://example.com/dogs-1' },
            { uri: 'https://example.com/dogs-2' },
          ],
        },
      },
    ]);
    expect(metadata.groundingMetadata).toEqual([
      {
        webSearchQueries: ['cats'],
        groundingChunks: [{ id: 'cats-chunk' }],
      },
      {
        webSearchQueries: ['dogs'],
        groundingChunks: [{ id: 'dogs-chunk' }],
      },
    ]);
    expect(metadata.citations).toEqual([
      {
        citations: [
          { uri: 'https://example.com/cats-1' },
          { uri: 'https://example.com/cats-2' },
        ],
      },
      {
        citations: [
          { uri: 'https://example.com/dogs-1' },
          { uri: 'https://example.com/dogs-2' },
        ],
      },
    ]);
  });

  it('preserves multi-candidate tool thought signatures in serialized Gemini responses', () => {
    const state = createGeminiGenerateContentAggregateState();
    applyGeminiGenerateContentAggregate(state, [
      {
        responseId: 'resp-multi-tools',
        modelVersion: 'gemini-3.1-pro-preview',
        candidates: [
          {
            index: 1,
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'call_2',
                    name: 'lookupDocs',
                    args: { query: 'transformers' },
                  },
                  thoughtSignature: 'sig-candidate-2',
                },
              ],
            },
            groundingMetadata: { webSearchQueries: ['transformers'] },
          },
        ],
      },
      {
        responseId: 'resp-multi-tools',
        modelVersion: 'gemini-3.1-pro-preview',
        candidates: [
          {
            index: 0,
            finishReason: 'STOP',
            content: {
              parts: [
                { text: 'candidate zero answer', thoughtSignature: 'sig-candidate-1' },
              ],
            },
            citationMetadata: { citations: [{ uri: 'https://example.com/zero' }] },
          },
        ],
      },
    ]);

    expect(serializeGeminiAggregateResponse(state)).toEqual({
      responseId: 'resp-multi-tools',
      modelVersion: 'gemini-3.1-pro-preview',
      candidates: [
        {
          index: 0,
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [{ text: 'candidate zero answer', thoughtSignature: 'sig-candidate-1' }],
          },
          citationMetadata: { citations: [{ uri: 'https://example.com/zero' }] },
        },
        {
          index: 1,
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_2',
                  name: 'lookupDocs',
                  args: { query: 'transformers' },
                },
                thoughtSignature: 'sig-candidate-2',
              },
            ],
          },
          groundingMetadata: { webSearchQueries: ['transformers'] },
        },
      ],
    });
  });

  it('prefers final answer thought signature for scalar metadata while retaining tool signatures in the array', () => {
    const state = createGeminiGenerateContentAggregateState();
    applyGeminiGenerateContentAggregate(state, [
      {
        responseId: 'resp-thought-order',
        modelVersion: 'gemini-3.1-pro-preview',
        candidates: [
          {
            index: 0,
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'call_1',
                    name: 'lookupWeather',
                    args: { city: 'Paris' },
                  },
                  thoughtSignature: 'sig-tool-first',
                },
              ],
            },
          },
        ],
      },
      {
        responseId: 'resp-thought-order',
        modelVersion: 'gemini-3.1-pro-preview',
        candidates: [
          {
            index: 0,
            finishReason: 'STOP',
            content: {
              parts: [
                { text: 'reasoning', thought: true, thoughtSignature: 'sig-answer-final' },
                { text: 'answer' },
              ],
            },
          },
        ],
      },
    ]);

    const metadata = extractResponseMetadata(state);

    expect(metadata.thoughtSignature).toBe('sig-answer-final');
    expect(metadata.thoughtSignatures).toEqual([
      'sig-tool-first',
      'sig-answer-final',
    ]);
  });

  it('extracts Gemini usage from aggregate state and serialized response consistently', () => {
    const state = createGeminiGenerateContentAggregateState();
    applyGeminiGenerateContentAggregate(state, {
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 7,
        totalTokenCount: 31,
        cachedContentTokenCount: 4,
        thoughtsTokenCount: 4,
      },
    });

    const serialized = serializeGeminiAggregateResponse(state);

    expect(extractGeminiUsage(state)).toEqual({
      promptTokens: 20,
      completionTokens: 11,
      totalTokens: 31,
      cachedTokens: 4,
      cacheReadTokens: 4,
      cacheCreationTokens: 0,
      reasoningTokens: 4,
    });
    expect(extractGeminiUsage(serialized)).toEqual({
      promptTokens: 20,
      completionTokens: 11,
      totalTokens: 31,
      cachedTokens: 4,
      cacheReadTokens: 4,
      cacheCreationTokens: 0,
      reasoningTokens: 4,
    });
  });

  it('drops non-finite Gemini usage values instead of leaking NaN or Infinity into normalized usage', () => {
    const usage = extractGeminiUsage({
      usageMetadata: {
        promptTokenCount: Number.NaN,
        candidatesTokenCount: 6,
        totalTokenCount: Number.POSITIVE_INFINITY,
        cachedContentTokenCount: Number.NaN,
        thoughtsTokenCount: Number.NEGATIVE_INFINITY,
      },
    });

    expect(usage).toEqual({
      promptTokens: 0,
      completionTokens: 6,
      totalTokens: 6,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('keeps request-preserved metadata stable after serialize -> metadata extraction round-trip', () => {
    const state = createGeminiGenerateContentAggregateState();
    applyGeminiGenerateContentAggregate(state, {
      responseId: 'resp-roundtrip',
      modelVersion: 'gemini-3.1-pro-preview',
      candidates: [
        {
          index: 0,
          finishReason: 'STOP',
          groundingMetadata: { webSearchQueries: ['roundtrip'] },
          citationMetadata: { citations: [{ uri: 'https://example.com/roundtrip' }] },
          content: {
            parts: [
              { text: 'thinking', thought: true, thoughtSignature: 'sig-roundtrip' },
              { text: 'final answer' },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 8,
        candidatesTokenCount: 3,
        totalTokenCount: 13,
        cachedContentTokenCount: 1,
        thoughtsTokenCount: 2,
      },
    });

    const requestPayload = {
      systemInstruction: { role: 'system', parts: [{ text: 'preserve me' }] },
      cachedContent: 'cached/roundtrip',
      generationConfig: {
        responseModalities: ['TEXT', 'AUDIO'],
        responseMimeType: 'application/json',
        responseSchema: { type: 'object' },
        thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
      },
      tools: [{ googleSearch: {} }, { codeExecution: {} }],
    };

    const fromState = extractResponseMetadata(state, requestPayload);
    const serialized = serializeGeminiAggregateResponse(state);
    const fromSerialized = extractResponseMetadata(serialized, requestPayload);

    expect(fromSerialized).toEqual(fromState);
  });
});
