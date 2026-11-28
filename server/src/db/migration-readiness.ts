import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

// This manifest is the application's minimum schema contract. Keep it in sync
// when a new numbered SQL migration becomes required by backend code.
export const REQUIRED_MIGRATION_VERSIONS = [
  '001_initial_identity',
  '002_simulation_ledger',
  '003_spot_market_engine',
  '004_spot_pool_ledger_reconciliation'
] as const;

export interface MigrationReadiness {
  ready: boolean;
  expected: string[];
  applied: string[];
  missing: string[];
}

export async function checkMigrationReadiness(
  db: Pick<Pool, 'query'>,
  directory = resolve(process.cwd(), 'server/migrations')
): Promise<MigrationReadiness> {
  const availableFiles = new Set(
    (await readdir(directory))
      .filter(file => /^\d+_[a-z0-9_]+\.sql$/.test(file))
      .map(file => file.replace(/\.sql$/, ''))
  );
  const expected = [...new Set([...REQUIRED_MIGRATION_VERSIONS, ...availableFiles])].sort();

  const table = await db.query<{ migration_table: string | null }>(
    "SELECT to_regclass('public.schema_migrations') AS migration_table"
  );
  if (!table.rows[0]?.migration_table) {
    return { ready: false, expected, applied: [], missing: expected };
  }

  const result = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  const applied = result.rows.map(row => row.version).sort();
  const appliedSet = new Set(applied);
  const missing = expected.filter(version => !availableFiles.has(version) || !appliedSet.has(version));
  return { ready: missing.length === 0, expected, applied, missing };
}
