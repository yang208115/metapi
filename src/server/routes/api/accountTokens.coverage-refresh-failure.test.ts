import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const refreshModelsForAccountMock = vi.fn();
const rebuildTokenRoutesFromAvailabilityMock = vi.fn();

vi.mock('../../services/modelService.js', () => ({
  refreshModelsForAccount: (...args: unknown[]) => refreshModelsForAccountMock(...args),
  rebuildTokenRoutesFromAvailability: (...args: unknown[]) => rebuildTokenRoutesFromAvailabilityMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('account token coverage refresh failure handling', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-token-coverage-failure-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const accountTokenRoutesModule = await import('./accountTokens.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(accountTokenRoutesModule.accountTokensRoutes);
  });

  beforeEach(async () => {
    refreshModelsForAccountMock.mockReset();
    rebuildTokenRoutesFromAvailabilityMock.mockReset();

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('returns success after token persistence even when coverage rebuild fails', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-1',
      url: 'https://site-1.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-1',
      accessToken: 'acc-token-1',
      status: 'active',
    }).returning().get();

    refreshModelsForAccountMock.mockResolvedValue({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      errorCode: null,
      errorMessage: '',
      modelCount: 1,
      modelsPreview: ['gpt-4o-mini'],
      tokenScanned: 1,
      discoveredByCredential: false,
      discoveredApiToken: false,
    });
    rebuildTokenRoutesFromAvailabilityMock.mockRejectedValue(new Error('rebuild failed'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'manual-token',
        token: 'sk-manual-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      coverageRefresh: {
        rebuild: {
          success: false,
          error: 'rebuild failed',
        },
      },
    });

    const tokens = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.token).toBe('sk-manual-token');
  });
});
