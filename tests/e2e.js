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
    await page.goto(URL_); await ev(() => __apex.ACT.doDelete()); await wait(500);
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
    catch (e) { failed++; console.log('FAIL', name, '-', e.message.split('\n')[0]); }
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
  await test('prices survive reload', async () => {
    await ev(() => { __apex.DB.SOL.p *= 2; }); const a = await ev(() => __apex.DB.SOL.p);
    await page.reload(); near(await ev(() => __apex.DB.SOL.p) / a, 1);
  });
  await test('reload does not liquidate a perp', async () => {
    await deposit('100'); await toPerps('100'); await ev(() => { __apex.DB['p:BTC'].p *= 1.03; });
    await openLong('50', 40); await page.reload(); await wait(1800);
    assert.strictEqual((await state()).pos.find(p => p.kind === 'perp').open, true);
  });
  await test('spot fee and price impact', async () => {
    await deposit('2000'); await go('token/BASKET');
    const before = await ev(() => ({ p: __apex.DB.BASKET.p, d: Math.max(__apex.DB.BASKET.mc0 * 0.05, 2000) * Math.sqrt(__apex.DB.BASKET.p / __apex.DB.BASKET.p0) }));
    await ev(() => __apex.ACT.qtBuy({ dataset: { v: '1000' } }));
    const after = await ev(() => __apex.DB.BASKET.p), s = await state(), pos = s.pos.find(p => p.id === 'BASKET');
    const impact = 995 / before.d;
    near(pos.qty * before.p * (1 + impact), 995, 0.5);
    near(after / before.p, (1 + impact) ** 2, 0.004);
  });
  await test('buy above the slippage limit is blocked', async () => {
    await deposit('5000'); await go('token/JOE'); await act('qtBuy', { v: '2000' });
    assert.ok(!(await state()).pos.some(p => p.id === 'JOE'));
  });
  await test('round trip cannot make money', async () => {
    await deposit('1000'); await go('token/BASKET');
    await ev(() => { __apex.ACT.qtBuy({ dataset: { v: '1000' } }); __apex.ACT.qtSell({ dataset: { v: '100' } }); });
    const c = (await state()).cash.tokens; assert.ok(c < 1000 && c > 985, String(c));
  });
  await test('closed percentage after partial sells', async () => {
    await deposit('100'); await go('token/SOL'); await act('qtBuy', { v: '100' });
    await ev(() => { __apex.DB.SOL.p *= 2; }); await act('qtSell', { v: '50' });
    await ev(() => { __apex.DB.SOL.p *= 0.5; }); await act('qtSell', { v: '100' });
    const c = (await state()).closed[0]; near(c.pct, c.pnl, 0.05); assert.ok(c.pct > 40);
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
    await go('leaderboard'); await page.locator('.list .row').first().click();
    assert.ok((await page.textContent('#sb')).includes('398,738.66'));
  });
  const openTrader = async () => { await go('leaderboard'); await page.locator('.list .row').first().click(); };
  await test('trader preview opens full profile', async () => {
    await openTrader(); await page.click('#sb [data-go^="trader/"]'); await wait(200);
    assert.ok((await ev(() => location.hash)).startsWith('#/trader/kv4rl'));
    assert.strictEqual(await page.locator('#ov').count(), 0);
    const rows = () => page.locator('#main .list .row').count();
    assert.strictEqual(await rows(), 5); await page.click('[data-act="trShowMore"]'); assert.ok(await rows() > 5);
    await page.click('[data-act="trSeg"][data-v="closed"]'); assert.strictEqual(await rows(), 5);
    await page.click('[data-act="trRange"][data-v="7d"]'); assert.ok((await page.textContent('#main')).includes('7d'));
    await page.click('[data-act="trHist"]'); assert.strictEqual(await page.locator('#sb .rl').count(), 18);
  });
  await test('activity filters', async () => {
    await go('trader/kv4rl'); const n = () => page.locator('#trAct .fi').count(); const all = await n();
    await page.click('[data-act="trFilter"]'); await page.uncheck('.trck[data-k="Buy"]'); await page.uncheck('.trck[data-k="Sell"]');
    assert.strictEqual(await n(), 3); await page.click('[data-act="trReset"]'); assert.strictEqual(await n(), all);
    await page.click('[data-act="trAll"]'); assert.strictEqual(await n(), 0);
    await page.click('[data-act="trReset"]');
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
    await go('token/SOL'); await act('tTab', { v: 'feed' });
    const all = await page.locator('.tokpg .fi').count(); await page.click('[data-act="tThes"]');
    assert.ok(all > 0); assert.strictEqual(await page.locator('.tokpg .fi').count(), 0);
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
  await test('token transactions are never negative, change with time frame and move live', async () => {
    await go('token/VEXDIAL'); await act('tTab', { v: 'about' });
    assert.ok(!/-\d|\$-/.test(await page.locator('#abTx').textContent()));
    await go('token/SOL'); await act('tTab', { v: 'about' });
    const txt = () => page.locator('#abTx').textContent();
    const t1 = await txt(); assert.ok(!/-\d|\$-/.test(t1), t1);
    const nums = s => (s.match(/\d+/g) || []).join(',');
    await page.click('[data-act="abTf"][data-v="1D"]'); const d1 = await txt(); await page.click('[data-act="abTf"][data-v="5M"]'); const m5 = await txt();
    assert.notStrictEqual(nums(d1), nums(m5));
    await page.click('[data-act="abTf"][data-v="1D"]'); const a = await txt(); await wait(5000); assert.notStrictEqual(await txt(), a);
    await go('token/peldier'); await act('tTab', { v: 'about' }); assert.ok(/^0 buys0 sells/.test(await txt()));
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
    const snipeSell = get('sniper', x => x.type === 'Sell' || x.type === 'Reduced'); assert.ok(snipeSell.every(x => x.at >= 70000), 'sniper sold below 70K MC');
    const wh = get('whale', () => true); assert.ok(wh.length && wh.every(x => x.amt >= 15000), 'whale trade too small');
    const sm = get('small', x => x.type === 'Buy'); assert.ok(sm.length && sm.every(x => x.amt <= 60), 'small trader too big');
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

  await test('bonding progress is market-cap based and graduates at $69K', async () => {
    const initial = await ev(() => ({ target: __apex.market.graduationTarget, p: __apex.market.progress('VEXDIAL') }));
    assert.strictEqual(initial.target, 69000); assert.ok(initial.p > 0 && initial.p < 100);
    await ev(() => { const t=__apex.DB.VEXDIAL; t.p=t.p0*(69000/t.mc0); t.mc=69000; __apex.market.reconcile(); });
    assert.strictEqual(await ev(() => __apex.market.isBonding('VEXDIAL')), false);
    assert.strictEqual(await ev(() => __apex.market.isGraduated('VEXDIAL')), true);
    await ev(() => { __apex.DB.VEXDIAL.mc=12000; __apex.market.reconcile(); });
    assert.strictEqual(await ev(() => __apex.market.isGraduated('VEXDIAL')), true);
    await page.reload(); await wait(100);
    assert.strictEqual(await ev(() => __apex.market.isGraduated('VEXDIAL')), true);
  });
  await test('aggregated NPC flow changes prices and records volume', async () => {
    const before=await ev(() => Object.fromEntries(Object.values(__apex.DB).filter(t=>t.kind==='token'&&!t.dead).map(t=>[t.id,[t.p,t.vol]])));
    const flow=await ev(() => __apex.market.flow(180));
    const after=await ev(() => Object.fromEntries(Object.values(__apex.DB).filter(t=>t.kind==='token'&&!t.dead).map(t=>[t.id,[t.p,t.vol]])));
    const moved=Object.keys(before).some(id=>before[id][0]!==after[id][0]&&after[id][1]>before[id][1]);
    assert.strictEqual(flow.population,1000000); assert.ok(flow.orders>0&&flow.volume>0); assert.ok(moved);
  });
  await test('top holders come from the ledger and are capped at ten', async () => {
    await ev(() => __apex.market.flow(240));
    const hs=await ev(() => __apex.market.holders('VEXDIAL'));
    assert.ok(hs.length>0); assert.ok(hs.length<=10);
    for(let i=1;i<hs.length;i++)assert.ok(hs[i-1].qty>=hs[i].qty);
    assert.ok(hs.every(h=>Number.isFinite(h.qty)&&Number.isFinite(h.pc)&&Number.isFinite(h.pnl)));
  });
  assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join('; '));
  await browser.close();
  console.log(failed ? failed + ' failed' : 'all passed');
  process.exit(failed ? 1 : 0);
})();
