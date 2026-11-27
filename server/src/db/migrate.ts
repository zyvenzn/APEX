import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../config.js';

const { Pool } = pg;
async function migrate() {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const version = '001_initial_identity';
    const exists = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    if (exists.rowCount === 0) {
      const sql = await readFile(resolve(process.cwd(), 'server/migrations/001_initial_identity.sql'), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      console.log(`Applied migration ${version}`);
    } else {
      console.log('Database schema is up to date');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
migrate().catch(error => {
  console.error('Migration failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});