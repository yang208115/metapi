import { describe, expect, it } from 'vitest';
import { ensureSharedIndexSchemaCompatibility, type SharedIndexSchemaInspector } from './sharedIndexSchemaCompatibility.js';

function createInspector(
  dialect: SharedIndexSchemaInspector['dialect'],
  options?: {
    existingTables?: string[];
  },
) {
  const executedSql: string[] = [];
  const existingTables = new Set(options?.existingTables ?? []);

  const inspector: SharedIndexSchemaInspector = {
    dialect,
    async tableExists(table) {
      return existingTables.has(table);
    },
    async execute(sqlText) {
      executedSql.push(sqlText);
    },
  };

  return { inspector, executedSql };
}

describe('ensureSharedIndexSchemaCompatibility', () => {
  it.each([
    'sqlite',
    'mysql',
    'postgres',
  ] as const)('is a no-op for %s now that contract-defined indexes come from runtime bootstrap', async (dialect) => {
    const { inspector, executedSql } = createInspector(dialect, {
      existingTables: [
        'sites',
        'accounts',
        'account_tokens',
        'checkin_logs',
        'model_availability',
        'token_model_availability',
        'token_routes',
        'route_channels',
        'proxy_logs',
        'proxy_video_tasks',
        'downstream_api_keys',
        'events',
      ],
    });

    await ensureSharedIndexSchemaCompatibility(inspector);
    expect(executedSql).toEqual([]);
  });

  it('skips indexes for tables that do not exist', async () => {
    const { inspector, executedSql } = createInspector('postgres', {
      existingTables: ['sites'],
    });

    await ensureSharedIndexSchemaCompatibility(inspector);

    expect(executedSql).toEqual([]);
  });
});
