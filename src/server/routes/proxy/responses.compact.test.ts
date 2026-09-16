import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('responses proxy compact route', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { responsesProxyRoute } = await import('./responses.js');
    app = Fastify();
    await app.register(responsesProxyRoute);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts /v1/responses/compact requests instead of returning 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses/compact',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'model is required',
        type: 'invalid_request_error',
      },
    });
  });

  it('rejects streaming /v1/responses/compact requests because compact is non-streaming', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses/compact',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'stream is not supported on /v1/responses/compact',
        type: 'invalid_request_error',
      },
    });
  });
});
