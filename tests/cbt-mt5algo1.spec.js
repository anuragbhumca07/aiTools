// @ts-check
// MT5Algo1 — MT5 local terminal bridge, Fixed-SL $50 + Trail $25
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const LOCAL = 'http://localhost:3014';

test.beforeEach(async ({ request }) => {
  try { await request.post(`${LOCAL}/api/stop`); } catch {}
});
test.afterAll(async ({ request }) => {
  try { await request.post(`${LOCAL}/api/stop`); } catch {}
});

// ── Health ────────────────────────────────────────────────────────

test('health: server returns mt5-v1-trail25', async ({ request }) => {
  const r = await request.get(`${LOCAL}/health`);
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.status).toBe('ok');
  expect(body.strategy).toBe('mt5-v1-trail25');
});

// ── UI branding ───────────────────────────────────────────────────

test('UI: title shows MT5Algo1 branding', async ({ page }) => {
  await page.goto(LOCAL);
  await expect(page.locator('.title')).toContainText('CBT MT5Algo1');
  await expect(page.locator('.title')).toContainText('MT5');
});

test('UI: subtitle shows key parameters', async ({ page }) => {
  await page.goto(LOCAL);
  const subtitle = page.locator('.subtitle');
  await expect(subtitle).toContainText('Fixed SL $50');
  await expect(subtitle).toContainText('Trail $25');
  await expect(subtitle).toContainText('MT5 Python Bridge');
  await expect(subtitle).toContainText('5s fast poll');
});

test('UI: accent colour is orange (matches Algo1 theme)', async ({ page }) => {
  await page.goto(LOCAL);
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  );
  expect(accent).toBe('#f0883e');
});

test('UI: controls present with BTCUSD default text input', async ({ page }) => {
  await page.goto(LOCAL);
  await expect(page.locator('#ctrl-symbol')).toBeVisible();
  await expect(page.locator('#ctrl-tf')).toBeVisible();
  await expect(page.locator('#ctrl-balance')).toBeVisible();
  await expect(page.locator('#ctrl-interval')).toBeVisible();
  await expect(page.locator('#btn-start')).toBeEnabled();
  await expect(page.locator('#btn-stop')).toBeDisabled();

  // Symbol is a text input (not dropdown) — required for MT5 broker-specific names
  const tag = await page.locator('#ctrl-symbol').evaluate(el => el.tagName.toLowerCase());
  expect(tag).toBe('input');
  expect(await page.locator('#ctrl-symbol').inputValue()).toBe('BTCUSD');
  expect(await page.locator('#ctrl-tf').inputValue()).toBe('1m');
  expect(await page.locator('#ctrl-interval').inputValue()).toBe('60');
});

test('UI: Algo Logic section has MT5-specific content', async ({ page }) => {
  await page.goto(LOCAL);
  const card = page.locator('.card').filter({ hasText: 'Algo Logic' });
  await expect(card).toContainText('MT5');
  await expect(card).toContainText('Trail $25');
  await expect(card).toContainText('TRADE_ACTION_SLTP');
  await expect(card).toContainText('Python Bridge');
  await expect(card).toContainText('5s fast poll');
  await expect(card).toContainText('$500 hard stop');
});

test('UI: setup note mentions pip install MetaTrader5', async ({ page }) => {
  await page.goto(LOCAL);
  await expect(page.locator('.setup-note')).toContainText('pip install MetaTrader5');
});

test('UI: LIVE MT5 tab switches badge to green LIVE', async ({ page }) => {
  await page.goto(LOCAL);
  await page.locator('#tab-live').click();
  await expect(page.locator('#mode-badge')).toHaveText('LIVE');
  await expect(page.locator('#mode-badge')).toHaveClass(/badge-live/);
});

test('UI: PAPER TRADE tab shows yellow PAPER badge', async ({ page }) => {
  await page.goto(LOCAL);
  await expect(page.locator('#mode-badge')).toHaveText('PAPER');
  await expect(page.locator('#mode-badge')).toHaveClass(/badge-paper/);
});

test('UI: Live indicators section has all chip IDs', async ({ page }) => {
  await page.goto(LOCAL);
  await expect(page.locator('#ic-price')).toBeVisible();
  await expect(page.locator('#ic-ema21')).toBeVisible();
  await expect(page.locator('#ic-adx')).toBeVisible();
  await expect(page.locator('#ic-di')).toBeVisible();
  await expect(page.locator('#ic-dispread')).toBeVisible();
  await expect(page.locator('#buy-dots')).toBeVisible();
  await expect(page.locator('#sell-dots')).toBeVisible();
});

test('UI: Entry/Exit Records table has Ticket column', async ({ page }) => {
  await page.goto(LOCAL);
  const thead = page.locator('#trades-tbl thead');
  await expect(thead).toContainText('Ticket');
  await expect(thead).toContainText('Stop Loss');
  await expect(thead).toContainText('MAE $');
});

test('UI: Tick Log has full indicator columns', async ({ page }) => {
  await page.goto(LOCAL);
  const thead = page.locator('#log-tbl thead');
  await expect(thead).toContainText('EMA21');
  await expect(thead).toContainText('ADX');
  await expect(thead).toContainText('DI+/−');
  await expect(thead).toContainText('DI Spread');
});

// ── API ───────────────────────────────────────────────────────────

test('API /api/state returns correct defaults', async ({ request }) => {
  const r = await request.get(`${LOCAL}/api/state`);
  expect(r.ok()).toBeTruthy();
  const s = await r.json();
  expect(s.running).toBe(false);
  expect(s.strategyId).toBe('mt5-v1-trail25');
  expect(s.timeframe).toBe('1m');
  expect(s.symbol).toBe('BTCUSD');
  expect(s.balance).toBe(10000);
  expect(s.position).toBeNull();
});

test('API /api/strategies lists mt5-v1-trail25', async ({ request }) => {
  const r = await request.get(`${LOCAL}/api/strategies`);
  expect(r.ok()).toBeTruthy();
  const list = await r.json();
  const s = list.find(x => x.id === 'mt5-v1-trail25');
  expect(s).toBeTruthy();
  expect(s.name).toContain('mt5-v1-trail25');
});

test('API /api/mt5 reports bridge alive and connection status', async ({ request }) => {
  const r = await request.get(`${LOCAL}/api/mt5`);
  expect(r.ok()).toBeTruthy();
  const d = await r.json();
  expect(typeof d.connected).toBe('boolean');
  expect(typeof d.bridgeAlive).toBe('boolean');
  // Bridge must be alive (Python process running), even if MT5 terminal is closed
  expect(d.bridgeAlive).toBe(true);
  console.log(`MT5 bridge alive=${d.bridgeAlive}, connected=${d.connected}`);
});

test('API start with mode=live sets mode correctly', async ({ request }) => {
  const r = await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'BTCUSD', timeframe: '1m', balance: 10000, interval: 60, mode: 'live' },
  });
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.ok).toBe(true);
  expect(body.state.running).toBe(true);
  expect(body.state.mode).toBe('live');

  const stateR = await request.get(`${LOCAL}/api/state`);
  const state = await stateR.json();
  expect(state.mode).toBe('live');

  await request.post(`${LOCAL}/api/stop`);
});

test('API start with mode=paper sets mode correctly', async ({ request }) => {
  const r = await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'BTCUSD', timeframe: '1m', balance: 10000, interval: 60, mode: 'paper' },
  });
  const body = await r.json();
  expect(body.state.mode).toBe('paper');
  await request.post(`${LOCAL}/api/stop`);
});

test('API start/stop cycle', async ({ request }) => {
  const start = await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'BTCUSD', timeframe: '1m', balance: 5000, interval: 60, mode: 'paper' },
  });
  const startBody = await start.json();
  expect(startBody.ok).toBe(true);
  expect(startBody.state.running).toBe(true);

  const stop = await request.post(`${LOCAL}/api/stop`);
  const stopBody = await stop.json();
  expect(stopBody.ok).toBe(true);
  expect(stopBody.state.running).toBe(false);
});

// ── Live trading pipeline ─────────────────────────────────────────

test('LIVE: mt5Connected state reflects bridge connection', async ({ request }) => {
  const mt5R = await request.get(`${LOCAL}/api/mt5`);
  const mt5  = await mt5R.json();

  const stateR = await request.get(`${LOCAL}/api/state`);
  const state  = await stateR.json();

  // mt5Connected in state must match /api/mt5 connected field
  expect(state.mt5Connected).toBe(mt5.connected);
  console.log(`mt5Connected=${state.mt5Connected}`);
});

test('LIVE: in paper mode all trades get paper_xxx tickets (even with MT5 connected)', async ({ request }) => {
  await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'BTCUSD', timeframe: '1m', balance: 10000, interval: 60, mode: 'paper' },
  });

  // Wait up to 15s for a candle tick
  await new Promise(r => setTimeout(r, 15000));

  const stateR = await request.get(`${LOCAL}/api/state`);
  const state  = await stateR.json();
  await request.post(`${LOCAL}/api/stop`);

  if (state.position) {
    // Paper mode must always produce paper_xxx ticket regardless of MT5 connectivity
    expect(state.position.mt5Ticket).toMatch(/^paper_/);
    console.log(`Paper trade ticket: ${state.position.mt5Ticket} ✓`);
  } else {
    console.log('No trade triggered in time window — HOLD signal');
  }
});

test('LIVE: in live mode with mt5Connected, order goes through bridge (not silent paper fallback)', async ({ request }) => {
  const mt5R = await request.get(`${LOCAL}/api/mt5`);
  const mt5  = await mt5R.json();

  if (!mt5.connected) {
    console.log('MT5 not connected — skipping live order test');
    test.skip();
    return;
  }

  await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'BTCUSD', timeframe: '1m', balance: 10000, interval: 60, mode: 'live' },
  });

  // Wait up to 15s for a candle signal to fire
  await new Promise(r => setTimeout(r, 15000));

  const stateR = await request.get(`${LOCAL}/api/state`);
  const state  = await stateR.json();
  const logsR  = await request.get(`${LOCAL}/api/logs`);
  const logs   = await logsR.json();
  await request.post(`${LOCAL}/api/stop`);

  const hasSignal = logs.some(l => l.type === 'ENTRY' || l.type === 'ERROR');

  if (!hasSignal) {
    console.log('No BUY/SELL signal in time window — cannot verify live order');
    return;
  }

  if (state.position) {
    // A position exists — ticket MUST NOT be paper_xxx in live mode
    expect(state.position.mt5Ticket).not.toMatch(/^paper_/);
    console.log(`Live trade ticket: ${state.position.mt5Ticket} ✓`);
  } else {
    // No position — must be because MT5 rejected the order and error was surfaced (not silent paper)
    expect(state.error).toBeTruthy();
    expect(state.error).toContain('[LIVE]');
    console.log(`Live order rejected and surfaced: ${state.error} ✓`);
  }
});

test('LIVE: AutoTrading disabled (10027) surfaces visible error — no silent paper trade', async ({ request }) => {
  const mt5R = await request.get(`${LOCAL}/api/mt5`);
  const mt5  = await mt5R.json();

  if (!mt5.connected) {
    console.log('MT5 not connected — skipping');
    test.skip();
    return;
  }

  await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'BTCUSD', timeframe: '1m', balance: 10000, interval: 60, mode: 'live' },
  });

  await new Promise(r => setTimeout(r, 15000));

  const logsR = await request.get(`${LOCAL}/api/logs`);
  const logs  = await logsR.json();
  const stateR = await request.get(`${LOCAL}/api/state`);
  const state  = await stateR.json();
  await request.post(`${LOCAL}/api/stop`);

  const entryLogs = logs.filter(l => l.type === 'ENTRY');
  const errorLogs = logs.filter(l => l.type === 'ERROR');

  console.log(`Entry logs: ${entryLogs.length}, Error logs: ${errorLogs.length}`);

  if (entryLogs.length > 0) {
    // Signal fired and entry succeeded — ticket must NOT be paper_xxx
    const ticket = entryLogs[0].mt5?.orderId || state.position?.mt5Ticket || '';
    expect(ticket).not.toMatch(/^paper_/);
    console.log(`Real MT5 order placed: ticket=${ticket} ✓`);
  } else if (errorLogs.length > 0) {
    // Signal fired but MT5 rejected — error must be present and descriptive
    const errMsg = errorLogs[0].message || '';
    expect(errMsg).toContain('[LIVE]');
    // Must NOT have created a paper trade silently
    const tradesR = await request.get(`${LOCAL}/api/trades`);
    const trades  = await tradesR.json();
    // Any trades recorded should NOT have paper_ tickets while in live mode
    trades.filter(t => t.type === 'entry').forEach(t => {
      expect(t.mt5_ticket).not.toMatch(/^paper_/);
    });
    console.log(`Order rejected, error surfaced: "${errMsg}" ✓ No silent paper trades ✓`);
  } else {
    console.log('No signal generated in time window');
  }
});

test('LIVE: UI shows error banner when MT5 rejects live order', async ({ page, request }) => {
  const mt5R = await request.get(`${LOCAL}/api/mt5`);
  const mt5  = await mt5R.json();

  if (!mt5.connected) {
    console.log('MT5 not connected — skipping');
    test.skip();
    return;
  }

  await page.goto(LOCAL);

  // Switch to LIVE MT5 mode
  await page.locator('#tab-live').click();
  await expect(page.locator('#mode-badge')).toHaveText('LIVE');

  // Start the algo
  await page.locator('#btn-start').click();
  await expect(page.locator('#status-badge')).toContainText('RUNNING');

  // Wait for a tick to process
  await page.waitForTimeout(15000);

  const stateR = await request.get(`${LOCAL}/api/state`);
  const state  = await stateR.json();

  if (state.error && state.error.includes('[LIVE]')) {
    // Error should be visible in the error banner
    await expect(page.locator('#err-banner')).toBeVisible();
    await expect(page.locator('#err-banner')).toContainText('[LIVE]');
    console.log('Error banner visible with [LIVE] tag ✓');

    // No open position should exist (order was rejected, not silently paper-entered)
    expect(state.position).toBeNull();
    console.log('No phantom paper position created ✓');
  } else if (state.position) {
    // Order succeeded — ticket must not be paper_xxx
    expect(state.position.mt5Ticket).not.toMatch(/^paper_/);
    console.log(`Real MT5 position open: ticket=${state.position.mt5Ticket} ✓`);
  }

  await request.post(`${LOCAL}/api/stop`);
});
