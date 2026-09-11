// @ts-check
// Algo1x suite — algo111 (1m), algo105 (5m), algo115 (15m)
// All three share the same EMA Ribbon Swing logic (Fixed Qty=1 · ATR Dynamic SL)
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const ALGO111 = 'http://localhost:3017';
const ALGO105 = 'http://localhost:3018';
const ALGO115 = 'http://localhost:3019';

const STRATEGY_ID = 'swing-v3-fixed-qty-atr-trail';

// ── Stop any running sessions before/after tests ───────────────────
async function stopAll(request) {
  for (const base of [ALGO111, ALGO105, ALGO115]) {
    try { await request.post(`${base}/api/stop`); } catch {}
  }
}
test.beforeEach(async ({ request }) => stopAll(request));
test.afterAll(async  ({ request }) => stopAll(request));

// ── Health checks ──────────────────────────────────────────────────

test('algo111: health returns swing-v3-fixed-qty-atr-trail', async ({ request }) => {
  const r = await request.get(`${ALGO111}/health`);
  expect(r.ok()).toBeTruthy();
  expect((await r.json()).strategy).toBe(STRATEGY_ID);
});

test('algo105: health returns swing-v3-fixed-qty-atr-trail', async ({ request }) => {
  const r = await request.get(`${ALGO105}/health`);
  expect(r.ok()).toBeTruthy();
  expect((await r.json()).strategy).toBe(STRATEGY_ID);
});

test('algo115: health returns swing-v3-fixed-qty-atr-trail', async ({ request }) => {
  const r = await request.get(`${ALGO115}/health`);
  expect(r.ok()).toBeTruthy();
  expect((await r.json()).strategy).toBe(STRATEGY_ID);
});

// ── Default state / timeframes ─────────────────────────────────────

test('algo111: default timeframe is 1m', async ({ request }) => {
  const s = await (await request.get(`${ALGO111}/api/state`)).json();
  expect(s.running).toBe(false);
  expect(s.timeframe).toBe('1m');
  expect(s.symbol).toBe('BTCUSDT');
  expect(s.strategyId).toBe(STRATEGY_ID);
});

test('algo105: default timeframe is 5m', async ({ request }) => {
  const s = await (await request.get(`${ALGO105}/api/state`)).json();
  expect(s.running).toBe(false);
  expect(s.timeframe).toBe('5m');
  expect(s.symbol).toBe('BTCUSDT');
  expect(s.strategyId).toBe(STRATEGY_ID);
});

test('algo115: default timeframe is 15m', async ({ request }) => {
  const s = await (await request.get(`${ALGO115}/api/state`)).json();
  expect(s.running).toBe(false);
  expect(s.timeframe).toBe('15m');
  expect(s.symbol).toBe('BTCUSDT');
  expect(s.strategyId).toBe(STRATEGY_ID);
});

// ── SL / TP multipliers preserved in all variants ─────────────────

test('algo111: slAtrMult=2, tpAtrMult=4, fixedSize=1', async ({ request }) => {
  const s = await (await request.get(`${ALGO111}/api/state`)).json();
  expect(s.slAtrMult).toBe(2);
  expect(s.tpAtrMult).toBe(4);
  expect(s.fixedSize).toBe(1);
});

test('algo105: slAtrMult=2, tpAtrMult=4, fixedSize=1', async ({ request }) => {
  const s = await (await request.get(`${ALGO105}/api/state`)).json();
  expect(s.slAtrMult).toBe(2);
  expect(s.tpAtrMult).toBe(4);
  expect(s.fixedSize).toBe(1);
});

test('algo115: slAtrMult=2, tpAtrMult=4, fixedSize=1', async ({ request }) => {
  const s = await (await request.get(`${ALGO115}/api/state`)).json();
  expect(s.slAtrMult).toBe(2);
  expect(s.tpAtrMult).toBe(4);
  expect(s.fixedSize).toBe(1);
});

// ── /api/strategies endpoint ───────────────────────────────────────

test('algo105: /api/strategies lists swing-v3-fixed-qty-atr-trail', async ({ request }) => {
  const list = await (await request.get(`${ALGO105}/api/strategies`)).json();
  const s = list.find(x => x.id === STRATEGY_ID);
  expect(s).toBeTruthy();
  expect(s.description).toContain('ATR Trail');
});

test('algo115: /api/strategies lists swing-v3-fixed-qty-atr-trail', async ({ request }) => {
  const list = await (await request.get(`${ALGO115}/api/strategies`)).json();
  const s = list.find(x => x.id === STRATEGY_ID);
  expect(s).toBeTruthy();
  expect(s.description).toContain('ATR Trail');
});

// ── Start / stop cycle ─────────────────────────────────────────────
// Skip on non-chromium to avoid shared-server race across 3 browser projects

test('algo105: start with 5m → state shows 5m running', async ({ request, browserName }) => {
  test.skip(browserName !== 'chromium', 'Shared-server test — chromium only');
  await request.post(`${ALGO105}/api/stop`);
  const start = await request.post(`${ALGO105}/api/start`, {
    data: { symbol: 'BTCUSDT', timeframe: '5m', balance: 5000, interval: 300, mode: 'paper' },
  });
  expect(start.ok()).toBeTruthy();
  const body = await start.json();
  expect(body.ok).toBe(true);
  expect(body.state.running).toBe(true);
  expect(body.state.timeframe).toBe('5m');
  expect(body.state.balance).toBe(5000);

  await request.post(`${ALGO105}/api/stop`);
  const stateAfter = await (await request.get(`${ALGO105}/api/state`)).json();
  expect(stateAfter.running).toBe(false);
});

test('algo115: start with 15m → state shows 15m running', async ({ request, browserName }) => {
  test.skip(browserName !== 'chromium', 'Shared-server test — chromium only');
  await request.post(`${ALGO115}/api/stop`);
  const start = await request.post(`${ALGO115}/api/start`, {
    data: { symbol: 'BTCUSDT', timeframe: '15m', balance: 5000, interval: 900, mode: 'paper' },
  });
  expect(start.ok()).toBeTruthy();
  const body = await start.json();
  expect(body.ok).toBe(true);
  expect(body.state.running).toBe(true);
  expect(body.state.timeframe).toBe('15m');

  await request.post(`${ALGO115}/api/stop`);
  expect((await (await request.get(`${ALGO115}/api/state`)).json()).running).toBe(false);
});

// ── UI branding ────────────────────────────────────────────────────

test('algo111: UI title shows Algo111', async ({ page }) => {
  await page.goto(ALGO111);
  await expect(page.locator('.title')).toContainText('Algo111');
  await expect(page.locator('.subtitle')).toContainText('ATR');
});

test('algo105: UI title shows Algo105', async ({ page }) => {
  await page.goto(ALGO105);
  await expect(page.locator('.title')).toContainText('Algo105');
  await expect(page.locator('.subtitle')).toContainText('ATR');
});

test('algo115: UI title shows Algo115', async ({ page }) => {
  await page.goto(ALGO115);
  await expect(page.locator('.title')).toContainText('Algo115');
  await expect(page.locator('.subtitle')).toContainText('ATR');
});

// ── Timeframe dropdown defaults in UI ─────────────────────────────

test('algo105: ctrl-tf dropdown defaults to 5m', async ({ page }) => {
  await page.goto(ALGO105);
  expect(await page.locator('#ctrl-tf').inputValue()).toBe('5m');
});

test('algo115: ctrl-tf dropdown defaults to 15m', async ({ page }) => {
  await page.goto(ALGO115);
  expect(await page.locator('#ctrl-tf').inputValue()).toBe('15m');
});

test('algo111: ctrl-tf dropdown defaults to 1m', async ({ page }) => {
  await page.goto(ALGO111);
  expect(await page.locator('#ctrl-tf').inputValue()).toBe('1m');
});

// ── Live tick fires after start (algo105 + algo115) ────────────────

test('algo105: API endpoints all reachable after start', async ({ request, browserName }) => {
  test.skip(browserName !== 'chromium', 'Shared-server test — chromium only');
  await request.post(`${ALGO105}/api/stop`).catch(() => {});
  await request.post(`${ALGO105}/api/start`, {
    data: { symbol: 'BTCUSDT', timeframe: '5m', balance: 10000, interval: 300, mode: 'paper' },
  });
  // Verify all API endpoints respond while running
  const state = await (await request.get(`${ALGO105}/api/state`)).json();
  expect(state.running).toBe(true);
  expect(state.timeframe).toBe('5m');
  const logs = await (await request.get(`${ALGO105}/api/logs`)).json();
  expect(Array.isArray(logs)).toBe(true);
  const trades = await (await request.get(`${ALGO105}/api/trades`)).json();
  expect(Array.isArray(trades)).toBe(true);
  await request.post(`${ALGO105}/api/stop`).catch(() => {});
});

test('algo115: API endpoints all reachable after start', async ({ request, browserName }) => {
  test.skip(browserName !== 'chromium', 'Shared-server test — chromium only');
  await request.post(`${ALGO115}/api/stop`).catch(() => {});
  await request.post(`${ALGO115}/api/start`, {
    data: { symbol: 'BTCUSDT', timeframe: '15m', balance: 10000, interval: 900, mode: 'paper' },
  });
  const state = await (await request.get(`${ALGO115}/api/state`)).json();
  expect(state.running).toBe(true);
  expect(state.timeframe).toBe('15m');
  const logs = await (await request.get(`${ALGO115}/api/logs`)).json();
  expect(Array.isArray(logs)).toBe(true);
  const trades = await (await request.get(`${ALGO115}/api/trades`)).json();
  expect(Array.isArray(trades)).toBe(true);
  await request.post(`${ALGO115}/api/stop`).catch(() => {});
});
