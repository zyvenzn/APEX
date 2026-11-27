import { readdir, readFile } from 'node:fs/promises';
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
    const directory = resolve(process.cwd(), 'server/migrations');
    const files = (await readdir(directory)).filter(file => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (exists.rowCount > 0) continue;
      const sql = await readFile(resolve(directory, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      console.log(`Applied migration ${version}`);
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
