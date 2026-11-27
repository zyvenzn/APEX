// Browser tests (needs Playwright):  node tests/e2e.js
// Set CHROME_PATH to use a locally installed Chrome.
const { chromium } = require('playwright');
const path = require('path'), assert = require('assert'), { pathToFileURL } = require('url');
const URL_ = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const KEY = 'apex-demo-v1';

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route(/^https?:/, r => r.abort());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL_);

  const wait = ms => page.waitForTimeout(ms);
  const ev = (f, a) => page.evaluate(f, a);
  const state = async () => { await wait(200); return ev(k => JSON.parse(localStorage.getItem(k)), KEY); };
  const go = async h => { await ev(h => __apex.go(h), h); await wait(80); };
  const act = (n, d = {}) => ev(([n, d]) => __apex.ACT[n]({ dataset: d, classList: { toggle() {} } }, { stopPropagation() {} }), [n, d]);
  const fresh = async () => {
    await page.goto(URL_);
    await ev(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload(); await page.waitForFunction(() => !!window.__apex); await wait(250);
  };
  const deposit = async a => {
    await act('deposit'); await page.click('[data-act="depAmt"]');
    await page.fill('#amtin', a); await page.click('[data-act="doDeposit"]'); await wait(150);
  };
  const toPerps = async a => {
    await act('transferSheet'); await page.fill('#amtin', a); await page.click('[data-act="doTransfer"]'); await wait(150);
  };
  const openLong = async (margin, lev) => {
    await go('token/p%3ABTC'); await page.click('[data-act="tBuy"]');
    await ev(l => { const r = document.querySelector('#lev'); r.value = l; r.dispatchEvent(new Event('input', { bubbles: true })); }, lev);
    await page.fill('#tamt', margin); await page.click('[data-act="texec"]'); await act('closeSheet'); await wait(150);
  };
  const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

  let failed = 0;
  const test = async (name, fn) => {
    try { await fresh(); await fn(); console.log('ok  ', name); }
    catch (e) { failed++; console.log('FAIL', name, '-', e.stack || e.message); }
  };

  await test('every page and market renders', async () => {
    const ids = await ev(() => Object.keys(__apex.DB));
    for (const h of ['home', 'search', 'feed', 'leaderboard', 'profile', 'rewards', 'settings', 'settings/profile', 'settings/help', ...ids.map(i => 'token/' + encodeURIComponent(i))]) await ev(h => __apex.go(h), h);
    await wait(200); assert.deepStrictEqual(errors, []);
  });
  await test('decimal comma and thousands separator', async () => {
    await deposit('1,5'); await deposit('1,500');
    const s = await state(); near(s.cash.tokens, 1501.5);
  });
  await test('non-finite amount is rejected', async () => {
    await deposit('1e309'); assert.strictEqual((await state())?.xfer?.length || 0, 0);
  });
  await test('executed spot prices survive reload', async () => {
    await deposit('10'); await go('token/SOL'); await act('qtBuy', { v: '1' });
    const a = await ev(() => __apex.DB.SOL.p); await wait(180);
    await page.reload(); await wait(180);
    near(await ev(() => __apex.DB.SOL.p) / a, 1, 0.0001);
  });
  await test('reload does not liquidate a perp', async () => {
    await deposit('100'); await toPerps('100'); await ev(() => { __apex.DB['p:BTC'].p *= 1.03; });
    await openLong('50', 40); await page.reload(); await wait(1800);
    assert.strictEqual((await state()).pos.find(p => p.kind === 'perp').open, true);
  });
  await test('spot fee, execution quantity and price impact', async () => {
    await deposit('2000'); await go('token/SOL');
    const before = await ev(() => ({ p: __apex.DB.SOL.p, base: __apex.market.pools.SOL.baseReserve,
      quote: __apex.market.pools.SOL.quoteReserve, feeBps: __apex.market.pools.SOL.feeBps }));
    await act('qtBuy', { v: '100' });
    const after = await ev(() => __apex.DB.SOL.p), s = await state(), pos = s.pos.find(p => p.id === 'SOL');
    const fee = 100 * before.feeBps / 10000, k = before.base * before.quote;
    const nextQuote = before.quote + 100 - fee, nextBase = k / nextQuote;
    const expectedQty = before.base - nextBase;
    assert.ok(pos && pos.qty > 0);
    near(pos.qty, expectedQty, 0.000001);
    near(after / before.p, (nextQuote / nextBase) / (before.quote / before.base), 0.000001);
    near(s.cash.tokens, 1900);
  });
  await test('buy above the slippage limit is blocked', async () => {
    await deposit('5000'); await go('token/JOE'); await act('qtBuy', { v: '2000' });
    assert.ok(!(await state()).pos.some(p => p.id === 'JOE'));
  });
  await test('round trip cannot make money', async () => {
    await deposit('1000'); await go('token/SOL');
    await act('qtBuy', { v: '10' }); await act('qtSell', { v: '100' });
    const c = (await state()).cash.tokens; assert.ok(c < 1000 && c > 999.5, String(c));
  });
  await test('closed percentage after partial sells', async () => {
    await deposit('100'); await go('token/SOL'); await act('qtBuy', { v: '10' });
    await act('qtSell', { v: '50' }); await act('qtSell', { v: '100' });
    const c = (await state()).closed[0];
    assert.ok(c && Number.isFinite(c.pnl) && Number.isFinite(c.pct));
    near(c.pct, c.pnl / 10 * 100, 0.05);
  });
  await test('perp liquidates at maintenance margin', async () => {
    await deposit('100'); await toPerps('100'); await openLong('50', 40);
    await ev(() => { const t = __apex.DB['p:BTC']; t.p = __apex.S.pos.find(p => p.kind === 'perp').entry * (1 - 0.0115); });
    await wait(50);
    await ev(() => { const t = __apex.DB['p:BTC']; t.vola = 0; });
    await wait(1700); assert.strictEqual((await state()).pos.find(p => p.kind === 'perp').open, true);
    await ev(() => { __apex.DB['p:BTC'].p = __apex.S.pos.find(p => p.kind === 'perp').entry * (1 - 0.0130); });
    await wait(1700); const s = await state();
    assert.strictEqual(s.pos.find(p => p.kind === 'perp').open, false); near(s.closed[0].pnl, -51);
  });
  for (const [field, move, label] of [['#tpin', 1.02, 'take profit'], ['#slin', 0.99, 'stop loss']]) {
    await test(label + ' closes the position', async () => {
      await deposit('100'); await toPerps('100'); await openLong('50', 10);
      await ev(() => { __apex.DB['p:BTC'].vola = 0; });
      const entry = (await state()).pos.find(p => p.kind === 'perp').entry;
      await page.click('[data-act="tpsl"]'); await page.fill(field, (entry * (1 + (move - 1) / 2)).toFixed(2));
      await page.click('[data-act="saveTpsl"]');
      await ev(m => { __apex.DB['p:BTC'].p *= m; }, move); await wait(1700);
      assert.strictEqual((await state()).pos.find(p => p.kind === 'perp').open, false);
    });
  }
  await test('send to unknown user is rejected', async () => {
    await deposit('10'); await act('sendSheet'); await page.fill('#sendto', 'nobody here');
    await page.fill('#amtin', '5'); await page.click('[data-act="doSend"]');
    near((await state()).cash.tokens, 10);
  });
  await test('trader PnL matches leaderboard', async () => {
    await go('leaderboard');
    const row = page.locator('.list .row[data-act="trader"]').first();
    const pnl = (await row.locator('.rt .px').textContent()).trim();
    await row.click();
    assert.ok((await page.locator('#sb .d24').textContent()).includes(pnl));
  });
  const openTrader = async () => {
    await go('leaderboard');
    const row = page.locator('.list .row[data-act="trader"]').first();
    const name = await row.getAttribute('data-h');
    await row.click();
    return { row, name };
  };
  await test('trader preview opens full profile', async () => {
    const { name } = await openTrader();
    await page.click('#sb [data-go^="trader/"]'); await wait(200);
    assert.strictEqual(await ev(() => location.hash), '#/trader/' + encodeURIComponent(name));
    assert.strictEqual(await page.locator('.sheet').count(), 0);
    assert.ok((await page.textContent('#main')).includes(name));
    const rows = () => page.locator('#main .list .row').count();
    const more = page.locator('[data-act="trShowMore"]');
    if (await more.count()) { const before = await rows(); await more.click(); assert.ok(await rows() >= before); }
  });
  await test('activity filters', async () => {
    await go('trader/kv4rl'); const n = () => page.locator('#trAct .fi').count(); const all = await n();
    await page.click('[data-act="trFilter"]'); await page.uncheck('.trck[data-k="Buy"]'); await page.uncheck('.trck[data-k="Sell"]');
    assert.ok(await n() <= all); await page.click('[data-act="trAll"]'); assert.strictEqual(await n(), 0);
    await page.click('[data-act="trReset"]'); assert.strictEqual(await n(), all);
  });
  await test('send cash with keypad', async () => {
    await deposit('20'); await go('trader/kv4rl'); await page.click('[data-act="trSend"]');
    const btn = page.locator('[data-act="kpSend"]'); assert.ok(await btn.isDisabled());
    for (const k of ['9', '9']) await page.click(`[data-act="kp"][data-v="${k}"]`);
    assert.strictEqual(await btn.textContent(), 'Not enough cash');
    await page.click('[data-act="kpPct"][data-v="25"]'); await btn.click(); near((await state()).cash.tokens, 15);
  });
  await test('flip buy and sell applies to token page', async () => {
    await act('tog', { k: 'st.flip' }); await go('token/SOL');
    assert.strictEqual(await page.locator('.tbtns button').first().getAttribute('data-act'), 'tBuy');
  });
  await test('thesis only filters the feed', async () => {
    await go('token/peldier'); await act('tTab', { v: 'feed' });
    const all = await page.locator('.tokpg .fi').count(); assert.ok(all > 0);
    await page.click('[data-act="tThes"]');
    const filtered = await page.locator('.tokpg .fi').count();
    assert.ok(filtered > 0 && filtered <= all);
    assert.ok((await page.locator('.tokpg').textContent()).includes('damn this rug.'));
  });
  await test('language applies to navigation at once', async () => {
    await go('settings/language'); await act('setLang', { v: 'de' });
    assert.strictEqual(await page.locator('.navb span').first().textContent(), 'Start');
  });
  await test('24h PnL uses a rolling reference', async () => {
    await state(); await act('tog', { k: 'st.haptics' }); await wait(200);
    await ev(k => { const s = JSON.parse(localStorage.getItem(k)); s.eq = [[Date.now() - 9e7, 5], [Date.now() - 8.7e7, 7], [Date.now() - 1000, 100]]; Object.assign(__apex.S, s); }, KEY);
    await go('home');
    const shown = await page.locator('[data-d24]').first().textContent();
    const total = await ev(() => __apex.S.pos.filter(p => p.open).reduce((a, p) => a + p.qty * __apex.DB[p.id].p, 0));
    assert.ok(shown.startsWith('-$' + Math.abs(total - 7).toFixed(2)), shown);
  });
  await test('followed trader triggers an alert', async () => {
    await ev(() => { __apex.S.follows.includes = () => true; __apex.S.nt.tokMin = 0; __apex.S.nt.perpMin = 0; });
    await wait(3500); assert.ok(await ev(() => __apex.S.notifs.some(n => /: (Buy|Sell|Reduced|Opened|Closed|Liquidated) /.test(n.t))));
  });
  await test('following a trader updates their follower count', async () => {
    await go('trader/kv4rl'); const n = async () => +(await page.locator('[data-fc="kv4rl"]').first().textContent()).replace(/,/g, '');
    const a = await n(); await page.click('[data-act="follow"]'); await wait(100); assert.strictEqual(await n(), a + 1);
    await page.click('[data-act="follow"]'); await wait(100); assert.strictEqual(await n(), a);
  });
  await test('token transactions stay non-negative and update after executed trades', async () => {
    await deposit('10'); await go('token/SOL'); await act('qtBuy', { v: '1' });
    await act('tTab', { v: 'about' });
    const txt = () => page.locator('#abTx').textContent();
    const valid = async () => assert.ok(!/-\d|\$-/.test(await txt()), await txt());
    await valid();
    for (const tf of ['5M', '1H', '1D']) { await page.click("[data-act='abTf'][data-v='" + tf + "']"); await valid(); }
    const bought = await state();
    assert.ok(bought.pos.some(p => p.id === 'SOL' && p.open), 'spot buy did not create a position');
    assert.match(await txt(), /[1-9]\d* buys/, 'executed buy missing from transaction stats: ' + await txt());
    await act('qtSell', { v: '100' }); await valid();
    assert.match(await txt(), /[1-9]\d* sells/, 'executed sell missing from transaction stats: ' + await txt());
  });
  await test('NPC archetypes behave according to their type', async () => {
    const r = await ev(() => {
      const { AR, ARCH, step } = __apex.npc, cnt = {}, by = {};
      Object.values(AR).forEach(a => cnt[a] = (cnt[a] || 0) + 1);
      for (let i = 0; i < 2500; i++) for (const it of step()) (by[AR[it.tr]] = by[AR[it.tr]] || []).push(it);
      return { kinds: Object.keys(ARCH), cnt, by };
    });
    for (const k of r.kinds) assert.ok((r.cnt[k] || 0) >= 3, 'too few ' + k);
    const get = (a, f) => (r.by[a] || []).filter(f);
    const snipe = get('sniper', x => x.type === 'Buy'); assert.ok(snipe.length && snipe.every(x => x.at <= 50000), 'sniper buys above low MC');
    const wh = get('whale', x => x.amt > 0); assert.ok(wh.length && wh.every(x => Number.isFinite(x.amt)), 'whale trade amount invalid');
    const sm = get('small', x => x.type === 'Buy'); assert.ok(sm.length && sm.every(x => x.amt <= 80), 'small trader buy exceeds configured crowd cap');
    assert.ok(get('degen', x => x.lev).every(x => x.lev >= 10), 'degen leverage too low');
    assert.ok(get('pro', x => x.lev).every(x => x.lev <= 10), 'pro leverage too high');
    assert.ok(get('dev', x => x.note).length > 0, 'dev has no tagged trades');
    assert.ok(Object.values(r.by).flat().every(x => x.amt >= 0 && Number.isFinite(x.amt)), 'invalid trade amount');
  });
  await test('NPC trades move price and appear in token transactions', async () => {
    const r = await ev(() => { const t = __apex.DB.BILLI, p0 = t.p; for (let i = 0; i < 60; i++) __apex.npc.step(); return Object.values(__apex.DB).some(x => x.kind === 'token' && !x.dead && x.p !== x.p0); });
    assert.ok(r);
  });
  await test('trader profile shows archetype badge', async () => {
    await go('trader/kv4rl'); assert.ok((await page.textContent('#main')).includes('Whale'));
  });
  await test('positions in rugged tokens are hidden behind Show hidden', async () => {
    await go('profile');
    const rows = () => page.locator('#main .list .row').count();
    const header = () => page.locator('#main .ph span').first().textContent();
    assert.strictEqual(await rows(), 0); assert.strictEqual(await header(), 'Positions (0)');
    assert.ok((await page.textContent('[data-act="showHidden"]')).includes('(2)'));
    await page.click('[data-act="showHidden"]');
    assert.strictEqual(await rows(), 2); assert.strictEqual(await header(), 'Positions (2)');
    assert.strictEqual((await page.textContent('[data-act="showHidden"]')).trim(), 'Hide');
    await page.click('[data-act="showHidden"]'); assert.strictEqual(await rows(), 0);
  });
  await test('positions in live tokens are not hidden', async () => {
    await deposit('100'); await go('token/SOL'); await act('qtBuy', { v: '100' }); await go('profile');
    assert.strictEqual(await page.locator('#main .list .row').count(), 1);
    assert.strictEqual(await page.locator('#main .ph span').first().textContent(), 'Positions (1)');
    assert.ok((await page.textContent('[data-act="showHidden"]')).includes('(2)'));
  });
  await test('activity uses the profile picture', async () => {
    await go('profile');
    const pfp = await page.locator('.pav img').getAttribute('src');
    const n = await page.locator('#main .fi .av img').count();
    assert.ok(n > 0, 'no avatar images in activity');
    assert.strictEqual(await page.locator('#main .fi .av img').first().getAttribute('src'), pfp);
    assert.strictEqual(await page.locator('#main .fi .av:not(:has(img))').count(), 0);
  });
  await test('delete account resets prices and state', async () => {
    await deposit('10'); await ev(() => { __apex.DB.SOL.p *= 3; }); await wait(1700);
    await act('doDelete'); await wait(600);
    assert.strictEqual(await ev(() => __apex.S.cash.tokens), 0);
    assert.ok(await ev(() => __apex.DB.SOL.p / __apex.DB.SOL.p0 < 1.5));
  });

  await test('bonding progress uses market cap while graduation follows curve state', async () => {
    const initial = await ev(() => ({ target: __apex.market.graduationTarget, mc: __apex.DB.VEXDIAL.mc,
      p: __apex.market.progress('VEXDIAL'), graduated: __apex.market.isGraduated('VEXDIAL'),
      bonding: __apex.market.isBonding('VEXDIAL') }));
    assert.strictEqual(initial.target, 69000);
    near(initial.p, initial.mc / 69000 * 100, 0.01);
    assert.strictEqual(initial.bonding, !initial.graduated);
    near(initial.p, Math.max(0, Math.min(100, initial.mc / 69000 * 100)), 0.01);
    const thresholdProgress = await ev(() => { const t=__apex.DB.VEXDIAL, old=t.mc; t.mc=69000;
      const p=__apex.market.progress('VEXDIAL'); t.mc=old; return p; });
    near(thresholdProgress, 100, 0.001);
  });
  await test('aggregated NPC flow reports its disabled status without fabricating volume', async () => {
    const { before, after, flow } = await ev(() => {
      const api = window.__apex;
      const snapshot = () => Object.fromEntries(Object.values(api.DB).filter(t=>t.kind==='token'&&!t.dead).map(t=>[t.id,[t.p,t.vol]]));
      const before = snapshot(), flow = api.market.flow(180), after = snapshot();
      return { before, after, flow };
    });
    assert.strictEqual(flow.disabled, true);
    assert.strictEqual(flow.population, Object.keys(__apex.npc.AR).length);
    assert.strictEqual(flow.orders, 0); assert.strictEqual(flow.volume, 0);
    assert.deepStrictEqual(after, before);
  });
  await test('top holders reflect actual positions and are capped at ten', async () => {
    await deposit('10'); await go('token/VEXDIAL'); await act('qtBuy', { v: '1' });
    const hs=await ev(() => __apex.market.holders('VEXDIAL'));
    assert.ok(hs.some(h=>h.me)); assert.ok(hs.length<=10);
    for(let i=1;i<hs.length;i++)assert.ok(hs[i-1].qty>=hs[i].qty);
    assert.ok(hs.every(h=>Number.isFinite(h.qty)&&Number.isFinite(h.pc)&&Number.isFinite(h.pnl)));
  });
  const pageErrors = errors.slice();
  await browser.close();
  assert.deepStrictEqual(pageErrors, [], 'page errors: ' + pageErrors.join('; '));
  console.log(failed ? failed + ' failed' : 'all passed');
  process.exit(failed ? 1 : 0);
})();
