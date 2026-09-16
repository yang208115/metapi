import { eq } from 'drizzle-orm';
import { db, runtimeDbDialect, schema } from './index.js';

/**
 * Dialect-aware upsert for the `settings` table.
 *
 * SQLite / PostgreSQL use `onConflictDoUpdate` while MySQL uses
 * `onDuplicateKeyUpdate`.  Drizzle exposes different builder types for each
 * dialect, so we branch at runtime.
 */
export async function upsertSetting(key: string, value: unknown, txDb: typeof db = db): Promise<void> {
    const jsonValue = JSON.stringify(value);

    if (runtimeDbDialect === 'mysql') {
        // MySQL path – try update first, insert if not exists
        const existing = await txDb.select({ key: schema.settings.key })
            .from(schema.settings)
            .where(eq(schema.settings.key, key))
            .get();

        if (existing) {
            await txDb.update(schema.settings)
                .set({ value: jsonValue })
                .where(eq(schema.settings.key, key))
                .run();
        } else {
            await txDb.insert(schema.settings)
                .values({ key, value: jsonValue })
                .run();
        }
    } else {
        // SQLite / PostgreSQL path
        await (txDb.insert(schema.settings)
            .values({ key, value: jsonValue }) as any)
            .onConflictDoUpdate({
                target: schema.settings.key,
                set: { value: jsonValue },
            })
            .run();
    }
}
