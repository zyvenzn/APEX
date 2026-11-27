/* APEX reserve-backed bonding curve + graduation engine.
 * Deterministic, browser/Node compatible virtual-money simulation.
 * No network calls and no real assets are moved.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ApexBondingCurve = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EPS = 1e-10;
  const DEFAULT_GRADUATION_MC_USD = 69000;
  const finitePositive = (n, label) => {
    if (!Number.isFinite(n) || n <= 0) throw new Error(label + ' must be a finite positive number');
    return n;
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  // Once graduated, the AMM pool becomes the live source of price and reserves.
  // The curve reserve fields remain as an immutable migration snapshot.
  const activeReserves = market => market?.status === 'GRADUATED' && market.ammPool
    ? market.ammPool : market;
  const price = market => {
    const reserves = activeReserves(market);
    return reserves.quoteReserve / reserves.baseReserve;
  };
  const marketCap = market => price(market) * market.circulatingSupply;
  const invariant = market => {
    const reserves = activeReserves(market);
    return reserves.baseReserve * reserves.quoteReserve;
  };

  function createMarket(config) {
    if (!config || typeof config !== 'object') throw new Error('config is required');
    const id = String(config.id || '').trim();
    if (!id) throw new Error('id is required');
    const baseReserve = finitePositive(config.baseReserve, 'baseReserve');
    const quoteReserve = finitePositive(config.quoteReserve, 'quoteReserve');
    const circulatingSupply = finitePositive(config.circulatingSupply, 'circulatingSupply');
    const feeBps = config.feeBps === undefined ? 100 : config.feeBps;
    const graduationTargetUsd = config.graduationTargetUsd === undefined
      ? DEFAULT_GRADUATION_MC_USD : config.graduationTargetUsd;
    if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps >= 10000) throw new Error('feeBps must be in [0, 10000)');
    finitePositive(graduationTargetUsd, 'graduationTargetUsd');

    return {
      id, status: 'BONDING', feeBps, graduationTargetUsd,
      baseReserve, quoteReserve, circulatingSupply,
      initialMarketCapUsd: (quoteReserve / baseReserve) * circulatingSupply,
      volumeQuote: 0, feesCollected: 0, trades: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
      graduation: null, ammPool: null
    };
  }

  function assertBonding(market) {
    if (!market || market.status !== 'BONDING') throw new Error('Bonding curve is not active');
  }

  function quoteBuy(market, amountQuote) {
    finitePositive(amountQuote, 'amountQuote');
    assertBonding(market);
    const fee = amountQuote * market.feeBps / 10000;
    const net = amountQuote - fee;
    if (!(net > 0) || net >= market.quoteReserve * 1000) throw new Error('Invalid buy size');
    const k = invariant(market);
    const nextQuoteReserve = market.quoteReserve + net;
    const nextBaseReserve = k / nextQuoteReserve;
    const amountBase = market.baseReserve - nextBaseReserve;
    if (!(amountBase > 0 && amountBase < market.baseReserve)) throw new Error('Insufficient token inventory');
    const executionPrice = amountQuote / amountBase;
    const priceBefore = price(market);
    const priceAfter = nextQuoteReserve / nextBaseReserve;
    return {
      side: 'BUY', amountQuote, amountBase, fee,
      priceBefore, priceAfter, executionPrice,
      impact: Math.max(0, executionPrice / priceBefore - 1),
      nextBaseReserve, nextQuoteReserve
    };
  }

  function quoteSell(market, amountBase) {
    finitePositive(amountBase, 'amountBase');
    assertBonding(market);
    if (amountBase >= market.baseReserve * 1000) throw new Error('Invalid sell size');
    const k = invariant(market);
    const nextBaseReserve = market.baseReserve + amountBase;
    const grossQuote = market.quoteReserve - k / nextBaseReserve;
    const fee = grossQuote * market.feeBps / 10000;
    const amountQuote = grossQuote - fee;
    if (!(amountQuote > 0 && amountQuote < market.quoteReserve)) throw new Error('Insufficient quote reserves');
    const executionPrice = amountQuote / amountBase;
    const priceBefore = price(market);
    const priceAfter = (market.quoteReserve - grossQuote) / nextBaseReserve;
    return {
      side: 'SELL', amountBase, grossQuote, amountQuote, fee,
      priceBefore, priceAfter, executionPrice,
      impact: Math.max(0, 1 - executionPrice / priceBefore),
      nextBaseReserve, nextQuoteReserve: market.quoteReserve - grossQuote
    };
  }

  function checkImpact(quote, maxImpact) {
    if (!Number.isFinite(maxImpact) || maxImpact < 0 || quote.impact > maxImpact) {
      throw new Error('Slippage tolerance exceeded');
    }
  }

  function maybeGraduate(market) {
    if (market.status !== 'BONDING' || marketCap(market) + EPS < market.graduationTargetUsd) return null;
    graduate(market);
    return clone(market.graduation);
  }

  function executeBuy(market, account, amountQuote, maxImpact = 1) {
    assertBonding(market);
    if (!account || !Number.isFinite(account.cash) || account.cash + EPS < amountQuote) throw new Error('Insufficient cash');
    const q = quoteBuy(market, amountQuote);
    checkImpact(q, maxImpact);
    const old = account.positions?.[market.id] || { quantity: 0, costBasis: 0, realizedPnl: 0 };
    if (![old.quantity, old.costBasis].every(Number.isFinite) || old.quantity < 0 || old.costBasis < 0) {
      throw new Error('Invalid account position');
    }
    const nextPosition = {
      quantity: old.quantity + q.amountBase,
      costBasis: old.costBasis + amountQuote,
      realizedPnl: old.realizedPnl || 0
    };
    // Commit all state only after every validation succeeds.
    market.baseReserve = q.nextBaseReserve;
    market.quoteReserve = q.nextQuoteReserve;
    market.volumeQuote += amountQuote;
    market.feesCollected += q.fee;
    market.trades += 1;
    market.updatedAt = Date.now();
    account.cash -= amountQuote;
    account.positions = account.positions || {};
    account.positions[market.id] = nextPosition;
    const graduation = maybeGraduate(market);
    return { ...q, position: clone(nextPosition), cashAfter: account.cash,
      marketCapAfter: marketCap(market), graduation };
  }

  function executeSell(market, account, amountBase, maxImpact = 1) {
    assertBonding(market);
    const old = account?.positions?.[market.id];
    if (!old || !Number.isFinite(old.quantity) || !Number.isFinite(old.costBasis) ||
        old.quantity + EPS < amountBase || amountBase <= 0) throw new Error('Insufficient token balance');
    const q = quoteSell(market, amountBase);
    checkImpact(q, maxImpact);
    const fraction = amountBase / old.quantity;
    const allocatedCost = old.costBasis * fraction;
    const nextPosition = {
      quantity: Math.max(0, old.quantity - amountBase),
      costBasis: Math.max(0, old.costBasis - allocatedCost),
      realizedPnl: (old.realizedPnl || 0) + q.amountQuote - allocatedCost
    };
    market.baseReserve = q.nextBaseReserve;
    market.quoteReserve = q.nextQuoteReserve;
    market.volumeQuote += q.amountQuote;
    market.feesCollected += q.fee;
    market.trades += 1;
    market.updatedAt = Date.now();
    account.cash += q.amountQuote;
    if (nextPosition.quantity <= EPS) delete account.positions[market.id];
    else account.positions[market.id] = nextPosition;
    const graduation = maybeGraduate(market);
    return { ...q, allocatedCost, realizedPnl: q.amountQuote - allocatedCost,
      position: clone(nextPosition), cashAfter: account.cash,
      marketCapAfter: marketCap(market), graduation };
  }

  function graduate(market) {
    if (!market) throw new Error('market is required');
    if (market.status === 'GRADUATED' && market.ammPool) return clone(market.ammPool);
    assertBonding(market);
    const finalMarketCap = marketCap(market);
    if (finalMarketCap + EPS < market.graduationTargetUsd) throw new Error('Graduation target not reached');
    finitePositive(market.baseReserve, 'final base reserve');
    finitePositive(market.quoteReserve, 'final quote reserve');

    // The AMM is seeded with the exact final curve reserves. Its initial marginal
    // price therefore equals the curve's final marginal price (before rounding).
    const pool = {
      id: market.id, status: 'ACTIVE', feeBps: market.feeBps,
      baseReserve: market.baseReserve, quoteReserve: market.quoteReserve,
      circulatingSupply: market.circulatingSupply,
      volume24h: 0, feesCollected: 0, trades: 0,
      createdAt: Date.now(), migratedFrom: 'BONDING',
      migration: {
        baseReserve: market.baseReserve,
        quoteReserve: market.quoteReserve,
        price: price(market),
        marketCapUsd: finalMarketCap,
        migratedAt: Date.now()
      }
    };
    market.status = 'GRADUATED';
    market.ammPool = pool;
    market.graduation = {
      status: 'COMPLETED',
      marketCapUsd: finalMarketCap,
      migratedBaseReserve: pool.baseReserve,
      migratedQuoteReserve: pool.quoteReserve,
      poolId: pool.id,
      migratedAt: pool.migration.migratedAt
    };
    market.updatedAt = Date.now();
    return clone(pool);
  }

  function progress(market) {
    if (!market) return 0;
    if (market.status === 'GRADUATED') return 100;
    return Math.max(0, Math.min(100, marketCap(market) / market.graduationTargetUsd * 100));
  }

  function quoteAmmBuy(pool, amountQuote) {
    finitePositive(amountQuote, 'amountQuote');
    if (!pool || pool.status !== 'ACTIVE') throw new Error('AMM pool is not active');
    const fee = amountQuote * pool.feeBps / 10000;
    const net = amountQuote - fee;
    const k = pool.baseReserve * pool.quoteReserve;
    const nextQuoteReserve = pool.quoteReserve + net;
    const nextBaseReserve = k / nextQuoteReserve;
    const amountBase = pool.baseReserve - nextBaseReserve;
    if (!(amountBase > 0 && amountBase < pool.baseReserve)) throw new Error('Insufficient token liquidity');
    const priceBefore = pool.quoteReserve / pool.baseReserve;
    const priceAfter = nextQuoteReserve / nextBaseReserve;
    return { side: 'BUY', amountQuote, amountBase, fee, priceBefore, priceAfter,
      executionPrice: amountQuote / amountBase,
      impact: Math.max(0, (amountQuote / amountBase) / priceBefore - 1),
      nextBaseReserve, nextQuoteReserve };
  }

  function quoteAmmSell(pool, amountBase) {
    finitePositive(amountBase, 'amountBase');
    if (!pool || pool.status !== 'ACTIVE') throw new Error('AMM pool is not active');
    const k = pool.baseReserve * pool.quoteReserve;
    const nextBaseReserve = pool.baseReserve + amountBase;
    const grossQuote = pool.quoteReserve - k / nextBaseReserve;
    const fee = grossQuote * pool.feeBps / 10000;
    const amountQuote = grossQuote - fee;
    if (!(amountQuote > 0 && amountQuote < pool.quoteReserve)) throw new Error('Insufficient quote liquidity');
    const priceBefore = pool.quoteReserve / pool.baseReserve;
    const nextQuoteReserve = pool.quoteReserve - grossQuote;
    const priceAfter = nextQuoteReserve / nextBaseReserve;
    return { side: 'SELL', amountBase, grossQuote, amountQuote, fee, priceBefore, priceAfter,
      executionPrice: amountQuote / amountBase,
      impact: Math.max(0, 1 - (amountQuote / amountBase) / priceBefore),
      nextBaseReserve, nextQuoteReserve };
  }

  function applyAmmQuote(pool, quote) {
    if (!pool || pool.status !== 'ACTIVE') throw new Error('AMM pool is not active');
    pool.baseReserve = quote.nextBaseReserve;
    pool.quoteReserve = quote.nextQuoteReserve;
    pool.volume24h += quote.amountQuote;
    pool.feesCollected += quote.fee;
    pool.trades += 1;
    pool.updatedAt = Date.now();
    return { ...quote, marketCapAfter: (pool.quoteReserve / pool.baseReserve) * pool.circulatingSupply };
  }

  function executeAmmBuy(pool, account, amountQuote, maxImpact = 1) {
    if (!account || !Number.isFinite(account.cash) || account.cash + EPS < amountQuote) throw new Error('Insufficient cash');
    const q = quoteAmmBuy(pool, amountQuote);
    checkImpact(q, maxImpact);
    const old = account.positions?.[pool.id] || { quantity: 0, costBasis: 0, realizedPnl: 0 };
    if (![old.quantity, old.costBasis].every(Number.isFinite) || old.quantity < 0 || old.costBasis < 0) throw new Error('Invalid account position');
    const nextPosition = { quantity: old.quantity + q.amountBase, costBasis: old.costBasis + amountQuote, realizedPnl: old.realizedPnl || 0 };
    applyAmmQuote(pool, q);
    account.cash -= amountQuote;
    account.positions = account.positions || {};
    account.positions[pool.id] = nextPosition;
    return { ...q, position: clone(nextPosition), cashAfter: account.cash,
      marketCapAfter: (pool.quoteReserve / pool.baseReserve) * pool.circulatingSupply };
  }

  function executeAmmSell(pool, account, amountBase, maxImpact = 1) {
    const old = account?.positions?.[pool.id];
    if (!old || !Number.isFinite(old.quantity) || !Number.isFinite(old.costBasis) || old.quantity + EPS < amountBase || amountBase <= 0) {
      throw new Error('Insufficient token balance');
    }
    const q = quoteAmmSell(pool, amountBase);
    checkImpact(q, maxImpact);
    const fraction = amountBase / old.quantity;
    const allocatedCost = old.costBasis * fraction;
    const nextPosition = { quantity: Math.max(0, old.quantity - amountBase),
      costBasis: Math.max(0, old.costBasis - allocatedCost),
      realizedPnl: (old.realizedPnl || 0) + q.amountQuote - allocatedCost };
    applyAmmQuote(pool, q);
    account.cash += q.amountQuote;
    if (nextPosition.quantity <= EPS) delete account.positions[pool.id];
    else account.positions[pool.id] = nextPosition;
    return { ...q, allocatedCost, realizedPnl: q.amountQuote - allocatedCost,
      position: clone(nextPosition), cashAfter: account.cash,
      marketCapAfter: (pool.quoteReserve / pool.baseReserve) * pool.circulatingSupply };
  }

  return {
    DEFAULT_GRADUATION_MC_USD, createMarket, price, marketCap, invariant, progress,
    quoteBuy, quoteSell, executeBuy, executeSell, graduate,
    quoteAmmBuy, quoteAmmSell, applyAmmQuote, executeAmmBuy, executeAmmSell
  };
});
