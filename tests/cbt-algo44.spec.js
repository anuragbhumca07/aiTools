// @ts-check
// CBT Algo44 tests — algo4 logic with algo5-style UI on port 3014
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE = 'http://localhost:3014';

test.beforeEach(async ({ request }) => {
  try { await request.post(`${BASE}/api/stop`); } catch {}
});

test.afterAll(async ({ request }) => {
  try { await request.post(`${BASE}/api/stop`); } catch {}
});

// ── 1. Page load & UI structure ──────────────────────────────────────────
test('algo44: page loads with algo5-style UI structure', async ({ page }) => {
  await page.goto(BASE);

  await expect(page).toHaveTitle(/Algo44/);
  await expect(page.locator('header .title')).toContainText('Algo44');
  await expect(page.locator('header .subtitle')).toContainText('Regime Gate');
  await expect(page.locator('#status-badge')).toContainText('STOPPED');

  // Mode tabs
  await expect(page.locator('#tab-paper')).toBeVisible();
  await expect(page.locator('#tab-live')).toBeVisible();
  await expect(page.locator('#tab-backtest')).toBeVisible();
  await expect(page.locator('#tab-paper')).toHaveClass(/active/);

  // Controls
  await expect(page.locator('#ctrl-symbol')).toBeVisible();
  await expect(page.locator('#ctrl-balance')).toBeVisible();
  await expect(page.locator('#btn-start')).toBeVisible();
  await expect(page.locator('#btn-stop')).toBeVisible();

  // PnL dashboard stat boxes
  await expect(page.locator('#stat-balance')).toBeVisible();
  await expect(page.locator('#stat-trades')).toBeVisible();
  await expect(page.locator('#stat-wr')).toBeVisible();
  await expect(page.locator('#stat-maxdd')).toBeVisible();
  await expect(page.locator('#stat-daily')).toBeVisible();
  await expect(page.locator('#stat-cl')).toBeVisible();
  await expect(page.locator('#stat-regime')).toBeVisible();

  // Indicators chips — algo4 data fields (regime/VWAP/ADX/RSI/EMA9/EMA21/ATR/sigma)
  await expect(page.locator('#ic-price')).toBeVisible();
  await expect(page.locator('#ic-vwap')).toBeVisible();
  await expect(page.locator('#ic-adx')).toBeVisible();
  await expect(page.locator('#ic-rsi')).toBeVisible();
  await expect(page.locator('#ic-ema9')).toBeVisible();
  await expect(page.locator('#ic-ema21')).toBeVisible();
  await expect(page.locator('#ic-atr')).toBeVisible();
  await expect(page.locator('#ic-sigma')).toBeVisible();

  // Regime chips
  await expect(page.locator('#regime-chip-1m')).toBeVisible();
  await expect(page.locator('#regime-chip-5m')).toBeVisible();

  // 8 entry conditions
  const conds = page.locator('.cond-grid .cond-row');
  await expect(conds).toHaveCount(8);
  const scoreText = await page.locator('#score-label').textContent();
  expect(scoreText).toMatch(/^\d\/8$/);

  // R-Ladder table — 8 milestones (header + 8 rows)
  const ladderRows = page.locator('#ladder-tbl tbody tr');
  await expect(ladderRows).toHaveCount(8);

  // Score dots — 8 BUY + 8 SELL
  await expect(page.locator('#buy-dots .dot-pip')).toHaveCount(8);
  await expect(page.locator('#sell-dots .dot-pip')).toHaveCount(8);

  // Tables
  await expect(page.locator('#trades-tbl')).toBeVisible();
  await expect(page.locator('#log-tbl')).toBeVisible();
});

// ── 2. Initial button states ─────────────────────────────────────────────
test('algo44: initial state — START enabled, STOP disabled', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('#btn-start')).not.toBeDisabled();
  await expect(page.locator('#btn-stop')).toBeDisabled();
  await expect(page.locator('#status-badge')).toContainText('STOPPED');
});

// ── 3. Mode-tab switching ────────────────────────────────────────────────
test('algo44: mode tabs switch between PAPER/LIVE/BACKTEST', async ({ page }) => {
  await page.goto(BASE);

  await page.click('#tab-live');
  await expect(page.locator('#tab-live')).toHaveClass(/active-live/);
  await expect(page.locator('#mode-badge')).toContainText('LIVE');

  await page.click('#tab-backtest');
  await expect(page.locator('#tab-backtest')).toHaveClass(/active-backtest/);
  await expect(page.locator('#mode-badge')).toContainText('BACKTEST');
  await expect(page.locator('#backtest-panel')).toBeVisible();
  await expect(page.locator('#bt-symbol')).toBeVisible();
  await expect(page.locator('#bt-months')).toBeVisible();
  await expect(page.locator('#btn-run-bt')).toBeVisible();
  await expect(page.locator('#btn-run-bt-multi')).toBeVisible();

  await page.click('#tab-paper');
  await expect(page.locator('#tab-paper')).toHaveClass(/active/);
  await expect(page.locator('#mode-badge')).toContainText('PAPER');
  await expect(page.locator('#backtest-panel')).not.toBeVisible();
});

// ── 4. Start / tick / stop via UI ────────────────────────────────────────
test('algo44: start algo, receive ticks, then stop', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto(BASE);

  await page.selectOption('#ctrl-symbol', 'BTCUSDT');
  await page.fill('#ctrl-balance', '10000');

  await page.click('#btn-start');

  // Status flips to RUNNING
  await expect(page.locator('#status-badge')).toContainText('RUNNING', { timeout: 10000 });
  await expect(page.locator('#btn-start')).toBeDisabled();
  await expect(page.locator('#btn-stop')).not.toBeDisabled();

  // Wait for first tick → log row
  await expect(page.locator('#log-body tr').first()).toBeVisible({ timeout: 90000 });

  // Indicators populated with real data ($-prefixed)
  await expect(page.locator('#ic-price')).not.toContainText('—', { timeout: 90000 });
  await expect(page.locator('#ic-vwap')).not.toContainText('—', { timeout: 10000 });
  await expect(page.locator('#ic-adx')).not.toContainText('—', { timeout: 10000 });
  await expect(page.locator('#ic-rsi')).not.toContainText('—', { timeout: 10000 });

  // Regime chips updated
  await expect(page.locator('#regime-chip-1m')).not.toContainText('—', { timeout: 10000 });

  // Stop
  await page.click('#btn-stop');
  await expect(page.locator('#status-badge')).toContainText('STOPPED', { timeout: 8000 });
  await expect(page.locator('#btn-start')).not.toBeDisabled();
  await expect(page.locator('#btn-stop')).toBeDisabled();

  // Logs persist after stop
  const rowCount = await page.locator('#log-body tr').count();
  expect(rowCount).toBeGreaterThan(0);

  // Balance shows dollar amount
  await expect(page.locator('#stat-balance')).toContainText('$');

  await page.screenshot({ path: 'tests/algo44-running.png', fullPage: true });
});

// ── 5. Conditions checklist uses real server data ────────────────────────
test('algo44: conditions checklist uses real server data', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto(BASE);
  await page.click('#btn-start');
  await expect(page.locator('#status-badge')).toContainText('RUNNING', { timeout: 10000 });

  // Wait for indicators to populate (server evaluated a tick)
  await expect(page.locator('#ic-price')).not.toContainText('—', { timeout: 90000 });
  await page.waitForTimeout(3000);

  // Condition 1 should be cond-ok or cond-fail (not cond-na)
  const c1Class = await page.locator('#c1').getAttribute('class');
  expect(c1Class).toMatch(/cond-(ok|fail)/);

  // Score is X/8
  const scoreText = await page.locator('#score-label').textContent();
  expect(scoreText).toMatch(/^\d\/8$/);

  // Determinism — same class on re-read
  const c1ClassAgain = await page.locator('#c1').getAttribute('class');
  expect(c1ClassAgain).toBe(c1Class);

  await page.click('#btn-stop');
});

// ── 6. API endpoints ─────────────────────────────────────────────────────
test('algo44: API endpoints respond correctly', async ({ request }) => {
  const health = await request.get(`${BASE}/health`);
  expect(health.ok()).toBeTruthy();
  const hj = await health.json();
  expect(hj.status).toBe('ok');
  expect(hj.service).toBe('cbt-algo44');

  const state = await request.get(`${BASE}/api/state`);
  expect(state.ok()).toBeTruthy();
  const s = await state.json();
  expect(typeof s.running).toBe('boolean');
  expect(typeof s.balance).toBe('number');
  expect(typeof s.pnl).toBe('number');
  expect(typeof s.winRate).toBe('string');
  expect(s.timeframe).toBe('1m');

  const logs = await request.get(`${BASE}/api/logs`);
  expect(Array.isArray(await logs.json())).toBeTruthy();

  const trades = await request.get(`${BASE}/api/trades`);
  expect(Array.isArray(await trades.json())).toBeTruthy();
});

// ── 7. Start/stop API roundtrip ──────────────────────────────────────────
test('algo44: API start/stop roundtrip', async ({ request }) => {
  const start = await request.post(`${BASE}/api/start`, {
    data: { symbol: 'BTCUSDT', balance: 5000, mode: 'paper' },
  });
  expect(start.ok()).toBeTruthy();
  const sd = await start.json();
  expect(sd.ok).toBe(true);
  expect(sd.state.running).toBe(true);
  expect(sd.state.symbol).toBe('BTCUSDT');
  expect(sd.state.balance).toBe(5000);

  const start2 = await request.post(`${BASE}/api/start`, {
    data: { symbol: 'BTCUSDT', balance: 5000 },
  });
  const sd2 = await start2.json();
  expect(sd2.ok).toBe(false);

  const stop = await request.post(`${BASE}/api/stop`);
  const stopD = await stop.json();
  expect(stopD.ok).toBe(true);
  expect(stopD.state.running).toBe(false);

  const stop2 = await request.post(`${BASE}/api/stop`);
  const stop2D = await stop2.json();
  expect(stop2D.ok).toBe(false);
});

// ── 8. Symbol selector ────────────────────────────────────────────────────
test('algo44: symbol selector works — ETH starts correctly', async ({ request }) => {
  const r = await request.post(`${BASE}/api/start`, {
    data: { symbol: 'ETHUSDT', balance: 8000, mode: 'paper' },
  });
  const d = await r.json();
  expect(d.ok).toBe(true);
  expect(d.state.symbol).toBe('ETHUSDT');
  expect(d.state.balance).toBe(8000);
  await request.post(`${BASE}/api/stop`);
});

// ── 9. Position card shows FLAT initially ────────────────────────────────
test('algo44: position display shows FLAT when no position', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('#pos-display')).toContainText('FLAT');
});

// ── 10. Halt / pause banners hidden initially ────────────────────────────
test('algo44: halt and pause banners hidden on fresh load', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('#halt-banner')).not.toBeVisible();
  await expect(page.locator('#pause-banner')).not.toBeVisible();
});

// ── 11. Backtest results UI renders from injected data ───────────────────
test('algo44: backtest results render stat grid and per-symbol tabs', async ({ page }) => {
  test.setTimeout(30000);
  await page.goto(BASE);

  await page.click('#tab-backtest');
  await expect(page.locator('#backtest-panel')).toBeVisible();

  // Inject fake multi-symbol results to test UI without a real fetch
  await page.evaluate(() => {
    const mk = sym => ({
      ok: true, symbol: sym,
      summary: { symbol: sym, totalTrades: 10, wins: 6, losses: 4,
        winRate: '60.0', totalPnl: 120, pnlPct: '1.20',
        maxDrawdown: 50, finalBalance: 10120, period: '1 month', candlesAnalyzed: 43200 },
      trades: [
        { side: 'long',  entryPrice: 80000, exitPrice: 80200, pnl: 50, balance: 10050,
          entryTime: '2026-05-11T10:00:00.000Z', exitTime: '2026-05-11T10:05:00.000Z',
          reason: 'Trailing SL hit', rr: 2.5, trailed: true, lockR: 0.8 },
        { side: 'short', entryPrice: 80100, exitPrice: 80200, pnl: -30, balance: 10020,
          entryTime: '2026-05-12T10:00:00.000Z', exitTime: '2026-05-12T10:02:00.000Z',
          reason: 'SL hit: $80200', rr: 3.0, trailed: false, lockR: 0 },
      ],
    });
    window.renderMultiResults([mk('BTCUSDT'), mk('ETHUSDT'), mk('SOLUSDT')]);
  });

  await expect(page.locator('#bt-results')).toBeVisible();

  // 3 summary cards
  const symCards = page.locator('#bt-results .bt-sym-card');
  await expect(symCards).toHaveCount(3);

  // 3 tabs, first active
  const tabs = page.locator('#bt-results .bt-tab');
  await expect(tabs).toHaveCount(3);
  await expect(tabs.first()).toHaveClass(/active/);

  // Switch to ETH tab
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveClass(/active/);
  await expect(tabs.first()).not.toHaveClass(/active/);

  // Trades sub-table rendered for active panel
  const tradeRows = page.locator('#bt-panel-1 table tbody tr');
  await expect(tradeRows).toHaveCount(2);
});

// ── 12. Backtest single-symbol UI shows progress indicator ───────────────
test('algo44: backtest single-symbol shows progress indicator', async ({ page }) => {
  test.setTimeout(30000);
  await page.goto(BASE);

  await page.click('#tab-backtest');
  await page.selectOption('#bt-symbol', 'BTCUSDT');
  await page.selectOption('#bt-months', '1');

  await page.click('#btn-run-bt');

  // Progress indicator appears
  await expect(page.locator('#bt-status .bt-progress')).toBeVisible({ timeout: 5000 });

  // Buttons disabled while running
  await expect(page.locator('#btn-run-bt')).toBeDisabled();
  await expect(page.locator('#btn-run-bt-multi')).toBeDisabled();
});

// ── 13. Backtest API — single symbol BTC ────────────────────────────────
test('algo44: single-symbol backtest API (BTC 1 month)', async ({ request }) => {
  test.setTimeout(600000);
  const r = await request.post(`${BASE}/api/backtest`, {
    data: { symbol: 'BTCUSDT', months: 1 },
  });
  expect(r.ok()).toBeTruthy();
  const d = await r.json();
  expect(d.ok).toBe(true);
  expect(d.summary.symbol).toBe('BTCUSDT');
  expect(typeof d.summary.totalTrades).toBe('number');
  expect(typeof d.summary.winRate).toBe('string');
  expect(typeof d.summary.totalPnl).toBe('number');
  expect(typeof d.summary.maxDrawdown).toBe('number');
  expect(d.summary.candlesAnalyzed).toBeGreaterThan(1000);
  expect(Array.isArray(d.trades)).toBeTruthy();
});

// ── 14. Regime chip updates after start ──────────────────────────────────
test('algo44: regime chips update after start', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto(BASE);

  await page.click('#btn-start');
  await expect(page.locator('#status-badge')).toContainText('RUNNING', { timeout: 10000 });

  await expect(page.locator('#regime-chip-1m')).not.toContainText('—', { timeout: 90000 });
  const r1text = await page.locator('#regime-chip-1m').textContent();
  expect(r1text).toMatch(/TRENDING_BULL|TRENDING_BEAR|SIDEWAYS/);

  await page.click('#btn-stop');
});

// ── 15. Balance reflects start value ─────────────────────────────────────
test('algo44: balance stat reflects the start balance', async ({ page }) => {
  test.setTimeout(30000);
  await page.goto(BASE);
  await page.fill('#ctrl-balance', '7500');
  await page.click('#btn-start');
  await expect(page.locator('#status-badge')).toContainText('RUNNING', { timeout: 10000 });
  await expect(page.locator('#stat-balance')).toContainText('$7,500', { timeout: 5000 });
  await page.click('#btn-stop');
});

// ── 16. Visual smoke screenshot ──────────────────────────────────────────
test('algo44: capture full-page screenshot of UI shell', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/algo44-ui.png', fullPage: true });
});
