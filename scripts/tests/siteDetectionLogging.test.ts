import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Fastify from 'fastify';

// Route imports initialize the database; keep this test isolated from local data.
process.env.DB_TYPE = 'sqlite';
process.env.DB_URL = ':memory:';

const { sitesRoutes } = await import('../../src/server/routes/api/sites.js');
const { closeDbConnections } = await import('../../src/server/db/index.js');
const { OpenAiAdapter } = await import('../../src/server/services/platforms/openai.js');
const { installConsoleLogCapture, subscribeToTerminalLogs } = await import('../../src/server/services/terminalLogService.js');
const { operationalUrlHost } = await import('../../src/server/shared/operationalLog.js');

installConsoleLogCapture();
after(closeDbConnections);

test('automatic detection logs an unmatched HTTP 200 result to the terminal feed', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(sitesRoutes);
  const entries: Array<{ level: string; message: string }> = [];
  const subscription = subscribeToTerminalLogs(1, (entry) => entries.push(entry));
  t.after(subscription.unsubscribe);

  const response = await app.inject({
    method: 'POST', url: '/api/sites/detect',
    payload: { url: 'https://sub2api.example.test/private-path?token=private-token#private-fragment' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().error, 'Could not detect platform');
  assert.ok(entries.some((entry) => entry.message.includes('[site.detect.started]')));
  assert.equal(entries.filter((entry) => entry.message.includes('[site.detect.adapter_result]')).length, 3);
  assert.ok(entries.some((entry) => entry.level === 'warn' && entry.message.includes('no_supported_platform_matched')));
  assert.doesNotMatch(JSON.stringify(entries), /private-path|private-token|private-fragment/);
});

test('successful URL matching logs the detected platform and duration', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(sitesRoutes);
  const messages: string[] = [];
  const subscription = subscribeToTerminalLogs(1, (entry) => messages.push(entry.message));
  t.after(subscription.unsubscribe);
  const response = await app.inject({
    method: 'POST', url: '/api/sites/detect', payload: { url: 'https://api.openai.com/v1' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().platform, 'openai');
  const completed = messages.find((message) => message.startsWith('[site.detect.completed]'));
  assert.ok(completed);
  assert.match(completed, /"status":"succeeded"/);
  assert.match(completed, /"platform":"openai"/);
  assert.match(completed, /"durationMs":\d+/);
});

test('adapter exceptions are logged without changing HTTP failure behavior', async (t) => {
  t.mock.method(OpenAiAdapter.prototype, 'detect', async () => {
    throw new TypeError('fetch failed: private-credential');
  });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(sitesRoutes);
  const messages: string[] = [];
  const subscription = subscribeToTerminalLogs(1, (entry) => messages.push(entry.message));
  t.after(subscription.unsubscribe);
  const response = await app.inject({
    method: 'POST', url: '/api/sites/detect', payload: { url: 'https://example.test' },
  });
  assert.equal(response.statusCode, 500);
  assert.ok(messages.some((message) => message.startsWith('[site.detect.adapter_failed]')));
  assert.ok(messages.some((message) => message.startsWith('[site.detect.failed]')));
  assert.doesNotMatch(JSON.stringify(messages), /private-credential/);
});

test('URL log context excludes credentials, paths and query parameters', () => {
  assert.equal(operationalUrlHost('https://user:password@example.test:8443/secret?key=secret#secret'), 'example.test:8443');
  assert.equal(operationalUrlHost('example.test/path'), 'example.test');
  assert.equal(operationalUrlHost('https://user:password@'), undefined);
});
