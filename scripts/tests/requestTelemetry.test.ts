import assert from 'node:assert/strict';
import test from 'node:test';
process.env.DB_TYPE = 'sqlite';
process.env.DB_URL = ':memory:';
import Fastify from 'fastify';
import type {
  ProxyRequestOutcomeInput,
} from '../../src/server/proxy-core/requestTelemetry.js';

const {
  __finalizeProxyRequestForTests,
  __markProxyRequestTransportFinishedForTests,
  __resetProxyRequestTelemetryForTests,
  __setProxyRequestOutcomeWriterForTests,
  installProxyRequestTelemetry,
  recordProxyLogAttempt,
  recordProxyRequestError,
} = await import('../../src/server/proxy-core/requestTelemetry.js');
const { closeDbConnections } = await import('../../src/server/db/index.js');

async function flushTelemetry(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function createTestApp(records: ProxyRequestOutcomeInput[]) {
  const app = Fastify({ logger: false });
  installProxyRequestTelemetry(app);
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer test-token') {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });
  app.post('/v1/telemetry', async (request, reply) => {
    const body = request.body as { mode?: string; model?: string } | undefined;
    const mode = body?.mode;
    if (mode === 'retry-success') {
      recordProxyLogAttempt({
        modelRequested: body?.model || 'demo-model',
        accountId: 11,
        channelId: 21,
        status: 'failed',
        httpStatus: 529,
        errorMessage: 'upstream overloaded',
      });
      recordProxyLogAttempt({
        modelRequested: body?.model || 'demo-model',
        accountId: 12,
        channelId: 22,
        status: 'success',
        httpStatus: 200,
        totalTokens: 42,
        estimatedCost: 0.12,
        firstByteLatencyMs: 18,
      });
      return reply.code(200).send({ ok: true });
    }
    if (mode === 'no-channel') return reply.code(503).send({ error: 'No available channels for this model' });
    if (mode === '429') return reply.code(429).send({ error: 'rate limited' });
    if (mode === '529') return reply.code(529).send({ error: 'upstream overloaded' });
    if (mode === 'stream-failure') {
      recordProxyLogAttempt({ status: 'success', isStream: true, httpStatus: 200 });
      recordProxyRequestError(request, new Error('upstream stream failed'));
      await __finalizeProxyRequestForTests(request, 'error', 200);
      return reply.code(200).send('partial');
    }
    if (mode === 'stream-cancel') {
      recordProxyLogAttempt({ status: 'success', isStream: true, httpStatus: 200 });
      await __finalizeProxyRequestForTests(request, 'close', 200);
      return reply.code(200).send('partial');
    }
    if (mode === 'stream-200') {
      return reply.code(200).send('empty');
    }
    if (mode === 'stream-late') {
      __markProxyRequestTransportFinishedForTests(request, 200);
      await new Promise((resolve) => setTimeout(resolve, 40));
      recordProxyLogAttempt({ status: 'success', isStream: true, httpStatus: 200 });
      return reply.code(200).send('late');
    }
    return reply.code(200).send({ ok: true });
  });
  const restoreWriter = __setProxyRequestOutcomeWriterForTests(async (input) => {
    records.push(input);
  });
  return { app, restoreWriter };
}

test('Fastify inject records auth rejection and no-channel 503 before a route handler', async () => {
  __resetProxyRequestTelemetryForTests();
  const records: ProxyRequestOutcomeInput[] = [];
  const { app, restoreWriter } = await createTestApp(records);
  try {
    const unauthorized = await app.inject({ method: 'POST', url: '/v1/telemetry', payload: { mode: 'no-channel' } });
    const streamUnauthorized = await app.inject({
      method: 'POST',
      url: '/v1/telemetry',
      headers: { accept: 'text/event-stream' },
      payload: { mode: 'no-channel', stream: true },
    });
    const noChannel = await app.inject({
      method: 'POST',
      url: '/v1/telemetry',
      headers: { authorization: 'Bearer test-token' },
      payload: { mode: 'no-channel' },
    });
    await flushTelemetry();
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(streamUnauthorized.statusCode, 401);
    assert.equal(noChannel.statusCode, 503);
    assert.deepEqual(records.map((item) => [item.status, item.httpStatus, item.errorClass]), [
      ['rejected', 401, 'authentication'],
      ['rejected', 401, 'authentication'],
      ['failed', 503, 'no_channel'],
    ]);
  } finally {
    restoreWriter();
    await app.close();
  }
});

test('Fastify inject aggregates retries and preserves 429/529 as failed request outcomes', async () => {
  __resetProxyRequestTelemetryForTests();
  const records: ProxyRequestOutcomeInput[] = [];
  const { app, restoreWriter } = await createTestApp(records);
  try {
    for (const mode of ['retry-success', '429', '529']) {
      await app.inject({
        method: 'POST',
        url: '/v1/telemetry',
        headers: { authorization: 'Bearer test-token' },
        payload: { mode },
      });
    }
    await flushTelemetry();
    assert.deepEqual(records.map((item) => [item.status, item.httpStatus]), [
      ['success', 200],
      ['failed', 429],
      ['failed', 529],
    ]);
    assert.equal(records[0]?.attemptCount, 2);
    assert.equal(records[0]?.failedAttemptCount, 1);
    assert.equal(records[0]?.channelId, 22);
    assert.equal(records[0]?.accountId, 12);
    assert.equal(records[0]?.firstByteLatencyMs, 18);
  } finally {
    restoreWriter();
    await app.close();
  }
});

test('stream failure/cancel are not stream-200 successes and absent attempts remain unknown', async () => {
  __resetProxyRequestTelemetryForTests();
  const records: ProxyRequestOutcomeInput[] = [];
  const { app, restoreWriter } = await createTestApp(records);
  try {
    for (const mode of ['stream-failure', 'stream-cancel', 'stream-200', 'stream-late']) {
      await app.inject({
        method: 'POST',
        url: '/v1/telemetry',
        headers: { authorization: 'Bearer test-token' },
        payload: { mode, stream: true },
      });
    }
    await flushTelemetry();
    assert.deepEqual(records.map((item) => [item.status, item.httpStatus]), [
      ['failed', 200],
      ['cancelled', 200],
      ['unknown', 200],
      ['success', 200],
    ]);
    assert.equal(records[2]?.firstByteLatencyMs, null);
    assert.equal(records[2]?.attemptCount, 0);
  } finally {
    restoreWriter();
    await app.close();
  }
});

test('concurrent inject requests keep ALS contexts and UUID request IDs isolated', async () => {
  __resetProxyRequestTelemetryForTests();
  const records: ProxyRequestOutcomeInput[] = [];
  const { app, restoreWriter } = await createTestApp(records);
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => app.inject({
      method: 'POST',
      url: '/v1/telemetry',
      headers: { authorization: 'Bearer test-token' },
      payload: { mode: 'retry-success', model: `model-${index}` },
    })));
    await flushTelemetry();
    assert.equal(records.length, 12);
    assert.equal(new Set(records.map((item) => item.requestId)).size, 12);
    assert.ok(records.every((item) => item.attemptCount === 2 && item.failedAttemptCount === 1));
    assert.deepEqual(new Set(records.map((item) => item.modelRequested)), new Set(
      Array.from({ length: 12 }, (_, index) => `model-${index}`),
    ));
  } finally {
    restoreWriter();
    await app.close();
  }
});

test.after(async () => {
  await closeDbConnections();
});
