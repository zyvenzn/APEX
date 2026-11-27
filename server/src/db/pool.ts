import pg from 'pg';
import Redis from 'ioredis';
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

export function createRedis(config: AppConfig) {
  return new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000
  });
}

export type Database = Pick<pg.Pool, 'query' | 'end'>;
export type Cache = Pick<Redis, 'ping' | 'quit' | 'connect'>;