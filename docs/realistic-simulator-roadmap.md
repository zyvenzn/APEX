# Realistic Simulator Engine — Stage 1

APEX is a virtual-money trading simulator. No blockchain settlement, external wallet, or real-money deposit is implied.

## Stage 1: Spot AMM accounting core

- Constant-product pool with explicit base and quote reserves.
- Marginal spot price is derived only from reserve ratio.
- Buy/sell quotes are pure and do not mutate state.
- Execution validates balances and slippage before committing pool and account changes.
- Fees, executed notional, trade count, cost basis, and realized PnL are recorded.
- A failed trade leaves pool and account unchanged.

## Seed liquidity policy

Each simulated market must be initialized with an explicit `liquidityUsd` parameter. It must not be inferred from volume or silently derived from market capitalization. Seed values are simulation configuration, not claims about real exchange liquidity.

## Remaining stages

1. Integrate this core into player and NPC spot execution.
2. Replace cohort holders with individual NPC accounts and remove fabricated virtual-population counts.
3. Derive portfolio, holders, activity feed, charts, market cap, volume, and liquidity from the same executed-event ledger.
4. Implement bonding-curve lifecycle and graduation into a dedicated AMM pool with an idempotent migration.
5. Add persistent shared backend state and concurrency controls before claiming cross-device or multi-user shared markets.

## Verification

Run:

```sh
node --test tests/market-engine.test.js
```

The tests cover reserve invariants, pure quotes, atomic failures, balance checks, cost-basis allocation, and price-impact behavior.
