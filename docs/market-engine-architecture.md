# APEX Hybrid Market Engine Architecture

Status: Adopted architecture baseline
Branch: feat/market-engine-v2
Product direction: Fomo-style social trading experience with a hybrid token lifecycle.
Graduation target: USD 69,000 market capitalization (configurable constant).

## 1. Product model

APEX is a social crypto trading simulator. The product combines market discovery, spot trading, trader profiles, portfolio analytics, activity feeds, and leaderboards.

The product experience may resemble social trading applications, but the market lifecycle is explicitly hybrid:

- Newly launched APEX tokens start on a bonding curve.
- Bonding tokens graduate at the configured USD 69,000 market-cap target.
- Graduation migrates the token's remaining inventory and quote-asset reserves into a dedicated AMM pool.
- Graduated tokens trade against that AMM pool.
- Assets that are not launched through the APEX bonding launch flow may be listed directly against an AMM market; they do not need to be forced through bonding.

The UI categories (Bonding, Graduated, Trending, Gainers, Most Held, etc.) are market-discovery views, not separate pricing systems.

## 2. Token lifecycle and state machine

Canonical states:

1. `BONDING`: curve is active; buys and sells execute against the curve reserves.
2. `GRADUATING`: trading is briefly locked while the migration is validated and committed atomically.
3. `GRADUATED`: curve is permanently closed; all subsequent spot trades route to the token's AMM pool.
4. `PAUSED` / `DELISTED`: administrative safety states; no ordinary trade execution.

Graduation requirements:

- The token is in `BONDING`.
- Its market cap reaches or exceeds `GRADUATION_MC_USD = 69000`.
- The migration can be funded and validated from the curve's recorded reserves.
- The transition is idempotent: repeated checks cannot migrate twice or create duplicate pools.

The graduation target is an APEX simulation parameter, not a claim that all external launchpads use the same threshold. The market-cap calculation must use a documented circulating-supply convention and a consistent quote-asset/USD conversion.

## 3. Pricing engines

### Bonding curve

Use a constant-product curve with explicit reserves:

`baseReserve * quoteReserve = k`

For a buy, calculate quote input after fees, calculate base output from the invariant, enforce available inventory, then commit reserves and the trader ledger together.

For a sell, calculate base input, calculate quote output from the same invariant, enforce available quote reserves, then commit reserves and the ledger together.

The quote path must be pure (no state mutation). Execution reuses the quote result and commits once. Buy and sell calculations must be symmetric, subject to fees and rounding.

### Graduated AMM

Each graduated token receives one dedicated AMM pool. The pool maintains its own base and quote reserves and uses the same constant-product invariant for spot swaps.

Migration must:
- close the curve to new orders;
- validate the final curve reserves and migration allocation;
- seed the AMM with the defined remaining token inventory and quote assets;
- preserve the pre-migration marginal price as closely as the selected reserve ratio permits;
- record a migration event;
- mark the token graduated only after successful pool creation.

The migration allocation, fees, and reserve amounts must be explicit configuration, not hidden constants. Never count virtual reserves as withdrawable real assets.

## 4. Liquidity, price impact, and slippage

Keep these concepts separate:

- Virtual reserves: pricing parameters used by a curve, not spendable funds.
- Real reserves: actual simulated assets available to satisfy trades and migration.
- Volume: executed notional over a time window; volume is not liquidity.
- Market cap: price multiplied by the chosen circulating supply; it is not pool depth.

Price impact must be derived from the actual pre-trade and post-trade quote, not a separate linear estimate. Slippage protection compares the user's minimum acceptable output (or maximum acceptable input) against the execution quote.

Do not hide shallow liquidity by silently increasing slippage limits or fabricating volume. If the pool is shallow, show the impact and reject trades that exceed the user's slippage tolerance.

Large-order splitting may be offered as an explicit execution strategy, but each child order must execute against the same live pool state and incur normal fees and price impact.

## 5. One execution and accounting path

All participants use the same validated trade execution functions:

- Human player
- NPC trader
- Any future automated strategy

A successful trade must atomically update:
- pool or curve reserves;
- trader cash / quote balance;
- token quantity;
- average cost basis;
- realized PnL on sells;
- transaction history;
- token volume and price history;
- activity-feed event;
- holder ranking inputs.

A failed trade changes none of these values.

The ledger is the source of truth for balances and ownership. UI summaries, Top Holders, portfolio views, feed, and leaderboards are derived from ledger and execution records rather than independently fabricated values.

## 6. NPC simulation

NPCs are simulated traders, not decorative volume generators.

Each trader needs a stable identity and wallet/account record, starting capital, strategy profile, holdings, cost basis, realized PnL, and transaction history.

Strategies may include momentum, breakout, sniper, scalper, whale, swing, and long-term holder. Strategy decisions may be generated in batches or cohorts for performance, but each resulting fill must be attributed to a trader and pass through the same execution engine as a player trade.

Constraints:
- A trader cannot buy more than its available cash.
- A trader cannot sell more tokens than it owns.
- Buy/sell fills update the same reserves and ledger as player trades.
- NPC orders must not guarantee a price direction.
- Cohort aggregation is a compute optimization only; it must not bypass per-account accounting.
- The claimed virtual population is a simulation scale, not a count of individually running processes.

## 7. Top Holders, PnL, and social data

Top Holders displays the ten largest current token balances, ranked by actual ledger quantity. Percent-of-supply uses the same circulating-supply denominator used by market analytics. Exclude zero or negative balances and avoid double-counting a trader.

Trader PnL must distinguish:
- Unrealized PnL: current marked value minus remaining cost basis.
- Realized PnL: net proceeds from closed/reduced quantities minus their allocated cost basis.
- Total PnL: realized plus unrealized, with fees treated consistently.

The feed displays executed transactions only. Leaderboards are derived from the same accounting records and define their ranking window and fee treatment.

## 8. Market discovery

Market tabs are filters over canonical token records:

- Bonding: lifecycle state is `BONDING`.
- Graduated: lifecycle state is `GRADUATED`.
- Trending: documented recent activity / momentum ranking.
- Gainers: price change over a defined time window.
- Most Held: number of holders or aggregate ownership, with the exact metric named.
- Crypto / Perps: separate asset classes and execution paths.

A token must disappear from Bonding and appear in Graduated as part of the same committed lifecycle transition.

## 9. Persistence and recovery

Persist canonical account balances, token lifecycle state, pool/curve reserves, ledger positions, cost basis, realized PnL, and transaction identifiers.

On startup:
- validate persisted schema and numeric invariants;
- rebuild derived lists and rankings from canonical state;
- reconcile any interrupted graduation safely;
- reject or quarantine corrupt records instead of silently creating inconsistent balances.

For a production multi-user service, authoritative writes must move to a transactional backend/database. Browser localStorage is suitable only for a local demo and cannot provide shared global ownership or secure server-authoritative accounting.

## 10. Required tests

### Curve and AMM math
- Buy and sell preserve the constant-product invariant within rounding tolerance.
- Quotes are pure and deterministic for identical inputs.
- Buy output never exceeds available token inventory.
- Sell output never exceeds available quote reserves.
- Round-trip trading loses the documented fees and does not create money.
- Price impact is derived from the actual execution quote.

### Lifecycle
- Bonding token graduates at the configured $69,000 target.
- Below-target tokens remain bonding.
- Graduation is idempotent.
- Graduated tokens cannot trade against the old curve.
- Migration creates exactly one AMM pool and preserves the intended price/reserve relationship.
- Graduated tokens never reappear in Bonding after reload.

### Ledger and NPC
- Player and NPC trades use the same execution path.
- Insufficient cash and insufficient token balance are rejected without partial state mutation.
- Holder balances reconcile with all executed trades.
- Top Holders returns at most ten positive balances in descending order.
- Realized and unrealized PnL reconcile after partial and full sells.
- Feed and volume reflect executed fills only.

### Market behavior
- Both buy and sell activity can move price in either direction.
- Higher depth reduces price impact for the same notional trade.
- More volume does not automatically imply more liquidity.
- Large trades respect the user's slippage tolerance.

## 11. Implementation sequence

1. Introduce canonical token lifecycle and reserve models without changing UI.
2. Implement and unit-test pure bonding and AMM quote functions.
3. Route player trades through the shared execution and ledger path.
4. Implement atomic graduation and AMM migration.
5. Route NPC trades through the same engine with funded accounts and inventory.
6. Derive Top Holders, PnL, volume, feed, and leaderboard from canonical records.
7. Add persistence validation and reload/recovery tests.
8. Tune NPC frequency and market parameters only after accounting and math tests pass.

## 12. Non-goals and guardrails

- Do not use NPC volume as a substitute for liquidity.
- Do not use a linear market-cap percentage as a substitute for a reserve-based bonding curve.
- Do not create feed events for trades that did not execute.
- Do not allow a graduated token to continue trading on its bonding curve.
- Do not describe the simulator as a real blockchain or claim that virtual reserves are real funds.
- Do not merge to main until math, lifecycle, accounting, and browser tests pass.
