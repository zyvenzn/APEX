import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool, createRedis } from '../src/db/pool.js';

async function main() {
  const config = loadConfig();
  const db = createPool(config);
  const redis = createRedis(config);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const email = `integration-${randomUUID()}@example.test`;
  let userId: string | undefined;
  try {
    await redis.connect();
    app = await buildApp({ config, db, redis });

    const ready = await app.inject({ method: 'GET', url: '/v1/health/ready' });
    if (ready.statusCode !== 200) throw new Error('Readiness failed: ' + ready.body);

    const registered = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: 'integration-test-password-2026', displayName: 'Integration Test' }
    });
    if (registered.statusCode !== 201) throw new Error('Registration failed: ' + registered.body);
    userId = registered.json().user.id;

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'integration-test-password-2026' }
    });
    if (login.statusCode !== 200) throw new Error('Login failed: ' + login.body);
    const cookie = String(login.headers['set-cookie']).split(';')[0];

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    if (me.statusCode !== 200 || me.json().user.id !== userId) throw new Error('Authenticated identity lookup failed');

    const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    if (logout.statusCode !== 204) throw new Error('Logout failed: ' + logout.body);
    const revoked = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    if (revoked.statusCode !== 401) throw new Error('Session was not revoked');

    console.log('PostgreSQL + Redis integration passed: readiness, register, login, identity, logout/revocation.');
  } finally {
    if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
    if (app) await app.close();
    await Promise.allSettled([db.end(), redis.quit()]);
  }
}

main().catch(error => {
  console.error('Backend integration test failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});