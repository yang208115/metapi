import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('TokenRouter session decoupling', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-session-decoupling-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  it('keeps explicit token-bound channels routable when account session is expired', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'managed-site',
      url: 'https://managed.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'expired-session-user',
      accessToken: 'expired-session-token',
      apiToken: null,
      status: 'expired',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'stable-token',
      token: 'sk-stable-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    const selected = await router.selectChannel('gpt-4o-mini');

    expect(selected).not.toBeNull();
    expect(selected?.channel.id).toBe(channel.id);
    expect(selected?.tokenValue).toBe('sk-stable-token');
    expect(selected?.account.id).toBe(account.id);

    const decision = await router.explainSelection('gpt-4o-mini');
    const candidate = decision.candidates.find((item) => item.channelId === channel.id);
    expect(candidate?.eligible).toBe(true);
    expect(candidate?.reason).not.toContain('账号状态=expired');
  });

  it('still blocks fallback account-token channels when account session is expired', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'legacy-site',
      url: 'https://legacy.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'legacy-user',
      accessToken: 'expired-session-token',
      apiToken: 'sk-fallback-account-token',
      status: 'expired',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4.1-mini',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    const selected = await router.selectChannel('gpt-4.1-mini');
    expect(selected).toBeNull();

    const decision = await router.explainSelection('gpt-4.1-mini');
    const candidate = decision.candidates.find((item) => item.channelId === channel.id);
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.reason).toContain('账号状态=expired');
  });
});
