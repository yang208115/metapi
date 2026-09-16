import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

type DbModule = typeof import('../../db/index.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');

describe('POST /api/routes/decision/batch', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let dataDir = '';
  let seedId = 0;

  const nextId = () => {
    seedId += 1;
    return seedId;
  };

  const seedRoutableChannel = async () => {
    const id = nextId();
    const site = await db.insert(schema.sites).values({
      name: `site-${id}`,
      url: `https://site-${id}.example.com`,
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${id}`,
      accessToken: `access-token-${id}`,
      apiToken: `sk-api-token-${id}`,
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-route-decision-batch-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    seedId = 0;
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
  });

  afterAll(async () => {
    await app.close();
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  it('returns decisions for multiple requested models in one call', async () => {
    seedRoutableChannel();

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes/decision/batch',
      payload: {
        models: ['gpt-4o-mini', 'gpt-4o-mini', 'unknown-model', ''],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      decisions: Record<string, { matched: boolean; candidates: Array<unknown> }>;
    };
    expect(body.success).toBe(true);
    expect(Object.keys(body.decisions).sort()).toEqual(['gpt-4o-mini', 'unknown-model']);
    expect(body.decisions['gpt-4o-mini']?.matched).toBe(true);
    expect(Array.isArray(body.decisions['gpt-4o-mini']?.candidates)).toBe(true);
    expect(body.decisions['gpt-4o-mini']?.candidates.length).toBeGreaterThan(0);
    expect(body.decisions['unknown-model']?.matched).toBe(false);
  });

  it('returns decisions scoped by route id to avoid wildcard channel mismatch', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'wildcard-site',
      url: 'https://wildcard-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'wildcard-user',
      accessToken: 'wildcard-access',
      apiToken: 'wildcard-api',
      status: 'active',
    }).returning().get();

    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: exactRoute.id,
      accountId: account.id,
      tokenId: null,
      sourceModel: 'claude-opus-4-6',
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const wildcardRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-(opus|sonnet)-4-6$',
      enabled: true,
    }).returning().get();

    const wildcardChannel = await db.insert(schema.routeChannels).values({
      routeId: wildcardRoute.id,
      accountId: account.id,
      tokenId: null,
      sourceModel: 'claude-opus-4-6',
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes/decision/by-route/batch',
      payload: {
        items: [{ routeId: wildcardRoute.id, model: 'claude-opus-4-6' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      decisions: Record<string, Record<string, { routeId?: number; matched: boolean; candidates: Array<{ channelId: number }> }>>;
    };
    expect(body.success).toBe(true);

    const decision = body.decisions[String(wildcardRoute.id)]?.['claude-opus-4-6'];
    expect(decision?.matched).toBe(true);
    expect(decision?.routeId).toBe(wildcardRoute.id);
    expect(decision?.candidates.some((candidate) => candidate.channelId === wildcardChannel.id)).toBe(true);
  });

  it('returns route-wide wildcard probabilities normalized to 100 across all channels', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'route-wide-site',
      url: 'https://route-wide-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'route-wide-user',
      accessToken: 'route-wide-access',
      apiToken: 'route-wide-api',
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-(opus|sonnet)-4-6$',
      enabled: true,
    }).returning().get();

    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      sourceModel: 'claude-opus-4-6',
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      sourceModel: 'claude-sonnet-4-6',
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes/decision/route-wide/batch',
      payload: { routeIds: [route.id] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      decisions: Record<string, {
        matched: boolean;
        routeId?: number;
        candidates: Array<{ channelId: number; probability: number }>;
      }>;
    };
    expect(body.success).toBe(true);

    const decision = body.decisions[String(route.id)];
    expect(decision?.matched).toBe(true);
    expect(decision?.routeId).toBe(route.id);
    expect(decision?.candidates.some((candidate) => candidate.channelId === channelA.id)).toBe(true);
    expect(decision?.candidates.some((candidate) => candidate.channelId === channelB.id)).toBe(true);

    const totalProbability = (decision?.candidates || []).reduce((sum, candidate) => sum + (candidate.probability || 0), 0);
    expect(totalProbability).toBeCloseTo(100, 1);
  });
});
