// @ts-check
// Algo1 v3 — Closed Candle + No-Drift Timer + Trailing SL
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const LOCAL  = 'http://localhost:3006';
const REMOTE = 'https://cbt-algo1-production.up.railway.app';

test.beforeEach(async ({ request }) => {
  try { await request.post(`${LOCAL}/api/stop`); } catch {}
});
test.afterAll(async ({ request }) => {
  try { await request.post(`${LOCAL}/api/stop`); } catch {}
});

// ── Health checks ─────────────────────────────────────────────────

test('health: local server returns swing-v3-closed-candle', async ({ request }) => {
  const r = await request.get(`${LOCAL}/health`);
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.status).toBe('ok');
  expect(body.strategy).toBe('swing-v3-closed-candle');
});

test('health: Railway service returns swing-v3-closed-candle', async ({ request }) => {
  const r = await request.get(`${REMOTE}/health`);
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.status).toBe('ok');
  expect(body.strategy).toBe('swing-v3-closed-candle');
});

// ── UI branding ───────────────────────────────────────────────────

test('UI: title and subtitle show Closed Candle branding', async ({ page }) => {
  await page.goto(LOCAL);

  await expect(page.locator('.title')).toContainText('CBT Algo1');
  await expect(page.locator('.title')).toContainText('Closed Candle');

  const subtitle = page.locator('.subtitle');
  await expect(subtitle).toContainText('Closed Candle');
  await expect(subtitle).toContainText('No-Drift');
  await expect(subtitle).toContainText('Trails');
  await expect(subtitle).toContainText('DI-Spread');
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

  const intervalValue = await page.locator('#ctrl-interval').inputValue();
  expect(intervalValue).toBe('60');
});

test('UI: accent colour is orange', async ({ page }) => {
  await page.goto(LOCAL);
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  );
  expect(accent).toBe('#f0883e');
});

test('UI: Algo Logic section shows Closed Candle gates', async ({ page }) => {
  await page.goto(LOCAL);
  const card = page.locator('.card').filter({ hasText: 'Algo Logic' });
  await expect(card).toContainText('Closed Candle');
  await expect(card).toContainText('No-Drift');
  await expect(card).toContainText('251 candles');
  await expect(card).toContainText(':01s');
});

// ── API ───────────────────────────────────────────────────────────

test('API /api/state returns correct defaults', async ({ request }) => {
  const r = await request.get(`${LOCAL}/api/state`);
  expect(r.ok()).toBeTruthy();
  const s = await r.json();
  expect(s.running).toBe(false);
  expect(s.strategyId).toBe('swing-v3-closed-candle');
  expect(s.timeframe).toBe('1m');
  expect(s.balance).toBe(10000);
  expect(s.position).toBeNull();
});

test('API /api/strategies lists swing-v3-closed-candle', async ({ request }) => {
  const r = await request.get(`${LOCAL}/api/strategies`);
  expect(r.ok()).toBeTruthy();
  const list = await r.json();
  const s = list.find(x => x.id === 'swing-v3-closed-candle');
  expect(s).toBeTruthy();
  expect(s.name).toContain('Closed Candle');
});

test('API start/stop cycle works', async ({ request }) => {
  // Start
  const start = await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'BTCUSDT', timeframe: '1m', balance: 5000, interval: 60, mode: 'paper' },
  });
  expect(start.ok()).toBeTruthy();
  const startBody = await start.json();
  expect(startBody.ok).toBe(true);
  expect(startBody.state.running).toBe(true);
  expect(startBody.state.timeframe).toBe('1m');

  // State reflects running
  const state = await request.get(`${LOCAL}/api/state`);
  const stateBody = await state.json();
  expect(stateBody.running).toBe(true);
  expect(stateBody.balance).toBe(5000);

  // Stop
  const stop = await request.post(`${LOCAL}/api/stop`);
  const stopBody = await stop.json();
  expect(stopBody.ok).toBe(true);
  expect(stopBody.state.running).toBe(false);
});

test('API start → tick fires → log appears', async ({ request }) => {
  await request.post(`${LOCAL}/api/start`, {
    data: { symbol: 'BTCUSDT', timeframe: '1m', balance: 10000, interval: 60, mode: 'paper' },
  });

  // Give the immediate first tick a moment to complete (Kraken fetch ~1-2s)
  await new Promise(r => setTimeout(r, 4000));

  const logsResp = await request.get(`${LOCAL}/api/logs`);
  const logs = await logsResp.json();
  expect(logs.length).toBeGreaterThan(0);
  // First tick should produce a TICK or ENTRY entry
  const first = logs[0];
  expect(['TICK', 'ENTRY', 'ERROR']).toContain(first.type);

  await request.post(`${LOCAL}/api/stop`);
});
