import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlink } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';

process.env.DB_TYPE = 'sqlite';
const databasePath = join(tmpdir(), `metapi-monitoring-integrity-${randomUUID()}.db`);
process.env.DB_URL = databasePath;

const { buildModelAnalysis, buildModelAnalysisFromDailyUsage, resolveModelAnalysisSpend } =
  await import('../../src/server/services/modelAnalysisService.js');
const { normalizeProxyDebugResponseHeaders } =
  await import('../../src/server/services/proxyDebugTraceStore.js');
const { buildSiteTrendIdentity } =
  await import('../../src/server/services/siteStatsSnapshotService.js');
const { db, schema, closeDbConnections } = await import('../../src/server/db/index.js');
const { runSqliteRuntimeMigrations } = await import('../../src/server/runtimeDatabaseBootstrap.js');
const { cleanupUsageLogs } = await import('../../src/server/services/logCleanupService.js');

after(async () => {
  await closeDbConnections();
  await unlink(databasePath).catch(() => {});
  await unlink(`${databasePath}-wal`).catch(() => {});
  await unlink(`${databasePath}-shm`).catch(() => {});
});

test('model analysis uses latencyCount, keeps explicit zero cost, and returns null without samples', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');
  const result = buildModelAnalysis([
    {
      createdAt: '2026-09-20 10:00:00',
      modelActual: 'model-a',
      modelRequested: null,
      status: 'success',
      latencyMs: 100,
      totalTokens: 500_000,
      estimatedCost: 0,
    },
    {
      createdAt: '2026-09-20 11:00:00',
      modelActual: 'model-a',
      modelRequested: null,
      status: 'success',
      latencyMs: null,
      totalTokens: 0,
      estimatedCost: null,
    },
    {
      createdAt: '2026-09-20 11:30:00',
      modelActual: 'model-b',
      modelRequested: null,
      status: 'failed',
      latencyMs: null,
      totalTokens: 0,
      estimatedCost: 0,
    },
  ], { now, days: 1 });

  assert.equal(resolveModelAnalysisSpend({ estimatedCost: 0 }, 500_000), 0);
  assert.equal(result.totals.spend, 0);
  assert.equal(result.callRanking.find((item) => item.model === 'model-a')?.avgLatencyMs, 100);
  assert.equal(result.callRanking.find((item) => item.model === 'model-b')?.avgLatencyMs, null);

  const daily = buildModelAnalysisFromDailyUsage([
    {
      localDay: '2026-09-20', model: 'model-c', totalCalls: 3, successCalls: 3,
      totalTokens: 0, totalSpend: 0, totalLatencyMs: 300, latencyCount: 2,
    },
  ], { now, days: 1 });
  assert.equal(daily.callRanking[0]?.avgLatencyMs, 150);
});

test('debug trace header normalization redacts auth, cookie, and API key values', () => {
  const headers = normalizeProxyDebugResponseHeaders({
    Authorization: 'Bearer private-token',
    Cookie: 'session=private-cookie',
    'X-API-Key': 'private-api-key',
    'X-Request-Id': 'safe-id',
  });

  assert.deepEqual(headers, {
    Authorization: '[REDACTED]',
    Cookie: '[REDACTED]',
    'X-API-Key': '[REDACTED]',
    'X-Request-Id': 'safe-id',
  });
  assert.doesNotMatch(JSON.stringify(headers), /private-token|private-cookie|private-api-key/);
});

test('site trend identity keeps same-named sites separate', () => {
  assert.notEqual(buildSiteTrendIdentity(1, 'same-name'), buildSiteTrendIdentity(2, 'same-name'));
});

test('log cleanup refuses to delete logs while the projection lease blocks watermark progress', async () => {
  await runSqliteRuntimeMigrations();
  const sqlite = new Database(databasePath);
  for (const column of [
    'billing_details', 'downstream_api_key_id', 'client_family', 'client_app_id',
    'client_app_name', 'client_confidence', 'is_stream', 'first_byte_latency_ms',
  ]) {
    const exists = sqlite.prepare('PRAGMA table_info(proxy_logs)').all()
      .some((row: { name?: string }) => row.name === column);
    if (!exists) sqlite.exec(`ALTER TABLE proxy_logs ADD COLUMN ${column} ${column === 'billing_details' ? 'TEXT' : 'INTEGER'}`);
  }
  sqlite.close();
  await db.insert(schema.proxyLogs).values({
    createdAt: '2020-01-01 00:00:00',
    status: 'success',
    estimatedCost: 0,
  }).run();
  await db.insert(schema.analyticsProjectionCheckpoints).values({
    projectorKey: 'usage-aggregates-v1',
    timeZone: 'UTC',
    lastProxyLogId: 0,
    leaseOwner: 'test',
    leaseToken: 'test-token',
    leaseExpiresAt: '2999-01-01T00:00:00.000Z',
  }).run();

  await assert.rejects(
    cleanupUsageLogs(1, Date.parse('2026-09-20T00:00:00.000Z')),
    /watermark did not advance|watermark is behind/,
  );
  assert.equal((await db.select().from(schema.proxyLogs).all()).length, 1);

  await db.update(schema.analyticsProjectionCheckpoints).set({
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
  }).where(
    eq(schema.analyticsProjectionCheckpoints.projectorKey, 'usage-aggregates-v1'),
  ).run();
  const cleanup = await cleanupUsageLogs(1, Date.parse('2026-09-20T00:00:00.000Z'));
  assert.equal(cleanup.deleted, 1);
  assert.equal((await db.select().from(schema.proxyLogs).all()).length, 0);
});
