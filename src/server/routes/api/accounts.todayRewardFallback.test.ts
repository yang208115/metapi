import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  formatLocalDate,
  formatUtcSqlDateTime,
  getLocalDayRangeUtc,
  parseStoredUtcDateTime,
} from '../../services/localTimeService.js';

type DbModule = typeof import('../../db/index.js');
type RepairModule = typeof import('../../services/storedTimestampRepairService.js');

describe('accounts api today reward fallback', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let repairStoredCreatedAtValues: RepairModule['repairStoredCreatedAtValues'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-reward-fallback-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    const repairModule = await import('../../services/storedTimestampRepairService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    repairStoredCreatedAtValues = repairModule.repairStoredCreatedAtValues;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
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


  it('counts today spend only inside local-day range', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'spend-site',
      url: 'https://spend-site.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'spend-user',
      accessToken: 'token',
      status: 'active',
    }).returning().get();

    const { startUtc, endUtc } = getLocalDayRangeUtc();
    const startDate = parseStoredUtcDateTime(startUtc)!;
    const endDate = parseStoredUtcDateTime(endUtc)!;
    const beforeStart = formatUtcSqlDateTime(new Date(startDate.getTime() - 60_000));
    const inRange = formatUtcSqlDateTime(new Date(startDate.getTime() + 60_000));
    const afterEnd = formatUtcSqlDateTime(new Date(endDate.getTime() + 60_000));

    await db.insert(schema.proxyLogs).values([
      {
        accountId: account.id,
        status: 'success',
        estimatedCost: 1,
        createdAt: beforeStart,
      },
      {
        accountId: account.id,
        status: 'success',
        estimatedCost: 2,
        createdAt: inRange,
      },
      {
        accountId: account.id,
        status: 'success',
        estimatedCost: 4,
        createdAt: afterEnd,
      },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/accounts',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      generatedAt: string;
      accounts: Array<{ id: number; todaySpend: number }>;
      sites: any[];
    };
    const rows = body.accounts;
    const target = rows.find((row) => row.id === account.id);
    expect(target?.todaySpend).toBe(2);
  });

  it('repairs ISO timestamps for today spend filtering', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'iso-spend-site',
      url: 'https://iso-spend-site.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'iso-spend-user',
      accessToken: 'token',
      status: 'active',
    }).returning().get();

    const { startUtc } = getLocalDayRangeUtc();
    const startDate = parseStoredUtcDateTime(startUtc)!;
    const inRangeIso = new Date(startDate.getTime() + 60_000).toISOString();

    await db.insert(schema.proxyLogs).values({
      accountId: account.id,
      status: 'success',
      estimatedCost: 2.25,
      createdAt: inRangeIso,
    }).run();
    await repairStoredCreatedAtValues();

    const response = await app.inject({
      method: 'GET',
      url: '/api/accounts',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      generatedAt: string;
      accounts: Array<{ id: number; todaySpend: number }>;
      sites: any[];
    };
    const rows = body.accounts;
    const target = rows.find((row) => row.id === account.id);
    expect(target?.todaySpend).toBe(2.25);
  });
});
