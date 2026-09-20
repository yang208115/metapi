import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getLocalRangeStartDayKey } from "./localTimeService.js";
import {
  readSnapshotCache,
  type SnapshotEnvelope,
} from "./snapshotCacheService.js";
import {
  toRoundedMicroNumber,
} from "./statsShared.js";
import { createAdminSnapshotPersistence } from "./adminSnapshotStore.js";
import {
  runUsageAggregationProjectionPass,
} from "./usageAggregationService.js";

export type SiteStatsSnapshotPayload = {
  distribution: Array<{
    siteId: number;
    siteName: string;
    platform: string | null;
    totalBalance: number;
    totalSpend: number;
    accountCount: number;
  }>;
  trend: Array<{
    date: string;
    sites: Record<string, { spend: number; calls: number }>;
  }>;
  sites: Array<typeof schema.sites.$inferSelect>;
};

export type SiteStatsSnapshotOptions = {
  days?: number;
  siteId?: number | null;
  platform?: string | null;
};

const SITE_STATS_TTL_MS = 15_000;

export function buildSiteTrendIdentity(siteId: number, siteName: string | null | undefined): string {
  return `${String(siteName || "unknown")}::${siteId}`;
}

function normalizeSiteStatsOptions(options: SiteStatsSnapshotOptions = {}) {
  const siteId = Number.isFinite(options.siteId) && Number(options.siteId) > 0
    ? Math.trunc(Number(options.siteId))
    : null;
  const platform = String(options.platform || "").trim() || null;
  return {
    days: Math.max(1, Math.trunc(Number(options.days || 7))),
    siteId,
    platform,
  };
}

async function loadSiteStatsSnapshotPayload(
  options: SiteStatsSnapshotOptions,
): Promise<SiteStatsSnapshotPayload> {
  const normalized = normalizeSiteStatsOptions(options);
  const sinceDay = getLocalRangeStartDayKey(normalized.days);
  await runUsageAggregationProjectionPass();

  const siteFilters = [
    ...(normalized.siteId == null ? [] : [eq(schema.sites.id, normalized.siteId)]),
    ...(normalized.platform == null ? [] : [eq(schema.sites.platform, normalized.platform)]),
  ];
  const siteWhere = siteFilters.length > 0 ? and(...siteFilters) : undefined;

  const [spendRows, trendRows, sites, accountDistributionRows] =
    await Promise.all([
    db
      .select({
        siteId: schema.siteDayUsage.siteId,
        totalSpend: sql<number>`coalesce(sum(${schema.siteDayUsage.totalSiteSpend}), 0)`,
      })
      .from(schema.siteDayUsage)
      .innerJoin(schema.sites, eq(schema.siteDayUsage.siteId, schema.sites.id))
      .where(siteWhere ? and(gte(schema.siteDayUsage.localDay, sinceDay), siteWhere) : gte(schema.siteDayUsage.localDay, sinceDay))
      .groupBy(schema.siteDayUsage.siteId)
      .all(),
    db
      .select()
      .from(schema.siteDayUsage)
      .where(sql`${schema.siteDayUsage.localDay} >= ${sinceDay}`)
      .all(),
    db
      .select()
      .from(schema.sites)
      .where(siteWhere)
      .all(),
    db
      .select({
        siteId: schema.sites.id,
        siteName: schema.sites.name,
        platform: schema.sites.platform,
        totalBalance: sql<number>`coalesce(sum(coalesce(${schema.accounts.balance}, 0)), 0)`,
        accountCount: sql<number>`count(*)`,
      })
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(siteWhere)
      .groupBy(schema.sites.id, schema.sites.name, schema.sites.platform)
      .all(),
  ]);

  const spendBySiteId = new Map<number, number>();
  for (const row of spendRows) {
    if (row.siteId == null) continue;
    spendBySiteId.set(row.siteId, Number(row.totalSpend || 0));
  }

  const distribution = accountDistributionRows.map((row) => ({
    siteId: row.siteId,
    siteName: row.siteName,
    platform: row.platform,
    totalBalance: toRoundedMicroNumber(Number(row.totalBalance || 0)),
    totalSpend: toRoundedMicroNumber(spendBySiteId.get(row.siteId) || 0),
    accountCount: Number(row.accountCount || 0),
  }));

  const dayMap: Record<
    string,
    Record<string, { spend: number; calls: number }>
  > = {};
  const activeSiteById = new Map<number, (typeof schema.sites.$inferSelect)>(
    sites.map((site) => [site.id, site]),
  );
  for (const row of trendRows) {
    const site = activeSiteById.get(row.siteId);
    if (!site) continue;
    const siteName = site.name || "unknown";
    const siteIdentity = buildSiteTrendIdentity(site.id, siteName);
    const date = row.localDay;

    if (!dayMap[date]) dayMap[date] = {};
    if (!dayMap[date][siteIdentity])
      dayMap[date][siteIdentity] = { spend: 0, calls: 0 };

    dayMap[date][siteIdentity].spend += Number(row.totalSiteSpend || 0);
    dayMap[date][siteIdentity].calls += Number(row.totalCalls || 0);
  }

  const trend = Object.entries(dayMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({
      date,
      sites: Object.fromEntries(
        Object.entries(value).map(([siteName, stats]) => [
          siteName,
          {
            spend: toRoundedMicroNumber(stats.spend),
            calls: stats.calls,
          },
        ]),
      ),
    }));

  return {
    distribution,
    trend,
    sites,
  };
}

export async function getSiteStatsSnapshot(options?: {
  days?: number;
  forceRefresh?: boolean;
  siteId?: number | null;
  platform?: string | null;
}): Promise<SnapshotEnvelope<SiteStatsSnapshotPayload>> {
  const normalized = normalizeSiteStatsOptions(options);
  const key = JSON.stringify(normalized);
  return readSnapshotCache({
    namespace: "site-stats",
    key,
    ttlMs: SITE_STATS_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: createAdminSnapshotPersistence<SiteStatsSnapshotPayload>({
      namespace: "site-stats",
      key,
    }),
    loader: async () => loadSiteStatsSnapshotPayload(normalized),
  });
}
