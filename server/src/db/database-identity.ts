import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';

export type DatabaseIdentity = Pick<AppConfig, 'EXPECTED_DATABASE_NAME' | 'EXPECTED_DATABASE_USER'>;

/** Refuse to operate on an unexpected database. Never include DATABASE_URL in errors. */
export async function assertDatabaseIdentity(
  db: Pick<Pool, 'query'>,
  expected: DatabaseIdentity
): Promise<void> {
  const result = await db.query(
    'SELECT current_database() AS database_name, current_user AS database_user'
  );
  const actual = result.rows[0] as { database_name?: string; database_user?: string } | undefined;
  if (
    actual?.database_name !== expected.EXPECTED_DATABASE_NAME ||
    actual?.database_user !== expected.EXPECTED_DATABASE_USER
  ) {
    throw new Error(
      'Database identity mismatch: expected database "' +
      expected.EXPECTED_DATABASE_NAME + '" and user "' +
      expected.EXPECTED_DATABASE_USER + '". Refusing to continue.'
    );
  }
}
