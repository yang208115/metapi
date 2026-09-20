import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, like, desc, eq, or } from 'drizzle-orm';
import { getProxyLogBaseSelectFields } from '../../services/proxyLogStore.js';
import { getCredentialModeFromExtraConfig, supportsDirectAccountRoutingConnection } from '../../services/accountExtraConfig.js';

function hasSessionTokenValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveAccountSearchSegment(account: typeof schema.accounts.$inferSelect): 'session' | 'apikey' {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit === 'apikey') return 'apikey';
  if (explicit === 'session') return 'session';
  return hasSessionTokenValue(account.accessToken) ? 'session' : 'apikey';
}

function normalizeSearchQuery(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchesApiKeyDisplayLabel(query: string): boolean {
  const normalized = normalizeSearchQuery(query);
  return [
    'apikey',
    'api key',
    'api-key',
    'api key 连接',
    'apikey 连接',
    'api key connection',
    'apikey connection',
  ].some((keyword) => normalized.includes(keyword));
}

export async function searchRoutes(app: FastifyInstance) {
  const proxyLogBaseFields = getProxyLogBaseSelectFields();

  app.post<{ Body: { query: string; limit?: number } }>('/api/search', async (request) => {
    const { query, limit = 20 } = request.body;
    if (!query || query.trim().length === 0) {
      return { accounts: [], sites: [], proxyLogs: [], models: [] };
    }

    const q = `%${query.trim()}%`;
    const perCategory = Math.min(Math.ceil(limit / 6), 10);

    // Search sites
    const sites = await db.select().from(schema.sites)
      .where(or(
        like(schema.sites.name, q),
        like(schema.sites.url, q),
        like(schema.sites.platform, q),
      ))
      .limit(perCategory).all();
    // Deduplicate by id
    const uniqueSites = [...new Map(sites.map(s => [s.id, s])).values()].slice(0, perCategory);

    // Search accounts (join with sites for site name)
    const accountResults = await db.select().from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(or(
        like(schema.accounts.username, q),
        like(schema.sites.name, q),
        like(schema.sites.platform, q),
      ))
      .limit(perCategory).all();
    const apiKeyLabelMatches = matchesApiKeyDisplayLabel(query);
    const apiKeyAccountResults = apiKeyLabelMatches
      ? await db.select().from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(or(
          eq(schema.accounts.accessToken, ''),
          like(schema.accounts.extraConfig, '%"credentialMode":"apikey"%'),
        ))
        .limit(perCategory)
        .all()
      : [];
    const accounts = [...new Map([...accountResults, ...apiKeyAccountResults].map((r) => [r.accounts.id, ({
      ...r.accounts,
      segment: resolveAccountSearchSegment(r.accounts),
      site: r.sites,
    })])).values()].slice(0, perCategory);

    // Search proxy logs (by model name)
    const proxyLogs = await db.select(proxyLogBaseFields).from(schema.proxyLogs)
      .where(like(schema.proxyLogs.modelRequested, q))
      .orderBy(desc(schema.proxyLogs.createdAt))
      .limit(perCategory).all();

    // Search models (only keep routable items)
    const directAccountModelRows = await db.select({
      modelName: schema.modelAvailability.modelName,
      accountId: schema.accounts.id,
      siteId: schema.sites.id,
      accounts: schema.accounts,
    })
      .from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          like(schema.modelAvailability.modelName, q),
          eq(schema.modelAvailability.available, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .limit(perCategory * 20)
      .all();

    const modelAgg = new Map<string, { accountIds: Set<number>; siteIds: Set<number> }>();
    for (const row of directAccountModelRows) {
      if (!supportsDirectAccountRoutingConnection(row.accounts)) continue;
      const key = row.modelName;
      if (!modelAgg.has(key)) {
        modelAgg.set(key, { accountIds: new Set(), siteIds: new Set() });
      }
      const agg = modelAgg.get(key)!;
      agg.accountIds.add(row.accountId);
      agg.siteIds.add(row.siteId);
    }

    const models = Array.from(modelAgg.entries())
      .map(([name, agg]) => ({
        name,
        accountCount: agg.accountIds.size,
        siteCount: agg.siteIds.size,
      }))
      .sort((a, b) => {
        if (b.accountCount !== a.accountCount) return b.accountCount - a.accountCount;
        return a.name.localeCompare(b.name);
      })
      .slice(0, perCategory);

    return { accounts, sites: uniqueSites, proxyLogs, models };
  });
}
