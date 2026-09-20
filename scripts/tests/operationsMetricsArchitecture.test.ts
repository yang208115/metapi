import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const serviceSource = await readFile(new URL('../../src/server/services/operationsMetrics.ts', import.meta.url), 'utf8');
const routeSource = await readFile(new URL('../../src/server/routes/api/operations.ts', import.meta.url), 'utf8');

test('operations metrics service stays above proxy route boundaries', () => {
  assert.doesNotMatch(serviceSource, /routes\/proxy/);
  assert.doesNotMatch(serviceSource, /from ['"].*routes\//);
});

test('operations route remains a thin adapter', () => {
  assert.doesNotMatch(routeSource, /from ['"].*\/db\//);
  assert.doesNotMatch(routeSource, /drizzle-orm/);
  assert.match(routeSource, /getOperationsSnapshot/);
  assert.match(routeSource, /listOperationsRequests/);
});
