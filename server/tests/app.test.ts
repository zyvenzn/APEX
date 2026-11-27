import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const config = {
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3001,
  DATABASE_URL: 'postgres://apex:secret@localhost:5432/apex',
  APP_ORIGIN: 'http://localhost:3000',
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
  return buildApp({ config, db: db as never });
}

test('liveness endpoint does not depend on backing services', async () => {
  const app = await makeApp(false);
  const response = await app.inject({ method: 'GET', url: '/v1/health/live' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'ok');
  await app.close();
});

test('readiness endpoint checks PostgreSQL only', async () => {
  const app = await makeApp(true);
  const response = await app.inject({ method: 'GET', url: '/v1/health/ready' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().checks, { postgres: 'ok' });
  await app.close();
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
