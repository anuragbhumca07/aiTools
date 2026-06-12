// @ts-check
// Kronos Trader (algo2) Playwright tests — serial to avoid shared server races
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE = 'http://localhost:3009';

// ── 1. Health endpoint ────────────────────────────────────────────
test('algo2: /health returns ok', async ({ request }) => {
  const res = await request.get(`${BASE}/health`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(body.service).toBe('kronos-trader');
  expect(body.port).toBe(3009);
});

// ── 2. Page loads with correct UI structure ───────────────────────
test('algo2: page loads with correct UI structure', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Header
  await expect(page.locator('h1')).toContainText('Kronos Trader');
  await expect(page.locator('.hdr .sub')).toContainText('AI-Powered Algo Trading');

  // Status badge
  await expect(page.locator('#status-badge')).toBeVisible();

  // Kronos forecast gauges
  await expect(page.locator('#kronos-bullish-prob')).toBeVisible();
  await expect(page.locator('#kronos-bearish-prob')).toBeVisible();
  await expect(page.locator('#kronos-vol-prob')).toBeVisible();

  // Signal rows
  await expect(page.locator('#sig-vwap')).toBeVisible();
  await expect(page.locator('#sig-volume-profile')).toBeVisible();
  await expect(page.locator('#sig-order-blocks')).toBeVisible();
  await expect(page.locator('#sig-liquidity')).toBeVisible();

  // Composite
  await expect(page.locator('#composite-direction')).toBeVisible();
  await expect(page.locator('#composite-score')).toBeVisible();

  // Market indicators
  await expect(page.locator('#ind-price')).toBeVisible();
  await expect(page.locator('#ind-atr')).toBeVisible();
  await expect(page.locator('#ind-vwap')).toBeVisible();
  await expect(page.locator('#ind-spread')).toBeVisible();
  await expect(page.locator('#ind-poc')).toBeVisible();
  await expect(page.locator('#ind-zone')).toBeVisible();

  // Controls
  await expect(page.locator('#sel-symbol')).toBeVisible();
  await expect(page.locator('#sel-timeframe')).toBeVisible();
  await expect(page.locator('#btn-refresh')).toBeVisible();
  await expect(page.locator('#btn-run-bt')).toBeVisible();
  await expect(page.locator('#sel-bt-days')).toBeVisible();
  await expect(page.locator('#inp-capital')).toBeVisible();

  // Log area
  await expect(page.locator('#log-area')).toBeVisible();
});

// ── 3. Status API returns valid paper trading state ───────────────
test('algo2: /api/status returns valid state', async ({ request }) => {
  const res = await request.get(`${BASE}/api/status`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(body.mode).toBe('paper');
  expect(typeof body.capital).toBe('number');
  expect(body.capital).toBeGreaterThan(0);
  expect(Array.isArray(body.open_positions)).toBe(true);
  expect(typeof body.trades_total).toBe('number');
});

// ── 4. Signals API returns valid live data ────────────────────────
test('algo2: /api/signals returns valid Kronos + signal data', async ({ request }) => {
  const res = await request.get(`${BASE}/api/signals?symbol=XBTUSD&timeframe=1h`, {
    timeout: 30000,
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');

  // Market data
  expect(body.market).toBeDefined();
  expect(body.market.price).toBeGreaterThan(0);
  expect(body.market.atr).toBeGreaterThan(0);

  // Kronos forecast
  expect(body.kronos).toBeDefined();
  expect(body.kronos.bullish_prob).toBeGreaterThanOrEqual(0);
  expect(body.kronos.bullish_prob).toBeLessThanOrEqual(1);
  expect(body.kronos.bearish_prob).toBeGreaterThanOrEqual(0);
  expect(body.kronos.source).toBeTruthy();

  // Signal components
  expect(body.signals).toBeDefined();
  expect(body.signals.vwap).toBeDefined();
  expect(body.signals.volume_profile).toBeDefined();
  expect(body.signals.order_blocks).toBeDefined();
  expect(body.signals.liquidity).toBeDefined();

  // Composite
  expect(body.composite).toBeDefined();
  expect(['long', 'short', 'neutral']).toContain(body.composite.direction);
  expect(body.composite.score).toBeGreaterThanOrEqual(0);
  expect(body.composite.score).toBeLessThanOrEqual(1);
  expect(Array.isArray(body.composite.reasons)).toBe(true);
});

// ── 5. Signals auto-load on page open ────────────────────────────
test('algo2: signals auto-load and update UI on page open', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Wait for signals to load (auto-refresh fires on DOMContentLoaded)
  await page.waitForFunction(() => {
    const badge = document.getElementById('status-badge');
    return badge && (badge.textContent === 'LIVE' || badge.textContent === 'ERROR');
  }, { timeout: 35000 });

  const badge = await page.locator('#status-badge').textContent();
  // If Kraken is reachable, should show LIVE; otherwise ERROR is acceptable
  expect(['LIVE', 'ERROR']).toContain(badge);

  if (badge === 'LIVE') {
    // Price should be populated
    const price = await page.locator('#ind-price').textContent();
    expect(price).toMatch(/^\$[\d,]+$/);

    // Composite direction filled in
    const dir = await page.locator('#composite-direction').textContent();
    expect(['LONG', 'SHORT', 'NEUTRAL']).toContain(dir);

    // Score is a number
    const score = await page.locator('#composite-score').textContent();
    expect(parseFloat(score)).toBeGreaterThanOrEqual(0);

    // Kronos probs filled
    const bull = await page.locator('#kronos-bullish-prob').textContent();
    expect(bull).toMatch(/[\d.]+%/);
  }
});

// ── 6. Backtest runs and returns metrics ─────────────────────────
test('algo2: /api/backtest returns valid metrics', async ({ request }) => {
  const res = await request.post(`${BASE}/api/backtest`, {
    data: { symbol: 'XBTUSD', timeframe: '1h', days: 7, capital: 10000 },
    timeout: 60000,
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');

  // Candles tested
  expect(body.candles_tested).toBeGreaterThan(0);

  // Metrics shape
  const m = body.metrics;
  expect(m).toBeDefined();
  expect(typeof m.total_trades).toBe('number');
  expect(typeof m.win_rate).toBe('number');
  expect(m.win_rate).toBeGreaterThanOrEqual(0);
  expect(m.win_rate).toBeLessThanOrEqual(1);
  expect(typeof m.profit_factor).toBe('number');
  expect(typeof m.max_drawdown_pct).toBe('number');
  expect(typeof m.sharpe_ratio).toBe('number');
  expect(typeof m.total_return_pct).toBe('number');
  expect(typeof m.final_capital).toBe('number');
  expect(Array.isArray(m.equity_curve)).toBe(true);
  expect(m.equity_curve.length).toBeGreaterThan(0);

  // Trades array
  expect(Array.isArray(body.trades)).toBe(true);
});

// ── 7. Backtest results render in UI ─────────────────────────────
test('algo2: backtest results render correctly in UI', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await page.selectOption('#sel-bt-days', '7');
  await page.fill('#inp-capital', '10000');
  await page.click('#btn-run-bt');

  // Loading indicator appears
  await expect(page.locator('#bt-running')).toBeVisible({ timeout: 5000 });

  // Wait for results (up to 90s for API + backtest)
  await page.waitForSelector('#backtest-results:not([style*="display: none"])', { timeout: 90000 });

  // Metrics populated
  const trades = await page.locator('#bt-total-trades').textContent();
  expect(trades).toMatch(/^\d+$/);

  const winRate = await page.locator('#bt-win-rate').textContent();
  expect(winRate).toMatch(/[\d.]+%/);

  const pf = await page.locator('#bt-profit-factor').textContent();
  expect(pf).toBeTruthy();

  const sharpe = await page.locator('#bt-sharpe').textContent();
  expect(sharpe).toBeTruthy();

  const maxDD = await page.locator('#bt-max-dd').textContent();
  expect(maxDD).toMatch(/[\d.]+%/);

  // Canvas drawn
  await expect(page.locator('#equity-chart')).toBeVisible();
});

// ── 8. Symbol + timeframe selectors have expected options ─────────
test('algo2: symbol and timeframe selectors have correct options', async ({ page }) => {
  await page.goto(BASE);

  const symbols = await page.locator('#sel-symbol option').allTextContents();
  expect(symbols).toContain('BTC/USD');
  expect(symbols).toContain('ETH/USD');

  const timeframes = await page.locator('#sel-timeframe option').allTextContents();
  expect(timeframes).toContain('1h');
  expect(timeframes).toContain('4h');
  expect(timeframes).toContain('1d');
});

// ── 9. Signal API validates VWAP + Volume Profile content ─────────
test('algo2: signals contain valid VWAP and Volume Profile data', async ({ request }) => {
  const res = await request.get(`${BASE}/api/signals?symbol=XBTUSD&timeframe=1h`, {
    timeout: 30000,
  });
  const body = await res.json();
  if (body.status !== 'ok') return; // Skip if API unavailable

  const vwap = body.signals.vwap;
  expect(vwap.vwap).toBeGreaterThan(0);
  expect(['above_vwap', 'below_vwap']).toContain(vwap.position);
  expect(typeof vwap.score).toBe('number');

  const vp = body.signals.volume_profile;
  expect(vp.poc).toBeGreaterThan(0);
  expect(vp.vah).toBeGreaterThanOrEqual(vp.poc);
  expect(vp.val).toBeLessThanOrEqual(vp.poc);
  expect(['above_vah', 'value_area', 'below_val']).toContain(vp.current_zone);
});

// ── 10. Refresh button re-fetches signals ─────────────────────────
test('algo2: refresh button triggers new signal fetch', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Wait for initial load
  await page.waitForFunction(() => {
    const b = document.getElementById('status-badge');
    return b && b.textContent !== 'IDLE' && b.textContent !== 'LOADING';
  }, { timeout: 35000 });

  // Click refresh
  const logBefore = await page.locator('#log-area').innerHTML();
  await page.click('#btn-refresh');
  await expect(page.locator('#status-badge')).toHaveText('LOADING', { timeout: 2000 });

  // Wait for it to complete
  await page.waitForFunction(() => {
    const b = document.getElementById('status-badge');
    return b && b.textContent !== 'LOADING';
  }, { timeout: 35000 });

  // Log should have new entry
  const logAfter = await page.locator('#log-area').innerHTML();
  expect(logAfter).not.toBe(logBefore);
});
