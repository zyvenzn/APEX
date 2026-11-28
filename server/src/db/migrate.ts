import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { assertDatabaseIdentity } from './database-identity.js';

// Stable two-int PostgreSQL advisory-lock key. Namespace 0x41504558 is ASCII "APEX".
export const APEX_MIGRATION_LOCK_NAMESPACE = 0x41504558;
export const APEX_MIGRATION_LOCK_ID = 1;

export interface MigrationOptions {
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
}

export class MigrationLockTimeoutError extends Error {
  readonly code = 'APEX_MIGRATION_LOCK_TIMEOUT';
  constructor(timeoutMs: number) {
    super(`Timed out waiting ${timeoutMs}ms for the APEX PostgreSQL migration advisory lock.`);
    this.name = 'MigrationLockTimeoutError';
  }
}

const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

export async function runMigrations(
  pool: Pool,
  expectedIdentity: {
    EXPECTED_DATABASE_NAME: string;
    EXPECTED_DATABASE_USER: string;
    EXPECTED_DATABASE_INSTANCE_ID: string;
    DEPLOYMENT_ENVIRONMENT: 'development' | 'test' | 'staging' | 'production';
  },
  directory = resolve(process.cwd(), 'server/migrations'),
  options: MigrationOptions = {}
): Promise<void> {
  const lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
  const lockPollIntervalMs = options.lockPollIntervalMs ?? 100;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1 ||
      !Number.isInteger(lockPollIntervalMs) || lockPollIntervalMs < 1) {
    throw new Error('Migration lock timeout and poll interval must be positive integers.');
  }

  await assertDatabaseIdentity(pool, expectedIdentity);
  const client = await pool.connect();
  let lockAcquired = false;
  let transactionOpen = false;
  let failure: unknown;

  try {
    const deadline = Date.now() + lockTimeoutMs;
    while (!lockAcquired) {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        [APEX_MIGRATION_LOCK_NAMESPACE, APEX_MIGRATION_LOCK_ID]
      );
      lockAcquired = result.rows[0]?.acquired === true;
      if (lockAcquired) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new MigrationLockTimeoutError(lockTimeoutMs);
      await delay(Math.min(lockPollIntervalMs, remaining));
    }

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
