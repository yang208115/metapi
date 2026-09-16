import cron from 'node-cron';
import { config } from '../config.js';
import { cleanupConfiguredLogs } from './logCleanupService.js';
import { normalizeLogCleanupRetentionDays } from '../shared/logCleanupRetentionDays.js';

const LOG_CLEANUP_DEFAULT_CRON = '0 6 * * *';
type LogCleanupTask = ReturnType<typeof cron.schedule>;
let logCleanupTask: LogCleanupTask | null = null;

function createLogCleanupTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    if (!config.logCleanupConfigured) {
      console.log('[Scheduler] Log cleanup skipped: legacy fallback mode is active');
      return;
    }
    console.log('[Scheduler] Running log cleanup at ' + new Date().toISOString());
    try {
      const result = await cleanupConfiguredLogs();
      if (!result.enabled) {
        console.log('[Scheduler] Log cleanup skipped: no log target enabled');
        return;
      }
      console.log(
        '[Scheduler] Log cleanup complete: usage=' + result.usageLogsDeleted
          + ', program=' + result.programLogsDeleted + ', cutoff=' + result.cutoffUtc,
      );
    } catch (error) {
      console.error('[Scheduler] Log cleanup error:', error);
    }
  });
}

export function startLogCleanupScheduler() {
  logCleanupTask?.stop();
  const cronExpr = config.logCleanupCron || LOG_CLEANUP_DEFAULT_CRON;
  if (!cron.validate(cronExpr)) {
    console.warn('[Scheduler] Invalid log cleanup cron: ' + cronExpr);
    return;
  }
  logCleanupTask = createLogCleanupTask(cronExpr);
  console.log(
    '[Scheduler] Log cleanup cron: ' + cronExpr
      + ' (configured=' + config.logCleanupConfigured
      + ', usage=' + config.logCleanupUsageLogsEnabled
      + ', program=' + config.logCleanupProgramLogsEnabled
      + ', retentionDays=' + normalizeLogCleanupRetentionDays(config.logCleanupRetentionDays) + ')',
  );
}

export function updateLogCleanupSettings(input: {
  cronExpr?: string;
  usageLogsEnabled?: boolean;
  programLogsEnabled?: boolean;
  retentionDays?: number;
}) {
  const cronExpr = input.cronExpr ?? config.logCleanupCron;
  if (!cron.validate(cronExpr)) throw new Error('Invalid cron: ' + cronExpr);

  config.logCleanupCron = cronExpr;
  if (input.usageLogsEnabled !== undefined) config.logCleanupUsageLogsEnabled = !!input.usageLogsEnabled;
  if (input.programLogsEnabled !== undefined) config.logCleanupProgramLogsEnabled = !!input.programLogsEnabled;
  config.logCleanupRetentionDays = normalizeLogCleanupRetentionDays(
    input.retentionDays ?? config.logCleanupRetentionDays,
  );

  logCleanupTask?.stop();
  logCleanupTask = createLogCleanupTask(cronExpr);
}

export function stopLogCleanupScheduler() {
  logCleanupTask?.stop();
  logCleanupTask = null;
}

export function __resetLogCleanupSchedulerForTests() {
  stopLogCleanupScheduler();
}
