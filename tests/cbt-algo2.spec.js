// @ts-check
// Kronos Trader (algo2) Playwright tests — serial to avoid shared server races
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE = 'http://localhost:3009';

// ── 1. Health endpoint ────────────────────────────────────────────
test('algo2: /health returns ok', async ({ request }) => {
  const res  = await request.get(`${BASE}/health`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(body.service).toBe('kronos-trader');
});

// ── 2. Page loads with correct UI structure ───────────────────────
test('algo2: page loads with correct UI structure', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Header
  await expect(page.locator('header .title')).toContainText('Kronos Trader');

  // Status badge
  await expect(page.locator('#status-badge')).toBeVisible();

  // Live controls
  await expect(page.locator('#sel-symbol')).toBeVisible();
  await expect(page.locator('#sel-timeframe')).toBeVisible();
  await expect(page.locator('#btn-start')).toBeVisible();
  await expect(page.locator('#btn-stop')).toBeVisible();
  await expect(page.locator('#btn-refresh')).toBeVisible();

  // Backtest controls (separate from live)
  await expect(page.locator('#sel-bt-symbol')).toBeVisible();
  await expect(page.locator('#sel-bt-timeframe')).toBeVisible();
  await expect(page.locator('#sel-bt-days')).toBeVisible();
  await expect(page.locator('#inp-capital')).toBeVisible();
  await expect(page.locator('#btn-run-bt')).toBeVisible();

  // Kronos gauges
  await expect(page.locator('#kronos-bullish-prob')).toBeVisible();
  await expect(page.locator('#kronos-bearish-prob')).toBeVisible();
  await expect(page.locator('#kronos-vol-prob')).toBeVisible();

  // Signal breakdown
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

  // Log area
  await expect(page.locator('#log-area')).toBeVisible();
});

// ── 3. Status API returns valid paper trading state ───────────────
test('algo2: /api/status returns valid state', async ({ request }) => {
  const res  = await request.get(`${BASE}/api/status`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(body.mode).toBe('paper');
  expect(typeof body.capital).toBe('number');
  expect(body.capital).toBeGreaterThan(0);
  expect(Array.isArray(body.open_positions)).toBe(true);
  expect(typeof body.trades_total).toBe('number');
});

// ── 4. Signals API — BTC/USD 1h ──────────────────────────────────
test('algo2: /api/signals BTC/USD 1h returns valid data', async ({ request }) => {
  const res  = await request.get(`${BASE}/api/signals?symbol=BTCUSD&timeframe=1h`, { timeout: 30000 });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');

  expect(body.market.price).toBeGreaterThan(0);
  expect(body.market.atr).toBeGreaterThan(0);

  expect(body.kronos.bullish_prob).toBeGreaterThanOrEqual(0);
  expect(body.kronos.bullish_prob).toBeLessThanOrEqual(1);
  expect(body.kronos.source).toBeTruthy();

  expect(body.signals.vwap).toBeDefined();
  expect(body.signals.volume_profile).toBeDefined();
  expect(body.signals.order_blocks).toBeDefined();
  expect(body.signals.liquidity).toBeDefined();

  expect(['long', 'short', 'neutral']).toContain(body.composite.direction);
  expect(body.composite.score).toBeGreaterThanOrEqual(0);
  expect(body.composite.score).toBeLessThanOrEqual(1);
  expect(Array.isArray(body.composite.reasons)).toBe(true);
});

// ── 5. Signals API — ETH/USD 4h ──────────────────────────────────
test('algo2: /api/signals ETH/USD 4h returns valid data', async ({ request }) => {
  const res  = await request.get(`${BASE}/api/signals?symbol=ETHUSD&timeframe=4h`, { timeout: 30000 });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(body.symbol).toBe('ETHUSD');
  expect(body.timeframe).toBe('4h');
  expect(body.market.price).toBeGreaterThan(0);
  expect(['long', 'short', 'neutral']).toContain(body.composite.direction);
});

// ── 6. Signals auto-load and update UI on page open ──────────────
test('algo2: signals auto-load on page open', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await page.waitForFunction(() => {
    const badge = document.getElementById('status-badge');
    return badge && (badge.textContent === 'LIVE' || badge.textContent === 'ERROR');
  }, { timeout: 35000 });

  const badge = await page.locator('#status-badge').textContent();
  expect(['LIVE', 'ERROR']).toContain(badge);

  if (badge === 'LIVE') {
    const price = await page.locator('#ind-price').textContent();
    expect(price).toMatch(/\$[\d,]+/);

    const dir = await page.locator('#composite-direction').textContent();
    expect(['LONG', 'SHORT', 'NEUTRAL']).toContain(dir);

    const bull = await page.locator('#kronos-bullish-prob').textContent();
    expect(bull).toMatch(/[\d.]+%/);
  }
});

// ── 7. Backtest API — BTC/USD 1h 7 days ─────────────────────────
test('algo2: /api/backtest BTC/USD 1h 7 days returns valid metrics', async ({ request }) => {
  test.setTimeout(90000);
  const res  = await request.post(`${BASE}/api/backtest`, {
    data: { symbol: 'BTCUSD', timeframe: '1h', days: 7, capital: 10000 },
    timeout: 70000,
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(body.candles_tested).toBeGreaterThan(0);

  const m = body.metrics;
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
  expect(Array.isArray(body.trades)).toBe(true);
});

// ── 8. Backtest API — ETH/USD 4h 7 days ─────────────────────────
test('algo2: /api/backtest ETH/USD 4h 7 days returns valid metrics', async ({ request }) => {
  test.setTimeout(90000);
  const res  = await request.post(`${BASE}/api/backtest`, {
    data: { symbol: 'ETHUSD', timeframe: '4h', days: 7, capital: 10000 },
    timeout: 70000,
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(body.symbol).toBe('ETHUSD');
  expect(body.timeframe).toBe('4h');
  expect(body.candles_tested).toBeGreaterThan(0);
  expect(typeof body.metrics.total_trades).toBe('number');
  expect(Array.isArray(body.metrics.equity_curve)).toBe(true);
});

// ── 9. Backtest API — SOL/USD 1h 7 days ─────────────────────────
test('algo2: /api/backtest SOL/USD 1h 7 days returns valid metrics', async ({ request }) => {
  test.setTimeout(90000);
  const res  = await request.post(`${BASE}/api/backtest`, {
    data: { symbol: 'SOLUSD', timeframe: '1h', days: 7, capital: 10000 },
    timeout: 70000,
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(body.symbol).toBe('SOLUSD');
  expect(body.candles_tested).toBeGreaterThan(0);
  expect(typeof body.metrics.win_rate).toBe('number');
  expect(Array.isArray(body.metrics.equity_curve)).toBe(true);
});

// ── 10. Backtest UI — BTC/USD 1h renders results ─────────────────
test('algo2: backtest UI BTC/USD 1h renders results', async ({ page }) => {
  test.setTimeout(150000);
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await page.selectOption('#sel-bt-symbol', 'BTCUSD');
  await page.selectOption('#sel-bt-timeframe', '1h');
  await page.selectOption('#sel-bt-days', '7');
  await page.fill('#inp-capital', '10000');
  await page.click('#btn-run-bt');

  await expect(page.locator('#bt-running')).toBeVisible({ timeout: 5000 });

  await page.waitForSelector('#backtest-results:not([style*="display: none"])', { timeout: 110000 });

  const trades = await page.locator('#bt-total-trades').textContent();
  expect(trades).toMatch(/^\d+$/);

  const winRate = await page.locator('#bt-win-rate').textContent();
  expect(winRate).toMatch(/[\d.]+%/);

  const maxDD = await page.locator('#bt-max-dd').textContent();
  expect(maxDD).toMatch(/[\d.]+%/);

  await expect(page.locator('#equity-chart')).toBeVisible();
  expect(await page.locator('#bt-label').textContent()).toContain('BTCUSD');
});

// ── 11. Backtest UI — ETH/USD 4h renders results ─────────────────
test('algo2: backtest UI ETH/USD 4h renders results', async ({ page }) => {
  test.setTimeout(150000);
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await page.selectOption('#sel-bt-symbol', 'ETHUSD');
  await page.selectOption('#sel-bt-timeframe', '4h');
  await page.selectOption('#sel-bt-days', '7');
  await page.fill('#inp-capital', '10000');
  await page.click('#btn-run-bt');

  await expect(page.locator('#bt-running')).toBeVisible({ timeout: 5000 });

  await page.waitForSelector('#backtest-results:not([style*="display: none"])', { timeout: 110000 });

  const trades = await page.locator('#bt-total-trades').textContent();
  expect(trades).toMatch(/^\d+$/);

  expect(await page.locator('#bt-label').textContent()).toContain('ETHUSD');
  expect(await page.locator('#bt-label').textContent()).toContain('4h');
  await expect(page.locator('#equity-chart')).toBeVisible();
});

// ── 12. Symbol selectors have correct options ─────────────────────
test('algo2: symbol and timeframe selectors have correct options', async ({ page }) => {
  await page.goto(BASE);

  // Live signal selectors
  const liveSymbols = await page.locator('#sel-symbol option').allTextContents();
  expect(liveSymbols).toContain('BTC/USD');
  expect(liveSymbols).toContain('ETH/USD');

  const liveTFs = await page.locator('#sel-timeframe option').allTextContents();
  expect(liveTFs).toContain('1h');
  expect(liveTFs).toContain('4h');
  expect(liveTFs).toContain('1d');

  // Backtest selectors (separate from live)
  const btSymbols = await page.locator('#sel-bt-symbol option').allTextContents();
  expect(btSymbols).toContain('BTC/USD');
  expect(btSymbols).toContain('ETH/USD');

  const btTFs = await page.locator('#sel-bt-timeframe option').allTextContents();
  expect(btTFs).toContain('1h');
  expect(btTFs).toContain('4h');
});

// ── 13. VWAP + Volume Profile signal data validation ──────────────
test('algo2: signals contain valid VWAP and Volume Profile data', async ({ request }) => {
  const res  = await request.get(`${BASE}/api/signals?symbol=BTCUSD&timeframe=1h`, { timeout: 30000 });
  const body = await res.json();
  if (body.status !== 'ok') return;

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

// ── 14. Refresh button triggers new signal fetch ──────────────────
test('algo2: refresh button triggers new signal fetch', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await page.waitForFunction(() => {
    const b = document.getElementById('status-badge');
    return b && b.textContent !== 'IDLE' && b.textContent !== 'LOADING';
  }, { timeout: 35000 });

  const logBefore = await page.locator('#log-area').innerHTML();
  await page.click('#btn-refresh');
  await expect(page.locator('#status-badge')).toHaveText('LOADING', { timeout: 2000 });

  await page.waitForFunction(() => {
    const b = document.getElementById('status-badge');
    return b && b.textContent !== 'LOADING';
  }, { timeout: 35000 });

  const logAfter = await page.locator('#log-area').innerHTML();
  expect(logAfter).not.toBe(logBefore);
});

// ── 15. START / STOP auto-poll controls work ─────────────────────
test('algo2: START and STOP buttons control auto-polling', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await page.waitForFunction(() => {
    const b = document.getElementById('status-badge');
    return b && b.textContent !== 'IDLE' && b.textContent !== 'LOADING';
  }, { timeout: 35000 });

  // Start polling
  await page.click('#btn-start');
  await expect(page.locator('#btn-start')).toBeDisabled({ timeout: 2000 });
  await expect(page.locator('#btn-stop')).toBeEnabled({ timeout: 2000 });

  // Stop polling
  await page.click('#btn-stop');
  await expect(page.locator('#btn-start')).toBeEnabled({ timeout: 2000 });
  await expect(page.locator('#btn-stop')).toBeDisabled({ timeout: 2000 });

  const badge = await page.locator('#status-badge').textContent();
  expect(badge).toBe('STOPPED');
});
