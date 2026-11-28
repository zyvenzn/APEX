import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

async function withPage(run: (page: import('playwright').Page, origin: string) => Promise<void>) {
  const html = readFileSync('index.html', 'utf8');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static test server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(origin + '/#/home');
    await page.locator('#main .page').waitFor();
    await page.locator('[data-apex-action="configure"]').first().click();
    await page.locator('#apex-api-url').fill('https://api-not-ready.example');
    await run(page, origin);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('frontend does not persist API configuration when readiness returns 503', async () => {
  await withPage(async page => {
    await page.route('https://api-not-ready.example/**', async route => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'degraded', checks: { postgres: 'ok', migrations: 'error' } })
      });
    });
    await page.locator('[data-apex-action="save-api"]').click();
    await page.waitForFunction(() => {
      const error = document.querySelector('#apex-api-error');
      return !!error && error.textContent.includes('Backend is not ready');
    });
    assert.equal(await page.evaluate(() => localStorage.getItem('apex-backend-api-base-v1')), null);
    assert.ok(await page.locator('#apex-backend-modal').count(), 'configuration modal must remain open');
  });
});

test('frontend does not persist API configuration when refreshAll fails after readiness', async () => {
  await withPage(async page => {
    await page.route('https://api-not-ready.example/v1/health/ready', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' })
    }));
    await page.route('https://api-not-ready.example/v1/spot/markets', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ markets: [] })
    }));
    await page.route('https://api-not-ready.example/v1/auth/me', route => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'INTERNAL_ERROR' })
    }));
    await page.locator('[data-apex-action="save-api"]').click();
    await page.waitForFunction(() => {
      const error = document.querySelector('#apex-api-error');
      return !!error && error.textContent.includes('application data could not be loaded');
    });
    assert.equal(await page.evaluate(() => localStorage.getItem('apex-backend-api-base-v1')), null);
    assert.ok(await page.locator('#apex-backend-modal').count(), 'configuration modal must remain open');
  });
});
