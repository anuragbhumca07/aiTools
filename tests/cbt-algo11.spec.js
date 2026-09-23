// @ts-check
// Algo11 — Gold (XAU/USD) EMA Ribbon Swing (same logic as Algo1, gold symbol)
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const LOCAL = 'http://localhost:3016';

test.beforeEach(async ({ request }) => {
  try { await request.post(`${LOCAL}/api/stop`); } catch {}
});
test.afterAll(async ({ request }) => {
  try { await request.post(`${LOCAL}/api/stop`); } catch {}
});

// ── Health ────────────────────────────────────────────────────────

test('health: local server returns swing-v3-closed-candle', async ({ request }) => {
  const r = await request.get(`${LOCAL}/health`);
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.status).toBe('ok');
  expect(body.strategy).toBe('swing-v3-closed-candle');
});

// ── UI branding ───────────────────────────────────────────────────

test('UI: title and subtitle show Gold branding', async ({ page }) => {
  await page.goto(LOCAL);

  await expect(page.locator('.title')).toContainText('CBT Algo11');
  await expect(page.locator('.title')).toContainText('Gold');

  const subtitle = page.locator('.subtitle');
  await expect(subtitle).toContainText('Gold');
  await expect(subtitle).toContainText('Closed Candle');
  await expect(subtitle).toContainText('No-Drift');
  await expect(subtitle).toContainText('DI-Spread');
});

test('UI: symbol dropdown defaults to XAUUSD (Gold)', async ({ page }) => {
  await page.goto(LOCAL);

  await expect(page.locator('#ctrl-symbol')).toHaveValue('XAUUSD');

  const goldOptionText = await page.locator('#ctrl-symbol option[value="XAUUSD"]').textContent();
  expect(goldOptionText).toContain('Gold');
});

test('UI: backtest symbol dropdown defaults to XAUUSD', async ({ page }) => {
  await page.goto(LOCAL);

  await page.click('#tab-backtest');
  const btSymbolValue = await page.locator('#bt-symbol').inputValue();
  expect(btSymbolValue).toBe('XAUUSD');
});

test('UI: controls present with 1m default', async ({ page }) => {
  await page.goto(LOCAL);

  await expect(page.locator('#ctrl-symbol')).toBeVisible();
  await expect(page.locator('#ctrl-tf')).toBeVisible();
  await expect(page.locator('#ctrl-balance')).toBeVisible();
  await expect(page.locator('#ctrl-interval')).toBeVisible();
  await expect(page.locator('#btn-start')).toBeEnabled();
  await expect(page.locator('#btn-stop')).toBeDisabled();

  const tfValue = await page.locator('#ctrl-tf').inputValue();
  expect(tfValue).toBe('1m');
});

test('UI: Algo Logic section shows Gold and milestone trailing', async ({ page }) => {
  await page.goto(LOCAL);
  const card = page.locator('.card').filter({ hasText: 'Algo Logic' });
  await expect(card).toContainText('Gold');
  await expect(card).toContainText('Closed Candle');
  await expect(card).toContainText('251 candles');
  await expect(card).toContainText('break-even');
  await expect(card).toContainText('$200');
});

// ── API ───────────────────────────────────────────────────────────

test('API /api/state defaults to XAUUSD', async ({ request }) => {
  // Stop first to get a clean state (shared server; other browser workers may have started it)
  await request.post(`${LOCAL}/api/stop`);
  const r = await request.get(`${LOCAL}/api/state`);
  expect(r.ok()).toBeTruthy();
  const s = await r.json();
  expect(s.running).toBe(false);
  expect(s.symbol).toBe('XAUUSD');
  expect(s.strategyId).toBe('swing-v3-closed-candle');
  expect(s.timeframe).toBe('1m');
  expect(s.position).toBeNull();
});

test('API /api/strategies lists swing-v3-closed-candle with milestone trail description', async ({ request }) => {
  const r = await request.get(`${LOCAL}/api/strategies`);
  expect(r.ok()).toBeTruthy();
  const list = await r.json();
  const s = list.find(x => x.id === 'swing-v3-closed-candle');
  expect(s).toBeTruthy();
  expect(s.description).toContain('BE@$200');
});

test('API start/stop cycle with XAUUSD', async ({ request }) => {
  const start = await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'XAUUSD', timeframe: '1m', balance: 5000, interval: 60, mode: 'paper' },
  });
  expect(start.ok()).toBeTruthy();
  const startBody = await start.json();
  expect(startBody.ok).toBe(true);
  expect(startBody.state.running).toBe(true);
  expect(startBody.state.symbol).toBe('XAUUSD');

  const state = await request.get(`${LOCAL}/api/state`);
  const stateBody = await state.json();
  expect(stateBody.running).toBe(true);
  expect(stateBody.symbol).toBe('XAUUSD');
  expect(stateBody.balance).toBe(5000);

  await request.post(`${LOCAL}/api/stop`);
  const stoppedState = await request.get(`${LOCAL}/api/state`);
  expect((await stoppedState.json()).running).toBe(false);
});

test('API start → tick fires → log appears (XAUUSD)', async ({ request }) => {
  await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'XAUUSD', timeframe: '1m', balance: 10000, interval: 60, mode: 'paper' },
  });

  await new Promise(r => setTimeout(r, 5000));

  const logsResp = await request.get(`${LOCAL}/api/logs`);
  const logs = await logsResp.json();
  expect(logs.length).toBeGreaterThan(0);
  const first = logs[0];
  expect(['TICK', 'ENTRY', 'ERROR']).toContain(first.type);

  await request.post(`${LOCAL}/api/stop`);
});
