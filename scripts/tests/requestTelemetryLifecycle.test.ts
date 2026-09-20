import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import type { ProxyRequestOutcomeInput } from '../../src/server/proxy-core/requestTelemetry.js';

process.env.DB_TYPE = 'sqlite';
process.env.DB_URL = ':memory:';
const telemetry = await import('../../src/server/proxy-core/requestTelemetry.js');
const { closeDbConnections } = await import('../../src/server/db/index.js');
after(closeDbConnections);

test('real raw response finish waits for delayed retry bookkeeping without counting it as response latency', { timeout: 5000 }, async () => {
  telemetry.__resetProxyRequestTelemetryForTests();
  const records: ProxyRequestOutcomeInput[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let written!: () => void;
  const persisted = new Promise<void>(resolve => { written = resolve; });
  const restore = telemetry.__setProxyRequestOutcomeWriterForTests(async input => { records.push(input); written(); });
  const app = Fastify();
  telemetry.installProxyRequestTelemetry(app);
  app.post('/v1/responses', async (_request, reply) => {
    telemetry.recordProxyLogAttempt({ status: 'failed', httpStatus: 529 });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.end('data: [DONE]\n\n');
    await gate;
    telemetry.recordProxyLogAttempt({ status: 'success', httpStatus: 200, isStream: true });
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream: true }) });
    assert.equal(response.status, 200);
    await response.text();
    const responseEnded = Date.now();
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.equal(records.length, 0, 'transport finish must not finalize before bookkeeping');
    release();
    await persisted;
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'success');
    assert.equal(records[0].httpStatus, 200);
    assert.equal(records[0].attemptCount, 2);
    assert.equal(records[0].failedAttemptCount, 1);
    assert.ok(Date.parse(records[0].completedAt) <= responseEnded);
    assert.equal(telemetry.getProxyRequestTelemetryHealthSync().inFlight, 0);
  } finally {
    release();
    await app.close();
    restore();
  }
});

test('stream acceptance header does not leave early authentication rejection in flight', { timeout: 5000 }, async () => {
  telemetry.__resetProxyRequestTelemetryForTests();
  const records: ProxyRequestOutcomeInput[] = [];
  const restore = telemetry.__setProxyRequestOutcomeWriterForTests(async input => { records.push(input); });
  const app = Fastify();
  telemetry.installProxyRequestTelemetry(app);
  app.addHook('onRequest', async (_request, reply) => { reply.code(401).send({ error: 'Unauthorized' }); });
  app.post('/v1/responses', async () => { throw new Error('handler must not run'); });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/responses', headers: { accept: 'text/event-stream' }, payload: { stream: true } });
    await app.close();
    assert.equal(response.statusCode, 401);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'rejected');
    assert.equal(records[0].attemptCount, 0);
    assert.equal(telemetry.getProxyRequestTelemetryHealthSync().inFlight, 0);
  } finally {
    await app.close();
    restore();
  }
});
