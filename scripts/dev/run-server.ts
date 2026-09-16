import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  buildBetterSqliteRebuildCommand,
  isNodeModuleVersionMismatch,
} from '../../src/server/nativeModuleGuard.js';

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: false,
      env: process.env,
    });

    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed: ${command} ${args.join(' ')} (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });

    child.once('error', reject);
  });
}

async function ensureBetterSqliteCompatible() {
  try {
    await import('better-sqlite3');
    return;
  } catch (error) {
    if (!isNodeModuleVersionMismatch(error)) {
      throw error;
    }
  }

  const rebuild = buildBetterSqliteRebuildCommand();
  console.log('[metapi] Detected better-sqlite3 ABI mismatch. Rebuilding for the current Node.js runtime...');
  await run(rebuild.command, rebuild.args);

  try {
    await import('better-sqlite3');
  } catch (error) {
    throw new Error(
      `better-sqlite3 is still incompatible after rebuild: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main() {
  const isWatchMode = process.argv.includes('--watch');
  await ensureBetterSqliteCompatible();

  if (isWatchMode) {
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const child = spawn(process.execPath, [tsxCli, 'watch', 'src/server/index.ts'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    child.once('exit', (code) => {
      process.exit(code ?? 0);
    });
    return;
  }

  const child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  child.once('exit', (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
