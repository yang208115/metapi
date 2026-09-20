import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.DB_TYPE = 'sqlite';
process.env.DB_URL = ':memory:';

const { db, closeDbConnections } = await import('../../src/server/db/index.js');
const { getOperationsSnapshot, listOperationsRequests } = await import('../../src/server/services/operationsMetrics.js');
const { sql } = await import('drizzle-orm');

const now = Date.now();
const stamp = (offsetMinutes: number) => new Date(now - offsetMinutes * 60 * 1_000).toISOString();
const sqlStamp = (offsetMinutes: number) => stamp(offsetMinutes).slice(0, 19).replace('T', ' ');

async function run(statement: string) {
  await db.run(sql.raw(statement));
}

before(async () => {
  await run('CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, status TEXT NOT NULL)');
  await run('CREATE TABLE accounts (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, status TEXT, api_token TEXT, access_token TEXT, extra_config TEXT, oauth_provider TEXT, oauth_account_key TEXT, oauth_project_id TEXT)');
  await run('CREATE TABLE token_routes (id INTEGER PRIMARY KEY, enabled INTEGER)');
  await run('CREATE TABLE route_channels (id INTEGER PRIMARY KEY, route_id INTEGER, account_id INTEGER, token_id INTEGER, enabled INTEGER, cooldown_until TEXT)');
  await run('CREATE TABLE proxy_logs (id INTEGER PRIMARY KEY, account_id INTEGER, channel_id INTEGER, status TEXT, http_status INTEGER, latency_ms INTEGER, first_byte_latency_ms INTEGER, total_tokens INTEGER, estimated_cost REAL, created_at TEXT)');
  await run('CREATE TABLE proxy_request_outcomes (id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT NOT NULL, downstream_path TEXT NOT NULL, model_requested TEXT, site_id INTEGER, account_id INTEGER, channel_id INTEGER, status TEXT NOT NULL, http_status INTEGER, latency_ms INTEGER NOT NULL, first_byte_latency_ms INTEGER, attempt_count INTEGER NOT NULL, failed_attempt_count INTEGER NOT NULL, total_tokens INTEGER, estimated_cost REAL, error_class TEXT, is_stream INTEGER NOT NULL)');
  await run("INSERT INTO sites VALUES (1, 'same-name', 'openai', 'active'), (2, 'same-name', 'claude', 'active'), (3, 'same-name', 'openai', 'disabled')");
  await run("INSERT INTO accounts VALUES (1, 1, 'active', 'legacy-token', 'access-token', NULL, NULL, NULL, NULL), (2, 2, 'active', 'claude-token', 'access-token', NULL, NULL, NULL, NULL)");
  await run('INSERT INTO token_routes VALUES (1, 1), (2, 1)');
  await run('INSERT INTO route_channels VALUES (1, 1, 1, 1, 1, NULL), (2, 2, 2, 2, 1, NULL)');
  await run(`INSERT INTO proxy_request_outcomes VALUES
    (1, 'r-success-retry', '${stamp(2)}', '${stamp(1)}', '/v1/chat/completions', 'm', 1, 1, 1, 'success', 200, 100, 20, 2, 1, 10, 0.1, NULL, 0),
    (2, 'r-529', '${stamp(3)}', '${stamp(2)}', '/v1/chat/completions', 'm', 1, 1, 1, 'failed', 529, 120, NULL, 1, 1, NULL, 0, 'upstream_529', 0),
    (3, 'r-rejected', '${stamp(4)}', '${stamp(3)}', '/v1/messages', 'm', 2, NULL, NULL, 'rejected', 429, 30, NULL, 1, 1, NULL, 0, 'rate_limited', 0),
    (4, 'r-unassigned', '${stamp(5)}', '${stamp(4)}', '/v1/chat/completions', 'm', NULL, NULL, NULL, 'unknown', 503, 40, NULL, 1, 1, NULL, 0, 'no_channel', 0),
    (5, 'r-previous', '${stamp(70)}', '${stamp(69)}', '/v1/chat/completions', 'm', 1, 1, 1, 'success', 200, 90, 10, 1, 0, 20, 0.2, NULL, 0)`);
  await run(`INSERT INTO proxy_logs VALUES
    (1, 1, 1, 'failed', 529, 50, NULL, NULL, 0, '${stamp(5)}'),
    (2, 1, 1, 'success', 200, 100, 15, 10, 0.1, '${stamp(4)}'),
    (3, 2, 2, 'failed', 429, 20, NULL, NULL, 0, '${stamp(6)}'),
    (4, 1, 1, 'success', 200, 80, 12, 5, 0.05, '${sqlStamp(3)}')`);
});

after(async () => {
  await closeDbConnections();
});

test('snapshot keeps final request counts separate from proxy attempt counts', async () => {
  const snapshot = await getOperationsSnapshot({ windowMinutes: 60, liveWindowMinutes: 5 });
  assert.equal(snapshot.current.total, 4);
  assert.equal(snapshot.current.success, 1);
  assert.equal(snapshot.current.failed, 1);
  assert.equal(snapshot.current.rejected, 1);
  assert.equal(snapshot.current.unknown, 1);
  assert.equal(snapshot.current.successRate, 25);
  assert.equal(snapshot.attempts.total, 4);
  assert.equal(snapshot.attempts.rateLimited, 1);
  assert.equal(snapshot.attempts.serverErrors, 1);
  assert.equal(snapshot.live.bucketSeconds, 3);
  assert.equal(snapshot.live.requests, 4);
  assert.equal(snapshot.sites.length, 3);
  assert.equal(snapshot.filters.length, 3);
  assert.equal(snapshot.sites[0].id, 1);
  assert.equal(snapshot.sites[0].name, 'same-name');
  assert.ok(snapshot.sites.some((site) => site.id === 3 && site.requests.total === 0));
  assert.ok(snapshot.telemetry.notes.some((note) => note.includes('历史对比区间')));
});

test('site and platform filters use ids and keep no-sample metrics null', async () => {
  const snapshot = await getOperationsSnapshot({ windowMinutes: 60, liveWindowMinutes: 1, siteId: 2, platform: 'claude' });
  assert.equal(snapshot.scope.siteId, 2);
  assert.equal(snapshot.scope.platform, 'claude');
  assert.equal(snapshot.current.total, 1);
  assert.equal(snapshot.current.rejected, 1);
  assert.equal(snapshot.current.successRate, 0);
  assert.equal(snapshot.latency.count, 1);
  assert.equal(snapshot.firstByte.count, 0);
  assert.equal(snapshot.firstByte.p50, null);
  assert.equal(snapshot.sites.length, 1);
  assert.equal(snapshot.sites[0].id, 2);
});

test('recovered drilldown requires a successful request with a failed attempt', async () => {
  const response = await listOperationsRequests({
    fromMs: now - 60 * 60 * 1_000,
    toMs: now,
    status: 'success',
    recovered: true,
    limit: 50,
    offset: 0,
  });
  assert.deepEqual(response.items.map((item) => item.requestId), ['r-success-retry']);
  assert.equal(response.total, 1);
});
