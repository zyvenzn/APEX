import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import {
  runMigrations, APEX_MIGRATION_LOCK_NAMESPACE, APEX_MIGRATION_LOCK_ID
} from '../src/db/migrate.js';

test('serializes concurrent migration executors and releases advisory lock after success and failure', async () => {
  const config = loadConfig(process.env);
  const pool = createPool(config);
  const directory = await mkdtemp(resolve(tmpdir(), 'apex-migrations-'));
  const version = '999_concurrency_' + randomUUID().replace(/-/g, '');
  const failingVersion = '998_failure_' + randomUUID().replace(/-/g, '');

  const lockIsAvailable = async () => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        [APEX_MIGRATION_LOCK_NAMESPACE, APEX_MIGRATION_LOCK_ID]
      );
      if (!result.rows[0].acquired) return false;
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        APEX_MIGRATION_LOCK_NAMESPACE, APEX_MIGRATION_LOCK_ID
      ]);
      return true;
    } finally {
      client.release();
    }
  };

  try {
    await writeFile(resolve(directory, version + '.sql'), 'SELECT pg_sleep(1);');
    const startedAt = Date.now();
    await Promise.all([
      runMigrations(pool, config, directory),
      runMigrations(pool, config, directory)
    ]);
    assert.ok(Date.now() - startedAt >= 800, 'second executor must wait for the first session lock');
    const applied = await pool.query('SELECT version FROM schema_migrations WHERE version = $1', [version]);
    assert.equal(applied.rowCount, 1, 'migration version must be recorded exactly once');
    assert.equal(await lockIsAvailable(), true, 'lock must be released after successful migration');

    await writeFile(resolve(directory, failingVersion + '.sql'), 'SELECT 1 / 0;');
    await assert.rejects(runMigrations(pool, config, directory));
    assert.equal(await lockIsAvailable(), true, 'lock must be released after failed migration');
    const failed = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [failingVersion]);
    assert.equal(failed.rowCount, 0, 'failed migration must not be recorded');
  } finally {
    await pool.query('DELETE FROM schema_migrations WHERE version = ANY($1::text[])', [[version, failingVersion]]).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    await pool.end();
  }
});
