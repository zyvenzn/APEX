import pg from 'pg';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { runMigrations } from './migrate.js';

const { Pool } = pg;

async function main() {
  const config = loadConfig();
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000
  });
  try {
    await runMigrations(pool, config, resolve(process.cwd(), 'server/migrations'));
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error('Migration failed:', message);
  process.exit(1);
});
