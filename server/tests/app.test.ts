import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const config = {
  NODE_ENV: 'test', DEPLOYMENT_ENVIRONMENT: 'test', HOST: '127.0.0.1', PORT: 3001,
  DATABASE_URL: 'postgres://apex:secret@localhost:5432/apex',
  EXPECTED_DATABASE_NAME: 'apex', EXPECTED_DATABASE_USER: 'apex',
  EXPECTED_DATABASE_INSTANCE_ID: '00000000-0000-4000-8000-000000000002',
  APP_ORIGIN: 'http://localhost:3000',
  SESSION_TTL_HOURS: 168, COOKIE_SECURE: false
} as AppConfig;

const requiredMigrations = [
  '001_initial_identity', '002_simulation_ledger',
  '003_spot_market_engine', '004_spot_pool_ledger_reconciliation'
];

function makeApp(ready = true, migrationState: 'complete' | 'missing' | 'incomplete' = 'complete') {
  const db = {
    query: async (sql: string) => {
      if (!ready) throw new Error('database unavailable');
      if (sql.includes('to_regclass')) return { rows: [{ migration_table: migrationState === 'missing' ? null : 'schema_migrations' }], rowCount: 1 } as never;
      if (sql.includes('SELECT version FROM schema_migrations')) {
        const versions = migrationState === 'complete' ? requiredMigrations : requiredMigrations.slice(0, 3);
        return { rows: versions.map(version => ({ version })), rowCount: versions.length } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
    end: async () => undefined
  };
  return buildApp({ config, db: db as never });
}

test('liveness endpoint does not depend on backing services', async () => {
  const app = await makeApp(false);
  const response = await app.inject({ method: 'GET', url: '/v1/health/live' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'ok');
  await app.close();
});

test('readiness requires PostgreSQL and every application migration', async () => {
  const app = await makeApp(true);
  const response = await app.inject({ method: 'GET', url: '/v1/health/ready' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().checks, { postgres: 'ok', migrations: 'ok' });
  await app.close();
});

test('readiness returns 503 when schema_migrations is absent or a required version is missing', async () => {
  for (const state of ['missing', 'incomplete'] as const) {
    const app = await makeApp(true, state);
    const response = await app.inject({ method: 'GET', url: '/v1/health/ready' });
    assert.equal(response.statusCode, 503, state);
    assert.equal(response.json().checks.migrations, 'error');
    await app.close();
  }
});

test('readiness returns 503 when a dependency is unavailable', async () => {
  const app = await makeApp(false);
  const response = await app.inject({ method: 'GET', url: '/v1/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, 'degraded');
  await app.close();
});

test('registration, session identity and logout work end-to-end through REST injection', async () => {
  let user: Record<string, unknown> | null = null;
  let passwordHash = '';
  const sessions = new Set<string>();
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO users')) {
        user = { id: 'user-1', email: params[0], displayName: params[2], createdAt: new Date().toISOString() };
        passwordHash = String(params[1]);
        return { rows: [user], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO auth_sessions')) {
        sessions.add(String(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM users WHERE lower(email)')) {
        return { rows: user ? [{ ...user, password_hash: passwordHash }] : [], rowCount: user ? 1 : 0 };
      }
      if (sql.includes('FROM auth_sessions s')) {
        const exists = sessions.has(String(params[0]));
        return { rows: exists && user ? [user] : [], rowCount: exists && user ? 1 : 0 };
      }
      if (sql.includes('DELETE FROM auth_sessions')) {
        sessions.delete(String(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
      throw new Error('Unexpected test query: ' + sql);
    },
    end: async () => undefined
  };
  const app = await buildApp({ config, db: db as never });

  const registered = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    payload: { email: 'Test@Example.com', password: 'correct-horse-battery', displayName: 'Test User' }
  });
  assert.equal(registered.statusCode, 201);
  assert.equal(registered.json().user.email, 'test@example.com');
  assert.ok(passwordHash.startsWith('scrypt:'));
  const cookie = registered.headers['set-cookie'];
  assert.ok(cookie);
  const sessionCookie = String(cookie).split(';')[0];
  assert.match(String(cookie), /HttpOnly/i);
  assert.match(String(cookie), /SameSite=Lax/i);
  const registrationMe = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: sessionCookie } });
  assert.equal(registrationMe.statusCode, 200);
  const registrationLogout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: sessionCookie } });
  assert.equal(registrationLogout.statusCode, 204);
  const revokedRegistrationSession = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: sessionCookie } });
  assert.equal(revokedRegistrationSession.statusCode, 401);

  const badLogin = await app.inject({
    method: 'POST', url: '/v1/auth/login',
    payload: { email: 'test@example.com', password: 'wrong-password' }
  });
  assert.equal(badLogin.statusCode, 401);

  const login = await app.inject({
    method: 'POST', url: '/v1/auth/login',
    payload: { email: 'TEST@example.com', password: 'correct-horse-battery' }
  });
  assert.equal(login.statusCode, 200);
  const loginCookie = String(login.headers['set-cookie']).split(';')[0];
  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: loginCookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.id, 'user-1');

  const loggedOut = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: loginCookie } });
  assert.equal(loggedOut.statusCode, 204);
  const afterLogout = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: loginCookie } });
  assert.equal(afterLogout.statusCode, 401);
  await app.close();
});

test('ledger endpoints require an authenticated session', async () => {
  const app = await makeApp(true);
  const requests = [
    { method: 'GET' as const, url: '/v1/ledger/balance' },
    { method: 'GET' as const, url: '/v1/ledger/journals' },
    { method: 'GET' as const, url: '/v1/ledger/events' },
    { method: 'POST' as const, url: '/v1/ledger/starter-credit' }
  ];
  for (const request of requests) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 401, request.url + ' must require authentication');
  }
  await app.close();
});

test('mutating requests reject foreign Origin and Referer values', async () => {
  const app = await makeApp(true);
  const badOrigin = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { origin: 'https://evil.example' } });
  assert.equal(badOrigin.statusCode, 403);
  assert.equal(badOrigin.json().error, 'CSRF_ORIGIN_REJECTED');
  const badReferer = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { referer: 'https://evil.example/path' } });
  assert.equal(badReferer.statusCode, 403);
  await app.close();
});

test('production mutating requests require the configured Origin', async () => {
  const strictConfig = { ...config, NODE_ENV: 'production', DEPLOYMENT_ENVIRONMENT: 'staging', COOKIE_SECURE: true } as AppConfig;
  let user: Record<string, unknown> | null = null;
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO users')) {
        user = { id: 'prod-cookie-user', email: params[0], displayName: params[2], createdAt: new Date().toISOString() };
        return { rows: [user], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO auth_sessions')) return { rows: [], rowCount: 1 };
      if (sql.includes('DELETE FROM auth_sessions')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    end: async () => undefined
  };
  const app = await buildApp({ config: strictConfig, db: db as never });
  const missing = await app.inject({ method: 'POST', url: '/v1/auth/logout' });
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.json().error, 'CSRF_ORIGIN_REQUIRED');
  const foreign = await app.inject({
    method: 'POST', url: '/v1/auth/logout', headers: { origin: 'https://evil.example' }
  });
  assert.equal(foreign.statusCode, 403);
  const preflight = await app.inject({
    method: 'OPTIONS', url: '/v1/auth/register',
    headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' }
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.equal(preflight.headers['access-control-allow-credentials'], 'true');
  const registered = await app.inject({
    method: 'POST', url: '/v1/auth/register', headers: { origin: 'http://localhost:3000' },
    payload: { email: 'cookie@example.test', password: 'correct-horse-battery', displayName: 'Cookie Test' }
  });
  assert.equal(registered.statusCode, 201);
  const cookie = String(registered.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=None/i);
  await app.close();
});

test('registration endpoint enforces its per-IP rate limit', async () => {
  const app = await makeApp(true);
  const responses = [];
  for (let i = 0; i < 6; i++) {
    responses.push(await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email: 'invalid', password: 'short', displayName: 'x' }
    }));
  }
  assert.equal(responses.slice(0, 5).every(response => response.statusCode === 400), true);
  assert.equal(responses[5].statusCode, 429);
  await app.close();
});
