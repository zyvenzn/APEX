const assert = require('node:assert/strict');
const test = require('node:test');
const Amm = require('../src/market-engine');
const Curve = require('../src/bonding-curve');
const Router = require('../src/spot-trading-router');

function setup(savedMarkets = {}) {
  const pools = { CURVE: Amm.createPool({
    id: 'CURVE', price: 0.001, liquidityUsd: 2, feeBps: 100,
    circulatingSupply: 10_000_000
  }) };
  const router = Router.createRouter({
    amm: Amm, curve: Curve, pools, bondingIds: ['CURVE'], savedMarkets
  });
  return { pools, router };
}

test('bonding token buy changes price and market cap through app router', () => {
  const { router } = setup();
  const account = { cash: 100, positions: {} };
  const before = router.price('CURVE');
  const fill = router.executeBuy('CURVE', account, 0.2, 1);
  assert.ok(fill.quantity > 0);
  assert.ok(router.price('CURVE') > before);
  assert.ok(router.marketCap('CURVE') > 10_000);
  assert.equal(router.isBonding('CURVE'), true);
});

test('bonding token sell moves price down and credits account', () => {
  const { router } = setup();
  const account = { cash: 100, positions: {} };
  const buy = router.executeBuy('CURVE', account, 0.2, 1);
  const before = router.price('CURVE');
  const sell = router.executeSell('CURVE', account, buy.quantity / 2, 1);
  assert.ok(sell.output > 0);
  assert.ok(router.price('CURVE') < before);
  assert.ok(account.cash > 99.8);
});

test('graduation migrates reserves and router continues on AMM', () => {
  const pools = { CURVE: Amm.createPool({
    id: 'CURVE', price: 0.001, liquidityUsd: 2, feeBps: 100,
    circulatingSupply: 10_000_000
  }) };
  const router = Router.createRouter({ amm: Amm, curve: Curve, pools, bondingIds: ['CURVE'] });
  const m = router.market('CURVE');
  // The initial cap is $10K; a $2 buy moves it across the $69K graduation target.
  const account = { cash: 100, positions: {} };
  const buy = router.executeBuy('CURVE', account, 2, 3);
  assert.equal(router.isGraduated('CURVE'), true);
  assert.equal(m.status, 'GRADUATED');
  assert.equal(pools.CURVE.baseReserve, m.ammPool.baseReserve);
  assert.equal(pools.CURVE.quoteReserve, m.ammPool.quoteReserve);
  const before = router.price('CURVE');
  const post = router.executeBuy('CURVE', account, 0.1, 100);
  assert.ok(post.quantity > 0);
  assert.ok(router.price('CURVE') > before);
  assert.equal(router.progress('CURVE'), 100);
});

test('router restores persisted bonding and graduated markets', () => {
  const { router } = setup();
  const state = router.serialize();
  const pools2 = { CURVE: Amm.createPool({
    id: 'CURVE', price: 0.001, liquidityUsd: 2, feeBps: 100,
    circulatingSupply: 10_000_000
  }) };
  const restored = Router.createRouter({ amm: Amm, curve: Curve, pools: pools2,
    bondingIds: ['CURVE'], savedMarkets: state });
  assert.equal(restored.market('CURVE').status, 'BONDING');
  assert.equal(restored.price('CURVE'), router.price('CURVE'));
});
