import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  resolveGeneratedSchemaContractPath,
  type SchemaContract,
} from '../../src/server/db/schemaContract.js';

interface FixtureScriptOptions {
  fromRef?: string;
  outputPath: string;
  dropTables: string[];
  dropColumns: string[];
}

function parseArgs(argv: string[]): FixtureScriptOptions {
  const options: FixtureScriptOptions = {
    outputPath: 'src/server/db/generated/fixtures/2026-03-14-baseline.schemaContract.json',
    dropTables: [],
    dropColumns: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--from-ref') {
      options.fromRef = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--output') {
      options.outputPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--drop-table') {
      options.dropTables.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (argument === '--drop-column') {
      options.dropColumns.push(argv[index + 1]);
      index += 1;
    }
  }

  return options;
}

function pruneContract(contract: SchemaContract, options: FixtureScriptOptions): SchemaContract {
  const droppedTables = new Set(options.dropTables);
  const droppedColumns = new Map<string, Set<string>>();

  for (const entry of options.dropColumns) {
    const [tableName, columnName] = entry.split('.', 2);
    if (!tableName || !columnName) {
      throw new Error(`invalid --drop-column value: ${entry}`);
    }
    const tableColumns = droppedColumns.get(tableName) ?? new Set<string>();
    tableColumns.add(columnName);
    droppedColumns.set(tableName, tableColumns);
  }

  const tables = Object.fromEntries(
    Object.entries(contract.tables)
      .filter(([tableName]) => !droppedTables.has(tableName))
      .map(([tableName, table]) => {
        const removedColumns = droppedColumns.get(tableName) ?? new Set<string>();
        const columns = Object.fromEntries(
          Object.entries(table.columns).filter(([columnName]) => !removedColumns.has(columnName)),
        );
        return [tableName, { columns }];
      }),
  );

  const hasColumn = (tableName: string, columnName: string): boolean =>
    !!tables[tableName]?.columns[columnName];

  return {
    tables,
    indexes: contract.indexes.filter((index) =>
      !!tables[index.table] && index.columns.every((columnName) => hasColumn(index.table, columnName))),
    uniques: contract.uniques.filter((unique) =>
      !!tables[unique.table] && unique.columns.every((columnName) => hasColumn(unique.table, columnName))),
    foreignKeys: contract.foreignKeys.filter((foreignKey) =>
      !!tables[foreignKey.table]
      && !!tables[foreignKey.referencedTable]
      && foreignKey.columns.every((columnName) => hasColumn(foreignKey.table, columnName))
      && foreignKey.referencedColumns.every((columnName) => hasColumn(foreignKey.referencedTable, columnName))),
  };
}

function readContractFromRef(fromRef: string): SchemaContract {
  const contractJson = execFileSync(
    'git',
    ['-c', 'safe.directory=.', 'show', `${fromRef}:src/server/db/generated/schemaContract.json`],
    { encoding: 'utf8' },
  );
  return JSON.parse(contractJson) as SchemaContract;
}

function readCurrentContract(): SchemaContract {
  return JSON.parse(readFileSync(resolveGeneratedSchemaContractPath(), 'utf8')) as SchemaContract;
}

const options = parseArgs(process.argv.slice(2));
const sourceContract = options.fromRef ? readContractFromRef(options.fromRef) : readCurrentContract();
const contract = pruneContract(sourceContract, options);
const outputPath = resolve(process.cwd(), options.outputPath);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');

console.log(`[schema:upgrade-fixture] wrote ${outputPath}`);
