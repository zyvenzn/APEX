import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const config = {
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3001,
  DATABASE_URL: 'postgres://apex:secret@localhost:5432/apex',
  REDIS_URL: 'redis://localhost:6379', APP_ORIGIN: 'http://localhost:3000',
  SESSION_TTL_HOURS: 168, COOKIE_SECURE: false
} as AppConfig;

function makeApp(ready = true) {
  const db = {
    query: async () => {
      if (!ready) throw new Error('database unavailable');
      return { rows: [], rowCount: 0 } as never;
    },
    end: async () => undefined
  };
  const redis = {
    ping: async () => { if (!ready) throw new Error('redis unavailable'); return 'PONG'; },
    quit: async () => 'OK',
    connect: async () => undefined
  };
  return buildApp({ config, db: db as never, redis: redis as never });
}

test('liveness endpoint does not depend on backing services', async () => {
  const app = await makeApp(false);
  const response = await app.inject({ method: 'GET', url: '/v1/health/live' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'ok');
  await app.close();
});

test('readiness endpoint checks PostgreSQL and Redis', async () => {
  const app = await makeApp(true);
  const response = await app.inject({ method: 'GET', url: '/v1/health/ready' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().checks, { postgres: 'ok', redis: 'ok' });
  await app.close();
});

test('readiness returns 503 when a dependency is unavailable', async () => {
  const app = await makeApp(false);
  const response = await app.inject({ method: 'GET', url: '/v1/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, 'degraded');
  await app.close();
});