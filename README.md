# Apex Trading Hub

APEX is a browser-based social trading simulator prototype. Prices, traders, balances and trades are simulated demo data; no real funds or blockchain transactions are involved.

## Run locally

The repository keeps readable source files under `src/`. To generate the self-contained static page:

```sh
npm install
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

The API is a separate Node.js + TypeScript service. The existing browser simulator remains a static frontend; the backend does not yet execute trades or own balances/prices.

### Local services

```sh
cp server/.env.example .env
docker compose up -d postgres redis
npm install
npm run migrate
npm run dev:api
```

The API listens on `http://localhost:3001` by default.

### API surface

- `GET /v1/health/live` — process liveness.
- `GET /v1/health/ready` — PostgreSQL and Redis readiness.
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

The migration runner is explicit; it does not mutate a database during application startup. Use a dedicated database and review migrations before applying them. The integration smoke test expects the PostgreSQL and Redis services from Docker Compose to be running.

### Current Phase 01 boundary

This foundation does not yet connect the frontend to server identity, persist simulator balances, execute simulated trades, publish market events, or integrate external chains. Redis is currently used as a required readiness dependency and is reserved for later shared coordination/pub-sub. No real deposits, wallet signing, blockchain transactions, or real-money actions are implemented.

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

Example response amounts are integer minor-unit strings, never floating-point numbers. The existing frontend has not yet been migrated to use these endpoints; localStorage state remains separate and is not authoritative for this backend ledger.

### Phase 02 validation

CI applies all versioned SQL migrations, then runs the PostgreSQL + Redis integration test. The ledger integration checks concurrent duplicate requests, idempotency, one-time claim enforcement, balance/history, balanced postings, and append-only protections.
