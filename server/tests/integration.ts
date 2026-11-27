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

    const starterKey = 'phase02-starter-credit-001';
    const concurrentClaims = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/ledger/starter-credit', headers: { cookie, 'idempotency-key': starterKey } }),
      app.inject({ method: 'POST', url: '/v1/ledger/starter-credit', headers: { cookie, 'idempotency-key': starterKey } })
    ]);
    const claimStatuses = concurrentClaims.map(result => result.statusCode).sort();
    if (claimStatuses[0] !== 200 || claimStatuses[1] !== 201) {
      throw new Error('Concurrent idempotent starter credit claims failed: ' + claimStatuses.join(','));
    }
    const claimBodies = concurrentClaims.map(result => result.json());
    if (claimBodies[0].journalId !== claimBodies[1].journalId) throw new Error('Idempotent requests created different journals');
    if (claimBodies.some(body => body.balanceMinor !== '1000000')) throw new Error('Starter credit balance is incorrect');
    if (claimBodies.some(body => body.note?.includes('No cryptocurrency') !== true)) throw new Error('Virtual-credit disclosure missing');

    const repeatedClaim = await app.inject({
      method: 'POST', url: '/v1/ledger/starter-credit',
      headers: { cookie, 'idempotency-key': 'phase02-starter-credit-002' }
    });
    if (repeatedClaim.statusCode !== 409) throw new Error('Starter credit was claimable more than once');

    const balance = await app.inject({ method: 'GET', url: '/v1/ledger/balance', headers: { cookie } });
    if (balance.statusCode !== 200 || balance.json().balanceMinor !== '1000000') throw new Error('Ledger balance endpoint returned an incorrect balance');

    const history = await app.inject({ method: 'GET', url: '/v1/ledger/journals', headers: { cookie } });
    if (history.statusCode !== 200 || history.json().journals.length !== 1) throw new Error('Ledger journal history is incorrect');

    const journalId = claimBodies[0].journalId;
    const entries = await db.query(
      'SELECT amount_minor::text AS amount_minor FROM ledger_entries WHERE journal_id = $1 ORDER BY id',
      [journalId]
    );
    if (entries.rows.length !== 2 || BigInt(entries.rows[0].amount_minor) + BigInt(entries.rows[1].amount_minor) !== 0n) {
      throw new Error('Double-entry journal is not balanced');
    }
    const immutableAttempt = await db.query(
      'UPDATE ledger_entries SET amount_minor = amount_minor WHERE journal_id = $1',
      [journalId]
    ).then(() => false, error => (error as { code?: string }).code === '55000');
    if (!immutableAttempt) throw new Error('Ledger entries are not immutable');

    const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    if (logout.statusCode !== 204) throw new Error('Logout failed: ' + logout.body);
    const revoked = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    if (revoked.statusCode !== 401) throw new Error('Session was not revoked');

    console.log('PostgreSQL + Redis integration passed: auth, atomic double-entry grant, idempotency/concurrency, balance/history, immutability, logout/revocation.');
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