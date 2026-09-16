import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

type DbModule = typeof import('../../db/index.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');

describe('route decision snapshots', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-route-decision-snapshot-'));
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
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
    invalidateTokenRouterCache();
  });

  afterAll(async () => {
    await app.close();
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  it('persists exact-route decision snapshots and exposes them from getRoutes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'snapshot-site',
      url: 'https://snapshot-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'snapshot-user',
      accessToken: 'snapshot-access',
      apiToken: 'snapshot-api',
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

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/routes/decision/batch',
      payload: {
        models: ['gpt-4o-mini'],
        persistSnapshots: true,
      },
    });

    expect(refreshResponse.statusCode).toBe(200);

    const routesResponse = await app.inject({
      method: 'GET',
      url: '/api/routes',
    });

    expect(routesResponse.statusCode).toBe(200);
    const body = routesResponse.json() as Array<{
      id: number;
      decisionSnapshot?: { matched: boolean; candidates: Array<unknown> } | null;
      decisionRefreshedAt?: string | null;
    }>;
    const refreshedRoute = body.find((item) => item.id === route.id);

    expect(refreshedRoute?.decisionSnapshot?.matched).toBe(true);
    expect(Array.isArray(refreshedRoute?.decisionSnapshot?.candidates)).toBe(true);
    expect(refreshedRoute?.decisionSnapshot?.candidates.length).toBeGreaterThan(0);
    expect(typeof refreshedRoute?.decisionRefreshedAt).toBe('string');
  });

  it('persists wildcard route-wide decision snapshots and exposes them from getRoutes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'wildcard-snapshot-site',
      url: 'https://wildcard-snapshot-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'wildcard-snapshot-user',
      accessToken: 'wildcard-snapshot-access',
      apiToken: 'wildcard-snapshot-api',
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-(opus|sonnet)-4-6$',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: route.id,
        accountId: account.id,
        tokenId: null,
        sourceModel: 'claude-opus-4-6',
        priority: 0,
        weight: 10,
        enabled: true,
      },
      {
        routeId: route.id,
        accountId: account.id,
        tokenId: null,
        sourceModel: 'claude-sonnet-4-6',
        priority: 0,
        weight: 10,
        enabled: true,
      },
    ]).run();

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/routes/decision/route-wide/batch',
      payload: {
        routeIds: [route.id],
        persistSnapshots: true,
      },
    });

    expect(refreshResponse.statusCode).toBe(200);

    const routesResponse = await app.inject({
      method: 'GET',
      url: '/api/routes',
    });

    expect(routesResponse.statusCode).toBe(200);
    const body = routesResponse.json() as Array<{
      id: number;
      decisionSnapshot?: { matched: boolean; routeId?: number } | null;
      decisionRefreshedAt?: string | null;
    }>;
    const refreshedRoute = body.find((item) => item.id === route.id);

    expect(refreshedRoute?.decisionSnapshot?.matched).toBe(true);
    expect(refreshedRoute?.decisionSnapshot?.routeId).toBe(route.id);
    expect(typeof refreshedRoute?.decisionRefreshedAt).toBe('string');
  });
});
