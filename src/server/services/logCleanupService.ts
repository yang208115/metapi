import { and, lt, lte, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { normalizeLogCleanupRetentionDays } from '../shared/logCleanupRetentionDays.js';
import { ensureUsageAggregationProjectedThroughLogId } from './usageAggregationService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type LogCleanupOptions = {
  usageLogsEnabled?: boolean;
  retentionDays?: number;
  nowMs?: number;
};

export type LogCleanupResult = {
  enabled: boolean;
  usageLogsEnabled: boolean;
  retentionDays: number;
  cutoffUtc: string | null;
  usageLogsDeleted: number;
  totalDeleted: number;
};

export function getLogCleanupCutoffUtc(retentionDays: number, nowMs = Date.now()): string | null {
  const normalizedDays = normalizeLogCleanupRetentionDays(retentionDays);
  return formatUtcSqlDateTime(new Date(nowMs - normalizedDays * DAY_MS));
}

export async function cleanupUsageLogs(retentionDays: number, nowMs = Date.now()): Promise<{
  retentionDays: number;
  cutoffUtc: string | null;
  deleted: number;
}> {
  const normalizedDays = normalizeLogCleanupRetentionDays(retentionDays);
  const cutoffUtc = getLogCleanupCutoffUtc(normalizedDays, nowMs);
  if (!cutoffUtc) {
    return {
      retentionDays: normalizedDays,
      cutoffUtc: null,
      deleted: 0,
    };
  }

  const candidate = await db
    .select({
      maxId: sql<number | null>`max(${schema.proxyLogs.id})`,
    })
    .from(schema.proxyLogs)
    .where(lt(schema.proxyLogs.createdAt, cutoffUtc))
    .get();
  const candidateMaxId = Math.max(0, Math.trunc(Number(candidate?.maxId || 0)));
  if (candidateMaxId <= 0) {
    return {
      retentionDays: normalizedDays,
      cutoffUtc,
      deleted: 0,
    };
  }

  // Project every candidate first. The id bound also prevents a late inserted
  // old-dated row from bypassing the watermark check in this cleanup pass.
  await ensureUsageAggregationProjectedThroughLogId(candidateMaxId);
  const deleted = (
    await db.delete(schema.proxyLogs)
      .where(and(
        lt(schema.proxyLogs.createdAt, cutoffUtc),
        lte(schema.proxyLogs.id, candidateMaxId),
      ))
      .run()
  ).changes;

  return {
    retentionDays: normalizedDays,
    cutoffUtc,
    deleted,
  };
}

export async function cleanupConfiguredLogs(options: LogCleanupOptions = {}): Promise<LogCleanupResult> {
  const usageLogsEnabled = options.usageLogsEnabled ?? config.logCleanupUsageLogsEnabled;
  const retentionDays = normalizeLogCleanupRetentionDays(
    options.retentionDays ?? config.logCleanupRetentionDays,
    config.logCleanupRetentionDays,
  );
  const nowMs = options.nowMs ?? Date.now();
  const enabled = usageLogsEnabled;
  const cutoffUtc = enabled ? getLogCleanupCutoffUtc(retentionDays, nowMs) : null;

  if (!enabled || !cutoffUtc) {
    return {
      enabled: false,
      usageLogsEnabled,
      retentionDays,
      cutoffUtc,
      usageLogsDeleted: 0,
      totalDeleted: 0,
    };
  }

  const usageResult = usageLogsEnabled
    ? await cleanupUsageLogs(retentionDays, nowMs)
    : { deleted: 0 };
  return {
    enabled: true,
    usageLogsEnabled,
    retentionDays,
    cutoffUtc,
    usageLogsDeleted: usageResult.deleted,
    totalDeleted: usageResult.deleted,
  };
}
