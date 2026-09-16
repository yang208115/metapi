import { existsSync, readFileSync } from 'node:fs';
import { writeDialectArtifactFiles } from '../../src/server/db/schemaArtifactGenerator.js';
import {
  resolveGeneratedSchemaContractPath,
  type SchemaContract,
  writeSchemaContractFile,
} from '../../src/server/db/schemaContract.js';

function readPreviousSchemaContract(): SchemaContract | null {
  const contractPath = resolveGeneratedSchemaContractPath();
  if (!existsSync(contractPath)) {
    return null;
  }

  return JSON.parse(readFileSync(contractPath, 'utf8')) as SchemaContract;
}

const previousContract = readPreviousSchemaContract();
const contract = writeSchemaContractFile();
writeDialectArtifactFiles(contract, previousContract);
const tableCount = Object.keys(contract.tables).length;

console.log(`[schema:contract] wrote ${tableCount} tables and dialect artifacts`);
