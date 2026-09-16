export type SharedIndexSchemaDialect = 'sqlite' | 'mysql' | 'postgres';

export interface SharedIndexSchemaInspector {
  dialect: SharedIndexSchemaDialect;
  tableExists(table: string): Promise<boolean>;
  execute(sqlText: string): Promise<void>;
}

type SharedIndexCompatibilitySpec = {
  table: string;
  indexName: string;
  createSql: Record<SharedIndexSchemaDialect, string>;
};

// Contract-defined indexes are owned by generated schema artifacts and
// runtimeSchemaBootstrap. This legacy hook is intentionally empty so startup
// does not maintain a second static source of index SQL.
export const SHARED_INDEX_COMPATIBILITY_SPECS: SharedIndexCompatibilitySpec[] = [];

function normalizeSchemaErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message?: unknown }).message || '');
  }
  return String(error || '');
}

function isDuplicateSchemaError(error: unknown): boolean {
  const lowered = normalizeSchemaErrorMessage(error).toLowerCase();
  return lowered.includes('already exists')
    || lowered.includes('duplicate')
    || lowered.includes('relation') && lowered.includes('already exists');
}

async function executeIgnoreDuplicate(inspector: SharedIndexSchemaInspector, sqlText: string): Promise<void> {
  try {
    await inspector.execute(sqlText);
  } catch (error) {
    if (!isDuplicateSchemaError(error)) {
      throw error;
    }
  }
}

export async function ensureSharedIndexSchemaCompatibility(inspector: SharedIndexSchemaInspector): Promise<void> {
  const tableExistsCache = new Map<string, boolean>();

  for (const spec of SHARED_INDEX_COMPATIBILITY_SPECS) {
    let hasTable = tableExistsCache.get(spec.table);
    if (hasTable === undefined) {
      hasTable = await inspector.tableExists(spec.table);
      tableExistsCache.set(spec.table, hasTable);
    }
    if (!hasTable) {
      continue;
    }

    await executeIgnoreDuplicate(inspector, spec.createSql[inspector.dialect]);
  }
}
