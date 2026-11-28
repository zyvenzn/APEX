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
npm run test:api:browser
```

The migration runner is explicit; it does not mutate a database during application startup. It verifies `EXPECTED_DATABASE_NAME` and `EXPECTED_DATABASE_USER` against PostgreSQL before applying DDL, then takes a session-level advisory lock on the dedicated migration connection. The integration smoke tests expect PostgreSQL to be running.

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

- `GET /v1/spot/markets` — simulator market list, pool reserve balances from the ledger, and accrued fee totals.
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


## Database safety and deployment identity

APEX fails closed unless PostgreSQL contains an operator-provisioned `apex_database_identity` marker matching all configured values. The marker is deliberately **not** created by application startup or by application migrations. It provides an independent environment/instance check in addition to `current_database()` and `current_user`; hostname matching alone is not treated as isolation.

Required backend and migration environment variables:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Runtime mode; use `production` on Render |
| `DEPLOYMENT_ENVIRONMENT` | Exact marker environment: `staging` or `production` |
| `DATABASE_URL` | Connection URL for the isolated database |
| `EXPECTED_DATABASE_NAME` | Exact result of `current_database()` |
| `EXPECTED_DATABASE_USER` | Exact result of `current_user` |
| `EXPECTED_DATABASE_INSTANCE_ID` | Unique UUID assigned to this specific database instance |
| `APP_ORIGIN` | Exact frontend origin, no wildcard or trailing path |
| `COOKIE_SECURE` | Must be `true` when `NODE_ENV=production` |
| `SESSION_TTL_HOURS` | Session lifetime, 1–720 hours |
| `HOST`, `PORT` | Render binds `0.0.0.0` and supplies the port |

### Provision the identity marker

Create a **separate PostgreSQL instance for staging**, with a database name and login role that are not used by production. Use the database owner/admin connection to provision the marker before running migrations. Generate a new random UUID for each database instance; store the same UUID in Render's `EXPECTED_DATABASE_INSTANCE_ID`. Do not reuse this UUID in production or another environment.

Example SQL (replace the environment, UUID, database name, and role with the actual staging values):

```sql
CREATE TABLE apex_database_identity (
  singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  environment_name text NOT NULL CHECK (environment_name IN ('development','test','staging','production')),
  instance_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO apex_database_identity (singleton, environment_name, instance_id)
VALUES (TRUE, 'staging', 'b7e2b47a-a4d8-4d86-8e4a-a2a98e3e81c1');
GRANT SELECT ON apex_database_identity TO apex_staging_user;
```

The marker is not a cryptographic proof that a remote PostgreSQL cluster is physically separate. The actual safety boundary remains a separately provisioned staging database/service, unique database and role, unique credentials, restricted access, and an instance UUID that is not copied from production. Never configure staging with production's `DATABASE_URL`, username, password, or marker UUID. A hostname or Render internal URL by itself is insufficient proof of isolation.

For local Docker development, `docker-compose.yml` mounts `docker/postgres-init/001-database-identity.sql` into the PostgreSQL initialization directory. The development marker uses the UUID in `server/.env.example`. If the Docker volume already existed before this file was added, remove only that disposable local development volume or provision the marker manually; do not run volume deletion commands against any shared database.

### Migration execution and readiness

Migrations remain an explicit one-shot operation; backend startup never runs DDL.

1. Provision the dedicated PostgreSQL staging instance and identity marker.
2. Set all required environment variables on the migration command/service.
3. Run `npm ci --include=dev` and `npm run build:api`.
4. Run `npm run migrate` exactly once as a controlled pre-deployment step. The advisory lock serializes concurrent executors; the default lock wait is 30 seconds and timeout exits with `APEX_MIGRATION_LOCK_TIMEOUT`.
5. Deploy/start the API only after migration exits successfully.
6. Verify `GET /v1/health/live` returns 200 and `GET /v1/health/ready` returns 200. Readiness checks PostgreSQL and every migration file currently required by the application. Missing migration table/version returns 503.
7. Deploy the static frontend and verify the browser can authenticate and call the API.

The advisory lock key remains `(1095781720, 1)` (namespace `0x41504558`, ASCII APEX). The lock is acquired with `pg_try_advisory_lock` on a dedicated connection and held across the migration transaction. Failure rolls back; unlock is attempted on the same session. If the session disconnects, PostgreSQL releases its session lock.

### Render deployment contract (manual configuration only)

No Render resource is created or modified by this repository change. Configure the following resources manually, using the staging-only database credentials and identity marker above.

**1. Render PostgreSQL**

- Create a new PostgreSQL instance specifically for staging; do not attach or reuse production.
- Create/use a dedicated staging database and login role.
- Provision `apex_database_identity` as described above.
- Use its **internal** connection URL for the API service.
- Keep the database and API in the same Render region where possible.
- Keep backups/exports separate from Git; treat a free instance as disposable.

**2. Render Web Service — backend API**

| Setting | Value |
| --- | --- |
| Root Directory | `.` |
| Runtime | Node |
| Build Command | `npm ci --include=dev && npm run build:api` |
| Start Command | `npm run start:api` |
| Health Check Path | `/v1/health/ready` |
| Instance count | 1 for current process-local rate limiter |

Set the environment variables listed above. In particular, set `NODE_ENV=production`, `DEPLOYMENT_ENVIRONMENT=staging`, `COOKIE_SECURE=true`, `HOST=0.0.0.0`, `DATABASE_URL` to the staging internal URL, and the exact expected database name, role, and unique marker UUID. Set `APP_ORIGIN` to the deployed frontend origin (for example `https://apex-staging.onrender.com`), not a wildcard. Render supplies `PORT`; the service binds to it.

**3. Render Static Site — frontend**

| Setting | Value |
| --- | --- |
| Root Directory | `.` |
| Build Command | `npm ci --include=dev && npm run build` |
| Publish Directory | `public` |

After publishing, configure the API origin in **Backend Spot → Configure API** using the backend HTTPS origin. The frontend uses credentialed fetch requests. Production cookies are `HttpOnly; Secure; SameSite=None`; browsers may still block third-party cookies. A same-site custom domain or same-origin reverse proxy is more reliable where browser privacy restrictions apply.

### Security and operational boundaries

- Never copy production credentials, connection URLs, or database identity UUIDs into staging.
- Do not put secrets in Git, README examples, build arguments, frontend code, or logs.
- The app identity marker is checked before the backend binds its HTTP listener and before migration lock acquisition.
- Liveness is process-only. Readiness checks database connectivity plus the complete required migration set.
- CI provisions its own temporary PostgreSQL marker and never connects to Render.
- Fastify rate limits are process-local; keep staging to one API instance until a shared limiter is implemented.
- Cookie/CORS/CSRF tests use Fastify injection. They verify emitted headers and policy decisions, not real browser cookie acceptance over a deployed HTTPS domain. A real staging HTTPS browser smoke test remains mandatory after deployment.
