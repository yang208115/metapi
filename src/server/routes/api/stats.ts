import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { refreshModelsForAccount } from "../../services/modelService.js";
import * as routeRefreshWorkflow from "../../services/routeRefreshWorkflow.js";
import { buildModelAnalysis } from "../../services/modelAnalysisService.js";
import {
  fetchModelPricingCatalog,
} from "../../services/modelPricingService.js";
import {
  getBackgroundTask,
  getRunningTaskByDedupeKey,
  startBackgroundTask,
} from "../../services/backgroundTaskService.js";
import {
  getProxyLogBaseSelectFields,
  parseProxyLogBillingDetails,
  withProxyLogSelectFields,
} from "../../services/proxyLogStore.js";
import {
  getProxyDebugTraceDetail,
  listProxyDebugTraces,
} from "../../services/proxyDebugTraceStore.js";
import { parseProxyLogMessageMeta } from "../../services/proxyLogMessage.js";
import { requiresManagedAccountTokens } from "../../services/accountExtraConfig.js";
import { ACCOUNT_TOKEN_VALUE_STATUS_READY } from "../../services/accountTokenService.js";
import {
  formatLocalDateTime,
  formatUtcSqlDateTime,
  getLocalDayRangeUtc,
  getLocalRangeStartDayKey,
  getLocalRangeStartUtc,
  parseStoredUtcDateTime,
  type StoredUtcDateTimeInput,
  toLocalDayKeyFromStoredUtc,
} from "../../services/localTimeService.js";
import { createRateLimitGuard } from "../../middleware/requestRateLimit.js";
import {
  getDashboardInsightsSnapshot,
  getDashboardSummarySnapshot,
} from "../../services/dashboardSnapshotService.js";
import { getSiteStatsSnapshot } from "../../services/siteStatsSnapshotService.js";
import {
  runUsageAggregationProjectionPass,
} from "../../services/usageAggregationService.js";

function parseBooleanFlag(raw?: string): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeDashboardView(raw?: string) {
  const normalized = (raw || "").trim().toLowerCase();
  if (normalized === "summary" || normalized === "insights") {
    return normalized;
  }
  return "full";
}

function normalizeProxyLogsView(raw?: string) {
  const normalized = (raw || "").trim().toLowerCase();
  if (normalized === "query" || normalized === "meta" || normalized === "window") {
    return normalized;
  }
  return "full";
}

function normalizeProxyLogBucketCount(raw?: string): number {
  const parsed = Number.parseInt(raw || "20", 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(6, Math.min(60, parsed));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const MODELS_CACHE_TTL_MS = 15_000;
const limitModelTokenCandidatesRead = createRateLimitGuard({
  bucket: "models-token-candidates-read",
  max: 30,
  windowMs: 60_000,
});

type ModelsCacheEntry = {
  expiresAt: number;
  models: any[];
};

let modelsCache: ModelsCacheEntry | null = null;

function readModelsCache(): any[] | null {
  const cached = modelsCache;
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    modelsCache = null;
    return null;
  }
  return cached.models;
}

function writeModelsCache(models: any[]): void {
  modelsCache = {
    expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
    models,
  };
}

function proxyCostSqlExpression() {
  return sql<number>`
    coalesce(
      ${schema.proxyLogs.estimatedCost},
      coalesce(${schema.proxyLogs.totalTokens}, 0) / 500000.0
    )
  `;
}

type ProxyLogStatusFilter = "all" | "success" | "failed";
type ProxyLogClientFilter = {
  kind: "app" | "family";
  value: string;
} | null;

type ProxyLogClientOption = {
  value: string;
  label: string;
};

const PROXY_LOG_CLIENT_FAMILY_LABELS: Record<string, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  gemini_cli: "Gemini CLI",
  generic: "通用",
};

function normalizeProxyLogPageSize(raw?: string): number {
  const parsed = Number.parseInt(raw || "50", 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(100, parsed));
}

function normalizeProxyLogOffset(raw?: string): number {
  const parsed = Number.parseInt(raw || "0", 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function normalizeProxyLogStatusFilter(raw?: string): ProxyLogStatusFilter {
  const normalized = (raw || "").trim().toLowerCase();
  if (normalized === "success") return "success";
  if (normalized === "failed") return "failed";
  return "all";
}

function normalizeProxyLogSearch(raw?: string): string {
  return (raw || "").trim().toLowerCase();
}

function normalizeProxyLogSiteId(raw?: string): number | null {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeProxyLogClientFilter(raw?: string): ProxyLogClientFilter {
  const text = (raw || "").trim();
  if (!text) return null;
  const separatorIndex = text.indexOf(":");
  if (separatorIndex <= 0) return null;
  const kind = text.slice(0, separatorIndex).trim().toLowerCase();
  const value = text
    .slice(separatorIndex + 1)
    .trim()
    .toLowerCase();
  if (!value) return null;
  if (kind === "app" || kind === "family") {
    return { kind, value };
  }
  return null;
}

function normalizeProxyLogTimeBoundary(raw?: string): string | null {
  const text = (raw || "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatUtcSqlDateTime(parsed);
}

function parseDownstreamKeyTags(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of parsed) {
      const text = String(value || "").trim();
      if (!text) continue;
      const dedupeKey = text.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      result.push(text);
    }
    return result;
  } catch {
    return [];
  }
}

function buildProxyLogSearchCondition(search: string) {
  if (!search) return null;
  const likeTerm = `%${search}%`;
  return sql<boolean>`(
    lower(coalesce(${schema.proxyLogs.modelRequested}, '')) like ${likeTerm}
    or lower(coalesce(${schema.proxyLogs.modelActual}, '')) like ${likeTerm}
    or lower(coalesce(${schema.downstreamApiKeys.name}, '')) like ${likeTerm}
    or lower(coalesce(${schema.downstreamApiKeys.groupName}, '')) like ${likeTerm}
    or lower(coalesce(${schema.downstreamApiKeys.tags}, '')) like ${likeTerm}
  )`;
}

function buildProxyLogStatusCondition(status: ProxyLogStatusFilter) {
  if (status === "success") {
    return eq(schema.proxyLogs.status, "success");
  }
  if (status === "failed") {
    return sql<boolean>`coalesce(${schema.proxyLogs.status}, '') <> 'success'`;
  }
  return null;
}

function buildProxyLogClientCondition(client: ProxyLogClientFilter) {
  if (!client) return null;
  if (client.kind === "app") {
    return eq(schema.proxyLogs.clientAppId, client.value);
  }
  return eq(schema.proxyLogs.clientFamily, client.value);
}

function buildProxyLogWhereClause(params: {
  status?: ProxyLogStatusFilter;
  search?: string;
  client?: ProxyLogClientFilter;
  siteId?: number | null;
  fromUtc?: string | null;
  toUtc?: string | null;
}) {
  const conditions = [
    params.status ? buildProxyLogStatusCondition(params.status) : null,
    params.search ? buildProxyLogSearchCondition(params.search) : null,
    params.client ? buildProxyLogClientCondition(params.client) : null,
    params.siteId ? eq(schema.sites.id, params.siteId) : null,
    params.fromUtc ? gte(schema.proxyLogs.createdAt, params.fromUtc) : null,
    params.toUtc ? lt(schema.proxyLogs.createdAt, params.toUtc) : null,
  ].filter(
    (condition): condition is NonNullable<typeof condition> =>
      condition !== null,
  );

  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

function toRoundedMicroNumber(value: number | null | undefined): number {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function normalizeNullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeClientConfidence(value: unknown): string | null {
  const normalized = normalizeNullableText(value)?.toLowerCase() || null;
  if (
    normalized === "exact" ||
    normalized === "heuristic" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return null;
}

function displayProxyLogClientFamily(value: string | null): string | null {
  if (!value) return null;
  return PROXY_LOG_CLIENT_FAMILY_LABELS[value] || value;
}

function resolveProxyLogClientMeta(proxyLog: Record<string, unknown>) {
  const clientFamily =
    normalizeNullableText(proxyLog.clientFamily)?.toLowerCase() || null;
  const clientAppId =
    normalizeNullableText(proxyLog.clientAppId)?.toLowerCase() || null;
  const clientAppName = normalizeNullableText(proxyLog.clientAppName) || null;
  const clientConfidence = normalizeClientConfidence(proxyLog.clientConfidence);

  if (clientFamily || clientAppId || clientAppName || clientConfidence) {
    return {
      clientFamily,
      clientAppId,
      clientAppName,
      clientConfidence,
    };
  }

  const legacyMeta = parseProxyLogMessageMeta(
    typeof proxyLog.errorMessage === "string" ? proxyLog.errorMessage : "",
  );
  return {
    clientFamily:
      normalizeNullableText(legacyMeta.clientKind)?.toLowerCase() || null,
    clientAppId: null,
    clientAppName: null,
    clientConfidence: null,
  };
}

function normalizeProxyLogUsageSource(
  value: unknown,
): "upstream" | "self-log" | "unknown" | null {
  const normalized = normalizeNullableText(value)?.toLowerCase() || null;
  if (
    normalized === "upstream" ||
    normalized === "self-log" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return null;
}

function buildProxyLogClientOptions(
  rows: Array<{
    clientFamily?: string | null;
    clientAppId?: string | null;
    clientAppName?: string | null;
  }>,
): ProxyLogClientOption[] {
  const appOptions = new Map<string, ProxyLogClientOption>();
  const familyOptions = new Map<string, ProxyLogClientOption>();

  for (const row of rows) {
    const clientAppId =
      normalizeNullableText(row.clientAppId)?.toLowerCase() || null;
    const clientAppName = normalizeNullableText(row.clientAppName) || null;
    const clientFamily =
      normalizeNullableText(row.clientFamily)?.toLowerCase() || null;

    if (clientAppId && clientAppName && !appOptions.has(clientAppId)) {
      appOptions.set(clientAppId, {
        value: `app:${clientAppId}`,
        label: `应用 · ${clientAppName}`,
      });
    }

    if (
      clientFamily &&
      clientFamily !== "generic" &&
      !familyOptions.has(clientFamily)
    ) {
      familyOptions.set(clientFamily, {
        value: `family:${clientFamily}`,
        label: `协议 · ${displayProxyLogClientFamily(clientFamily) || clientFamily}`,
      });
    }
  }

  return [
    ...Array.from(appOptions.values()).sort((left, right) =>
      left.label.localeCompare(right.label, "zh-CN"),
    ),
    ...Array.from(familyOptions.values()).sort((left, right) =>
      left.label.localeCompare(right.label, "zh-CN"),
    ),
  ];
}

const SITE_AVAILABILITY_BUCKET_COUNT = 24;
const SITE_AVAILABILITY_BUCKET_MS = 60 * 60 * 1000;

type SiteAvailabilitySiteRow = {
  id: number;
  name: string;
  url: string | null;
  platform: string | null;
  sortOrder: number | null;
  isPinned: boolean | null;
};

type SiteAvailabilityLogRow = {
  siteId: number | null;
  createdAt: StoredUtcDateTimeInput;
  status: string | null;
  latencyMs: number | null;
};

type SiteAvailabilityBucketAccumulator = {
  startUtc: string;
  label: string;
  totalRequests: number;
  successCount: number;
  failedCount: number;
  latencyTotalMs: number;
  latencyCount: number;
};

function roundPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

function buildSiteAvailabilitySummaries(
  sites: SiteAvailabilitySiteRow[],
  logs: SiteAvailabilityLogRow[],
  now = new Date(),
) {
  const endLocal = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    0,
    0,
    0,
  );
  const startLocal = new Date(
    endLocal.getTime() -
      (SITE_AVAILABILITY_BUCKET_COUNT - 1) * SITE_AVAILABILITY_BUCKET_MS,
  );
  const startMs = startLocal.getTime();
  const rangeMs = SITE_AVAILABILITY_BUCKET_COUNT * SITE_AVAILABILITY_BUCKET_MS;

  const createBucketTemplate = (): SiteAvailabilityBucketAccumulator[] =>
    Array.from({ length: SITE_AVAILABILITY_BUCKET_COUNT }, (_, index) => {
      const bucketStart = new Date(
        startMs + index * SITE_AVAILABILITY_BUCKET_MS,
      );
      return {
        startUtc: bucketStart.toISOString(),
        label: formatLocalDateTime(bucketStart),
        totalRequests: 0,
        successCount: 0,
        failedCount: 0,
        latencyTotalMs: 0,
        latencyCount: 0,
      };
    });

  const siteMap = new Map<
    number,
    {
      site: SiteAvailabilitySiteRow;
      totalRequests: number;
      successCount: number;
      failedCount: number;
      latencyTotalMs: number;
      latencyCount: number;
      buckets: SiteAvailabilityBucketAccumulator[];
    }
  >();

  for (const site of sites) {
    siteMap.set(site.id, {
      site,
      totalRequests: 0,
      successCount: 0,
      failedCount: 0,
      latencyTotalMs: 0,
      latencyCount: 0,
      buckets: createBucketTemplate(),
    });
  }

  for (const log of logs) {
    if (log.siteId == null) continue;
    const target = siteMap.get(log.siteId);
    if (!target) continue;

    const parsed = parseStoredUtcDateTime(log.createdAt);
    if (!parsed) continue;
    const timestampMs = parsed.getTime();
    const diffMs = timestampMs - startMs;
    if (diffMs < 0 || diffMs >= rangeMs) continue;

    const bucketIndex = Math.floor(diffMs / SITE_AVAILABILITY_BUCKET_MS);
    const bucket = target.buckets[bucketIndex];
    const isSuccess = (log.status || "").trim().toLowerCase() === "success";

    target.totalRequests += 1;
    bucket.totalRequests += 1;
    if (isSuccess) {
      target.successCount += 1;
      bucket.successCount += 1;
    } else {
      target.failedCount += 1;
      bucket.failedCount += 1;
    }

    const latencyMs = Number(log.latencyMs);
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      target.latencyTotalMs += latencyMs;
      target.latencyCount += 1;
      bucket.latencyTotalMs += latencyMs;
      bucket.latencyCount += 1;
    }
  }

  return sites.map((site) => {
    const aggregate = siteMap.get(site.id)!;
    return {
      siteId: site.id,
      siteName: site.name,
      siteUrl: site.url,
      platform: site.platform,
      totalRequests: aggregate.totalRequests,
      successCount: aggregate.successCount,
      failedCount: aggregate.failedCount,
      availabilityPercent:
        aggregate.totalRequests > 0
          ? roundPercent(
              (aggregate.successCount / aggregate.totalRequests) * 100,
            )
          : null,
      averageLatencyMs:
        aggregate.latencyCount > 0
          ? Math.round(aggregate.latencyTotalMs / aggregate.latencyCount)
          : null,
      buckets: aggregate.buckets.map((bucket) => ({
        startUtc: bucket.startUtc,
        label: bucket.label,
        totalRequests: bucket.totalRequests,
        successCount: bucket.successCount,
        failedCount: bucket.failedCount,
        availabilityPercent:
          bucket.totalRequests > 0
            ? roundPercent((bucket.successCount / bucket.totalRequests) * 100)
            : null,
        averageLatencyMs:
          bucket.latencyCount > 0
            ? Math.round(bucket.latencyTotalMs / bucket.latencyCount)
            : null,
      })),
    };
  });
}

function mapProxyLogRow(
  row: {
    proxy_logs: Record<string, unknown> & { billingDetails?: string | null };
    accounts: { username?: string | null } | null;
    sites: {
      id?: number | null;
      name?: string | null;
      url?: string | null;
    } | null;
    downstream_api_keys: {
      id?: number | null;
      name?: string | null;
      groupName?: string | null;
      tags?: string | null;
    } | null;
  },
  options?: { includeBillingDetails?: boolean },
) {
  const clientMeta = resolveProxyLogClientMeta(row.proxy_logs);
  const legacyMeta = parseProxyLogMessageMeta(
    typeof row.proxy_logs.errorMessage === "string"
      ? row.proxy_logs.errorMessage
      : "",
  );
  return {
    ...row.proxy_logs,
    isStream:
      row.proxy_logs.isStream == null ? null : Boolean(row.proxy_logs.isStream),
    firstByteLatencyMs:
      typeof row.proxy_logs.firstByteLatencyMs === "number"
        ? row.proxy_logs.firstByteLatencyMs
        : null,
    ...(options?.includeBillingDetails
      ? {
          billingDetails: parseProxyLogBillingDetails(
            row.proxy_logs.billingDetails,
          ),
        }
      : {}),
    clientFamily: clientMeta.clientFamily,
    clientAppId: clientMeta.clientAppId,
    clientAppName: clientMeta.clientAppName,
    clientConfidence: clientMeta.clientConfidence,
    usageSource: normalizeProxyLogUsageSource(legacyMeta.usageSource),
    username: row.accounts?.username || null,
    siteId: row.sites?.id || null,
    siteName: row.sites?.name || null,
    siteUrl: row.sites?.url || null,
    downstreamKeyId: row.downstream_api_keys?.id || null,
    downstreamKeyName: row.downstream_api_keys?.name || null,
    downstreamKeyGroupName: row.downstream_api_keys?.groupName || null,
    downstreamKeyTags: parseDownstreamKeyTags(row.downstream_api_keys?.tags),
  };
}

function buildProxyLogModelAnalysisSelectFields() {
  return {
    createdAt: schema.proxyLogs.createdAt,
    modelActual: schema.proxyLogs.modelActual,
    modelRequested: schema.proxyLogs.modelRequested,
    status: schema.proxyLogs.status,
    latencyMs: schema.proxyLogs.latencyMs,
    totalTokens: schema.proxyLogs.totalTokens,
    estimatedCost: schema.proxyLogs.estimatedCost,
  };
}

function buildProxyLogSiteTrendSelectFields() {
  return {
    createdAt: schema.proxyLogs.createdAt,
    estimatedCost: schema.proxyLogs.estimatedCost,
    totalTokens: schema.proxyLogs.totalTokens,
  };
}

export async function statsRoutes(app: FastifyInstance) {
  const proxyLogBaseFields = getProxyLogBaseSelectFields();
  const proxyLogModelAnalysisFields = buildProxyLogModelAnalysisSelectFields();
  const proxyLogSiteTrendFields = buildProxyLogSiteTrendSelectFields();

  app.get<{ Querystring: { refresh?: string; view?: string } }>(
    "/api/stats/dashboard",
    async (request, reply) => {
      const forceRefresh = parseBooleanFlag(request.query.refresh);
      const view = normalizeDashboardView(request.query.view);
      if (view === "summary") {
        const snapshot = await getDashboardSummarySnapshot({ forceRefresh });
        reply.header("x-dashboard-summary-cache", snapshot.cacheStatus);
        return {
          generatedAt: snapshot.generatedAt,
          ...snapshot.payload,
        };
      }
      if (view === "insights") {
        const snapshot = await getDashboardInsightsSnapshot({ forceRefresh });
        reply.header("x-dashboard-insights-cache", snapshot.cacheStatus);
        return {
          generatedAt: snapshot.generatedAt,
          ...snapshot.payload,
        };
      }

      const [summary, insights] = await Promise.all([
        getDashboardSummarySnapshot({ forceRefresh }),
        getDashboardInsightsSnapshot({ forceRefresh }),
      ]);
      reply.header("x-dashboard-summary-cache", summary.cacheStatus);
      reply.header("x-dashboard-insights-cache", insights.cacheStatus);
      return {
        generatedAt: summary.generatedAt,
        ...summary.payload,
        ...insights.payload,
      };
    },
  );

  async function loadProxyLogsQueryPayload(params: {
    limit?: string;
    offset?: string;
    status?: string;
    search?: string;
    client?: string;
    siteId?: string;
    from?: string;
    to?: string;
  }) {
    const limit = normalizeProxyLogPageSize(params.limit);
    const offset = normalizeProxyLogOffset(params.offset);
    const status = normalizeProxyLogStatusFilter(params.status);
    const search = normalizeProxyLogSearch(params.search);
    const client = normalizeProxyLogClientFilter(params.client);
    const siteId = normalizeProxyLogSiteId(params.siteId);
    const fromUtc = normalizeProxyLogTimeBoundary(params.from);
    const toUtc = normalizeProxyLogTimeBoundary(params.to);
    const listWhere = buildProxyLogWhereClause({
      status,
      search,
      client,
      siteId,
      fromUtc,
      toUtc,
    });

    const listRows = (await withProxyLogSelectFields(
      ({ fields }) => {
        let query = db
          .select({
            proxy_logs: fields,
            accounts: {
              username: schema.accounts.username,
            },
            sites: {
              id: schema.sites.id,
              name: schema.sites.name,
              url: schema.sites.url,
            },
            downstream_api_keys: {
              id: schema.downstreamApiKeys.id,
              name: schema.downstreamApiKeys.name,
              groupName: schema.downstreamApiKeys.groupName,
              tags: schema.downstreamApiKeys.tags,
            },
          })
          .from(schema.proxyLogs)
          .leftJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .leftJoin(
            schema.downstreamApiKeys,
            eq(
              schema.proxyLogs.downstreamApiKeyId,
              schema.downstreamApiKeys.id,
            ),
          );

        if (listWhere) {
          query = query.where(listWhere) as typeof query;
        }

        return query
          .orderBy(desc(schema.proxyLogs.createdAt))
          .limit(limit)
          .offset(offset)
          .all();
      },
      { includeBillingDetails: false },
    )) as Array<{
      proxy_logs: Record<string, unknown> & { billingDetails?: string | null };
      accounts: { username?: string | null } | null;
      sites: {
        id?: number | null;
        name?: string | null;
        url?: string | null;
      } | null;
      downstream_api_keys: {
        id?: number | null;
        name?: string | null;
        groupName?: string | null;
        tags?: string | null;
      } | null;
    }>;

    let totalQuery = db
      .select({
        total: sql<number>`count(*)`,
      })
      .from(schema.proxyLogs)
      .leftJoin(
        schema.accounts,
        eq(schema.proxyLogs.accountId, schema.accounts.id),
      )
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(
        schema.downstreamApiKeys,
        eq(schema.proxyLogs.downstreamApiKeyId, schema.downstreamApiKeys.id),
      );
    if (listWhere) {
      totalQuery = totalQuery.where(listWhere) as typeof totalQuery;
    }
    const totalRow = await totalQuery.get();

    return {
      items: listRows.map((row) => mapProxyLogRow(row)),
      total: Number(totalRow?.total || 0),
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
    };
  }

  async function loadProxyLogsMetaPayload(params: {
    status?: string;
    search?: string;
    client?: string;
    siteId?: string;
    from?: string;
    to?: string;
  }) {
    const status = normalizeProxyLogStatusFilter(params.status);
    const search = normalizeProxyLogSearch(params.search);
    const client = normalizeProxyLogClientFilter(params.client);
    const siteId = normalizeProxyLogSiteId(params.siteId);
    const fromUtc = normalizeProxyLogTimeBoundary(params.from);
    const toUtc = normalizeProxyLogTimeBoundary(params.to);
    const summaryWhere = buildProxyLogWhereClause({
      search,
      client,
      siteId,
      fromUtc,
      toUtc,
    });
    const clientOptionsWhere = buildProxyLogWhereClause({
      status,
      search,
      siteId,
      fromUtc,
      toUtc,
    });

    const clientOptionRowsPromise = withProxyLogSelectFields(
      ({ fields, includeClientFields }) => {
        if (!includeClientFields) {
          return Promise.resolve([]);
        }

        let query = db
          .select({
            clientFamily: fields.clientFamily!,
            clientAppId: fields.clientAppId!,
            clientAppName: fields.clientAppName!,
          })
          .from(schema.proxyLogs)
          .leftJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .leftJoin(
            schema.downstreamApiKeys,
            eq(
              schema.proxyLogs.downstreamApiKeyId,
              schema.downstreamApiKeys.id,
            ),
          );

        if (clientOptionsWhere) {
          query = query.where(clientOptionsWhere) as typeof query;
        }

        return query
          .groupBy(
            fields.clientFamily!,
            fields.clientAppId!,
            fields.clientAppName!,
          )
          .all();
      },
      { includeBillingDetails: false, includeClientFields: true },
    ) as Promise<
      Array<{
        clientFamily?: string | null;
        clientAppId?: string | null;
        clientAppName?: string | null;
      }>
    >;

    const [clientOptionRows, summaryRow, siteRows] = await Promise.all([
      clientOptionRowsPromise,
      (async () => {
        let summaryQuery = db
          .select({
            totalCount: sql<number>`count(*)`,
            successCount: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
            failedCount: sql<number>`coalesce(sum(case when coalesce(${schema.proxyLogs.status}, '') <> 'success' then 1 else 0 end), 0)`,
            businessLimitCount: sql<number>`coalesce(sum(case when ${schema.proxyLogs.httpStatus} in (429, 529) then 1 else 0 end), 0)`,
            totalCost: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.estimatedCost}, 0)), 0)`,
            totalTokensAll: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
            averageLatencyMs: sql<number | null>`avg(nullif(${schema.proxyLogs.latencyMs}, 0))`,
            averageFirstByteLatencyMs: sql<number | null>`avg(nullif(${schema.proxyLogs.firstByteLatencyMs}, 0))`,
          })
          .from(schema.proxyLogs)
          .leftJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .leftJoin(
            schema.downstreamApiKeys,
            eq(
              schema.proxyLogs.downstreamApiKeyId,
              schema.downstreamApiKeys.id,
            ),
          );
        if (summaryWhere) {
          summaryQuery = summaryQuery.where(
            summaryWhere,
          ) as typeof summaryQuery;
        }
        return summaryQuery.get();
      })(),
      db
        .select({
          id: schema.sites.id,
          name: schema.sites.name,
          status: schema.sites.status,
        })
        .from(schema.sites)
        .all(),
    ]);

    return {
      clientOptions: buildProxyLogClientOptions(clientOptionRows),
      summary: {
        totalCount: Number(summaryRow?.totalCount || 0),
        successCount: Number(summaryRow?.successCount || 0),
        failedCount: Number(summaryRow?.failedCount || 0),
        businessLimitCount: Number(summaryRow?.businessLimitCount || 0),
        totalCost: toRoundedMicroNumber(summaryRow?.totalCost),
        totalTokensAll: Number(summaryRow?.totalTokensAll || 0),
        averageLatencyMs:
          summaryRow?.averageLatencyMs == null
            ? null
            : Math.round(Number(summaryRow.averageLatencyMs)),
        averageFirstByteLatencyMs:
          summaryRow?.averageFirstByteLatencyMs == null
            ? null
            : Math.round(Number(summaryRow.averageFirstByteLatencyMs)),
      },
      sites: siteRows,
    };
  }

  async function loadProxyLogsWindowPayload(params: {
    status?: string;
    search?: string;
    client?: string;
    siteId?: string;
    from?: string;
    to?: string;
    bucketCount?: string;
  }) {
    const status = normalizeProxyLogStatusFilter(params.status);
    const search = normalizeProxyLogSearch(params.search);
    const client = normalizeProxyLogClientFilter(params.client);
    const siteId = normalizeProxyLogSiteId(params.siteId);
    const fromUtc = normalizeProxyLogTimeBoundary(params.from);
    const toUtc = normalizeProxyLogTimeBoundary(params.to);
    const fromDate = fromUtc ? parseStoredUtcDateTime(fromUtc) : null;
    const toDate = toUtc ? parseStoredUtcDateTime(toUtc) : null;
    const endMs = toDate?.getTime() ?? Date.now();
    const startMs = fromDate?.getTime() ?? endMs - 60_000;
    const rangeMs = Math.max(1, endMs - startMs);
    const bucketCount = normalizeProxyLogBucketCount(params.bucketCount);
    const bucketDurationMs = rangeMs / bucketCount;
    const where = buildProxyLogWhereClause({
      status,
      search,
      client,
      siteId,
      fromUtc,
      toUtc,
    });

    let query = db
      .select({
        createdAt: schema.proxyLogs.createdAt,
        status: schema.proxyLogs.status,
        httpStatus: schema.proxyLogs.httpStatus,
        totalTokens: schema.proxyLogs.totalTokens,
      })
      .from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(
        schema.downstreamApiKeys,
        eq(schema.proxyLogs.downstreamApiKeyId, schema.downstreamApiKeys.id),
      );
    if (where) query = query.where(where) as typeof query;

    const buckets = Array.from({ length: bucketCount }, () => ({
      requestCount: 0,
      successCount: 0,
      failedCount: 0,
      businessLimitCount: 0,
      totalTokens: 0,
    }));
    for (const row of await query.all()) {
      const createdAtMs = parseStoredUtcDateTime(row.createdAt)?.getTime();
      if (createdAtMs == null || createdAtMs < startMs || createdAtMs >= endMs) {
        continue;
      }
      const bucketIndex = Math.min(
        bucketCount - 1,
        Math.floor((createdAtMs - startMs) / bucketDurationMs),
      );
      const bucket = buckets[bucketIndex];
      bucket.requestCount += 1;
      if ((row.status || "").trim().toLowerCase() === "success") {
        bucket.successCount += 1;
      } else {
        bucket.failedCount += 1;
      }
      if (row.httpStatus === 429 || row.httpStatus === 529) {
        bucket.businessLimitCount += 1;
      }
      bucket.totalTokens += Number(row.totalTokens || 0);
    }

    const bucketSeconds = bucketDurationMs / 1000;
    return {
      bucketDurationMs: Math.round(bucketDurationMs),
      peakQps: Math.max(
        0,
        ...buckets.map((bucket) => bucket.requestCount / bucketSeconds),
      ),
      buckets,
    };
  }

  // Proxy logs
  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      status?: string;
      search?: string;
      client?: string;
      siteId?: string;
      from?: string;
      to?: string;
      bucketCount?: string;
      view?: string;
    };
  }>("/api/stats/proxy-logs", async (request, reply) => {
    const view = normalizeProxyLogsView(request.query.view);
    if (view === "query") {
      return loadProxyLogsQueryPayload(request.query);
    }
    if (view === "meta") {
      return loadProxyLogsMetaPayload(request.query);
    }
    if (view === "window") {
      return loadProxyLogsWindowPayload(request.query);
    }
    const [queryPayload, metaPayload] = await Promise.all([
      loadProxyLogsQueryPayload(request.query),
      loadProxyLogsMetaPayload(request.query),
    ]);
    return {
      ...queryPayload,
      clientOptions: metaPayload.clientOptions,
      summary: metaPayload.summary,
      sites: metaPayload.sites,
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/stats/proxy-logs/:id",
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ message: "proxy log id is invalid" });
      }

      const row = (await withProxyLogSelectFields(
        ({ fields }) =>
          db
            .select({
              proxy_logs: fields,
              accounts: schema.accounts,
              sites: schema.sites,
              downstream_api_keys: {
                id: schema.downstreamApiKeys.id,
                name: schema.downstreamApiKeys.name,
                groupName: schema.downstreamApiKeys.groupName,
                tags: schema.downstreamApiKeys.tags,
              },
            })
            .from(schema.proxyLogs)
            .leftJoin(
              schema.accounts,
              eq(schema.proxyLogs.accountId, schema.accounts.id),
            )
            .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
            .leftJoin(
              schema.downstreamApiKeys,
              eq(
                schema.proxyLogs.downstreamApiKeyId,
                schema.downstreamApiKeys.id,
              ),
            )
            .where(eq(schema.proxyLogs.id, id))
            .get(),
        { includeBillingDetails: true },
      )) as
        | {
            proxy_logs: Record<string, unknown> & {
              billingDetails?: string | null;
            };
            accounts: { username?: string | null } | null;
            sites: {
              id?: number | null;
              name?: string | null;
              url?: string | null;
            } | null;
            downstream_api_keys: {
              id?: number | null;
              name?: string | null;
              groupName?: string | null;
              tags?: string | null;
            } | null;
          }
        | undefined;

      if (!row) {
        return reply.code(404).send({ message: "proxy log not found" });
      }

      return mapProxyLogRow(row, { includeBillingDetails: true });
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/stats/proxy-debug/traces",
    async (request) => {
      const limit = normalizeProxyLogPageSize(request.query.limit);
      const items = await listProxyDebugTraces({ limit });
      return { items };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/stats/proxy-debug/traces/:id",
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return reply
          .code(400)
          .send({ message: "proxy debug trace id is invalid" });
      }

      const detail = await getProxyDebugTraceDetail(id);
      if (!detail) {
        return reply.code(404).send({ message: "proxy debug trace not found" });
      }

      return detail;
    },
  );

  // Available models from persisted account and token state.
  app.get("/api/models", async () => {
    const cachedModels = readModelsCache();
    if (cachedModels) return { models: cachedModels };

    const availability = await db
      .select()
      .from(schema.tokenModelAvailability)
      .innerJoin(
        schema.accountTokens,
        eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id),
      )
      .innerJoin(
        schema.accounts,
        eq(schema.accountTokens.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.tokenModelAvailability.available, true),
          eq(schema.accountTokens.enabled, true),
          eq(
            schema.accountTokens.valueStatus,
            ACCOUNT_TOKEN_VALUE_STATUS_READY,
          ),
          eq(schema.accounts.status, "active"),
          eq(schema.sites.status, "active"),
        ),
      )
      .all();
    const accountAvailability = await db
      .select()
      .from(schema.modelAvailability)
      .innerJoin(
        schema.accounts,
        eq(schema.modelAvailability.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.modelAvailability.available, true),
          eq(schema.accounts.status, "active"),
          eq(schema.sites.status, "active"),
        ),
      )
      .all();

    const last7d = getLocalRangeStartUtc(7);
    const recentLogs = await db
      .select(proxyLogBaseFields)
      .from(schema.proxyLogs)
      .where(gte(schema.proxyLogs.createdAt, last7d))
      .all();
    const modelLogStats: Record<string, { success: number; total: number }> = {};
    for (const log of recentLogs) {
      const model = log.modelActual || log.modelRequested || "";
      if (!modelLogStats[model]) modelLogStats[model] = { success: 0, total: 0 };
      modelLogStats[model].total++;
      if (log.status === "success") modelLogStats[model].success++;
    }

    type ModelAccount = {
      id: number;
      site: string;
      username: string | null;
      latency: number | null;
      tokens: Array<{ id: number; name: string; isDefault: boolean }>;
    };
    const modelMap = new Map<string, { name: string; accountsById: Map<number, ModelAccount> }>();
    const ensureModel = (name: string) => {
      let model = modelMap.get(name);
      if (!model) {
        model = { name, accountsById: new Map() };
        modelMap.set(name, model);
      }
      return model;
    };
    const mergeAccount = (modelName: string, account: ModelAccount) => {
      const model = ensureModel(modelName);
      const existing = model.accountsById.get(account.id);
      if (!existing) {
        model.accountsById.set(account.id, account);
        return;
      }
      if (existing.latency == null || (account.latency != null && account.latency < existing.latency)) {
        existing.latency = account.latency;
      }
      for (const token of account.tokens) {
        if (!existing.tokens.some((item) => item.id === token.id)) {
          existing.tokens.push(token);
        }
      }
    };

    for (const row of availability) {
      const model = row.token_model_availability;
      const token = row.account_tokens;
      const account = row.accounts;
      const site = row.sites;
      if (!model.available || !token.enabled || account.status !== "active" || site.status !== "active") continue;
      mergeAccount(model.modelName, {
        id: account.id,
        site: site.name,
        username: account.username,
        latency: model.latencyMs,
        tokens: [{ id: token.id, name: token.name, isDefault: !!token.isDefault }],
      });
    }

    for (const row of accountAvailability) {
      const model = row.model_availability;
      const account = row.accounts;
      const site = row.sites;
      if (!model.available || account.status !== "active" || site.status !== "active") continue;
      mergeAccount(model.modelName, {
        id: account.id,
        site: site.name,
        username: account.username,
        latency: model.latencyMs,
        tokens: [],
      });
    }

    const models = Array.from(modelMap.values(), (model) => {
      const accounts = Array.from(model.accountsById.values());
      const latencyValues = accounts
        .map((account) => account.latency)
        .filter((latency): latency is number => typeof latency === "number" && Number.isFinite(latency));
      const logStats = modelLogStats[model.name];
      return {
        name: model.name,
        accountCount: accounts.length,
        tokenCount: accounts.reduce((sum, account) => sum + account.tokens.length, 0),
        avgLatency: latencyValues.length > 0
          ? Math.round(latencyValues.reduce((sum, latency) => sum + latency, 0) / latencyValues.length)
          : null,
        successRate: logStats
          ? Math.round((logStats.success / logStats.total) * 1000) / 10
          : null,
        description: null,
        tags: [],
        supportedEndpointTypes: [],
        accounts,
      };
    }).sort((a, b) => b.accountCount - a.accountCount || a.name.localeCompare(b.name));

    writeModelsCache(models);
    return { models };
  });

  app.get(
    "/api/models/token-candidates",
    { preHandler: [limitModelTokenCandidatesRead] },
    async () => {
      const resolveTokenGroupLabel = (
        tokenGroup: string | null,
        tokenName: string | null,
      ): string | null => {
        const explicit = (tokenGroup || "").trim();
        if (explicit) return explicit;

        const name = (tokenName || "").trim();
        if (!name) return null;
        const normalized = name.toLowerCase();
        if (
          normalized === "default" ||
          normalized === "默认" ||
          /^default($|[-_\s])/.test(normalized)
        ) {
          return "default";
        }
        if (/^token-\d+$/.test(normalized)) return null;
        return name;
      };

      // Load global allowed models whitelist
      const globalAllowedModels = new Set(
        config.globalAllowedModels
          .map((m) => m.toLowerCase().trim())
          .filter(Boolean),
      );

      const rows = await db
        .select()
        .from(schema.tokenModelAvailability)
        .innerJoin(
          schema.accountTokens,
          eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id),
        )
        .innerJoin(
          schema.accounts,
          eq(schema.accountTokens.accountId, schema.accounts.id),
        )
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.tokenModelAvailability.available, true),
            eq(schema.accountTokens.enabled, true),
            eq(
              schema.accountTokens.valueStatus,
              ACCOUNT_TOKEN_VALUE_STATUS_READY,
            ),
            eq(schema.accounts.status, "active"),
            eq(schema.sites.status, "active"),
          ),
        )
        .all();
      const availableModelRows = await db
        .select({
          modelName: schema.modelAvailability.modelName,
          accountId: schema.accounts.id,
          username: schema.accounts.username,
          siteId: schema.sites.id,
          siteName: schema.sites.name,
          accessToken: schema.accounts.accessToken,
          apiToken: schema.accounts.apiToken,
          extraConfig: schema.accounts.extraConfig,
        })
        .from(schema.modelAvailability)
        .innerJoin(
          schema.accounts,
          eq(schema.modelAvailability.accountId, schema.accounts.id),
        )
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.modelAvailability.available, true),
            eq(schema.accounts.status, "active"),
            eq(schema.sites.status, "active"),
          ),
        )
        .all();

      const result: Record<
        string,
        Array<{
          accountId: number;
          tokenId: number;
          tokenName: string;
          isDefault: boolean;
          username: string | null;
          siteId: number;
          siteName: string;
        }>
      > = {};
      const coveredAccountModelSet = new Set<string>();
      const coveredGroupsByAccountModel = new Map<
        string,
        Map<string, string>
      >();
      const unknownGroupCoverageByAccountModel = new Set<string>();
      const modelsWithoutToken: Record<
        string,
        Array<{
          accountId: number;
          username: string | null;
          siteId: number;
          siteName: string;
        }>
      > = {};
      const modelsMissingTokenGroups: Record<
        string,
        Array<{
          accountId: number;
          username: string | null;
          siteId: number;
          siteName: string;
          missingGroups: string[];
          requiredGroups: string[];
          availableGroups: string[];
          groupCoverageUncertain?: boolean;
        }>
      > = {};
      let hasAnyTokenGroupSignals = false;

      for (const row of rows) {
        const modelName = (row.token_model_availability.modelName || "").trim();
        if (!modelName) continue;
        const accountModelKey = `${row.accounts.id}::${modelName.toLowerCase()}`;
        coveredAccountModelSet.add(accountModelKey);

        const resolvedTokenGroup = resolveTokenGroupLabel(
          row.account_tokens.tokenGroup,
          row.account_tokens.name,
        );
        if (resolvedTokenGroup) {
          hasAnyTokenGroupSignals = true;
          if (!coveredGroupsByAccountModel.has(accountModelKey)) {
            coveredGroupsByAccountModel.set(
              accountModelKey,
              new Map<string, string>(),
            );
          }
          const groupKey = resolvedTokenGroup.toLowerCase();
          if (
            !coveredGroupsByAccountModel.get(accountModelKey)!.has(groupKey)
          ) {
            coveredGroupsByAccountModel
              .get(accountModelKey)!
              .set(groupKey, resolvedTokenGroup);
          }
        } else {
          unknownGroupCoverageByAccountModel.add(accountModelKey);
        }

        if (!result[modelName]) result[modelName] = [];
        if (
          result[modelName].some(
            (item) => item.tokenId === row.account_tokens.id,
          )
        )
          continue;
        result[modelName].push({
          accountId: row.accounts.id,
          tokenId: row.account_tokens.id,
          tokenName: row.account_tokens.name,
          isDefault: !!row.account_tokens.isDefault,
          username: row.accounts.username,
          siteId: row.sites.id,
          siteName: row.sites.name,
        });
      }

      for (const row of availableModelRows) {
        if (!requiresManagedAccountTokens(row)) continue;
        const modelName = (row.modelName || "").trim();
        if (!modelName) continue;
        const coverageKey = `${row.accountId}::${modelName.toLowerCase()}`;
        if (coveredAccountModelSet.has(coverageKey)) continue;
        if (!modelsWithoutToken[modelName]) modelsWithoutToken[modelName] = [];
        if (
          modelsWithoutToken[modelName].some(
            (item) => item.accountId === row.accountId,
          )
        )
          continue;
        modelsWithoutToken[modelName].push({
          accountId: row.accountId,
          username: row.username,
          siteId: row.siteId,
          siteName: row.siteName,
        });
      }

      const accountIdsForGroupHints = new Set(
        availableModelRows
          .filter((row) => requiresManagedAccountTokens(row))
          .map((row) => row.accountId),
      );
      const requiredGroupsByAccountModel = new Map<
        string,
        Map<string, string>
      >();
      const hasPotentialGroupHints =
        hasAnyTokenGroupSignals || unknownGroupCoverageByAccountModel.size > 0;

      if (hasPotentialGroupHints && accountIdsForGroupHints.size > 0) {
        const accountRows = await db
          .select()
          .from(schema.accounts)
          .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .where(
            and(
              eq(schema.accounts.status, "active"),
              eq(schema.sites.status, "active"),
            ),
          )
          .all();

        const metadataResults = await Promise.all(
          accountRows
            .filter((row) => accountIdsForGroupHints.has(row.accounts.id))
            .map(async (row) => {
              try {
                const catalog = await fetchModelPricingCatalog({
                  site: {
                    id: row.sites.id,
                    url: row.sites.url,
                    platform: row.sites.platform,
                  },
                  account: {
                    id: row.accounts.id,
                    accessToken: row.accounts.accessToken,
                    apiToken: row.accounts.apiToken,
                  },
                  modelName: "__metadata__",
                  totalTokens: 0,
                });
                return { accountId: row.accounts.id, catalog };
              } catch {
                return {
                  accountId: row.accounts.id,
                  catalog: null as Awaited<
                    ReturnType<typeof fetchModelPricingCatalog>
                  >,
                };
              }
            }),
        );

        for (const result of metadataResults) {
          if (!result.catalog) continue;
          for (const model of result.catalog.models) {
            const modelName = (model.modelName || "").trim();
            if (!modelName) continue;
            const groups = new Map<string, string>();
            for (const rawGroup of model.enableGroups || []) {
              const group = String(rawGroup || "").trim();
              if (!group) continue;
              const groupKey = group.toLowerCase();
              if (!groups.has(groupKey)) groups.set(groupKey, group);
            }
            if (groups.size === 0) continue;
            requiredGroupsByAccountModel.set(
              `${result.accountId}::${modelName.toLowerCase()}`,
              groups,
            );
          }
        }
      }

      for (const row of availableModelRows) {
        if (!requiresManagedAccountTokens(row)) continue;
        const modelName = (row.modelName || "").trim();
        if (!modelName) continue;
        const accountModelKey = `${row.accountId}::${modelName.toLowerCase()}`;

        const requiredGroups =
          requiredGroupsByAccountModel.get(accountModelKey);
        if (!requiredGroups || requiredGroups.size === 0) continue;

        const availableGroups =
          coveredGroupsByAccountModel.get(accountModelKey) ||
          new Map<string, string>();
        const missingGroups = Array.from(requiredGroups.entries())
          .filter(([groupKey]) => !availableGroups.has(groupKey))
          .map(([, label]) => label);
        if (missingGroups.length === 0) continue;

        if (!modelsMissingTokenGroups[modelName])
          modelsMissingTokenGroups[modelName] = [];
        if (
          modelsMissingTokenGroups[modelName].some(
            (item) => item.accountId === row.accountId,
          )
        )
          continue;
        const hintRow = {
          accountId: row.accountId,
          username: row.username,
          siteId: row.siteId,
          siteName: row.siteName,
          missingGroups: missingGroups.sort((a, b) => a.localeCompare(b)),
          requiredGroups: Array.from(requiredGroups.values()).sort((a, b) =>
            a.localeCompare(b),
          ),
          availableGroups: Array.from(availableGroups.values()).sort((a, b) =>
            a.localeCompare(b),
          ),
        } as {
          accountId: number;
          username: string | null;
          siteId: number;
          siteName: string;
          missingGroups: string[];
          requiredGroups: string[];
          availableGroups: string[];
          groupCoverageUncertain?: boolean;
        };
        if (unknownGroupCoverageByAccountModel.has(accountModelKey)) {
          hintRow.groupCoverageUncertain = true;
        }
        modelsMissingTokenGroups[modelName].push(hintRow);
      }

      const endpointTypesByModel: Record<string, string[]> = {};
      const cachedBase = readModelsCache();
      if (cachedBase) {
        for (const model of cachedBase) {
          if (
            Array.isArray(model.supportedEndpointTypes) &&
            model.supportedEndpointTypes.length > 0
          ) {
            endpointTypesByModel[model.name] = model.supportedEndpointTypes;
          }
        }
      }

      // Apply model whitelist filter if configured
      const filteredResult: typeof result = {};
      const filteredModelsWithoutToken: typeof modelsWithoutToken = {};
      const filteredModelsMissingTokenGroups: typeof modelsMissingTokenGroups =
        {};

      if (globalAllowedModels.size > 0) {
        // Filter result
        for (const [modelName, candidates] of Object.entries(result)) {
          if (globalAllowedModels.has(modelName.toLowerCase().trim())) {
            filteredResult[modelName] = candidates;
          }
        }
        // Filter modelsWithoutToken
        for (const [modelName, accounts] of Object.entries(
          modelsWithoutToken,
        )) {
          if (globalAllowedModels.has(modelName.toLowerCase().trim())) {
            filteredModelsWithoutToken[modelName] = accounts;
          }
        }
        // Filter modelsMissingTokenGroups
        for (const [modelName, accounts] of Object.entries(
          modelsMissingTokenGroups,
        )) {
          if (globalAllowedModels.has(modelName.toLowerCase().trim())) {
            filteredModelsMissingTokenGroups[modelName] = accounts;
          }
        }
      } else {
        // No whitelist configured, return all models (backward compatible)
        Object.assign(filteredResult, result);
        Object.assign(filteredModelsWithoutToken, modelsWithoutToken);
        Object.assign(
          filteredModelsMissingTokenGroups,
          modelsMissingTokenGroups,
        );
      }

      return {
        models: filteredResult,
        modelsWithoutToken: filteredModelsWithoutToken,
        modelsMissingTokenGroups: filteredModelsMissingTokenGroups,
        endpointTypesByModel,
      };
    },
  );

  // Refresh models for one account and rebuild routes.
  app.post<{ Params: { accountId: string } }>(
    "/api/models/check/:accountId",
    async (request) => {
      const accountId = Number.parseInt(request.params.accountId, 10);
      if (Number.isNaN(accountId)) {
        return { success: false, error: "Invalid account id" };
      }

      const refresh = await refreshModelsForAccount(accountId);
      const rebuild = await routeRefreshWorkflow.rebuildRoutesOnly();
      return { success: true, refresh, rebuild };
    },
  );

  // Site distribution – per-site aggregate data
  app.get<{ Querystring: { days?: string; refresh?: string } }>(
    "/api/stats/site-distribution",
    async (request) => {
      const snapshot = await getSiteStatsSnapshot({
        days: request.query.days ? parseInt(request.query.days, 10) : 7,
        forceRefresh: parseBooleanFlag(request.query.refresh),
      });
      return { distribution: snapshot.payload.distribution };
    },
  );

  // Site trend – daily spend/calls broken down by site
  app.get<{ Querystring: { days?: string; refresh?: string } }>(
    "/api/stats/site-trend",
    async (request) => {
      const snapshot = await getSiteStatsSnapshot({
        days: request.query.days ? parseInt(request.query.days, 10) : 7,
        forceRefresh: parseBooleanFlag(request.query.refresh),
      });
      return { trend: snapshot.payload.trend };
    },
  );

  // Model stats by site
  app.get<{ Querystring: { siteId?: string; days?: string } }>(
    "/api/stats/model-by-site",
    async (request) => {
      const siteId = request.query.siteId
        ? parseInt(request.query.siteId, 10)
        : null;
      const days = Math.max(1, parseInt(request.query.days || "7", 10));
      await runUsageAggregationProjectionPass();
      const sinceDay = getLocalRangeStartDayKey(days);
      const rows = siteId != null && Number.isFinite(siteId)
        ? await db
            .select()
            .from(schema.modelDayUsage)
            .where(
              and(
                gte(schema.modelDayUsage.localDay, sinceDay),
                eq(schema.modelDayUsage.siteId, siteId),
              ),
            )
            .all()
        : await db
            .select()
            .from(schema.modelDayUsage)
            .where(gte(schema.modelDayUsage.localDay, sinceDay))
            .all();

      const modelMap: Record<
        string,
        { calls: number; spend: number; tokens: number }
      > = {};

      for (const row of rows) {
        const model = row.model || "unknown";

        if (!modelMap[model])
          modelMap[model] = { calls: 0, spend: 0, tokens: 0 };
        modelMap[model].calls += Number(row.totalCalls || 0);
        modelMap[model].tokens += Number(row.totalTokens || 0);
        modelMap[model].spend += Number(row.totalSpend || 0);
      }

      const models = Object.entries(modelMap)
        .map(([model, stats]) => ({
          model,
          calls: stats.calls,
          spend: Math.round(stats.spend * 1_000_000) / 1_000_000,
          tokens: stats.tokens,
        }))
        .sort((a, b) => b.calls - a.calls);

      return { models };
    },
  );
}
