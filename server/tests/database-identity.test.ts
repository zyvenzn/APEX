import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDatabaseIdentity } from '../src/db/database-identity.js';

const expected = {
  EXPECTED_DATABASE_NAME: 'apex_staging',
  EXPECTED_DATABASE_USER: 'apex_staging_user'
};

test('accepts the expected PostgreSQL database and user', async () => {
  let receivedSql = '';
  const db = {
    async query(sql: string) {
      receivedSql = sql;
      return { rows: [{ database_name: 'apex_staging', database_user: 'apex_staging_user' }] };
    }
  };
  await assertDatabaseIdentity(db as never, expected);
  assert.match(receivedSql, /current_database\(\)/);
  assert.match(receivedSql, /current_user/);
});

test('rejects a database identity mismatch without exposing DATABASE_URL', async () => {
  const db = {
    async query() {
      return { rows: [{ database_name: 'apex_production', database_user: 'production' }] };
    }
  };
  await assert.rejects(
    assertDatabaseIdentity(db as never, expected),
    error => {
      const message = (error as Error).message;
      assert.match(message, /Database identity mismatch/);
      assert.match(message, /apex_staging/);
      assert.doesNotMatch(message, /super-secret|prod\.example\.com|postgres:\/\//);
      return true;
    }
  );
});
