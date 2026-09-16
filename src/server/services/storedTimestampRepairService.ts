import { eq, isNull, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

function normalizedCreatedAtSql(column: any) {
  return sql<string>`replace(substr(${column}, 1, 19), 'T', ' ')`;
}

export async function repairStoredCreatedAtValues(now = new Date()): Promise<void> {
  const repairedAt = formatUtcSqlDateTime(now);

  await db.update(schema.events)
    .set({ createdAt: repairedAt })
    .where(or(isNull(schema.events.createdAt), eq(schema.events.createdAt, '')))
    .run();
  await db.update(schema.proxyLogs)
    .set({ createdAt: repairedAt })
    .where(or(isNull(schema.proxyLogs.createdAt), eq(schema.proxyLogs.createdAt, '')))
    .run();
  await db.update(schema.checkinLogs)
    .set({ createdAt: repairedAt })
    .where(or(isNull(schema.checkinLogs.createdAt), eq(schema.checkinLogs.createdAt, '')))
    .run();

  await db.update(schema.events)
    .set({ createdAt: normalizedCreatedAtSql(schema.events.createdAt) })
    .where(like(schema.events.createdAt, '%T%'))
    .run();
  await db.update(schema.proxyLogs)
    .set({ createdAt: normalizedCreatedAtSql(schema.proxyLogs.createdAt) })
    .where(like(schema.proxyLogs.createdAt, '%T%'))
    .run();
  await db.update(schema.checkinLogs)
    .set({ createdAt: normalizedCreatedAtSql(schema.checkinLogs.createdAt) })
    .where(like(schema.checkinLogs.createdAt, '%T%'))
    .run();
}
