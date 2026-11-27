import pg from 'pg';
import type { AppConfig } from '../config.js';

const { Pool } = pg;

export function createPool(config: AppConfig) {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000
  });
}

export type Database = Pick<pg.Pool, 'query' | 'end'>;
export type Cache = Pick<Redis, 'ping' | 'quit' | 'connect'>;