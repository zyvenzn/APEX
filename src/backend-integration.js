(() => {
  'use strict';
  const apex = window.__apex;
  if (!apex) return;

  const CONFIG_KEY = 'apex-backend-api-base-v1';
  let apiBase = (localStorage.getItem(CONFIG_KEY) || '').replace(/\/+$/, '');
  let market = null;
  let markets = [];
  let user = null;
  let creditMinor = '0';
  let assetBalances = {};
  let tradeEvents = [];
  let busy = false;

  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const endpoint = path => (apiBase || location.origin) + path;
  const money = value => '$' + Number(value || 0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const units = (minor, decimals) => Number(BigInt(minor || '0')) / Math.pow(10, decimals);
  const key = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'apex-' + Date.now() + '-' + Math.random().toString(36).slice(2);

  async function request(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (options.body) headers['content-type'] = 'application/json';
    const response = await fetch(endpoint(path), Object.assign({}, options, {headers, credentials:'include'}));
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || body.error || ('HTTP ' + response.status));
      error.status = response.status;
      error.code = body.error;
      throw error;
    }
    return body;
  }

  function modal(html) {
    let overlay = $('#apex-backend-modal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'apex-backend-modal';
      overlay.className = 'ov';
      overlay.innerHTML = '<div class="sheet"><i class="grab"></i><div id="apex-backend-modal-body"></div></div>';
      overlay.addEventListener('click', event => { if (event.target === overlay) closeModal(); });
      document.body.appendChild(overlay);
    }
    $('#apex-backend-modal-body', overlay).innerHTML = html;
  }
  function closeModal() { $('#apex-backend-modal')?.remove(); }

  function configModal(message = '') {
    modal(
      '<h3>Connect APEX backend</h3>' +
      '<div class="sd">Enter the deployed API origin. Example: https://your-apex-api.onrender.com</div>' +
      '<div class="lbl">Backend URL</div><div class="field"><input id="apex-api-url" type="url" placeholder="https://your-api.example.com" value="' + esc(apiBase) + '"></div>' +
      '<div class="err" id="apex-api-error">' + esc(message) + '</div>' +
      '<button class="cta acc" data-apex-action="save-api">Test and connect</button>' +
      '<button class="btn block" style="margin-top:8px;background:#171724" data-apex-action="close">Cancel</button>'
    );
  }

  function authModal(mode = 'login', message = '') {
    const registering = mode === 'register';
    modal(
      '<h3>' + (registering ? 'Create APEX account' : 'Sign in to APEX') + '</h3>' +
      '<div class="sd">This account is for the APEX simulator. It does not connect a wallet or move real crypto.</div>' +
      (registering ? '<div class="lbl">Display name</div><div class="field"><input id="apex-auth-name" maxlength="40" placeholder="Your display name"></div>' : '') +
      '<div class="lbl">Email</div><div class="field"><input id="apex-auth-email" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
      '<div class="lbl">Password ' + (registering ? '(minimum 12 characters)' : '') + '</div><div class="field"><input id="apex-auth-password" type="password" autocomplete="' + (registering ? 'new-password' : 'current-password') + '" placeholder="Password"></div>' +
      '<div class="err" id="apex-auth-error">' + esc(message) + '</div>' +
      '<button class="cta acc" data-apex-action="' + (registering ? 'register' : 'login') + '">' + (registering ? 'Create account' : 'Sign in') + '</button>' +
      '<button class="btn block" style="margin-top:8px;background:#171724" data-apex-action="' + (registering ? 'show-login' : 'show-register') + '">' + (registering ? 'I already have an account' : 'Create an account') + '</button>' +
      '<button class="btn block" style="margin-top:8px;background:transparent;color:var(--mut)" data-apex-action="configure">API settings</button>'
    );
  }

  async function loadMarkets() {
    const data = await request('/v1/spot/markets');
    markets = data.markets || [];
    market = markets.find(item => item.marketId === 'apex-demo' && item.status === 'ACTIVE') || null;
    return market;
  }

  async function loadSession() {
    try {
      const data = await request('/v1/auth/me');
      user = data.user;
      return user;
    } catch (error) {
      user = null;
      if (error.status !== 401) throw error;
      return null;
    }
  }

  async function loadLedger() {
    if (!user) return;
    const [balance, eventPages] = await Promise.all([
      request('/v1/ledger/balance'),
      (async () => {
        const all = [];
        let cursor = '0';
        for (let page = 0; page < 50; page++) {
          const data = await request('/v1/ledger/events?after=' + encodeURIComponent(cursor) + '&limit=500');
          const rows = data.events || [];
          all.push(...rows);
          const next = data.nextAfter || cursor;
          if (!rows.length || next === cursor) break;
          cursor = next;
          if (rows.length < 500) break;
        }
        return all;
      })()
    ]);
    creditMinor = balance.balanceMinor || '0';
    assetBalances = {APEX_CREDIT: creditMinor};
    tradeEvents = eventPages.filter(event => event.eventType === 'spot_trade_executed').reverse();
    for (const event of eventPages) {
      const after = event.payload && event.payload.balanceAfter;
      if (after) Object.assign(assetBalances, after);
      if (event.eventType === 'starter_credit_granted') assetBalances.APEX_CREDIT = creditMinor;
    }
    renderPortfolio();
    renderMarket();
  }

  function balanceFor(asset) { return String(assetBalances[asset] || '0'); }
  function credit() { return units(creditMinor, 2); }
  function tokenQty() {
    if (!market) return 0;
    return units(balanceFor(market.baseAssetCode), market.baseDecimals);
  }

  function renderMarket() {
    const page = $('#main .page');
    if (!page || !market) return;
    let card = $('#apex-backend-market');
    if (!card) {
      card = document.createElement('section');
      card.id = 'apex-backend-market';
      card.style.cssText = 'margin:0 16px 14px;padding:14px;background:linear-gradient(135deg,#17172c,#10101a);border:1px solid #292943;border-radius:15px';
      const balance = $('.bal', page);
      if (balance) balance.insertAdjacentElement('afterend', card);
      else page.prepend(card);
    }
    const price = Number(market.priceQuotePerBase || 0);
    card.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px"><span class="tag">BACKEND SPOT</span><span class="mut" style="font-size:11px">Simulated market</span><span style="margin-left:auto;color:var(--up);font-size:11px">● API connected</span></div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-top:12px"><div class="ico" style="--s:42px;background:#4f5df5">D</div><div style="flex:1"><b style="font-size:18px">' + esc(market.symbol) + ' / APEX_CREDIT</b><div class="mut" style="font-size:11px">Market ID: ' + esc(market.marketId) + ' · Fee ' + (Number(market.feeBps)/100).toFixed(2) + '%</div></div><b style="font-size:18px">' + money(price) + '</b></div>' +
      '<div style="display:flex;justify-content:space-between;margin-top:12px;font-size:12px;color:var(--mut)"><span>Ledger cash: <b style="color:#fff">' + money(credit()) + '</b></span><span>DEMO: <b style="color:#fff">' + tokenQty().toLocaleString('en-US',{maximumFractionDigits:6}) + '</b></span></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px"><button class="tb buy" style="height:44px;font-size:14px" data-apex-action="buy">Buy ' + esc(market.symbol) + '</button><button class="tb sell" style="height:44px;font-size:14px" data-apex-action="sell">Sell ' + esc(market.symbol) + '</button><button class="ibtn" style="background:#202033" data-apex-action="refresh" aria-label="Refresh ledger">↻</button></div>' +
      '<div class="mut" style="font-size:10px;margin-top:9px">Trades affect only APEX’s virtual ledger and this simulator pool. No blockchain or external DEX transactions occur.</div>';
  }

  function renderPortfolio() {
    const page = $('#main .page');
    if (!page || !user) return;
    let panel = $('#apex-ledger-portfolio');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'apex-ledger-portfolio';
      panel.style.cssText = 'margin:14px 16px;padding:14px;background:#10101b;border:1px solid #292943;border-radius:15px';
      page.appendChild(panel);
    }
    const demoQty = tokenQty();
    const price = Number(market?.priceQuotePerBase || 0);
    const history = tradeEvents.slice(0, 12).map(event => {
      const p = event.payload || {};
      const side = p.side || 'TRADE';
      const isBuy = side === 'BUY';
      const amountIn = isBuy ? units(p.amountInMinor, market?.quoteDecimals ?? 2) : units(p.amountInMinor, market?.baseDecimals ?? 9);
      const amountOut = isBuy ? units(p.amountOutMinor, market?.baseDecimals ?? 9) : units(p.amountOutMinor, market?.quoteDecimals ?? 2);
      const date = new Date(event.createdAt || Date.now()).toLocaleString();
      return '<div style="display:flex;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid #242438"><b class="' + (isBuy?'up':'dn') + '" style="width:44px">' + side + '</b><span style="flex:1;min-width:0"><b>' + esc(p.symbol || market?.symbol || 'DEMO') + '</b><small class="mut" style="display:block;font-size:10px">' + esc(date) + '</small></span><span style="text-align:right;font-size:12px">' + (isBuy ? '−' + money(amountIn) + '<small class="mut" style="display:block">+' + amountOut.toFixed(6) + ' DEMO</small>' : '−' + amountIn.toFixed(6) + ' DEMO<small class="mut" style="display:block">+' + money(amountOut) + '</small>') + '</span></div>';
    }).join('');
    const assets = '<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #242438"><span>APEX_CREDIT <small class="mut">Virtual cash</small></span><b>' + money(credit()) + '</b></div>' +
      '<div style="display:flex;justify-content:space-between;padding:9px 0"><span>' + esc(market?.symbol || 'DEMO') + ' <small class="mut">Simulated asset</small></span><b>' + demoQty.toLocaleString('en-US',{maximumFractionDigits:9}) + ' <small class="mut">≈ ' + money(demoQty*price) + '</small></b></div>';
    panel.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px"><b style="font-size:16px">Backend portfolio</b><span class="tag">LEDGER SOURCE OF TRUTH</span><button class="ibtn" style="margin-left:auto" data-apex-action="refresh" aria-label="Refresh">↻</button></div>' +
      '<div class="mut" style="font-size:11px;margin-top:4px">Authenticated as ' + esc(user.displayName || user.email) + ' · Balances reconstructed from immutable ledger events</div>' +
      '<div style="margin-top:10px">' + assets + '</div>' +
      (credit() <= 0 ? '<button class="btn pri block" style="margin-top:10px" data-apex-action="claim">Claim one-time 10,000 virtual credits</button>' : '') +
      '<div style="font-weight:700;margin-top:16px">Backend trade history</div>' +
      (history || '<div class="mut" style="padding:12px 0;font-size:12px">No backend spot trades yet.</div>') +
      '<div class="mut" style="font-size:10px;margin-top:8px">This panel is ledger-backed. Legacy prototype positions elsewhere on this page remain local demo data.</div>';
  }

  function tradeModal(side, message = '') {
    if (!user) { authModal('login', 'Sign in to execute backend trades.'); return; }
    if (!market) { configModal('No active backend spot market was found.'); return; }
    const isBuy = side === 'BUY';
    const available = isBuy ? credit() : tokenQty();
    modal(
      '<h3>' + (isBuy ? 'Buy ' : 'Sell ') + esc(market.symbol) + '</h3>' +
      '<div class="sd">Backend market · ' + esc(market.marketId) + ' · 0.50% fee</div>' +
      '<div class="lbl">Amount ' + (isBuy ? '(APEX_CREDIT)' : '(' + esc(market.symbol) + ')') + '</div>' +
      '<div class="field"><input id="apex-trade-amount" inputmode="decimal" type="number" min="0" step="any" placeholder="0.00"><button class="chip" data-apex-action="max">MAX</button></div>' +
      '<div class="mut" style="font-size:11px">Available: ' + (isBuy ? money(available) : available.toLocaleString('en-US',{maximumFractionDigits:9}) + ' ' + esc(market.symbol)) + '</div>' +
      '<div id="apex-trade-quote" class="cardx" style="font-size:12px;margin-top:10px">Enter an amount to preview the quote.</div>' +
      '<div class="err" id="apex-trade-error">' + esc(message) + '</div>' +
      '<button class="cta ' + (isBuy?'acc':'sell') + '" data-apex-action="execute" data-side="' + side + '">Review and execute ' + side + '</button>' +
      '<button class="btn block" style="margin-top:8px;background:#171724" data-apex-action="close">Cancel</button>'
    );
    const input = $('#apex-trade-amount');
    input?.addEventListener('input', () => previewQuote(side));
  }

  function toMinor(value, decimals) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a valid amount.');
    const factor = Math.pow(10, decimals);
    const minor = Math.round(n * factor);
    if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error('Amount is outside supported precision.');
    return String(minor);
  }

  async function previewQuote(side) {
    const output = $('#apex-trade-quote');
    const input = $('#apex-trade-amount');
    if (!output || !input || !market) return;
    const amount = Number(input.value);
    if (!(amount > 0)) { output.textContent = 'Enter an amount to preview the quote.'; return; }
    try {
      const amountMinor = toMinor(amount, side === 'BUY' ? market.quoteDecimals : market.baseDecimals);
      const quote = await request('/v1/spot/quote', {method:'POST', body:JSON.stringify({marketId:market.marketId,side,amountMinor,maxSlippageBps:1500})});
      const received = units(quote.amountOutMinor, side === 'BUY' ? market.baseDecimals : market.quoteDecimals);
      output.innerHTML = '<b>Estimated receive: ' + (side === 'BUY' ? received.toLocaleString('en-US',{maximumFractionDigits:9}) + ' ' + esc(market.symbol) : money(received)) + '</b><div class="mut" style="margin-top:4px">Fee: ' + (side === 'BUY' ? money(units(quote.feeMinor, market.quoteDecimals)) : money(units(quote.feeMinor, market.quoteDecimals))) + ' · Price impact: ' + (Number(quote.effectiveSlippageBps)/100).toFixed(2) + '%</div>';
      output.dataset.amountMinor = amountMinor;
    } catch (error) {
      output.textContent = error.message;
      delete output.dataset.amountMinor;
    }
  }

  async function executeTrade(side) {
    if (busy) return;
    const input = $('#apex-trade-amount');
    const errorBox = $('#apex-trade-error');
    try {
      if (!user) throw new Error('Please sign in first.');
      const amountMinor = toMinor(input?.value, side === 'BUY' ? market.quoteDecimals : market.baseDecimals);
      if ((side === 'BUY' && Number(input.value) > credit()) || (side === 'SELL' && Number(input.value) > tokenQty())) {
        throw new Error('Amount exceeds your backend ledger balance.');
      }
      busy = true;
      const button = $('[data-apex-action="execute"]');
      if (button) { button.disabled = true; button.textContent = 'Executing…'; }
      const result = await request('/v1/spot/trades', {
        method:'POST',
        headers:{'idempotency-key':key()},
        body:JSON.stringify({marketId:market.marketId,side,amountMinor,maxSlippageBps:1500})
      });
      await loadMarkets();
      await loadLedger();
      closeModal();
      toast((result.replayed ? 'Recovered' : 'Executed') + ' simulated ' + side.toLowerCase() + ' trade. Ledger updated.');
    } catch (error) {
      if (error.status === 401) { user = null; authModal('login', 'Session expired. Sign in again.'); }
      else if (errorBox) errorBox.textContent = error.message;
      else toast(error.message, true);
    } finally {
      busy = false;
      const button = $('[data-apex-action="execute"]');
      if (button) button.disabled = false;
    }
  }

  async function refreshAll() {
    try {
      await loadMarkets();
      await loadSession();
      if (user) await loadLedger();
      else { renderMarket(); renderPortfolio(); }
      return true;
    } catch (error) {
      const card = $('#apex-backend-market');
      if (card) card.innerHTML = '<b>Backend not connected</b><div class="mut" style="font-size:12px;margin-top:6px">' + esc(error.message) + '</div><button class="btn pri sm" style="margin-top:10px" data-apex-action="configure">Configure API</button>';
      return false;
    }
  }

  async function saveApi() {
    const value = ($('#apex-api-url')?.value || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+$/i.test(value)) {
      const box = $('#apex-api-error'); if (box) box.textContent = 'Enter a valid API origin (scheme + host only).';
      return;
    }
    apiBase = value;
    try {
      await request('/v1/health/live');
      localStorage.setItem(CONFIG_KEY, apiBase);
      await refreshAll();
      closeModal();
      if (!user) authModal('login');
      toast('APEX API connected.');
    } catch (error) {
      const box = $('#apex-api-error'); if (box) box.textContent = 'Connection failed: ' + error.message;
    }
  }

  async function authenticate(mode) {
    const email = ($('#apex-auth-email')?.value || '').trim();
    const password = $('#apex-auth-password')?.value || '';
    const displayName = $('#apex-auth-name')?.value.trim() || '';
    try {
      const payload = mode === 'register' ? {email,password,displayName} : {email,password};
      await request('/v1/auth/' + mode, {method:'POST',body:JSON.stringify(payload)});
      await loadSession();
      await loadLedger();
      closeModal();
      toast(mode === 'register' ? 'APEX account created.' : 'Signed in to APEX.');
    } catch (error) {
      const box = $('#apex-auth-error'); if (box) box.textContent = error.message;
    }
  }

  async function claimCredits() {
    try {
      const result = await request('/v1/ledger/starter-credit', {method:'POST',headers:{'idempotency-key':key()}});
      await loadLedger();
      toast(result.replayed ? 'Virtual credits claim recovered.' : '10,000 virtual credits added.');
    } catch (error) {
      toast(error.code === 'STARTER_CREDIT_ALREADY_CLAIMED' ? 'Starter credits were already claimed for this account.' : error.message, true);
    }
  }

  document.addEventListener('click', event => {
    const target = event.target.closest('[data-apex-action]');
    if (!target) return;
    const action = target.dataset.apexAction;
    if (action === 'configure') configModal();
    else if (action === 'save-api') saveApi();
    else if (action === 'show-login') authModal('login');
    else if (action === 'show-register') authModal('register');
    else if (action === 'login' || action === 'register') authenticate(action);
    else if (action === 'close') closeModal();
    else if (action === 'buy') tradeModal('BUY');
    else if (action === 'sell') tradeModal('SELL');
    else if (action === 'execute') executeTrade(target.dataset.side);
    else if (action === 'refresh') refreshAll().then(() => toast('Ledger refreshed.'));
    else if (action === 'claim') claimCredits();
    else if (action === 'max') {
      const input = $('#apex-trade-amount');
      if (input) { input.value = target.closest('.sheet').querySelector('[data-apex-action="execute"]').dataset.side === 'BUY' ? credit() : tokenQty(); input.dispatchEvent(new Event('input')); }
    }
  });

  const observer = new MutationObserver(() => {
    renderMarket();
    renderPortfolio();
  });
  observer.observe($('#main'), {childList:true,subtree:true});

  refreshAll();
  renderMarket();
  setInterval(async () => {
    try { await loadMarkets(); renderMarket(); } catch { /* keep last known market snapshot */ }
  }, 8000);
  window.APEXBackend = {refresh:refreshAll, get apiBase(){return apiBase;}, get user(){return user;}};
})();