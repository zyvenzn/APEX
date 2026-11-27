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
