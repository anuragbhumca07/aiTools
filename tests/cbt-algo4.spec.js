// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3011';

// ── Health / API ──────────────────────────────────────────────────────────────
test('health endpoint returns ok with correct strategy', async ({ request }) => {
  const res  = await request.get(`${BASE}/health`);
  const json = await res.json();
  expect(res.status()).toBe(200);
  expect(json.status).toBe('ok');
  expect(json.strategy).toBe('10ema-crossover-v1');
});

test('state endpoint returns correct structure', async ({ request }) => {
  const res  = await request.get(`${BASE}/api/state`);
  const json = await res.json();
  expect(res.status()).toBe(200);
  expect(typeof json.running).toBe('boolean');
  expect(json.strategyId).toBe('10ema-crossover-v1');
  expect(json.timeframe).toBe('15m');
  expect(json.balance).toBeGreaterThan(0);
});

// ── Page loads correctly ──────────────────────────────────────────────────────
test('page loads with correct title', async ({ page }) => {
  await page.goto(BASE);
  await expect(page).toHaveTitle(/CBT Algo4/i);
});

test('header shows 10 EMA strategy info', async ({ page }) => {
  await page.goto(BASE);
  const header = await page.locator('h1, header, #app-title, .title').first().textContent();
  expect(header).toMatch(/10\s*EMA|Algo4/i);
});

test('mode tabs (PAPER/LIVE/BACKTEST) are present', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('#tab-paper')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#tab-live')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#tab-backtest')).toBeVisible({ timeout: 5000 });
});

test('EMA indicator chips are visible', async ({ page }) => {
  await page.goto(BASE);
  // EMA(10) chip label lives in .ind-chips > .ind-chip > .ic-lbl
  const emaChip = page.locator('.ind-chips .ic-lbl').filter({ hasText: /EMA/i }).first();
  await expect(emaChip).toBeVisible({ timeout: 5000 });
});

test('START button is visible', async ({ page }) => {
  await page.goto(BASE);
  const startBtn = page.locator('button:has-text("START"), #btn-start, [data-action="start"]').first();
  await expect(startBtn).toBeVisible({ timeout: 5000 });
});

// ── Start / Stop API ──────────────────────────────────────────────────────────
test('start then stop via API', async ({ request }) => {
  // Ensure stopped first
  await request.post(`${BASE}/api/stop`);

  const startRes = await request.post(`${BASE}/api/start`, {
    data: { symbol: 'BTC/USD', timeframe: '15m', mode: 'paper', balance: 10000 },
  });
  expect(startRes.status()).toBe(200);
  const startJson = await startRes.json();
  expect(startJson.ok).toBe(true);
  expect(startJson.state.running).toBe(true);

  await new Promise(r => setTimeout(r, 1500));

  const stopRes  = await request.post(`${BASE}/api/stop`);
  expect(stopRes.status()).toBe(200);
  const stopJson = await stopRes.json();
  expect(stopJson.ok).toBe(true);
  expect(stopJson.state.running).toBe(false);
});

// ── Backtest ──────────────────────────────────────────────────────────────────
test('backtest returns results for BTC', async ({ request }) => {
  const res = await request.post(`${BASE}/api/backtest`, {
    data: { symbol: 'BTC/USD', timeframe: '15m', balance: 10000, bars: 200 },
    timeout: 30000,
  });
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.ok).toBe(true);
  expect(json).toHaveProperty('trades');
  expect(json).toHaveProperty('summary');
  expect(json.summary).toHaveProperty('winRate');
  expect(json.summary).toHaveProperty('finalBalance');
  expect(Array.isArray(json.trades)).toBe(true);
  if (json.trades.length > 0) {
    const t = json.trades[0];
    expect(t).toHaveProperty('side');
    expect(t).toHaveProperty('entryPrice');
    expect(t).toHaveProperty('exitPrice');
    expect(t).toHaveProperty('pnl');
    expect(t).toHaveProperty('slPrice');
    expect(t).toHaveProperty('trailLockProfit');
  }
}, 35000);

test('backtest tab renders run button', async ({ page }) => {
  await page.goto(BASE);
  const backtestTab = page.locator('button:has-text("BACKTEST"), [data-mode="backtest"], #tab-backtest').first();
  await backtestTab.click();
  const runBtn = page.locator('button:has-text("Run"), button:has-text("Backtest"), #btn-backtest, [data-action="backtest"]').first();
  await expect(runBtn).toBeVisible({ timeout: 5000 });
}, 15000);
