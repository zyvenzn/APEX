/* APEX deterministic spot AMM core.
 * Browser + Node compatible. This is a virtual-money simulator, not an on-chain exchange.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ApexMarketEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const EPS = 1e-12;
  const finitePositive = (n, label) => {
    if (!Number.isFinite(n) || n <= 0) throw new Error(label + ' must be a finite positive number');
    return n;
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  function createPool({ id, price, liquidityUsd, feeBps = 100, circulatingSupply }) {
    finitePositive(price, 'price');
    finitePositive(liquidityUsd, 'liquidityUsd');
    finitePositive(circulatingSupply, 'circulatingSupply');
    if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps >= 10000) throw new Error('feeBps must be in [0, 10000)');
    const quoteReserve = liquidityUsd / 2;
    return {
      id, status: 'ACTIVE', feeBps, baseReserve: quoteReserve / price,
      quoteReserve, circulatingSupply, volume24h: 0, feesCollected: 0,
      trades: 0, updatedAt: Date.now()
    };
  }
  const spotPrice = pool => pool.quoteReserve / pool.baseReserve;
  const marketCap = pool => spotPrice(pool) * pool.circulatingSupply;
  function quoteBuy(pool, amount) {
    finitePositive(amount, 'amount');
    if (!pool || pool.status !== 'ACTIVE') throw new Error('Pool is not active');
    const fee = amount * pool.feeBps / 10000;
    const net = amount - fee;
    if (net <= 0 || net >= pool.quoteReserve * 1000) throw new Error('Invalid quote size');
    const k = pool.baseReserve * pool.quoteReserve;
    const nextQuote = pool.quoteReserve + net;
    const nextBase = k / nextQuote;
    const quantity = pool.baseReserve - nextBase;
    if (!(quantity > 0 && quantity < pool.baseReserve)) throw new Error('Insufficient base liquidity');
    const executionPrice = amount / quantity;
    const impact = Math.max(0, executionPrice / spotPrice(pool) - 1);
    return { side: 'BUY', amount, fee, quantity, executionPrice, impact,
      priceBefore: spotPrice(pool), priceAfter: nextQuote / nextBase,
      nextBaseReserve: nextBase, nextQuoteReserve: nextQuote };
  }
  function quoteSell(pool, quantity) {
    finitePositive(quantity, 'quantity');
    if (!pool || pool.status !== 'ACTIVE') throw new Error('Pool is not active');
    if (quantity >= pool.baseReserve * 1000) throw new Error('Invalid quote size');
    const k = pool.baseReserve * pool.quoteReserve;
    const nextBase = pool.baseReserve + quantity;
    const gross = pool.quoteReserve - k / nextBase;
    const fee = gross * pool.feeBps / 10000;
    const output = gross - fee;
    if (!(output > 0 && output < pool.quoteReserve)) throw new Error('Insufficient quote liquidity');
    const executionPrice = output / quantity;
    const impact = Math.max(0, 1 - executionPrice / spotPrice(pool));
    return { side: 'SELL', quantity, gross, fee, output, executionPrice, impact,
      priceBefore: spotPrice(pool), priceAfter: (pool.quoteReserve - gross) / nextBase,
      nextBaseReserve: nextBase, nextQuoteReserve: pool.quoteReserve - gross };
  }
  function executeBuy(pool, account, amount, maxImpact = 1) {
    if (!account || !Number.isFinite(account.cash) || account.cash + EPS < amount) throw new Error('Insufficient cash');
    const q = quoteBuy(pool, amount);
    if (!Number.isFinite(maxImpact) || maxImpact < 0 || q.impact > maxImpact) throw new Error('Slippage tolerance exceeded');
    const old = account.positions?.[pool.id] || { quantity: 0, costBasis: 0, realizedPnl: 0 };
    const nextPosition = { quantity: old.quantity + q.quantity, costBasis: old.costBasis + amount, realizedPnl: old.realizedPnl || 0 };
    pool.baseReserve = q.nextBaseReserve; pool.quoteReserve = q.nextQuoteReserve;
    pool.volume24h += amount; pool.feesCollected += q.fee; pool.trades += 1; pool.updatedAt = Date.now();
    account.cash -= amount; account.positions = account.positions || {}; account.positions[pool.id] = nextPosition;
    return { ...q, position: clone(nextPosition), cashAfter: account.cash, marketCapAfter: marketCap(pool) };
  }
  function executeSell(pool, account, quantity, maxImpact = 1) {
    const old = account?.positions?.[pool.id];
    if (!old || !Number.isFinite(old.quantity) || old.quantity + EPS < quantity) throw new Error('Insufficient token balance');
    const q = quoteSell(pool, quantity);
    if (!Number.isFinite(maxImpact) || maxImpact < 0 || q.impact > maxImpact) throw new Error('Slippage tolerance exceeded');
    const fraction = quantity / old.quantity;
    const allocatedCost = old.costBasis * fraction;
    const nextPosition = { quantity: Math.max(0, old.quantity - quantity),
      costBasis: Math.max(0, old.costBasis - allocatedCost),
      realizedPnl: (old.realizedPnl || 0) + q.output - allocatedCost };
    pool.baseReserve = q.nextBaseReserve; pool.quoteReserve = q.nextQuoteReserve;
    pool.volume24h += q.output; pool.feesCollected += q.fee; pool.trades += 1; pool.updatedAt = Date.now();
    account.cash += q.output;
    if (nextPosition.quantity <= EPS) delete account.positions[pool.id];
    else account.positions[pool.id] = nextPosition;
    return { ...q, allocatedCost, realizedPnl: q.output - allocatedCost,
      position: clone(nextPosition), cashAfter: account.cash, marketCapAfter: marketCap(pool) };
  }
  return { createPool, spotPrice, marketCap, quoteBuy, quoteSell, executeBuy, executeSell };
});
