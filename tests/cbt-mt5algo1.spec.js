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

test('health: local server returns mt5-v1-trail25', async ({ request }) => {
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

test('UI: controls present with BTCUSD default', async ({ page }) => {
  await page.goto(LOCAL);
  await expect(page.locator('#ctrl-symbol')).toBeVisible();
  await expect(page.locator('#ctrl-tf')).toBeVisible();
  await expect(page.locator('#ctrl-balance')).toBeVisible();
  await expect(page.locator('#ctrl-interval')).toBeVisible();
  await expect(page.locator('#btn-start')).toBeEnabled();
  await expect(page.locator('#btn-stop')).toBeDisabled();

  const symbolValue = await page.locator('#ctrl-symbol').inputValue();
  expect(symbolValue).toBe('BTCUSD');

  const tfValue = await page.locator('#ctrl-tf').inputValue();
  expect(tfValue).toBe('1m');

  const intervalValue = await page.locator('#ctrl-interval').inputValue();
  expect(intervalValue).toBe('60');
});

test('UI: accent colour is MT5 blue', async ({ page }) => {
  await page.goto(LOCAL);
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  );
  expect(accent).toBe('#1976d2');
});

test('UI: Algo Logic section shows MT5 gates', async ({ page }) => {
  await page.goto(LOCAL);
  const card = page.locator('.card').filter({ hasText: 'Algo Logic' });
  await expect(card).toContainText('MT5');
  await expect(card).toContainText('Trail $25');
  await expect(card).toContainText('TRADE_ACTION_SLTP');
  await expect(card).toContainText('Python Bridge');
  await expect(card).toContainText('5s fast poll');
});

test('UI: setup note mentions pip install', async ({ page }) => {
  await page.goto(LOCAL);
  await expect(page.locator('.setup-note')).toContainText('pip install MetaTrader5');
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

test('API /api/mt5 returns bridge status', async ({ request }) => {
  const r = await request.get(`${LOCAL}/api/mt5`);
  expect(r.ok()).toBeTruthy();
  const d = await r.json();
  expect(typeof d.connected).toBe('boolean');
  expect(typeof d.bridgeAlive).toBe('boolean');
});

test('API start/stop cycle works', async ({ request }) => {
  const start = await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'BTCUSD', timeframe: '1m', balance: 5000, interval: 60, mode: 'paper' },
  });
  expect(start.ok()).toBeTruthy();
  const startBody = await start.json();
  expect(startBody.ok).toBe(true);
  expect(startBody.state.running).toBe(true);
  expect(startBody.state.symbol).toBe('BTCUSD');
  expect(startBody.state.strategyId).toBe('mt5-v1-trail25');

  const state = await request.get(`${LOCAL}/api/state`);
  const stateBody = await state.json();
  expect(stateBody.running).toBe(true);
  expect(stateBody.balance).toBe(5000);

  const stop = await request.post(`${LOCAL}/api/stop`);
  const stopBody = await stop.json();
  expect(stopBody.ok).toBe(true);
  expect(stopBody.state.running).toBe(false);
});

test('API start fires tick and produces ERROR log (MT5 not running in CI)', async ({ request }) => {
  await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'BTCUSD', timeframe: '1m', balance: 10000, interval: 60, mode: 'paper' },
  });

  await new Promise(r => setTimeout(r, 3000));

  const logsResp = await request.get(`${LOCAL}/api/logs`);
  const logs = await logsResp.json();
  expect(logs.length).toBeGreaterThan(0);

  // Without MT5 running the first tick returns an ERROR; with MT5 it returns TICK/ENTRY
  const first = logs[0];
  expect(['TICK', 'ENTRY', 'ERROR']).toContain(first.type);

  await request.post(`${LOCAL}/api/stop`);
});
