# APEX Product & Market Data Architecture

Status: Adopted product baseline
Branch: feat/multichain-simulation-architecture

## 1. Locked product decisions

- Product: APEX is a social trading game / realistic trading simulator.
- Trading mode: SIMULATION ONLY. Every order from a player or NPC uses virtual balances and the APEX simulation ledger. No order is broadcast, signed, routed, or settled on a blockchain.
- Market universe: MULTI-CHAIN. APEX reads and displays real token/pool market data from supported chains. Multi-chain means read-only discovery and analytics, not real trading.
- Trader identity: HYBRID. Every player has an APEX username/profile. A player may optionally link one or more external wallet addresses to prove control and view public on-chain activity. Wallet connection does not grant custody, signing, spending, or trade execution permissions.
- UI/product inspiration: Fomo-style social trading UX: discovery, trending/new pairs, token pages, charts, holders, trader profiles, activity feed, watchlists, portfolio and leaderboards. Do not copy proprietary assets or imply affiliation.

## 2. Non-negotiable separation

There are two independent data planes:

1. External Market Data Plane: actual DEX pools, prices, liquidity, volume, OHLCV, token metadata, on-chain holders and public wallet activity. Every datum must retain chain, source, pool/token address, observation time and provenance.
2. APEX Simulation Plane: virtual cash, virtual positions, virtual pool/reserves, player/NPC orders, fills, fees, slippage, PnL and game rankings.

Simulation trades MUST NOT:
- alter external DEX prices, reserves, volume, liquidity, transactions or holder counts;
- be sent to RPC, DEX routers, aggregators or wallets;
- be presented as on-chain transactions.

External DEX trades MUST NOT be counted as APEX simulation fills. Display external and simulated activity in separately labelled views.

## 3. Multi-chain support

Use a chain registry with canonical chain IDs and explicit capabilities. Initial adapter targets:
- Solana (mainnet-beta)
- Ethereum (1)
- Base (8453)
- BNB Smart Chain (56)
- Arbitrum One (42161)
- Polygon PoS (137)

The registry is a capability/configuration list, not proof that a live provider integration exists. Each chain needs a provider adapter, supported DEX/pool sources, rate limits, token/pool identity validation and health status before it can be marked live in UI.

Canonical asset identity is `chainId + tokenAddress`; canonical pool identity is `chainId + dexId + poolAddress`. Never merge same-symbol assets across chains.

## 4. Market data ingestion

Provider adapters normalize to a common schema:
- chainId, chainName
- tokenAddress, tokenSymbol, tokenName, decimals
- poolAddress, dexId, quoteTokenAddress
- priceUsd, marketCapUsd, fdvUsd
- liquidityUsd, volume24hUsd, priceChange24hPct
- observedAt, source, sourceUrl, dataQuality

Rules:
- Missing values remain null, never fabricated or derived from unrelated metrics.
- Market cap and FDV are distinct; label each accurately.
- Liquidity is pool liquidity, not market cap or volume.
- Token price must be tied to a specific pool/quote route and timestamp.
- Deduplicate pools by canonical pool identity.
- Stale or unavailable provider data must be visibly marked.
- Aggregate token-level views only with a documented pool-selection/aggregation policy.
- Rate limits, retries, caching, provider outages and provenance are handled server-side. Never expose provider API keys in browser code.

## 5. Simulation engine

The simulation engine is independent of the external market-data provider. It may use the external DEX price as a reference/oracle input, but virtual trades execute only against APEX-owned virtual reserves.

Each simulated market stores:
- externalReference: chain, token, pool, source, observedAt, priceUsd
- simulationPool: virtual base/quote reserves, fee, status, lastFillAt
- simulation ledger: account, order, fill, fee, balance and position changes

Recommended game pricing model:
- Maintain a reference price from the selected external pool.
- Maintain a separate simulation AMM/order-flow price.
- Display both clearly: "DEX reference" and "APEX simulated price".
- If a reference price moves, update the reference/oracle input; do not rewrite prior fills.
- NPCs have individual virtual accounts and execute through the same quote/execute path as players.
- NPC order flow should be deterministic/configurable enough for testing, budget-constrained, inventory-aware and rate-limited. Do not fabricate DEX volume or holders.
- No synthetic random walk as a substitute for executed simulated fills.

## 6. Hybrid identity

Player profile is the canonical social identity:
- immutable internal playerId
- unique username and displayName
- avatar, bio, createdAt
- followers/following and social activity
- simulation portfolio and simulation PnL

Wallet links are optional identity proofs:
- chainId, address, verification method, verifiedAt, status
- support multiple wallet links per player
- require a chain-appropriate signature challenge for ownership verification
- store public address and verification result only
- never request or store seed phrase/private key
- no transaction signing or spend permission in Simulation mode
- public on-chain wallet analytics are separate from simulated player positions
- do not infer that a linked wallet owns a simulated position

## 7. UX information architecture

Primary navigation:
- Home / Following
- Discover (Trending, New Pairs, Gainers, Volume)
- Markets (chain and DEX filters)
- Token Detail (Chart, Trades, Holders, About)
- Feed (player posts and simulated fills, clearly labelled)
- Leaderboard (simulation PnL; optional separate on-chain public-wallet analytics)
- Portfolio (virtual balance, positions, realized/unrealized PnL)
- Profile (username, linked wallet badges, posts, history)
- Settings (chain preferences, data freshness, privacy)

Every token detail page must show chain, token contract, selected pool/DEX, DEX reference price, data timestamp and liquidity/volume source. The trade panel must clearly state "SIMULATION — no real assets".

## 8. Persistence and backend boundaries

Browser localStorage is acceptable only for local prototype preferences/cache. It is not authoritative for multi-user balances, trades, leaderboard or social activity.

Production source of truth must be server-side with transactional writes:
- users / profiles / wallet_links
- chains / tokens / pools / market_snapshots
- simulation_accounts / simulation_positions
- simulation_orders / simulation_fills / ledger_entries
- follows / posts / reactions / watchlists
Use idempotency keys and atomic ledger updates. Market ingestion is read-only and cannot write simulation ledger entries.

## 9. Security, compliance and product truth

- Simulation-only means no wallet transaction signing or asset custody.
- Wallet linking uses message-signature verification only.
- Clearly disclose that game balances, fills, PnL and rankings are simulated.
- Never represent simulation fills as real swaps.
- Never represent provider estimates as verified on-chain holder counts.
- Add token-risk flags and data freshness indicators; avoid safety guarantees.
- Do not add real swap functionality without a new explicit product decision and a separate security/compliance review.

## 10. Delivery sequence

1. Establish chain registry and canonical multi-chain market schema.
2. Implement read-only provider adapters and ingestion backend for one chain at a time.
3. Build chain-aware Discover and Token Detail pages.
4. Connect reference price snapshots to the independent simulation engine.
5. Implement server-authoritative virtual ledger and persistent player profiles.
6. Add wallet linking as optional identity verification (no signing/spending).
7. Build social feed, following, leaderboard and portfolio on authoritative simulation events.
8. Add observability, freshness, provider failover, rate-limit and integrity tests.

## 11. Acceptance criteria

- A simulation buy/sell changes only APEX virtual balances, virtual reserves and simulation PnL.
- No simulation code path invokes wallet signing, RPC transaction send, router or swap aggregator.
- DEX data displays chain, token/pool address, source and timestamp.
- Same ticker on two chains remains two distinct assets.
- Missing or stale market data is not replaced by fabricated values.
- Wallet linking verifies ownership without exposing private keys or granting spend permissions.
- Feed and leaderboard clearly distinguish simulated fills from external on-chain activity.
- Multi-user simulation ledger is server-authoritative before public competitive launch.
