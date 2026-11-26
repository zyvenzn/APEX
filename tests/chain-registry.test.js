const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/market-data/chain-registry.js');

test('registry exposes supported chains as read-only', () => {
  const chains = C.list();
  assert.ok(chains.length >= 5);
  assert.ok(chains.every(chain => chain.enabled && chain.mode === 'read-only'));
  assert.equal(C.get('solana').family, 'solana');
  assert.equal(C.get('eip155:8453').name, 'Base');
});

test('same ticker/address on different chains remains a different asset', () => {
  const sol = C.assetKey('solana:mainnet-beta', 'TokenAddress');
  const base = C.assetKey('eip155:8453', 'TokenAddress');
  assert.notEqual(sol, base);
});

test('pool identity includes chain, DEX and pool address', () => {
  assert.notEqual(
    C.poolKey('eip155:1', 'uniswap', '0xAbC'),
    C.poolKey('eip155:8453', 'uniswap', '0xAbC')
  );
  assert.throws(() => C.assetKey('', 'x'), /required/);
});
