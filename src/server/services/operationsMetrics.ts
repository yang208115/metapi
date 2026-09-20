import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { getProxyRequestTelemetryHealth } from '../proxy-core/requestTelemetry.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import {
  formatUtcSqlDateTime,
  getResolvedTimeZone,
  parseStoredUtcDateTime,
} from './localTimeService.js';
import type {
  OperationsCounts,
  OperationsFocus,
  OperationsRequestRecord,
  OperationsRequestsResponse,
  OperationsSite,
  OperationsSnapshot,
  OperationsTimelineBucket,
  OperationsWindow,
} from '../shared/operationsContract.js';
import {
  aggregateOperationsCounts,
  buildOperationsTimeline,
  calculateMetricDistribution,
  countAttemptFailures,
  countRateLimitedAttempts,
  countServerErrorAttempts,
  normalizeOutcomeStatus,
  type OperationsAttemptMetricRow,
  type OperationsOutcomeMetricRow,
} from './operationsMetricsAggregation.js';

const DEFAULT_WINDOW_MINUTES: OperationsWindow = 1440;
const DEFAULT_LIVE_WINDOW_MINUTES = 5;
const LIVE_BUCKET_SECONDS = 3;
const MAX_LIVE_BUCKETS = 1200;
const TIMELINE_TARGET_BUCKETS = 60;
const MAX_SCAN_ROWS = 50_000;
const REQUESTS_DEFAULT_LIMIT = 100;
const REQUESTS_MAX_LIMIT = 500;

type InternalOutcomeRow = OperationsOutcomeMetricRow & {
  downstreamPath: string;
};

type SiteRow = {
  id: number;
  name: string;
  platform: string;
  status: string;
};

type AttemptRow = OperationsAttemptMetricRow & {
  channelId: number | null;
  accountId: number | null;
};

type ChannelRow = {
  id: number;
  siteId: number | null;
  channelEnabled: boolean;
  routeEnabled: boolean;
  accountStatus: string | null;
  apiToken: string | null;
  accessToken: string | null;
  extraConfig: string | null;
  oauthProvider: string | null;
  oauthAccountKey: string | null;
  oauthProjectId: string | null;
  siteStatus: string | null;
  cooldownUntil: string | null;
};

type TelemetryHealth = {
  observedSince: string | null;
  observedSinceSource: 'outcomes' | null;
  pendingWrites: number;
  failedWrites: number;
  lastFailureAt: string | null;
  inFlight: number;
  notes: string[];
};

export class OperationsMetricsQueryLimitError extends Error {
  constructor() {
    super('operations metrics scan exceeded its safety limit; narrow the time window');
    this.name = 'OperationsMetricsQueryLimitError';
  }
}

type QueryScope = {
  siteId: number | null;
  platform: string | null;
};

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function asNullableString(value: unknown): string | null {
  return value == null ? null : asString(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asNullableNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return value == null || !Number.isFinite(number) ? null : number;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function timestampMs(value: string | null | undefined): number | null {
  const parsed = parseStoredUtcDateTime(value);
  return parsed ? parsed.getTime() : null;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function normalizePlatform(value: string | null | undefined): string | null {
  const normalized = (value || '').trim();
  return normalized || null;
}

function normalizeWindow(value: number | undefined, allowed: readonly number[], fallback: number): number {
  const normalized = Number(value);
  return allowed.includes(normalized) ? normalized : fallback;
}

function queryRows(query: SQL): Promise<unknown[][]> {
  return db.all(query) as Promise<unknown[][]>;
}

function appendWhere(conditions: SQL[]): SQL {
  return conditions.length > 0
    ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
    : sql``;
}

function isMissingOutcomeTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  const normalized = message.toLowerCase();
  return normalized.includes('proxy_request_outcomes')
    && (normalized.includes('no such table')
      || normalized.includes('does not exist')
      || normalized.includes('unknown table'));
}

function isInRange(value: string | null | undefined, fromMs: number, toMs: number): boolean {
  const valueMs = timestampMs(value);
  return valueMs !== null && valueMs >= fromMs && valueMs < toMs;
}

function mapOutcomeRow(row: unknown[]): InternalOutcomeRow {
  return {
    requestId: asString(row[0]),
    startedAt: asString(row[1]),
    completedAt: asString(row[2]),
    downstreamPath: asString(row[3]),
    modelRequested: asNullableString(row[4]),
    siteId: asNullableNumber(row[5]),
    status: normalizeOutcomeStatus(asString(row[6])),
    httpStatus: asNullableNumber(row[7]),
    latencyMs: asNullableNumber(row[8]),
    firstByteLatencyMs: asNullableNumber(row[9]),
    attemptCount: Math.max(0, Math.trunc(asNumber(row[10]))),
    failedAttemptCount: Math.max(0, Math.trunc(asNumber(row[11]))),
    totalTokens: asNullableNumber(row[12]),
    estimatedCost: asNullableNumber(row[13]),
    errorClass: asNullableString(row[14]),
  };
}

async function loadOutcomeRows(
  fromMs: number,
  toMs: number,
  scope: QueryScope,
): Promise<{ rows: InternalOutcomeRow[]; available: boolean }> {
  const conditions: SQL[] = [
    sql`o.completed_at >= ${isoAt(fromMs)}`,
    sql`o.completed_at < ${isoAt(toMs)}`,
  ];
  if (scope.siteId !== null) conditions.push(sql`o.site_id = ${scope.siteId}`);
  if (scope.platform !== null) conditions.push(sql`s.platform = ${scope.platform}`);

  try {
    const rows = await queryRows(sql`
      SELECT
        o.request_id,
        o.started_at,
        o.completed_at,
        o.downstream_path,
        o.model_requested,
        o.site_id,
        o.status,
        o.http_status,
        o.latency_ms,
        o.first_byte_latency_ms,
        o.attempt_count,
        o.failed_attempt_count,
        o.total_tokens,
        o.estimated_cost,
        o.error_class
      FROM proxy_request_outcomes o
      LEFT JOIN sites s ON s.id = o.site_id
      ${appendWhere(conditions)}
      ORDER BY o.completed_at ASC, o.id ASC
      LIMIT ${MAX_SCAN_ROWS + 1}
    `);
    if (rows.length > MAX_SCAN_ROWS) throw new OperationsMetricsQueryLimitError();
    return {
      available: true,
      rows: rows.map(mapOutcomeRow).filter((row) => isInRange(row.completedAt, fromMs, toMs)),
    };
  } catch (error) {
    if (!isMissingOutcomeTableError(error)) throw error;
    return { available: false, rows: [] };
  }
}

function mapAttemptRow(row: unknown[]): AttemptRow {
  return {
    occurredAt: asString(row[0]),
    status: asNullableString(row[1]),
    httpStatus: asNullableNumber(row[2]),
    latencyMs: asNullableNumber(row[3]),
    firstByteLatencyMs: asNullableNumber(row[4]),
    totalTokens: asNullableNumber(row[5]),
    estimatedCost: asNullableNumber(row[6]),
    accountId: asNullableNumber(row[7]),
    channelId: asNullableNumber(row[8]),
    siteId: asNullableNumber(row[9]),
  };
}

async function loadAttemptRows(
  fromMs: number,
  toMs: number,
  scope: QueryScope,
): Promise<AttemptRow[]> {
  const conditions: SQL[] = [
    sql`p.created_at >= ${formatUtcSqlDateTime(new Date(fromMs))}`,
    // Use an ISO upper bound so both legacy SQL timestamps and ISO timestamps
    // survive the coarse indexed scan; exact filtering is applied below.
    sql`p.created_at < ${isoAt(toMs)}`,
  ];
  if (scope.siteId !== null) conditions.push(sql`s.id = ${scope.siteId}`);
  if (scope.platform !== null) conditions.push(sql`s.platform = ${scope.platform}`);

  const rows = await queryRows(sql`
    SELECT
      p.created_at,
      p.status,
      p.http_status,
      p.latency_ms,
      p.first_byte_latency_ms,
      p.total_tokens,
      p.estimated_cost,
      p.account_id,
      p.channel_id,
      s.id
    FROM proxy_logs p
    LEFT JOIN accounts a ON a.id = p.account_id
    LEFT JOIN sites s ON s.id = a.site_id
    ${appendWhere(conditions)}
    ORDER BY p.created_at ASC, p.id ASC
    LIMIT ${MAX_SCAN_ROWS + 1}
  `);
  if (rows.length > MAX_SCAN_ROWS) throw new OperationsMetricsQueryLimitError();
  return rows.map(mapAttemptRow).filter((row) => isInRange(row.occurredAt, fromMs, toMs));
}

async function loadSites(): Promise<SiteRow[]> {
  const rows = await queryRows(sql`SELECT id, name, platform, status FROM sites ORDER BY id ASC`);
  return rows.map((row) => ({
    id: asNumber(row[0]),
    name: asString(row[1]),
    platform: asString(row[2]),
    status: asString(row[3], 'unknown'),
  }));
}

async function loadAccountRows(): Promise<Array<{ id: number; siteId: number; status: string }>> {
  const rows = await queryRows(sql`SELECT id, site_id, status FROM accounts`);
  return rows.map((row) => ({ id: asNumber(row[0]), siteId: asNumber(row[1]), status: asString(row[2]) }));
}

async function loadChannelRows(): Promise<ChannelRow[]> {
  const rows = await queryRows(sql`
    SELECT
      c.id,
      a.site_id,
      c.enabled,
      r.enabled,
      a.status,
      a.api_token,
      a.access_token,
      a.extra_config,
      a.oauth_provider,
      a.oauth_account_key,
      a.oauth_project_id,
      s.status,
      c.cooldown_until
    FROM route_channels c
    LEFT JOIN token_routes r ON r.id = c.route_id
    LEFT JOIN accounts a ON a.id = c.account_id
    LEFT JOIN sites s ON s.id = a.site_id
  `);
  return rows.map((row) => ({
    id: asNumber(row[0]),
    siteId: asNullableNumber(row[1]),
    channelEnabled: asBoolean(row[2]),
    routeEnabled: asBoolean(row[3]),
    accountStatus: asNullableString(row[4]),
    apiToken: asNullableString(row[5]),
    accessToken: asNullableString(row[6]),
    extraConfig: asNullableString(row[7]),
    oauthProvider: asNullableString(row[8]),
    oauthAccountKey: asNullableString(row[9]),
    oauthProjectId: asNullableString(row[10]),
    siteStatus: asNullableString(row[11]),
    cooldownUntil: asNullableString(row[12]),
  }));
}

function filterOutcomeRows(rows: InternalOutcomeRow[], fromMs: number, toMs: number): InternalOutcomeRow[] {
  return rows.filter((row) => isInRange(row.completedAt, fromMs, toMs));
}

function filterAttemptRows(rows: AttemptRow[], fromMs: number, toMs: number): AttemptRow[] {
  return rows.filter((row) => isInRange(row.occurredAt, fromMs, toMs));
}

function buildTimelineBucketSeconds(spanMs: number): number {
  return Math.max(1, Math.ceil(spanMs / TIMELINE_TARGET_BUCKETS / 1_000));
}

function buildLiveBuckets(
  outcomes: InternalOutcomeRow[],
  attempts: AttemptRow[],
  fromMs: number,
  toMs: number,
): OperationsTimelineBucket[] {
  const spanMs = Math.max(1, toMs - fromMs);
  const bucketSeconds = Math.max(LIVE_BUCKET_SECONDS, Math.ceil(spanMs / MAX_LIVE_BUCKETS / 1_000));
  return buildOperationsTimeline({
    fromMs,
    toMs,
    bucketSeconds,
    outcomes,
    attempts,
  });
}

function buildFocus(
  current: OperationsCounts,
  currentAttempts: AttemptRow[],
  sites: OperationsSite[],
  telemetry: OperationsSnapshot['telemetry'],
  scope: QueryScope,
): OperationsFocus[] {
  const focus: OperationsFocus[] = [];
  const scopeLabel = scope.siteId !== null
    ? `选定站点 ${scope.siteId}`
    : scope.platform !== null
      ? `选定平台 ${scope.platform}`
      : '选定范围';
  const failedFinal = current.failed + current.rejected + current.cancelled + current.unknown;
  if (failedFinal > 0) {
    focus.push({
      id: 'final-request-failures',
      severity: current.success === 0 ? 'critical' : 'warning',
      title: '最终请求存在故障结果',
      evidence: `最终请求 ${current.total} 个，其中失败 ${current.failed}、拒绝 ${current.rejected}、取消 ${current.cancelled}、未知 ${current.unknown}。`,
      action: '打开最近失败或全部结果下钻，先确认错误分类；再按站点检查尝试证据。',
      siteId: null,
      kind: 'request',
    });
  }

  const failedAttempts = countAttemptFailures(currentAttempts);
  if (failedAttempts > 0) {
    focus.push({
      id: 'upstream-attempt-failures',
      severity: 'warning',
      title: '上游尝试失败或重试',
      evidence: `${scopeLabel}内记录上游尝试 ${currentAttempts.length} 次，其中 ${failedAttempts} 次未成功；这是当前筛选范围的尝试结果证据。`,
      action: '按站点检查 429/529、5xx 和通道冷却状态，再查看最终请求是否通过重试恢复。',
      siteId: null,
      kind: 'attempt',
    });
  }

  for (const site of sites.filter((site) => site.requests.total > 0 || site.failedAttempts > 0).slice(0, 5)) {
    const siteFaults = site.requests.failed + site.requests.rejected + site.requests.cancelled + site.requests.unknown + site.failedAttempts;
    if (siteFaults === 0) continue;
    focus.push({
      id: `site-${site.id}-faults`,
      severity: site.requests.total > 0 && site.requests.success === 0 ? 'critical' : 'warning',
      title: `${site.name} 有故障证据`,
      evidence: `该站点最终请求 ${site.requests.total} 个、故障结果 ${site.requests.failed + site.requests.rejected + site.requests.cancelled + site.requests.unknown} 个；未成功的上游尝试 ${site.failedAttempts} 次。`,
      action: '检查该站点账号、凭据和冷却状态，再查看具体失败的最终结果。',
      siteId: site.id,
      kind: site.failedAttempts > 0 ? 'attempt' : 'request',
    });
  }

  const noReadyTrafficSite = sites.find((site) => site.requests.total > 0 && site.readyChannels === 0);
  if (noReadyTrafficSite) {
    focus.push({
      id: `site-${noReadyTrafficSite.id}-no-ready-channel`,
      severity: 'critical',
      title: `${noReadyTrafficSite.name} 没有可选通道`,
      evidence: `该站点有 ${noReadyTrafficSite.requests.total} 个最终请求，但当前没有满足启用、凭据、账号、站点和冷却条件的可选通道。`,
      action: '检查可选通道的启用状态、凭据有效性、账号和站点状态，或等待冷却结束；这不代表主动探测成功。',
      siteId: noReadyTrafficSite.id,
      kind: 'route',
    });
  }

  if (telemetry.unassignedRequests > 0) {
    focus.push({
      id: 'unassigned-request-telemetry',
      severity: 'warning',
      title: '存在未分配站点的最终请求',
      evidence: `有 ${telemetry.unassignedRequests} 个最终请求未能归属站点，无法纳入站点故障归因；这是当前筛选范围的请求结果证据。`,
      action: '检查鉴权失败、无通道入口和请求 outcome 的最后选择写入。',
      siteId: null,
      kind: 'telemetry',
    });
  }

  if (!telemetry.historyComplete) {
    focus.push({
      id: 'incomplete-history',
      severity: 'info',
      title: '历史覆盖不足，比较结果需谨慎',
      evidence: `${scopeLabel}的请求结果采集起点不足以证明完整历史对比区间，提升或下降不能视为可靠趋势。`,
      action: '等待请求结果持续采集覆盖完整对比区间，再使用前后周期比较。',
      siteId: null,
      kind: 'telemetry',
    });
  }
  return focus;
}

function buildErrorSummary(rows: InternalOutcomeRow[]): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (normalizeOutcomeStatus(row.status) === 'success') continue;
    const kind = row.errorClass?.trim()
      || (row.httpStatus == null ? normalizeOutcomeStatus(row.status) : `http_${row.httpStatus}`);
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind));
}

function buildRecentFailures(rows: InternalOutcomeRow[]): OperationsSnapshot['recentFailures'] {
  return rows
    .filter((row) => normalizeOutcomeStatus(row.status) !== 'success')
    .sort((left, right) => (timestampMs(right.completedAt) || 0) - (timestampMs(left.completedAt) || 0))
    .slice(0, 20)
    .map((row) => ({
      requestId: row.requestId,
      completedAt: row.completedAt,
      model: row.modelRequested,
      siteId: row.siteId,
      status: normalizeOutcomeStatus(row.status),
      httpStatus: row.httpStatus,
      errorClass: row.errorClass,
      latencyMs: row.latencyMs,
      attemptCount: row.attemptCount,
    }));
}

function isReadyChannel(row: ChannelRow, nowMs: number): boolean {
  const coolingUntil = timestampMs(row.cooldownUntil);
  const account = {
    extraConfig: row.extraConfig,
    oauthProvider: row.oauthProvider,
    oauthAccountKey: row.oauthAccountKey,
    oauthProjectId: row.oauthProjectId,
  };
  const tokenReady = Boolean(
    getOauthInfoFromAccount(account)
      ? row.accessToken?.trim() || row.apiToken?.trim()
      : row.apiToken?.trim() || row.accessToken?.trim(),
  );
  return row.channelEnabled
    && row.routeEnabled
    && row.accountStatus === 'active'
    && row.siteStatus === 'active'
    && tokenReady
    && (coolingUntil === null || coolingUntil <= nowMs);
}

function isCoolingChannel(row: ChannelRow, nowMs: number): boolean {
  const coolingUntil = timestampMs(row.cooldownUntil);
  return coolingUntil !== null && coolingUntil > nowMs;
}

function filterSiteRows(rows: SiteRow[], scope: QueryScope): SiteRow[] {
  return rows.filter((site) => (scope.siteId === null || site.id === scope.siteId)
    && (scope.platform === null || site.platform === scope.platform));
}

function buildSiteSummaries(
  siteRows: SiteRow[],
  accountRows: Array<{ id: number; siteId: number; status: string }>,
  channelRows: ChannelRow[],
  outcomes: InternalOutcomeRow[],
  attempts: AttemptRow[],
  fromMs: number,
  toMs: number,
  timelineBucketSeconds: number,
): OperationsSite[] {
  const nowMs = Date.now();
  const timeline = buildOperationsTimeline({
    fromMs,
    toMs,
    bucketSeconds: timelineBucketSeconds,
    outcomes,
    attempts,
  });
  const bucketMs = timelineBucketSeconds * 1_000;
  const attemptBucketsBySite = new Map<number, Array<{ total: number; failed: number }>>();
  for (const site of siteRows) {
    attemptBucketsBySite.set(site.id, timeline.map(() => ({ total: 0, failed: 0 })));
  }
  for (const attempt of attempts) {
    if (attempt.siteId === null) continue;
    const occurredAtMs = timestampMs(attempt.occurredAt);
    if (occurredAtMs === null) continue;
    const bucketIndex = Math.floor((occurredAtMs - fromMs) / bucketMs);
    const buckets = attemptBucketsBySite.get(attempt.siteId);
    if (!buckets || bucketIndex < 0 || bucketIndex >= buckets.length) continue;
    buckets[bucketIndex].total += 1;
    if ((attempt.status || '').trim().toLowerCase() !== 'success') buckets[bucketIndex].failed += 1;
  }
  return siteRows.map((site) => {
    const siteOutcomes = outcomes.filter((row) => row.siteId === site.id);
    const siteAttempts = attempts.filter((row) => row.siteId === site.id);
    const siteAccounts = accountRows.filter((row) => row.siteId === site.id);
    const siteChannels = channelRows.filter((row) => row.siteId === site.id);
    const requestCounts = aggregateOperationsCounts(siteOutcomes);
    return {
      id: site.id,
      name: site.name,
      platform: site.platform,
      status: site.status,
      requests: requestCounts,
      attempts: siteAttempts.length,
      failedAttempts: countAttemptFailures(siteAttempts),
      latency: calculateMetricDistribution(siteOutcomes.map((row) => row.latencyMs)),
      firstByte: calculateMetricDistribution(siteOutcomes.map((row) => row.firstByteLatencyMs)),
      buckets: attemptBucketsBySite.get(site.id) || timeline.map(() => ({ total: 0, failed: 0 })),
      accounts: siteAccounts.length,
      activeAccounts: siteAccounts.filter((row) => row.status === 'active').length,
      channels: siteChannels.length,
      readyChannels: siteChannels.filter((row) => isReadyChannel(row, nowMs)).length,
      coolingChannels: siteChannels.filter((row) => isCoolingChannel(row, nowMs)).length,
    } satisfies OperationsSite;
  });
}

function sortSites(sites: OperationsSite[]): OperationsSite[] {
  return sites.sort((left, right) => {
    const leftFaults = left.requests.failed + left.requests.rejected + left.requests.cancelled + left.requests.unknown + left.failedAttempts;
    const rightFaults = right.requests.failed + right.requests.rejected + right.requests.cancelled + right.requests.unknown + right.failedAttempts;
    const leftTraffic = left.requests.total + left.attempts;
    const rightTraffic = right.requests.total + right.attempts;
    if ((leftTraffic === 0) !== (rightTraffic === 0)) return leftTraffic === 0 ? 1 : -1;
    return rightFaults - leftFaults || rightTraffic - leftTraffic || left.name.localeCompare(right.name) || left.id - right.id;
  });
}

function emptyCounts(): OperationsCounts {
  return aggregateOperationsCounts([]);
}

export async function getOperationsSnapshot(options?: {
  windowMinutes?: OperationsWindow;
  liveWindowMinutes?: 1 | 5 | 30 | 60;
  siteId?: number;
  platform?: string;
}): Promise<OperationsSnapshot> {
  const windowMinutes = normalizeWindow(options?.windowMinutes, [60, 1440, 10080], DEFAULT_WINDOW_MINUTES) as OperationsWindow;
  const liveWindowMinutes = normalizeWindow(options?.liveWindowMinutes, [1, 5, 30, 60], DEFAULT_LIVE_WINDOW_MINUTES);
  const nowMs = Date.now();
  const currentFromMs = nowMs - windowMinutes * 60 * 1_000;
  const previousFromMs = currentFromMs - windowMinutes * 60 * 1_000;
  const liveFromMs = nowMs - liveWindowMinutes * 60 * 1_000;
  const scope: QueryScope = {
    siteId: Number.isInteger(options?.siteId) ? options!.siteId! : null,
    platform: normalizePlatform(options?.platform),
  };

  const [outcomeResult, attemptRows, siteRows, accountRows, channelRows, telemetryHealth] = await Promise.all([
    loadOutcomeRows(previousFromMs, nowMs, scope),
    loadAttemptRows(currentFromMs, nowMs, scope),
    loadSites(),
    loadAccountRows(),
    loadChannelRows(),
    getProxyRequestTelemetryHealth(),
  ]);
  const previousOutcomes = filterOutcomeRows(outcomeResult.rows, previousFromMs, currentFromMs);
  const currentOutcomes = filterOutcomeRows(outcomeResult.rows, currentFromMs, nowMs);
  const currentAttempts = filterAttemptRows(attemptRows, currentFromMs, nowMs);
  const liveOutcomes = filterOutcomeRows(outcomeResult.rows, liveFromMs, nowMs);
  const liveAttempts = filterAttemptRows(attemptRows, liveFromMs, nowMs);
  const selectedSites = filterSiteRows(siteRows, scope);
  const timelineBucketSeconds = buildTimelineBucketSeconds(windowMinutes * 60 * 1_000);
  const current = aggregateOperationsCounts(currentOutcomes);
  const previous = aggregateOperationsCounts(previousOutcomes);
  const currentLatency = calculateMetricDistribution(currentOutcomes.map((row) => row.latencyMs));
  const currentFirstByte = calculateMetricDistribution(currentOutcomes.map((row) => row.firstByteLatencyMs));
  const liveBuckets = buildLiveBuckets(liveOutcomes, liveAttempts, liveFromMs, nowMs);
  const liveTokens = liveOutcomes.reduce((sum, row) => sum + (row.totalTokens != null && row.totalTokens >= 0 ? row.totalTokens : 0), 0);
  const liveQps = liveOutcomes.length / (liveWindowMinutes * 60);
  const peakQps = liveBuckets.reduce((max, bucket) => Math.max(max, bucket.requests / LIVE_BUCKET_SECONDS), 0);
  const observedSince = telemetryHealth.observedSince;
  const observedSinceMs = timestampMs(observedSince);
  const historyComplete = outcomeResult.available
    && telemetryHealth.observedSinceSource === 'outcomes'
    && observedSinceMs !== null
    && observedSinceMs <= previousFromMs;
  const notes: string[] = [
    '当前、前一周期和实时请求量来自最终请求结果；上游尝试量单独统计。',
    '首块时延只表示明确观测到的上游首个字节，不是下游 TTFT。',
    'HTTP 状态推断不覆盖 WebSocket；实时健康计数和写入失败是当前进程全局值，不按当前筛选范围拆分。',
    ...telemetryHealth.notes,
  ];
  if (!outcomeResult.available) notes.push('当前部署尚未提供最终请求结果采集，成功率和请求量暂不具备完整覆盖。');
  if (!historyComplete) notes.push('历史对比区间没有完整请求结果覆盖，前后周期变化不能解释为可靠提升。');
  if (telemetryHealth.failedWrites > 0) notes.push(`有 ${telemetryHealth.failedWrites} 次请求结果写入失败，当前统计可能不完整。`);
  if (telemetryHealth.pendingWrites > 0) notes.push(`有 ${telemetryHealth.pendingWrites} 条请求结果仍在写入，当前统计可能继续变化。`);
  if (currentOutcomes.some((row) => row.siteId === null)) notes.push('有请求结果尚未归属站点，站点统计不包含这些请求。');

  const telemetry: OperationsSnapshot['telemetry'] = {
    observedSince,
    lastObservedAt: currentOutcomes.length > 0
      ? currentOutcomes.reduce((latest, row) => (timestampMs(row.completedAt) || 0) > (timestampMs(latest) || 0) ? row.completedAt : latest, currentOutcomes[0].completedAt)
      : null,
    historyComplete,
    latencyCoverage: current.total > 0 ? (currentLatency.count / current.total) * 100 : null,
    firstByteCoverage: current.total > 0 ? (currentFirstByte.count / current.total) * 100 : null,
    unassignedRequests: currentOutcomes.filter((row) => row.siteId === null).length,
    writeFailures: telemetryHealth.failedWrites,
    pendingWrites: telemetryHealth.pendingWrites,
    inFlight: telemetryHealth.inFlight,
    notes,
  };
  const sites = sortSites(buildSiteSummaries(
    selectedSites,
    accountRows,
    channelRows.filter((row) => scope.siteId === null || row.siteId === scope.siteId),
    currentOutcomes,
    currentAttempts,
    currentFromMs,
    nowMs,
    timelineBucketSeconds,
  ));
  const snapshot: OperationsSnapshot = {
    generatedAt: new Date(nowMs).toISOString(),
    scope: {
      from: isoAt(currentFromMs),
      to: isoAt(nowMs),
      windowMinutes,
      siteId: scope.siteId,
      platform: scope.platform,
      timezone: getResolvedTimeZone(),
    },
    previousScope: { from: isoAt(previousFromMs), to: isoAt(currentFromMs) },
    current,
    previous,
    latency: currentLatency,
    firstByte: currentFirstByte,
    attempts: {
      total: currentAttempts.length,
      failed: countAttemptFailures(currentAttempts),
      rateLimited: countRateLimitedAttempts(currentAttempts),
      serverErrors: countServerErrorAttempts(currentAttempts),
      tokens: currentAttempts.reduce((sum, row) => sum + (row.totalTokens != null && row.totalTokens >= 0 ? row.totalTokens : 0), 0),
      cost: currentAttempts.reduce((sum, row) => sum + (row.estimatedCost != null && row.estimatedCost >= 0 ? row.estimatedCost : 0), 0),
    },
    live: {
      from: isoAt(liveFromMs),
      to: isoAt(nowMs),
      windowMinutes: liveWindowMinutes,
      requests: liveOutcomes.length,
      tokens: liveTokens,
      qps: liveQps,
      tokensPerSecond: liveTokens / (liveWindowMinutes * 60),
      peakQps,
      bucketSeconds: LIVE_BUCKET_SECONDS,
      buckets: liveBuckets,
    },
    timeline: buildOperationsTimeline({
      fromMs: currentFromMs,
      toMs: nowMs,
      bucketSeconds: timelineBucketSeconds,
      outcomes: currentOutcomes,
      attempts: currentAttempts,
    }),
    sites,
    filters: siteRows.map((site) => ({ id: site.id, name: site.name, platform: site.platform, status: site.status })),
    errors: buildErrorSummary(currentOutcomes),
    focus: buildFocus(current, currentAttempts, sites, telemetry, scope),
    telemetry,
    recentFailures: buildRecentFailures(currentOutcomes),
  };
  return snapshot;
}

function normalizePage(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(parsed)));
}

export async function listOperationsRequests(options: {
  fromMs: number;
  toMs: number;
  requestId?: string;
  siteId?: number;
  platform?: string;
  status?: string;
  recovered?: boolean;
  limit?: number;
  offset?: number;
}): Promise<OperationsRequestsResponse> {
  const scope: QueryScope = {
    siteId: Number.isInteger(options.siteId) ? options.siteId! : null,
    platform: normalizePlatform(options.platform),
  };
  const result = await loadOutcomeRows(options.fromMs, options.toMs, scope);
  const normalizedStatus = options.status ? normalizeOutcomeStatus(options.status) : null;
  const filtered = normalizedStatus
    ? result.rows.filter((row) => normalizeOutcomeStatus(row.status) === normalizedStatus)
    : result.rows;
  const requestFiltered = options.requestId
    ? filtered.filter((row) => row.requestId === options.requestId)
    : filtered;
  const recoveredFiltered = options.recovered
    ? requestFiltered.filter((row) => normalizeOutcomeStatus(row.status) === 'success'
      && row.attemptCount > 1
      && row.failedAttemptCount > 0)
    : requestFiltered;
  const recentFirst = [...recoveredFiltered].reverse();
  const offset = Math.max(0, Math.trunc(options.offset || 0));
  const limit = Math.max(1, Math.min(REQUESTS_MAX_LIMIT, Math.trunc(options.limit || REQUESTS_DEFAULT_LIMIT)));
  return {
    items: recentFirst.slice(offset, offset + limit).map((row): OperationsRequestRecord => ({
      requestId: row.requestId,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      downstreamPath: row.downstreamPath,
      modelRequested: row.modelRequested,
      siteId: row.siteId,
      status: normalizeOutcomeStatus(row.status),
      httpStatus: row.httpStatus,
      latencyMs: row.latencyMs,
      firstByteLatencyMs: row.firstByteLatencyMs,
      attemptCount: row.attemptCount,
      failedAttemptCount: row.failedAttemptCount,
      totalTokens: row.totalTokens,
      errorClass: row.errorClass,
    })),
    total: recoveredFiltered.length,
    limit,
    offset,
  };
}

export const operationsMetricsTestUtils = {
  buildFocus,
  buildErrorSummary,
  buildRecentFailures,
  isReadyChannel,
  normalizePage,
};
