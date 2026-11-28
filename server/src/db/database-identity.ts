import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';

export type DatabaseIdentity = Pick<AppConfig,
  'EXPECTED_DATABASE_NAME' | 'EXPECTED_DATABASE_USER' |
  'EXPECTED_DATABASE_INSTANCE_ID' | 'DEPLOYMENT_ENVIRONMENT'
>;

/**
 * Requires a separately provisioned identity marker. The marker is intentionally
 * not created by application startup or migrations: it is an operator-controlled
 * environment boundary, not an application-owned schema migration.
 */
export async function assertDatabaseIdentity(
  db: Pick<Pool, 'query'>,
  expected: DatabaseIdentity
): Promise<void> {
  let actual: {
    database_name?: string;
    database_user?: string;
    environment_name?: string;
    instance_id?: string;
  } | undefined;

  try {
    const result = await db.query(
      `SELECT current_database() AS database_name,
              current_user AS database_user,
              environment_name,
              instance_id::text AS instance_id
         FROM apex_database_identity
        WHERE singleton = TRUE`
    );
    actual = result.rows[0] as typeof actual;
  } catch {
    throw new Error('Database identity marker is missing or inaccessible. Refusing to continue.');
  }

  if (
    !actual ||
    actual.database_name !== expected.EXPECTED_DATABASE_NAME ||
    actual.database_user !== expected.EXPECTED_DATABASE_USER ||
    actual.environment_name !== expected.DEPLOYMENT_ENVIRONMENT ||
    actual.instance_id?.toLowerCase() !== expected.EXPECTED_DATABASE_INSTANCE_ID.toLowerCase()
  ) {
    throw new Error(
      'Database identity mismatch: expected the configured database name, role, environment, and instance ID. Refusing to continue.'
    );
  }
}
