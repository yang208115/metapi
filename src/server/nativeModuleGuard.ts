type RebuildCommandInput = {
  npmExecPath?: string;
};

type RebuildCommand = {
  command: string;
  args: string[];
};

export function isNodeModuleVersionMismatch(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  const message = 'message' in error ? String((error as { message?: unknown }).message || '') : '';
  return code === 'ERR_DLOPEN_FAILED' && message.includes('NODE_MODULE_VERSION');
}

export function buildBetterSqliteRebuildCommand(input: RebuildCommandInput = {}): RebuildCommand {
  const npmExecPath = input.npmExecPath || process.env.npm_execpath;
  if (npmExecPath && npmExecPath.length > 0) {
    return {
      command: process.execPath,
      args: [
        npmExecPath,
        'rebuild',
        'better-sqlite3',
        '--no-audit',
        '--fund=false',
      ],
    };
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return {
    command: npmCommand,
    args: ['rebuild', 'better-sqlite3', '--no-audit', '--fund=false'],
  };
}
