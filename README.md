# Apex Trading Hub

Prototype web app (token and perps trading UI) with simulated markets.
Single static page: `index.html` is self-contained (CSS, JS and images inlined).
All prices, traders and balances are demo data. No real funds are involved.

## Run
Open `index.html` in a browser, or deploy the folder to any static host (Vercel, GitHub Pages).

## Develop
Edit `src/app.js` and `src/style.css`, then inline them into `index.html`:

    node build.js

## Test
Needs [Playwright](https://playwright.dev). Run after building:

    node tests/e2e.js
    CHROME_PATH=/usr/bin/google-chrome node tests/e2e.js   # use an installed Chrome

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
