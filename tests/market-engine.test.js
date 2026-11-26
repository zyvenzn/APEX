const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/market-engine.js');

function fixture() {
  const pool = M.createPool({ id: 'TEST', price: 0.01, liquidityUsd: 20000, feeBps: 100, circulatingSupply: 100000000 });
  const account = { cash: 1000, positions: {} };
  return { pool, account };
}

test('pool starts at configured marginal price and market cap', () => {
  const { pool } = fixture();
  assert.equal(M.spotPrice(pool), 0.01);
  assert.equal(M.marketCap(pool), 1000000);
});

test('quotes are pure and do not mutate pool reserves', () => {
  const { pool } = fixture();
  const before = { ...pool };
  const q = M.quoteBuy(pool, 100);
  assert.ok(q.quantity > 0);
  assert.ok(q.impact > 0);
  assert.deepEqual(pool, before);
});

test('buy and sell use the same constant-product reserve invariant', () => {
  const { pool, account } = fixture();
  const k0 = pool.baseReserve * pool.quoteReserve;
  const buy = M.executeBuy(pool, account, 100);
  const k1 = pool.baseReserve * pool.quoteReserve;
  assert.ok(Math.abs(k1 - k0) / k0 < 1e-12);
  const sell = M.executeSell(pool, account, buy.quantity);
  const k2 = pool.baseReserve * pool.quoteReserve;
  assert.ok(Math.abs(k2 - k1) / k1 < 1e-12);
  assert.ok(sell.output < 100);
  assert.ok(account.cash < 1000);
  assert.equal(account.positions.TEST, undefined);
});

test('failed slippage and insufficient-balance trades are atomic', () => {
  const { pool, account } = fixture();
  const poolBefore = { ...pool }, accountBefore = JSON.stringify(account);
  assert.throws(() => M.executeBuy(pool, account, 100, 0.00001), /Slippage/);
  assert.deepEqual(pool, poolBefore);
  assert.equal(JSON.stringify(account), accountBefore);
  assert.throws(() => M.executeBuy(pool, account, 2000), /Insufficient cash/);
  assert.deepEqual(pool, poolBefore);
});

test('sell cannot exceed the account token balance', () => {
  const { pool, account } = fixture();
  assert.throws(() => M.executeSell(pool, account, 1), /Insufficient token balance/);
  assert.equal(pool.trades, 0);
});

test('partial sell allocates cost basis and records realized PnL', () => {
  const { pool, account } = fixture();
  const buy = M.executeBuy(pool, account, 200);
  const sold = M.executeSell(pool, account, buy.quantity / 2);
  assert.ok(sold.allocatedCost > 0);
  assert.ok(Number.isFinite(sold.realizedPnl));
  assert.ok(account.positions.TEST.quantity > 0);
  assert.ok(account.positions.TEST.costBasis > 0);
});

test('larger buys create larger price impact in the same pool', () => {
  const { pool } = fixture();
  assert.ok(M.quoteBuy(pool, 500).impact > M.quoteBuy(pool, 50).impact);
});
