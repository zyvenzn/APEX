/* APEX multi-chain read-only market registry.
 * This file describes supported chain identities; it does not implement a live provider
 * and must never be used as permission to submit transactions.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ApexChainRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CHAINS = Object.freeze([
    { id: 'solana', chainId: 'solana:mainnet-beta', name: 'Solana', family: 'solana', nativeSymbol: 'SOL', enabled: true, mode: 'read-only' },
    { id: 'ethereum', chainId: 'eip155:1', name: 'Ethereum', family: 'evm', nativeSymbol: 'ETH', enabled: true, mode: 'read-only' },
    { id: 'base', chainId: 'eip155:8453', name: 'Base', family: 'evm', nativeSymbol: 'ETH', enabled: true, mode: 'read-only' },
    { id: 'bnb', chainId: 'eip155:56', name: 'BNB Chain', family: 'evm', nativeSymbol: 'BNB', enabled: true, mode: 'read-only' },
    { id: 'arbitrum', chainId: 'eip155:42161', name: 'Arbitrum One', family: 'evm', nativeSymbol: 'ETH', enabled: true, mode: 'read-only' },
    { id: 'polygon', chainId: 'eip155:137', name: 'Polygon PoS', family: 'evm', nativeSymbol: 'POL', enabled: true, mode: 'read-only' }
  ]);

  function list() { return CHAINS.map(chain => ({ ...chain })); }
  function get(id) {
    const chain = CHAINS.find(item => item.id === id || item.chainId === id);
    return chain ? { ...chain } : null;
  }
  function assetKey(chainId, tokenAddress) {
    if (!chainId || !tokenAddress || !String(tokenAddress).trim()) throw new Error('chainId and tokenAddress are required');
    return String(chainId) + ':' + String(tokenAddress).toLowerCase();
  }
  function poolKey(chainId, dexId, poolAddress) {
    if (!chainId || !dexId || !poolAddress || !String(poolAddress).trim()) throw new Error('chainId, dexId and poolAddress are required');
    return String(chainId) + ':' + String(dexId).toLowerCase() + ':' + String(poolAddress).toLowerCase();
  }
  return Object.freeze({ list, get, assetKey, poolKey });
});
