const assert = require('node:assert/strict');
const test = require('node:test');
const Curve = require('../src/bonding-curve');

function market(overrides = {}) {
  return Curve.createMarket({
    id: 'TEST', baseReserve: 1_000_000, quoteReserve: 10_000,
    circulatingSupply: 1_000_000, feeBps: 100,
    graduationTargetUsd: 69_000, ...overrides
  });
}

test('buy quote is pure and moves marginal price up', () => {
  const m = market();
  const before = { base: m.baseReserve, quote: m.quoteReserve };
  const q = Curve.quoteBuy(m, 100);
  assert.ok(q.amountBase > 0);
  assert.ok(q.priceAfter > q.priceBefore);
  assert.equal(m.baseReserve, before.base);
  assert.equal(m.quoteReserve, before.quote);
});

test('sell quote is pure and moves marginal price down', () => {
  const m = market();
  const q = Curve.quoteSell(m, 1_000);
  assert.ok(q.amountQuote > 0);
  assert.ok(q.priceAfter < q.priceBefore);
  assert.equal(m.baseReserve, 1_000_000);
  assert.equal(m.quoteReserve, 10_000);
});

test('buy and sell update reserves, cash, holdings and fees together', () => {
  const m = market();
  const account = { cash: 1_000, positions: {} };
  const buy = Curve.executeBuy(m, account, 100, 1);
  assert.ok(buy.amountBase > 0);
  assert.equal(account.cash, 900);
  assert.equal(account.positions.TEST.quantity, buy.amountBase);
  assert.ok(m.feesCollected > 0);
  const sell = Curve.executeSell(m, account, buy.amountBase / 2, 1);
  assert.ok(sell.amountQuote > 0);
  assert.equal(account.positions.TEST.quantity, buy.amountBase / 2);
  assert.ok(account.cash > 900);
  assert.ok(sell.priceAfter < sell.priceBefore);
});

test('failed trades do not partially mutate market or account', () => {
  const m = market();
  const account = { cash: 10, positions: {} };
  const before = JSON.stringify({ m, account });
  assert.throws(() => Curve.executeBuy(m, account, 100, 1), /Insufficient cash/);
  assert.equal(JSON.stringify({ m, account }), before);
  assert.throws(() => Curve.executeSell(m, account, 1, 1), /Insufficient token balance/);
  assert.equal(JSON.stringify({ m, account }), before);
});

test('slippage limit rejects a large trade without mutation', () => {
  const m = market();
  const account = { cash: 10_000, positions: {} };
  const before = JSON.stringify({ m, account });
  assert.throws(() => Curve.executeBuy(m, account, 2_000, 0.01), /Slippage/);
  assert.equal(JSON.stringify({ m, account }), before);
});

test('round trip pays fees and cannot create cash', () => {
  const m = market();
  const account = { cash: 1_000, positions: {} };
  Curve.executeBuy(m, account, 500, 1);
  const qty = account.positions.TEST.quantity;
  Curve.executeSell(m, account, qty, 1);
  assert.ok(account.cash < 1_000);
  assert.ok(account.cash > 990);
});

test('graduation happens at threshold and migrates exact reserves', () => {
  const m = market({ baseReserve: 1_000, quoteReserve: 1, circulatingSupply: 10_000_000 });
  // At initial price 0.001, MC is $10K. A large buy crosses the $69K target.
  const account = { cash: 100_000, positions: {} };
  const result = Curve.executeBuy(m, account, 2, 3);
  assert.equal(m.status, 'GRADUATED');
  assert.equal(result.graduation.status, 'COMPLETED');
  assert.equal(m.ammPool.status, 'ACTIVE');
  assert.equal(m.ammPool.baseReserve, m.baseReserve);
  assert.equal(m.ammPool.quoteReserve, m.quoteReserve);
  assert.ok(Math.abs(Curve.price(m) - m.ammPool.quoteReserve / m.ammPool.baseReserve) < 1e-12);
  assert.ok(Curve.progress(m) === 100);
});

test('graduation is idempotent and old curve is permanently closed', () => {
  const m = market({ baseReserve: 1_000, quoteReserve: 1, circulatingSupply: 10_000_000 });
  Curve.executeBuy(m, { cash: 100_000, positions: {} }, 2, 3);
  const first = JSON.stringify(m.ammPool);
  const second = JSON.stringify(Curve.graduate(m));
  assert.equal(second, first);
  assert.throws(() => Curve.quoteBuy(m, 1), /not active/);
  assert.throws(() => Curve.quoteSell(m, 1), /not active/);
});

test('graduated AMM continues to quote swaps', () => {
  const m = market({ baseReserve: 1_000, quoteReserve: 1, circulatingSupply: 10_000_000 });
  Curve.executeBuy(m, { cash: 100_000, positions: {} }, 2, 3);
  const pool = m.ammPool;
  const account = { cash: 100, positions: {} };
  const before = pool.quoteReserve / pool.baseReserve;
  const buy = Curve.executeAmmBuy(pool, account, 10, 100);
  assert.ok(buy.amountBase > 0);
  assert.ok(pool.quoteReserve / pool.baseReserve > before);
  assert.equal(account.cash, 90);
  const sell = Curve.executeAmmSell(pool, account, buy.amountBase / 2, 100);
  assert.ok(sell.amountQuote > 0);
  assert.ok(account.cash > 90);
  assert.ok(account.positions.TEST.quantity > 0);
});

test('market price, market cap and invariant follow live AMM after graduation', () => {
  const m = market({ baseReserve: 1_000, quoteReserve: 1, circulatingSupply: 10_000_000 });
  Curve.executeBuy(m, { cash: 100_000, positions: {} }, 2, 3);
  const pool = m.ammPool;
  const beforeBuyPrice = Curve.price(m);
  const beforeBuyCap = Curve.marketCap(m);
  const account = { cash: 100, positions: {} };
  Curve.executeAmmBuy(pool, account, 10, 100);
  assert.ok(Curve.price(m) > beforeBuyPrice);
  assert.ok(Curve.marketCap(m) > beforeBuyCap);
  assert.equal(Curve.price(m), pool.quoteReserve / pool.baseReserve);
  assert.equal(Curve.marketCap(m), (pool.quoteReserve / pool.baseReserve) * m.circulatingSupply);
  assert.equal(Curve.invariant(m), pool.baseReserve * pool.quoteReserve);
  const afterBuyPrice = Curve.price(m);
  Curve.executeAmmSell(pool, account, account.positions.TEST.quantity / 2, 100);
  assert.ok(Curve.price(m) < afterBuyPrice);
});

test('below-target market remains bonding and progress is bounded', () => {
  const m = market();
  assert.equal(m.status, 'BONDING');
  assert.ok(Curve.progress(m) >= 0 && Curve.progress(m) < 100);
  assert.throws(() => Curve.graduate(m), /target not reached/);
});
