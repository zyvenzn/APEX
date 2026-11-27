# Apex Trading Hub

APEX is a browser-based social trading simulator prototype. Prices, traders, balances and trades are simulated demo data; no real funds or blockchain transactions are involved.

## Run locally

The repository keeps readable source files under `src/`. To generate the self-contained static page:

```sh
npm ci
npm run build
```

Then open `index.html` in a browser or serve the repository folder with any static file server. The build step inlines the maintained CSS and JavaScript modules into `index.html`; it is safe to run repeatedly.

## Develop

- Edit application logic in `src/app.js`.
- Edit styles in `src/style.css`.
- Edit market modules under `src/`.
- Run `npm run build` after source changes to refresh the standalone `index.html`.

## Tests

Node.js 22 or newer is recommended.

```sh
npm install
npm test
npx playwright install chromium
npm run build
npm run test:e2e
```

The unit suite uses Node's built-in test runner. Browser E2E tests use the pinned Playwright development dependency and Chromium. In CI, Chromium is installed with its system dependencies.

## Simulation rules

These are simplified and do not reproduce any real exchange.

| Item | Rule |
| --- | --- |
| Spot fee | 0.5% per trade |
| Spot price impact | Constant-product pool, depth = max(5% of starting market cap, $2,000) x sqrt(price / starting price) |
| Slippage limit | Quick Trades setting (auto = 15%); trades above it are rejected |
| Perps fee | 0.05% of position size on open and close; no price impact |
| Maintenance margin | 1 / (2 x market max leverage); margin is lost on liquidation |
| TP / SL | Checked every 1.5 s while the page is open, filled at the current price |

Not simulated: funding, cross margin, mark price, TWAP.

## Backend foundation (Phase 01)

The API is a separate Node.js + TypeScript service. The existing browser simulator remains a static frontend; the backend Spot and Ledger panel uses PostgreSQL as its source of truth.

### Local services

```sh
cp server/.env.example .env
docker compose up -d postgres
npm install
npm run migrate
npm run dev:api
```

The API listens on `http://localhost:3001` by default.

### API surface

- `GET /v1/health/live` — process liveness.
- `GET /v1/health/ready` — PostgreSQL readiness.
- `POST /v1/auth/register` — create an account and session.
- `POST /v1/auth/login` — authenticate and issue an opaque session cookie.
- `GET /v1/auth/me` — return the current authenticated identity.
- `POST /v1/auth/logout` — revoke the current session.
- `GET /v1/ws` — authenticated WebSocket connection (connection/ping-pong foundation only).

Passwords are hashed with Node.js scrypt. Session tokens are random opaque values; only SHA-256 token hashes are stored in PostgreSQL. Cookies are HttpOnly and SameSite=Lax. Production requires `COOKIE_SECURE=true` and HTTPS.

### Backend checks

```sh
npm run build:api
npm run test:api
npm run migrate
npm run test:api:integration
```

The migration runner is explicit; it does not mutate a database during application startup. Use a dedicated database and review migrations before applying them. The integration smoke test expects the PostgreSQL service from Docker Compose to be running.

### Current Phase 01 boundary

This foundation does not yet connect the frontend to server identity, persist simulator balances, execute simulated trades, publish market events, or integrate external chains. Redis is not required by the current backend and is intentionally omitted. Fastify rate limits are process-local; keep staging to one API instance. A distributed limiter must be introduced before horizontally scaling a public production API. No real deposits, wallet signing, blockchain transactions, or real-money actions are implemented.

## Simulation ledger (Phase 02)

The ledger is a backend-authoritative, append-only double-entry journal for **virtual APEX credits only**. It is separate from external DEX/chain market data and from the existing browser-local simulator state.

- Monetary values are integer minor units (`BIGINT`); 100 minor units = 1.00 APEX_CREDIT. API balances are returned as integer strings to avoid JavaScript floating-point accounting.
- Every journal must contain entries that sum to zero in exactly one asset. PostgreSQL deferred constraints verify this at commit.
- Journal, entry, event, and account records reject UPDATE/DELETE. Corrections must be represented by a new compensating journal, never by rewriting history.
- Each journal has a per-user idempotency key and request hash. Repeating the same request returns the original journal; reusing a key with different request data is rejected.
- Account rows are locked in stable ID order inside a database transaction before posting, preventing concurrent balance mutations from racing.
- Ledger events carry an ordered event sequence and journal reference for deterministic replay/audit. Replay is reconstructed from the event and journal history, not from a mutable balance snapshot.
- The starter-credit endpoint grants 10,000.00 virtual credits once per account. It is a simulator allowance, not a crypto deposit, withdrawal, or blockchain transaction.

### Ledger API

All endpoints below require the authenticated `apex_session` cookie:

- `GET /v1/ledger/balance` — authoritative virtual-credit balance (`balanceMinor` string).
- `GET /v1/ledger/journals?limit=50&offset=0` — paginated journal and posting history.
- `GET /v1/ledger/events?after=0&limit=100` — ordered event stream for replay/audit, using a monotonic sequence cursor.
- `POST /v1/ledger/starter-credit` — one-time 10,000.00 virtual-credit grant. Requires an `Idempotency-Key` header (8–128 characters).

Example response amounts are integer minor-unit strings, never floating-point numbers. The Phase 02 ledger endpoints were initially separate; the later Phase 03 backend panel now reads this ledger. Legacy simulator localStorage state remains separate and is not authoritative for the backend ledger.

### Phase 02 validation

CI applies all versioned SQL migrations, then runs the PostgreSQL integration test. The ledger integration checks concurrent duplicate requests, idempotency, one-time claim enforcement, balance/history, balanced postings, and append-only protections.


## Spot market engine (Phase 03)

The backend spot engine is a deterministic virtual constant-product pool. It is separate from external DEX discovery data: no spot execution writes to a chain, external DEX, wallet, or real liquidity source.

- The seeded `apex-demo` / `DEMO` pool is explicitly a simulator market. Base quantities use 9 decimal places; quote credits use 2 decimal places.
- Pool reserves, fees, and execution amounts use integer `BIGINT` / `BigInt` arithmetic. The quote endpoint is indicative; execution recalculates under a PostgreSQL row lock.
- Buy debits virtual quote credits and credits virtual base units. Sell debits virtual base units and credits virtual quote credits.
- Each trade writes two independently balanced single-asset ledger journals in one database transaction, plus an immutable trade record and replay event.
- Per-market row locks serialize reserve changes. User ledger accounts are locked in stable ID order. Insufficient balances, invalid amounts, paused markets, and slippage breaches reject without committing any state.
- Trade requests require an `Idempotency-Key` (8–120 characters). Same-key/same-request replays the original result; same-key/different-request returns a conflict.
- Slippage is an all-in execution-price deviation (including the pool fee) and is capped at 5,000 bps.

### Spot API

- `GET /v1/spot/markets` — simulator market list and reserve metadata.
- `POST /v1/spot/quote` — indicative quote; body: `{ "marketId": "apex-demo", "side": "BUY", "amountMinor": "10000", "maxSlippageBps": 1500 }`.
- `POST /v1/spot/trades` — authenticated execution; same body plus `Idempotency-Key` header.

`amountMinor` means quote minor units for BUY and base minor units for SELL. API quantities and balances are integer strings. The Phase 03 frontend integration adds a dedicated backend Spot panel and ledger-backed trade history; prototype markets remain local-only.


## Phase 03 frontend integration (backend Spot + Ledger)

The frontend now contains a dedicated backend Spot panel for the seeded `apex-demo` / `DEMO` market. It does not route the prototype's unrelated local market cards into this single backend market.

### Connect the frontend

1. Deploy the Fastify API and its PostgreSQL dependency separately.
2. Set the API's `APP_ORIGIN` to the exact deployed frontend origin (no wildcard) and set `COOKIE_SECURE=true` in production.
3. Configure the API origin from the frontend's **Backend Spot → Configure API** panel, for example `https://your-api.example.com`.
4. Create an APEX backend account or sign in. Browser requests use credentialed cookies.
5. Claim the one-time 10,000.00 virtual starter credit, then trade the `DEMO` market.

The UI calls `GET /v1/spot/markets`, `POST /v1/spot/quote`, `POST /v1/spot/trades`, `GET /v1/ledger/balance`, and paginated `GET /v1/ledger/events`. A pending order retains the same `Idempotency-Key` across network retries for the identical order payload. Portfolio balances and trade history are rendered from ledger data; the legacy prototype portfolio remains explicitly labelled as local demo data.

For production cross-origin cookies, the API sets `SameSite=None; Secure`. Some browsers or privacy settings block third-party cookies regardless; a same-site custom domain or same-origin reverse proxy is the most reliable deployment arrangement. The API is not deployed by this code change, so configure a reachable API origin before expecting live backend trading. The Backend Ledger Portfolio is server-backed PostgreSQL data; legacy simulator positions remain localStorage-only demo data and are not combined.
 
### Staging safety and export
Treat a free Render PostgreSQL instance as disposable test infrastructure, not durable storage. Before its expiry or any reset, export it from a trusted machine with PostgreSQL client tools:

```sh
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file="apex-staging-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Restore into a separate target database only after checking the destination:

```sh
pg_restore --dbname "$TARGET_DATABASE_URL" --clean --if-exists --no-owner --no-acl --single-transaction apex-staging-backup.dump
```

Do not place database URLs or dumps in Git. Keep the staging API to one instance: current Fastify rate limits use process memory and are not shared across replicas. Redis is intentionally absent because no current application path needs it; introduce a shared limiter only before scaling beyond one instance.

The audit branch includes a lockfile-refresh workflow. It regenerates `package-lock.json` from the pinned manifest, then verifies `npm ci` and runs the full validation suite.


All orders remain simulated. No wallet signing, real deposits, blockchain transactions, or external DEX writes are performed. The frontend refreshes market snapshots by HTTP polling; the existing WebSocket endpoint does not yet publish market broadcasts.
