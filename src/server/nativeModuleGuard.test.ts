import { describe, expect, it } from 'vitest';
import {
  buildBetterSqliteRebuildCommand,
  isNodeModuleVersionMismatch,
} from './nativeModuleGuard.js';

describe('nativeModuleGuard', () => {
  it('detects better-sqlite3 ABI mismatch errors', () => {
    const error = Object.assign(
      new Error('NODE_MODULE_VERSION 133. This version of Node.js requires NODE_MODULE_VERSION 137.'),
      { code: 'ERR_DLOPEN_FAILED' },
    );

    expect(isNodeModuleVersionMismatch(error)).toBe(true);
  });

  it('ignores unrelated native module errors', () => {
    const error = Object.assign(
      new Error('Cannot find module'),
      { code: 'MODULE_NOT_FOUND' },
    );

    expect(isNodeModuleVersionMismatch(error)).toBe(false);
  });

  it('builds a rebuild command for the current npm client', () => {
    const command = buildBetterSqliteRebuildCommand({
      npmExecPath: '/tmp/npm-cli.js',
    });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([
      '/tmp/npm-cli.js',
      'rebuild',
      'better-sqlite3',
      '--no-audit',
      '--fund=false',
    ]);
  });
});
