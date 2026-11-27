import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg, { type Pool } from 'pg';
import { loadConfig } from '../config.js';
import { assertDatabaseIdentity } from './database-identity.js';

const { Pool: PgPool } = pg;

// Stable two-int PostgreSQL advisory-lock key. Namespace 0x41504558 is ASCII "APEX";
// key 1 is reserved for the schema migration executor. Keep this pair stable across releases.
export const APEX_MIGRATION_LOCK_NAMESPACE = 0x41504558;
export const APEX_MIGRATION_LOCK_ID = 1;

export async function runMigrations(
  pool: Pool,
  expectedIdentity: { EXPECTED_DATABASE_NAME: string; EXPECTED_DATABASE_USER: string },
  directory = resolve(process.cwd(), 'server/migrations')
): Promise<void> {
  await assertDatabaseIdentity(pool, expectedIdentity);
  const client = await pool.connect();
  let lockAcquired = false;
  let transactionOpen = false;
  let failure: unknown;

  try {
    // Session-level lock stays on this dedicated connection throughout the transaction.
    await client.query('SELECT pg_advisory_lock($1, $2)', [
      APEX_MIGRATION_LOCK_NAMESPACE, APEX_MIGRATION_LOCK_ID
    ]);
    lockAcquired = true;

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const files = (await readdir(directory))
      .filter(file => /^\d+_[a-z0-9_]+\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const exists = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1', [version]
      );
      if ((exists.rowCount ?? 0) > 0) continue;
      const sql = await readFile(resolve(directory, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      console.log(`Applied migration ${version}`);
    }

    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    failure = error;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackError) {
        failure = new AggregateError([error, rollbackError], 'Migration failed and rollback also failed');
      }
    }
  } finally {
    if (lockAcquired) {
      try {
        // Unlock on the same still-open PostgreSQL session that acquired the lock.
        await client.query('SELECT pg_advisory_unlock($1, $2)', [
          APEX_MIGRATION_LOCK_NAMESPACE, APEX_MIGRATION_LOCK_ID
        ]);
      } catch (unlockError) {
        failure ??= unlockError;
      }
    }
    client.release(failure instanceof Error ? failure : undefined);
  }
  if (failure) throw failure;
}
