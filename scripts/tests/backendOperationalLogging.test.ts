import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { logOperation, operationalErrorFields } from '../../src/server/shared/operationalLog.js';

function captureLogs(t: TestContext) {
  const lines: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    t.mock.method(console, level, (line: string) => {
      const end = line.indexOf(']');
      lines.push({ level, event: line.slice(1, end), fields: JSON.parse(line.slice(end + 2)) });
    });
  }
  return lines;
}

test('operations preserve results without logging credentials in the result', async (t) => {
  const lines = captureLogs(t);
  const result = { accessToken: 'private-token', body: 'private-message' };
  assert.equal(await logOperation('oauth.refresh', { accountId: 42 }, async () => result), result);
  assert.deepEqual(lines.map((line) => line.event), ['oauth.refresh.started', 'oauth.refresh.completed']);
  assert.equal(lines[0].fields.operationId, lines[1].fields.operationId);
  assert.equal(lines[1].fields.accountId, 42);
  assert.equal(typeof lines[1].fields.durationMs, 'number');
  assert.doesNotMatch(JSON.stringify(lines), /private-token|private-message/);
});

test('errors retain identity and log useful codes without raw messages or causes', async (t) => {
  const lines = captureLogs(t);
  const cause = Object.assign(new Error('https://user:password@example.com?token=secret'), { code: 'ECONNRESET' });
  const error = new TypeError('fetch failed: Authorization: Bearer private-key', { cause });
  await assert.rejects(logOperation('proxy.dispatch', {}, async () => { throw error; }), (actual) => actual === error);
  assert.equal(lines[1].level, 'error');
  assert.equal(lines[1].fields.errorCode, 'ECONNRESET');
  assert.equal(lines[1].fields.errorKind, 'network');
  assert.doesNotMatch(JSON.stringify(lines), /password|secret|private-key|Authorization/);
});

test('returned business failures are warnings and keep their original result', async (t) => {
  const lines = captureLogs(t);
  const result = { status: 'failed', errorCode: 'account_not_found' };
  assert.equal(await logOperation('models.refresh', {}, async () => result, (value) => value), result);
  assert.equal(lines[1].level, 'warn');
  assert.equal(lines[1].fields.errorCode, 'account_not_found');
});

test('concurrent operations have distinct correlation IDs', async (t) => {
  const lines = captureLogs(t);
  await Promise.all([1, 2].map((accountId) => logOperation('balance.refresh', { accountId }, async () => accountId)));
  const starts = lines.filter((line) => line.event.endsWith('.started'));
  assert.notEqual(starts[0].fields.operationId, starts[1].fields.operationId);
  for (const start of starts) {
    assert.equal(lines.filter((line) => line.fields.operationId === start.fields.operationId).length, 2);
  }
});

test('unknown thrown values and custom error properties cannot leak secrets', () => {
  assert.deepEqual(operationalErrorFields('secret'), { errorType: 'unknown' });
  const error = Object.assign(new Error('secret'), { name: 'secret-name', code: 'secret-code' });
  assert.doesNotMatch(JSON.stringify(operationalErrorFields(error)), /secret/);
});
