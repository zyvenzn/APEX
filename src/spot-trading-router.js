/* Routes simulated spot trades through bonding curves, then migrated AMMs.
 * Browser + Node compatible. Does not move real assets.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ApexSpotRouter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createRouter({ amm, curve, pools, bondingIds, savedMarkets = {} }) {
    if (!amm || !curve || !pools || !Array.isArray(bondingIds)) throw new Error('Router dependencies are required');
    const markets = {};
    for (const id of bondingIds) {
      const pool = pools[id];
      if (!pool) continue;
      const saved = savedMarkets[id];
      const validReserves = value => value && Number.isFinite(value.baseReserve) &&
        value.baseReserve > 0 && Number.isFinite(value.quoteReserve) && value.quoteReserve > 0 &&
        Number.isFinite(value.circulatingSupply) && value.circulatingSupply > 0;
      const validSaved = saved && saved.id === id &&
        ['BONDING', 'GRADUATED'].includes(saved.status) && validReserves(saved) &&
        Number.isFinite(saved.feeBps) && saved.feeBps >= 0 && saved.feeBps < 10000 &&
        (saved.status !== 'GRADUATED' || (validReserves(saved.ammPool) &&
          saved.ammPool.status === 'ACTIVE' && saved.ammPool.id === id));
      if (validSaved) {
        markets[id] = saved;
      } else {
        markets[id] = curve.createMarket({
          id,
          baseReserve: pool.baseReserve,
          quoteReserve: pool.quoteReserve,
          circulatingSupply: pool.circulatingSupply,
          feeBps: pool.feeBps,
          graduationTargetUsd: curve.DEFAULT_GRADUATION_MC_USD
        });
        // Upgrade legacy local AMM pools already beyond the graduation target.
        if (curve.marketCap(markets[id]) + 1e-10 >= markets[id].graduationTargetUsd) {
          curve.graduate(markets[id]);
        }
      }
      // Reconcile persisted BONDING snapshots too: a stale status must not keep
      // a market on the curve after its persisted reserves crossed the target.
      if (markets[id].status === 'BONDING' &&
          curve.marketCap(markets[id]) + 1e-10 >= markets[id].graduationTargetUsd) {
        curve.graduate(markets[id]);
      }
      if (markets[id].status === 'GRADUATED' && markets[id].ammPool) {
        markets[id].ammPool = normalizePool(markets[id].ammPool);
        pools[id] = markets[id].ammPool;
      }
    }

    function normalizePool(pool) {
      return { ...pool, volume24h: Number.isFinite(pool.volume24h) ? pool.volume24h : 0,
        feesCollected: Number.isFinite(pool.feesCollected) ? pool.feesCollected : 0,
        trades: Number.isFinite(pool.trades) ? pool.trades : 0 };
    }
    function market(id) { return markets[id] || null; }
    function isBonding(id) { return market(id)?.status === 'BONDING'; }
    function isGraduated(id) { return market(id)?.status === 'GRADUATED'; }
    function activePool(id) {
      const m = market(id);
      return m?.status === 'GRADUATED' ? m.ammPool : pools[id];
    }
    function sync(id) {
      const m = market(id);
      if (m?.status === 'GRADUATED') pools[id] = normalizePool(m.ammPool);
      return m;
    }
    function quoteBuy(id, amount) {
      const m = market(id);
      const q = m?.status === 'BONDING' ? curve.quoteBuy(m, amount)
        : m?.status === 'GRADUATED' ? curve.quoteAmmBuy(m.ammPool, amount)
        : amm.quoteBuy(pools[id], amount);
      return { ...q, quantity: q.amountBase ?? q.quantity, qty: q.amountBase ?? q.quantity,
        executionPrice: q.executionPrice, px: q.executionPrice };
    }
    function quoteSell(id, quantity) {
      const m = market(id);
      const q = m?.status === 'BONDING' ? curve.quoteSell(m, quantity)
        : m?.status === 'GRADUATED' ? curve.quoteAmmSell(m.ammPool, quantity)
        : amm.quoteSell(pools[id], quantity);
      return { ...q, output: q.amountQuote ?? q.output };
    }
    function executeBuy(id, account, amount, maxImpact) {
      const m = market(id);
      let result;
      if (m?.status === 'BONDING') {
        result = curve.executeBuy(m, account, amount, maxImpact);
        sync(id);
        return { ...result, quantity: result.amountBase, qty: result.amountBase,
          marketCapAfter: curve.marketCap(m), graduated: m.status === 'GRADUATED' };
      }
      if (m?.status === 'GRADUATED') {
        result = curve.executeAmmBuy(m.ammPool, account, amount, maxImpact);
        sync(id);
        return { ...result, quantity: result.amountBase, qty: result.amountBase,
          graduated: true };
      }
      return amm.executeBuy(pools[id], account, amount, maxImpact);
    }
    function executeSell(id, account, quantity, maxImpact) {
      const m = market(id);
      let result;
      if (m?.status === 'BONDING') {
        result = curve.executeSell(m, account, quantity, maxImpact);
        sync(id);
        return { ...result, output: result.amountQuote,
          marketCapAfter: curve.marketCap(m), graduated: m.status === 'GRADUATED' };
      }
      if (m?.status === 'GRADUATED') {
        result = curve.executeAmmSell(m.ammPool, account, quantity, maxImpact);
        sync(id);
        return { ...result, output: result.amountQuote, graduated: true };
      }
      return amm.executeSell(pools[id], account, quantity, maxImpact);
    }
    function price(id) {
      const m = market(id);
      return m ? curve.price(m) : amm.spotPrice(pools[id]);
    }
    function marketCap(id) {
      const m = market(id);
      return m ? curve.marketCap(m) : amm.marketCap(pools[id]);
    }
    function progress(id) {
      const m = market(id);
      return m ? curve.progress(m) : 100;
    }
    function serialize() {
      return JSON.parse(JSON.stringify(markets));
    }
    return { market, isBonding, isGraduated, activePool, quoteBuy, quoteSell,
      executeBuy, executeSell, price, marketCap, progress, serialize };
  }
  return { createRouter };
});
