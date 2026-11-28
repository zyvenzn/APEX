import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDatabaseIdentity } from '../src/db/database-identity.js';

const expected = {
  EXPECTED_DATABASE_NAME: 'apex_staging',
  EXPECTED_DATABASE_USER: 'apex_staging_user',
  EXPECTED_DATABASE_INSTANCE_ID: 'b7e2b47a-a4d8-4d86-8e4a-a2a98e3e81c1',
  DEPLOYMENT_ENVIRONMENT: 'staging' as const
};

test('accepts only the independently provisioned database environment marker', async () => {
  let receivedSql = '';
  const db = {
    async query(sql: string) {
      receivedSql = sql;
      return { rows: [{
        database_name: 'apex_staging',
        database_user: 'apex_staging_user',
        environment_name: 'staging',
        instance_id: expected.EXPECTED_DATABASE_INSTANCE_ID
      }] };
    }
  };
  await assertDatabaseIdentity(db as never, expected);
  assert.match(receivedSql, /current_database\(\)/);
  assert.match(receivedSql, /current_user/);
  assert.match(receivedSql, /apex_database_identity/);
});

test('rejects a matching host/name but wrong environment marker or instance ID', async () => {
  for (const marker of [
    { environment_name: 'production', instance_id: expected.EXPECTED_DATABASE_INSTANCE_ID },
    { environment_name: 'staging', instance_id: '00000000-0000-4000-8000-000000000099' },
    { database_name: 'apex_production', environment_name: 'staging', instance_id: expected.EXPECTED_DATABASE_INSTANCE_ID },
    { database_user: 'apex_production_user', environment_name: 'staging', instance_id: expected.EXPECTED_DATABASE_INSTANCE_ID }
  ]) {
    const db = { async query() {
      return { rows: [{
        database_name: 'apex_staging',
        database_user: 'apex_staging_user',
        ...marker
      }] };
    } };
    await assert.rejects(assertDatabaseIdentity(db as never, expected), /Database identity mismatch/);
  }
});

test('fails closed when the independent marker is missing or inaccessible', async () => {
  await assert.rejects(
    assertDatabaseIdentity({ query: async () => { throw new Error('permission denied: secret-host'); } } as never, expected),
    error => {
      assert.match((error as Error).message, /marker is missing or inaccessible/);
      assert.doesNotMatch((error as Error).message, /secret-host|postgres:\/\//);
      return true;
    }
  );
});
