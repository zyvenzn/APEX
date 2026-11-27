import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const apiBase = (process.env.APEX_STAGING_API_URL || '').replace(/\/+$/, '');
const origin = process.env.APEX_STAGING_ORIGIN || apiBase;
assert.ok(apiBase, 'APEX_STAGING_API_URL is required');
assert.ok(origin, 'APEX_STAGING_ORIGIN is required');

let sessionCookie = '';
async function call(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { origin };
  if (sessionCookie) headers.cookie = sessionCookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const response = await fetch(apiBase + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const value of setCookies) {
    const match = value.match(/(?:^|,\s*)apex_session=([^;]*)/);
    if (match) sessionCookie = match[1] ? 'apex_session=' + match[1] : '';
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, data };
}
function expectStatus(result, expected, label) {
  assert.equal(result.status, expected, label + ': ' + JSON.stringify(result.data));
}
async function verifyMarket(label, expectedFeeMinor) {
  const response = await call('/v1/spot/markets');
  expectStatus(response, 200, label + ' market snapshot');
  const market = response.data.markets.find(item => item.marketId === 'apex-demo');
  assert.ok(market, label + ': DEMO market missing');
  assert.equal(market.baseReserveMinor, market.baseReserveLedgerMinor, label + ': base reserve mismatch');
  assert.equal(market.quoteReserveMinor, market.quoteReserveLedgerMinor, label + ': quote reserve mismatch');
  assert.equal(market.feeAccruedMinor, expectedFeeMinor, label + ': fee ledger mismatch');
  return market;
}

const email = 'apex-staging-' + Date.now() + '-' + randomUUID().slice(0, 8) + '@example.test';
const password = 'apex-staging-smoke-password-2026';
const checks = [];

const ready = await call('/v1/health/ready');
expectStatus(ready, 200, 'PostgreSQL readiness');
checks.push({ step: 'health_ready', status: ready.status, body: ready.data });

const registered = await call('/v1/auth/register', {
  method: 'POST', body: { email, password, displayName: 'APEX Staging QA' }
});
expectStatus(registered, 201, 'register');
checks.push({ step: 'register', status: registered.status });

const login = await call('/v1/auth/login', { method: 'POST', body: { email, password } });
expectStatus(login, 200, 'login');
const identity = await call('/v1/auth/me');
expectStatus(identity, 200, 'identity after login');
const userId = identity.data.user.id;
checks.push({ step: 'login', status: login.status, userId });

const claim = await call('/v1/ledger/starter-credit', {
  method: 'POST', idempotencyKey: 'staging-claim-' + randomUUID(), body: {}
});
expectStatus(claim, 201, 'starter credit claim');
assert.equal(claim.data.balanceMinor, '1000000');
const secondClaim = await call('/v1/ledger/starter-credit', {
  method: 'POST', idempotencyKey: 'staging-claim-' + randomUUID(), body: {}
});
expectStatus(secondClaim, 409, 'starter credit must be one-time');
assert.equal(secondClaim.data.error, 'STARTER_CREDIT_ALREADY_CLAIMED');
checks.push({ step: 'starter_credit_once', status: claim.status, duplicateStatus: secondClaim.status });

const initialMarket = await verifyMarket('initial', '0');
const buyPayload = { marketId: 'apex-demo', side: 'BUY', amountMinor: '10000', maxSlippageBps: 1500 };
const buyKey = 'staging-buy-' + randomUUID();
const buy = await call('/v1/spot/trades', { method: 'POST', body: buyPayload, idempotencyKey: buyKey });
expectStatus(buy, 201, 'BUY');
assert.ok(BigInt(buy.data.amountOutMinor) > 0n);
assert.equal(buy.data.feeAccruedAfterMinor, buy.data.feeMinor);
const buyRetry = await call('/v1/spot/trades', { method: 'POST', body: buyPayload, idempotencyKey: buyKey });
expectStatus(buyRetry, 200, 'BUY retry');
assert.equal(buyRetry.data.tradeId, buy.data.tradeId);
assert.equal(buyRetry.data.replayed, true);
const balanceAfterBuy = await call('/v1/ledger/balance');
expectStatus(balanceAfterBuy, 200, 'balance after BUY');
assert.equal(balanceAfterBuy.data.balanceMinor, '990000');
const afterBuyMarket = await verifyMarket('after BUY', buy.data.feeMinor);
checks.push({
  step: 'buy_and_retry',
  buyStatus: buy.status,
  retryStatus: buyRetry.status,
  tradeId: buy.data.tradeId,
  feeMinor: buy.data.feeMinor,
  balanceMinor: balanceAfterBuy.data.balanceMinor,
  baseReserveMinor: afterBuyMarket.baseReserveMinor,
  quoteReserveMinor: afterBuyMarket.quoteReserveMinor
});

const sellAmountMinor = (BigInt(buy.data.amountOutMinor) / 2n).toString();
const sell = await call('/v1/spot/trades', {
  method: 'POST',
  idempotencyKey: 'staging-sell-' + randomUUID(),
  body: { marketId: 'apex-demo', side: 'SELL', amountMinor: sellAmountMinor, maxSlippageBps: 1500 }
});
expectStatus(sell, 201, 'SELL');
assert.ok(BigInt(sell.data.amountOutMinor) > 0n);
const balanceAfterSell = await call('/v1/ledger/balance');
expectStatus(balanceAfterSell, 200, 'balance after SELL');
assert.ok(BigInt(balanceAfterSell.data.balanceMinor) > BigInt(balanceAfterBuy.data.balanceMinor));
const expectedFeeAfterSell = (BigInt(buy.data.feeMinor) + BigInt(sell.data.feeMinor)).toString();
const afterSellMarket = await verifyMarket('after SELL', expectedFeeAfterSell);
assert.equal(sell.data.feeAccruedAfterMinor, expectedFeeAfterSell);
checks.push({
  step: 'sell',
  sellStatus: sell.status,
  tradeId: sell.data.tradeId,
  feeMinor: sell.data.feeMinor,
  feeAccruedMinor: afterSellMarket.feeAccruedMinor,
  balanceMinor: balanceAfterSell.data.balanceMinor
});

const concurrent = await Promise.all([
  call('/v1/spot/trades', {
    method: 'POST', idempotencyKey: 'staging-concurrent-a-' + randomUUID(),
    body: { marketId: 'apex-demo', side: 'BUY', amountMinor: '1000', maxSlippageBps: 5000 }
  }),
  call('/v1/spot/trades', {
    method: 'POST', idempotencyKey: 'staging-concurrent-b-' + randomUUID(),
    body: { marketId: 'apex-demo', side: 'BUY', amountMinor: '2000', maxSlippageBps: 5000 }
  })
]);
for (const [index, result] of concurrent.entries()) expectStatus(result, 201, 'concurrent BUY ' + index);
const expectedFinalFee = (
  BigInt(expectedFeeAfterSell) +
  concurrent.reduce((sum, result) => sum + BigInt(result.data.feeMinor), 0n)
).toString();
const finalMarket = await verifyMarket('after concurrent BUYs', expectedFinalFee);
const finalBalance = await call('/v1/ledger/balance');
expectStatus(finalBalance, 200, 'final balance');
const events = await call('/v1/ledger/events?after=0&limit=100');
expectStatus(events, 200, 'trade event history');
const trades = events.data.events.filter(event => event.eventType === 'spot_trade_executed');
assert.equal(trades.length, 4, 'expected one BUY, one SELL and two concurrent BUY trades');
checks.push({
  step: 'concurrent_trades_and_history',
  statuses: concurrent.map(result => result.status),
  tradeCount: trades.length,
  feeAccruedMinor: finalMarket.feeAccruedMinor,
  finalBalanceMinor: finalBalance.data.balanceMinor
});

const logout = await call('/v1/auth/logout', { method: 'POST', body: {} });
expectStatus(logout, 204, 'logout');
const afterLogout = await call('/v1/auth/me');
expectStatus(afterLogout, 401, 'session revocation after logout');
const loginAgain = await call('/v1/auth/login', { method: 'POST', body: { email, password } });
expectStatus(loginAgain, 200, 'login after logout');
const afterRelogin = await call('/v1/auth/me');
expectStatus(afterRelogin, 200, 'identity after re-login');
const balanceAfterRelogin = await call('/v1/ledger/balance');
expectStatus(balanceAfterRelogin, 200, 'balance after re-login');
assert.equal(balanceAfterRelogin.data.balanceMinor, finalBalance.data.balanceMinor);
const eventsAfterRelogin = await call('/v1/ledger/events?after=0&limit=100');
expectStatus(eventsAfterRelogin, 200, 'history after re-login');
assert.equal(eventsAfterRelogin.data.events.filter(event => event.eventType === 'spot_trade_executed').length, 4);
checks.push({
  step: 'logout_login_persistence',
  logoutStatus: logout.status,
  revokedStatus: afterLogout.status,
  reloginStatus: loginAgain.status,
  balancePersisted: balanceAfterRelogin.data.balanceMinor === finalBalance.data.balanceMinor,
  historyCount: 4
});

console.log(JSON.stringify({ result: 'PASS', email, userId, checks }, null, 2));
