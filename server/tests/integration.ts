import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';

async function main() {
  const config = loadConfig();
  const db = createPool(config);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const email = `integration-${randomUUID()}@example.test`;
  let userId: string | undefined;
  try {
    app = await buildApp({ config, db });

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

    const eventPage = await app.inject({ method: 'GET', url: '/v1/ledger/events?after=0&limit=10', headers: { cookie } });
    if (eventPage.statusCode !== 200 || eventPage.json().events.length !== 1) throw new Error('Ledger event replay page is incorrect');
    if (eventPage.json().events[0].eventType !== 'starter_credit_granted') throw new Error('Unexpected ledger replay event type');
    const eventTail = await app.inject({
      method: 'GET', url: '/v1/ledger/events?after=' + eventPage.json().nextAfter,
      headers: { cookie }
    });
    if (eventTail.statusCode !== 200 || eventTail.json().events.length !== 0) throw new Error('Ledger event cursor did not advance');


    const marketList = await app.inject({ method: 'GET', url: '/v1/spot/markets' });
    if (marketList.statusCode !== 200 || !marketList.json().markets.some((market: { marketId: string }) => market.marketId === 'apex-demo')) {
      throw new Error('Demo spot market was not seeded.');
    }
    const initialMarket = marketList.json().markets.find((market: { marketId: string }) => market.marketId === 'apex-demo');
    if (initialMarket.baseReserveMinor !== initialMarket.baseReserveLedgerMinor ||
        initialMarket.quoteReserveMinor !== initialMarket.quoteReserveLedgerMinor ||
        initialMarket.feeAccruedMinor !== '0') {
      throw new Error('Initial API pool snapshot does not reconcile to the opening ledger.');
    }
    const buyPayload = { marketId: 'apex-demo', side: 'BUY', amountMinor: '10000', maxSlippageBps: 1500 };
    const concurrentBuys = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/spot/trades', headers: { cookie, 'idempotency-key': 'phase03-spot-buy-001' }, payload: buyPayload }),
      app.inject({ method: 'POST', url: '/v1/spot/trades', headers: { cookie, 'idempotency-key': 'phase03-spot-buy-001' }, payload: buyPayload })
    ]);
    const buyStatuses = concurrentBuys.map(result => result.statusCode).sort();
    if (buyStatuses[0] !== 200 || buyStatuses[1] !== 201) throw new Error('Concurrent spot buy idempotency failed: ' + buyStatuses.join(','));
    const buyBodies = concurrentBuys.map(result => result.json());
    if (buyBodies[0].tradeId !== buyBodies[1].tradeId) throw new Error('Concurrent spot buys created multiple trades.');
    if (buyBodies.some(body => body.simulated !== true || !body.note?.includes('No blockchain transaction'))) {
      throw new Error('Spot trade virtual-only disclosure missing.');
    }
    const boughtBase = BigInt(buyBodies[0].amountOutMinor);
    if (buyBodies.some(body => body.feeAccruedAfterMinor !== body.feeMinor)) throw new Error('BUY API response fee total is inconsistent.');
    if (boughtBase <= 0n) throw new Error('Spot buy did not credit base asset.');

    const assertPoolReconciles = async (label: string) => {
      const state = await db.query(
        `SELECT m.base_reserve::text AS base_reserve, m.quote_reserve::text AS quote_reserve,
          (SELECT COALESCE(SUM(e.amount_minor), 0)::text FROM ledger_accounts a
            JOIN ledger_entries e ON e.account_id = a.id
           WHERE a.owner_user_id IS NULL AND a.account_code = 'SPOT_POOL:' || m.market_id
             AND a.asset_code = m.base_asset_code) AS base_ledger_reserve,
          (SELECT COALESCE(SUM(e.amount_minor), 0)::text FROM ledger_accounts a
            JOIN ledger_entries e ON e.account_id = a.id
           WHERE a.owner_user_id IS NULL AND a.account_code = 'SPOT_POOL:' || m.market_id
             AND a.asset_code = m.quote_asset_code) AS quote_ledger_reserve,
          (SELECT COALESCE(SUM(e.amount_minor), 0)::text FROM ledger_accounts a
            JOIN ledger_entries e ON e.account_id = a.id
           WHERE a.owner_user_id IS NULL AND a.account_code = 'SPOT_FEE_REVENUE:' || m.market_id
             AND a.asset_code = m.quote_asset_code) AS fee_ledger_minor
         FROM spot_markets m WHERE m.market_id = 'apex-demo'`
      );
      const row = state.rows[0];
      if (!row || row.base_reserve !== row.base_ledger_reserve || row.quote_reserve !== row.quote_ledger_reserve) {
        throw new Error(label + ': spot pool reserves do not reconcile to ledger pool accounts: ' + JSON.stringify(row));
      }
      return row;
    };
    const afterBuy = await assertPoolReconciles('After BUY');
    if (BigInt(afterBuy.fee_ledger_minor) !== BigInt(buyBodies[0].feeMinor)) {
      throw new Error('BUY fee was not posted to the fee revenue account.');
    }
    const repeatedBuy = await app.inject({
      method: 'POST', url: '/v1/spot/trades',
      headers: { cookie, 'idempotency-key': 'phase03-spot-buy-001' }, payload: buyPayload
    });
    if (repeatedBuy.statusCode !== 200 || repeatedBuy.json().tradeId !== buyBodies[0].tradeId || repeatedBuy.json().replayed !== true) {
      throw new Error('Spot retry did not replay the original committed trade.');
    }

    const replayWithChangedRequest = await app.inject({
      method: 'POST', url: '/v1/spot/trades',
      headers: { cookie, 'idempotency-key': 'phase03-spot-buy-001' },
      payload: { ...buyPayload, amountMinor: '11000' }
    });
    if (replayWithChangedRequest.statusCode !== 409) throw new Error('Spot idempotency key accepted a changed request.');

    const sellAmount = (boughtBase / 2n).toString();
    const sell = await app.inject({
      method: 'POST', url: '/v1/spot/trades',
      headers: { cookie, 'idempotency-key': 'phase03-spot-sell-001' },
      payload: { marketId: 'apex-demo', side: 'SELL', amountMinor: sellAmount, maxSlippageBps: 1500 }
    });
    if (sell.statusCode !== 201) throw new Error('Spot sell failed: ' + sell.statusCode + ' ' + sell.body);
    if (BigInt(sell.json().amountOutMinor) <= 0n) throw new Error('Spot sell returned no quote asset.');

    const afterSell = await assertPoolReconciles('After SELL');
    const expectedFees = BigInt(buyBodies[0].feeMinor) + BigInt(sell.json().feeMinor);
    if (BigInt(afterSell.fee_ledger_minor) !== expectedFees || BigInt(sell.json().feeAccruedAfterMinor) !== expectedFees) {
      throw new Error('BUY/SELL fee totals do not reconcile to fee revenue ledger and API response.');
    }
    const distinctConcurrentBuys = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/spot/trades', headers: { cookie, 'idempotency-key': 'phase03-concurrent-buy-a' },
        payload: { marketId: 'apex-demo', side: 'BUY', amountMinor: '1000', maxSlippageBps: 5000 } }),
      app.inject({ method: 'POST', url: '/v1/spot/trades', headers: { cookie, 'idempotency-key': 'phase03-concurrent-buy-b' },
        payload: { marketId: 'apex-demo', side: 'BUY', amountMinor: '2000', maxSlippageBps: 5000 } })
    ]);
    if (distinctConcurrentBuys.some(result => result.statusCode !== 201)) {
      throw new Error('Concurrent distinct spot trades failed: ' + distinctConcurrentBuys.map(result => result.statusCode).join(','));
    }
    if (distinctConcurrentBuys[0].json().tradeId === distinctConcurrentBuys[1].json().tradeId) {
      throw new Error('Distinct concurrent spot orders were incorrectly deduplicated.');
    }
    const afterConcurrent = await assertPoolReconciles('After concurrent BUYs');
    const concurrentFees = distinctConcurrentBuys.reduce((sum, result) => sum + BigInt(result.json().feeMinor), 0n);
    if (BigInt(afterConcurrent.fee_ledger_minor) !== expectedFees + concurrentFees) {
      throw new Error('Concurrent BUY fees do not reconcile to fee revenue ledger.');
    }
    const finalMarketList = await app.inject({ method: 'GET', url: '/v1/spot/markets' });
    const finalMarket = finalMarketList.json().markets.find((market: { marketId: string }) => market.marketId === 'apex-demo');
    if (finalMarket.baseReserveMinor !== finalMarket.baseReserveLedgerMinor ||
        finalMarket.quoteReserveMinor !== finalMarket.quoteReserveLedgerMinor ||
        BigInt(finalMarket.feeAccruedMinor) !== BigInt(afterConcurrent.fee_ledger_minor)) {
      throw new Error('Final API market snapshot differs from pool/fee ledger balances.');
    }

    const legacyClearing = await db.query(
      `SELECT id FROM ledger_accounts WHERE owner_user_id IS NULL AND account_code = 'SPOT_CLEARING'`
    );
    if (legacyClearing.rows.length !== 0) throw new Error('Legacy SPOT_CLEARING accounts were created.');

    const noFunds = await app.inject({
      method: 'POST', url: '/v1/spot/trades',
      headers: { cookie, 'idempotency-key': 'phase03-spot-overdraft-01' },
      payload: { marketId: 'apex-demo', side: 'BUY', amountMinor: '2000000', maxSlippageBps: 5000 }
    });
    if (noFunds.statusCode !== 409 || noFunds.json().error !== 'INSUFFICIENT_BALANCE') {
      throw new Error('Spot buy allowed a negative quote balance: ' + noFunds.statusCode + ' ' + noFunds.body);
    }
    const noTokens = await app.inject({
      method: 'POST', url: '/v1/spot/trades',
      headers: { cookie, 'idempotency-key': 'phase03-spot-oversell-01' },
      payload: { marketId: 'apex-demo', side: 'SELL', amountMinor: (boughtBase * 10n).toString(), maxSlippageBps: 5000 }
    });
    if (noTokens.statusCode !== 409 || noTokens.json().error !== 'INSUFFICIENT_BALANCE') {
      throw new Error('Spot sell allowed a negative base balance: ' + noTokens.statusCode + ' ' + noTokens.body);
    }

    const immutableTradeAttempt = await db.query(
      'UPDATE spot_trades SET amount_minor = amount_minor WHERE id = $1',
      [buyBodies[0].tradeId]
    ).then(() => false, error => (error as { code?: string }).code === '55000');
    if (!immutableTradeAttempt) throw new Error('Spot trade records are not immutable.');

    const tradeJournalRows = await db.query(
      `SELECT j.id, j.asset_code, COALESCE(SUM(e.amount_minor), 0)::text AS total
         FROM ledger_journals j JOIN ledger_entries e ON e.journal_id = j.id
        WHERE j.reference_type = 'spot_trade' AND j.reference_id = $1
        GROUP BY j.id, j.asset_code`,
      [buyBodies[0].tradeId]
    );
    if (tradeJournalRows.rows.length !== 2 || tradeJournalRows.rows.some(row => row.total !== '0')) {
      throw new Error('Spot trade did not produce two balanced single-asset journals.');
    }
    const replayEvents = await app.inject({ method: 'GET', url: '/v1/ledger/events?after=' + eventPage.json().nextAfter, headers: { cookie } });
    if (replayEvents.statusCode !== 200 || !replayEvents.json().events.some((event: { eventType: string }) => event.eventType === 'spot_trade_executed')) {
      throw new Error('Spot execution event is missing from the ledger replay stream.');
    }

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

    console.log('PostgreSQL integration passed: auth, ledger-backed pool reserves and fees, idempotency/retry, balance/history, immutability, logout/revocation.');
  } finally {
    // The CI database is disposable; append-only ledger history is retained until its Postgres service is discarded.
    if (app) await app.close();
    await db.end();
  }
}

main().catch(error => {
  console.error('Backend integration test failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});