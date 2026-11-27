import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createPool } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';

test('backend Spot UI survives refresh and replays a committed order after a dropped response', async () => {
  const frontendPort = 3310;
  const apiPort = 3311;
  const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(apiPort),
    APP_ORIGIN: frontendOrigin,
    COOKIE_SECURE: 'false'
  });
  const db = createPool(config);
  const app = await buildApp({ config, db });
  const html = readFileSync('index.html', 'utf8');
  const staticServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    await app.listen({ host: '127.0.0.1', port: apiPort });
    await new Promise<void>(resolve => staticServer.listen(frontendPort, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    const email = `browser-${randomUUID()}@example.test`;
    const password = 'browser-e2e-password-2026';

    await page.goto(frontendOrigin + '/#/home');
    await page.locator('#main .page').waitFor();
    await page.locator('[data-apex-action="configure"]').first().click();
    await page.locator('#apex-api-url').fill(apiOrigin);
    await page.locator('[data-apex-action="save-api"]').click();
    await page.locator('#apex-auth-email').waitFor();
    await page.locator('[data-apex-action="show-register"]').click();
    await page.locator('#apex-auth-name').fill('Browser Test');
    await page.locator('#apex-auth-email').fill(email);
    await page.locator('#apex-auth-password').fill(password);
    await page.locator('[data-apex-action="register"]').click();
    await page.locator('#apex-backend-modal').waitFor({ state: 'detached' });

    await page.goto(frontendOrigin + '/#/profile');
    await page.locator('#apex-ledger-portfolio').waitFor();
    await page.locator('[data-apex-action="claim"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-apex-action="claim"]'));

    await page.goto(frontendOrigin + '/#/home');
    await page.locator('[data-apex-action="buy"]').waitFor();
    const idempotencyKeys: string[] = [];
    let dropFirstResponse = true;
    await page.route(apiOrigin + '/v1/spot/trades', async route => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      idempotencyKeys.push(route.request().headers()['idempotency-key'] || '');
      const response = await route.fetch();
      if (dropFirstResponse) {
        dropFirstResponse = false;
        await route.abort('failed');
        return;
      }
      await route.fulfill({ response });
    });

    await page.locator('[data-apex-action="buy"]').click();
    await page.locator('#apex-trade-amount').fill('100');
    await page.locator('[data-apex-action="execute"]').click();
    await page.waitForFunction(() => {
      const error = document.querySelector('#apex-trade-error');
      return !!error && error.textContent.length > 0;
    });
    await page.locator('[data-apex-action="execute"]').click();
    await page.locator('#apex-backend-modal').waitFor({ state: 'detached' });
    assert.equal(idempotencyKeys.length, 2, 'the browser should send the order twice');
    assert.ok(idempotencyKeys[0], 'first request must include an idempotency key');
    assert.equal(idempotencyKeys[0], idempotencyKeys[1], 'retry must reuse the same idempotency key');

    const bought = await page.evaluate(async api => {
      const response = await fetch(api + '/v1/ledger/events?after=0&limit=100', { credentials: 'include' });
      const data = await response.json();
      return data.events.find((event: { eventType: string; payload: { side: string; amountOutMinor: string } }) =>
        event.eventType === 'spot_trade_executed' && event.payload.side === 'BUY'
      )?.payload.amountOutMinor as string | undefined;
    }, apiOrigin);
    assert.ok(bought, 'one committed BUY event should exist after the dropped response and retry');
    const sellMinor = (BigInt(bought) / 2n).toString();
    const sellInput = (Number(sellMinor) / 1_000_000_000).toFixed(9);

    await page.locator('[data-apex-action="sell"]').click();
    await page.locator('#apex-trade-amount').fill(sellInput);
    await page.locator('[data-apex-action="execute"]').click();
    await page.locator('#apex-backend-modal').waitFor({ state: 'detached' });
    await page.unroute(apiOrigin + '/v1/spot/trades');

    await page.goto(frontendOrigin + '/#/profile');
    const portfolio = page.locator('#apex-ledger-portfolio');
    await portfolio.waitFor();
    await page.waitForFunction(() => {
      const panel = document.querySelector('#apex-ledger-portfolio');
      return !!panel && panel.textContent.includes('BUY') && panel.textContent.includes('SELL');
    });
    const firstHistory = await portfolio.textContent();
    await page.reload();
    await page.locator('#apex-ledger-portfolio').waitFor();
    const refreshedHistory = await page.locator('#apex-ledger-portfolio').textContent();
    assert.ok(refreshedHistory?.includes('BUY') && refreshedHistory.includes('SELL'));
    assert.equal((refreshedHistory?.match(/BUY/g) || []).length, (firstHistory?.match(/BUY/g) || []).length);

    const logoutState = await page.evaluate(async api => {
      const logout = await fetch(api + '/v1/auth/logout', { method: 'POST', credentials: 'include' });
      const me = await fetch(api + '/v1/auth/me', { credentials: 'include' });
      return { logout: logout.status, me: me.status };
    }, apiOrigin);
    assert.deepEqual(logoutState, { logout: 204, me: 401 });

    await page.goto(frontendOrigin + '/#/home');
    await page.locator('[data-apex-action="buy"]').click();
    await page.locator('#apex-auth-email').fill(email);
    await page.locator('#apex-auth-password').fill(password);
    await page.locator('[data-apex-action="login"]').click();
    await page.locator('#apex-backend-modal').waitFor({ state: 'detached' });
    await page.goto(frontendOrigin + '/#/profile');
    await page.locator('#apex-ledger-portfolio').waitFor();
    const loggedInHistory = await page.locator('#apex-ledger-portfolio').textContent();
    assert.ok(loggedInHistory?.includes('BUY') && loggedInHistory.includes('SELL'));

    const dbTrades = await db.query(
      'SELECT COUNT(*)::text AS count FROM spot_trades WHERE user_id = (SELECT id FROM users WHERE email = $1)',
      [email]
    );
    assert.equal(dbTrades.rows[0].count, '2', 'one BUY and one SELL should be persisted; retry must not duplicate BUY');
  } finally {
    if (browser) await browser.close();
    await app.close();
    await new Promise<void>(resolve => staticServer.close(() => resolve()));
    await db.end();
  }
});
