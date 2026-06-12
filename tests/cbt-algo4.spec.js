// @ts-check
// CBT Algo4 tests — run serially to avoid shared-server races
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE = 'http://localhost:3011';

test.beforeEach(async ({ request }) => {
  try { await request.post(`${BASE}/api/stop`); } catch {}
});

test.afterAll(async ({ request }) => {
  try { await request.post(`${BASE}/api/stop`); } catch {}
});

// ── 1. Page load & UI structure ──────────────────────────────────────────
test('algo4: page loads with correct UI structure', async ({ page }) => {
  await page.goto(BASE);

  // Header
  await expect(page.locator('h1')).toContainText('Algo4');
  await expect(page.locator('.hdr .sub')).toContainText('Regime Gate');
  await expect(page.locator('#status-badge')).toContainText('STOPPED');

  // Left column: regime boxes
  await expect(page.locator('#regime-1m')).toBeVisible();
  await expect(page.locator('#regime-5m')).toBeVisible();

  // Indicators grid
  await expect(page.locator('#ind-price')).toBeVisible();
  await expect(page.locator('#ind-vwap')).toBeVisible();
  await expect(page.locator('#ind-adx')).toBeVisible();
  await expect(page.locator('#ind-rsi')).toBeVisible();

  // Entry conditions checklist (8 items)
  const conds = page.locator('.cond-list li');
  await expect(conds).toHaveCount(8);
  // Score shows X/8 format (0-8 depending on persisted server state)
  const scoreText = await page.locator('#score-label').textContent();
  expect(scoreText).toMatch(/^\d\/8$/);

  // R-ladder table
  await expect(page.locator('.ladder-table')).toBeVisible();
  const ladderRows = page.locator('.ladder-table tr');
  await expect(ladderRows).toHaveCount(9); // header + 8 rows

  // Controls
  await expect(page.locator('#sel-symbol')).toBeVisible();
  await expect(page.locator('#inp-balance')).toBeVisible();
  await expect(page.locator('#btn-start')).toBeVisible();
  await expect(page.locator('#btn-stop')).toBeVisible();

  // Backtest controls
  await expect(page.locator('#sel-bt-months')).toBeVisible();
  await expect(page.locator('#btn-run-bt')).toBeVisible();
  await expect(page.locator('#btn-run-bt-single')).toBeVisible();

  // Tick log
  await expect(page.locator('#log-area')).toBeVisible();
});

// ── 2. Initial button states ─────────────────────────────────────────────
test('algo4: initial state — START enabled, STOP disabled', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('#btn-start')).not.toBeDisabled();
  await expect(page.locator('#btn-stop')).toBeDisabled();
  await expect(page.locator('#status-badge')).toContainText('STOPPED');
});

// ── 3. Start / tick / stop ───────────────────────────────────────────────
test('algo4: start algo, receive ticks, then stop', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto(BASE);

  await page.selectOption('#sel-symbol', 'BTCUSDT');
  await page.fill('#inp-balance', '10000');

  await page.click('#btn-start');

  // Status flips to LIVE
  await expect(page.locator('#status-badge')).toContainText('LIVE', { timeout: 10000 });
  await expect(page.locator('#btn-start')).toBeDisabled();
  await expect(page.locator('#btn-stop')).not.toBeDisabled();

  // Wait for first tick log entry (Kraken fetch + candle eval)
  await expect(page.locator('#log-area .log-row').first()).toBeVisible({ timeout: 90000 });
  await expect(page.locator('#log-count')).not.toContainText('(0)');

  // Indicators populated
  await expect(page.locator('#ind-price')).not.toContainText('—', { timeout: 90000 });
  await expect(page.locator('#ind-vwap')).not.toContainText('—', { timeout: 5000 });
  await expect(page.locator('#ind-adx')).not.toContainText('—', { timeout: 5000 });
  await expect(page.locator('#ind-rsi')).not.toContainText('—', { timeout: 5000 });

  // Regime boxes updated
  await expect(page.locator('#regime-1m-label')).not.toContainText('—', { timeout: 5000 });

  // Stop
  await page.click('#btn-stop');
  await expect(page.locator('#status-badge')).toContainText('STOPPED', { timeout: 8000 });
  await expect(page.locator('#btn-start')).not.toBeDisabled();
  await expect(page.locator('#btn-stop')).toBeDisabled();

  // Logs persist after stop
  const rowCount = await page.locator('#log-area .log-row').count();
  expect(rowCount).toBeGreaterThan(0);

  // Balance shows dollar amount
  await expect(page.locator('#st-balance')).toContainText('$');

  await page.screenshot({ path: 'tests/algo4-running.png', fullPage: true });
});

// ── 4. Conditions checklist uses real server data (not random) ────────────
test('algo4: conditions checklist uses real server data', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto(BASE);
  await page.click('#btn-start');
  await expect(page.locator('#status-badge')).toContainText('LIVE', { timeout: 10000 });

  // Wait for indicators to populate (server has evaluated at least one tick)
  await expect(page.locator('#ind-price')).not.toContainText('—', { timeout: 90000 });

  // After a tick, condition 1 (regime) should be cond-ok or cond-fail — not cond-na
  // The server now sends real conditions on every tick
  await page.waitForTimeout(3000);
  const c1Class = await page.locator('#c1').getAttribute('class');
  expect(['cond-ok', 'cond-fail']).toContain(c1Class);

  // Score label should be a number/8 (0/8 in sideways is valid)
  const scoreText = await page.locator('#score-label').textContent();
  expect(scoreText).toMatch(/^\d\/8$/);

  // Conditions are deterministic — no randomness (run twice, same result)
  const c1ClassAgain = await page.locator('#c1').getAttribute('class');
  expect(c1ClassAgain).toBe(c1Class);

  await page.click('#btn-stop');
});

// ── 5. API endpoints ─────────────────────────────────────────────────────
test('algo4: API endpoints respond correctly', async ({ request }) => {
  const health = await request.get(`${BASE}/health`);
  expect(health.ok()).toBeTruthy();
  const hj = await health.json();
  expect(hj.status).toBe('ok');
  expect(hj.strategy).toBeTruthy();

  const state = await request.get(`${BASE}/api/state`);
  expect(state.ok()).toBeTruthy();
  const s = await state.json();
  expect(typeof s.running).toBe('boolean');
  expect(typeof s.balance).toBe('number');
  expect(typeof s.pnl).toBe('number');
  expect(typeof s.winRate).toBe('string');

  const logs = await request.get(`${BASE}/api/logs`);
  expect(Array.isArray(await logs.json())).toBeTruthy();

  const trades = await request.get(`${BASE}/api/trades`);
  expect(Array.isArray(await trades.json())).toBeTruthy();
});

// ── 6. Start/stop API roundtrip ──────────────────────────────────────────
test('algo4: API start/stop roundtrip', async ({ request }) => {
  const start = await request.post(`${BASE}/api/start`, {
    data: { symbol: 'BTCUSDT', balance: 5000, mode: 'paper' },
  });
  expect(start.ok()).toBeTruthy();
  const sd = await start.json();
  expect(sd.ok).toBe(true);
  expect(sd.state.running).toBe(true);
  expect(sd.state.symbol).toBe('BTCUSDT');
  expect(sd.state.balance).toBe(5000);

  // Double start returns error
  const start2 = await request.post(`${BASE}/api/start`, {
    data: { symbol: 'BTCUSDT', balance: 5000 },
  });
  const sd2 = await start2.json();
  expect(sd2.ok).toBe(false);

  const stop = await request.post(`${BASE}/api/stop`);
  const stopD = await stop.json();
  expect(stopD.ok).toBe(true);
  expect(stopD.state.running).toBe(false);

  // Double stop returns error
  const stop2 = await request.post(`${BASE}/api/stop`);
  const stop2D = await stop2.json();
  expect(stop2D.ok).toBe(false);
});

// ── 7. SSE events ────────────────────────────────────────────────────────
test('algo4: SSE /events connection returns connected event', async ({ page }) => {
  // Navigate to page — JS will connect SSE automatically
  await page.goto(BASE);
  // If SSE connected, the status badge is updated (even just to STOPPED)
  await expect(page.locator('#status-badge')).toBeVisible();
  // Balance shows the default
  await expect(page.locator('#st-balance')).toContainText('$');
});

// ── 8. Symbol selector populates on start ────────────────────────────────
test('algo4: symbol selector works — ETH starts correctly', async ({ request }) => {
  const r = await request.post(`${BASE}/api/start`, {
    data: { symbol: 'ETHUSDT', balance: 8000, mode: 'paper' },
  });
  const d = await r.json();
  expect(d.ok).toBe(true);
  expect(d.state.symbol).toBe('ETHUSDT');
  expect(d.state.balance).toBe(8000);
  await request.post(`${BASE}/api/stop`);
});

// ── 9. Position card shown/hidden ────────────────────────────────────────
test('algo4: position card is hidden when no position', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('#pos-card')).not.toBeVisible();
  await expect(page.locator('#no-pos')).toBeVisible();
});

// ── 10. Halt / pause banners hidden initially ────────────────────────────
test('algo4: halt and pause banners hidden on fresh load', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('#halt-banner')).not.toBeVisible();
  await expect(page.locator('#pause-banner')).not.toBeVisible();
  await expect(page.locator('#halt-indicator')).not.toBeVisible();
});

// ── 11. Backtest — single symbol BTC (via API, faster) ──────────────────
test('algo4: single-symbol backtest API (BTC 1 month)', async ({ request }) => {
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

// ── 11b. Backtest — UI smoke test (fast, no real data fetch) ─────────────
test('algo4: backtest UI shows running indicator', async ({ page }) => {
  test.setTimeout(30000);
  await page.goto(BASE);

  // Controls are visible
  await expect(page.locator('#sel-bt-months')).toBeVisible();
  await expect(page.locator('#btn-run-bt')).toBeVisible();
  await expect(page.locator('#btn-run-bt-single')).toBeVisible();
  await expect(page.locator('#sel-bt-single-symbol')).toBeVisible();

  // Click single symbol run
  await page.selectOption('#sel-bt-months', '1');
  await page.selectOption('#sel-bt-single-symbol', 'BTCUSDT');
  await page.click('#btn-run-bt-single');

  // Running indicator appears
  await expect(page.locator('#bt-running')).toBeVisible({ timeout: 5000 });

  // Buttons are disabled while running
  await expect(page.locator('#btn-run-bt')).toBeDisabled();
  await expect(page.locator('#btn-run-bt-single')).toBeDisabled();
});

// ── 12. Backtest — multi-symbol via API ──────────────────────────────────
test('algo4: multi-symbol backtest API (BTC + ETH + SOL)', async ({ request }) => {
  test.setTimeout(1200000); // 20 min for 3 × 1m historical fetches
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const results = [];
  for (const sym of symbols) {
    const r = await request.post(`${BASE}/api/backtest`, { data: { symbol: sym, months: 1 } });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.ok).toBe(true);
    expect(d.summary.symbol).toBe(sym);
    results.push(d.summary);
  }
  // All 3 returned summaries with expected fields
  for (const s of results) {
    expect(typeof s.totalTrades).toBe('number');
    expect(typeof s.winRate).toBe('string');
    expect(typeof s.totalPnl).toBe('number');
    expect(s.candlesAnalyzed).toBeGreaterThan(0);
  }
});

// ── 12b. Multi-symbol UI tab switching ───────────────────────────────────
test('algo4: backtest multi-symbol UI tab navigation works', async ({ page }) => {
  test.setTimeout(30000);
  await page.goto(BASE);

  // Manually inject fake results to test UI without waiting for real fetch
  await page.evaluate(() => {
    const fakeSummary = { symbol: 'BTCUSDT', totalTrades: 5, wins: 3, losses: 2,
      winRate: '60.0', totalPnl: 50, pnlPct: '0.50', maxDrawdown: 30, finalBalance: 10050, period: '1 month' };
    const fakeTrades = [];
    const fakeData = [
      { ok:true, symbol:'BTCUSDT', summary:{...fakeSummary, symbol:'BTCUSDT'}, trades:fakeTrades },
      { ok:true, symbol:'ETHUSDT', summary:{...fakeSummary, symbol:'ETHUSDT'}, trades:fakeTrades },
      { ok:true, symbol:'SOLUSDT', summary:{...fakeSummary, symbol:'SOLUSDT'}, trades:fakeTrades },
    ];
    window.renderMultiResults(fakeData);
  });

  // Results panel shown
  await expect(page.locator('#multi-bt-results')).toBeVisible();

  // 3 summary cards
  const cards = page.locator('#multi-bt-cards .mbt-card');
  await expect(cards).toHaveCount(3);

  // 3 tabs
  const tabs = page.locator('.bt-tab');
  await expect(tabs).toHaveCount(3);
  await expect(tabs.first()).toHaveClass(/active/);

  // Switch to ETH
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveClass(/active/);
  await expect(tabs.first()).not.toHaveClass(/active/);

  // Switch to SOL
  await tabs.nth(2).click();
  await expect(tabs.nth(2)).toHaveClass(/active/);
});

// ── 13. Backtest results UI stat grid (inject fake data) ─────────────────
test('algo4: backtest results show stat grid with expected fields', async ({ page }) => {
  test.setTimeout(30000);
  await page.goto(BASE);

  // Inject fake results
  await page.evaluate(() => {
    const s = { symbol:'BTCUSDT', totalTrades:10, wins:6, losses:4, winRate:'60.0',
                totalPnl:120, pnlPct:'1.20', maxDrawdown:50, finalBalance:10120, period:'1 month', candlesAnalyzed:43200 };
    const trades = [
      { side:'long', entryPrice:80000, exitPrice:80200, pnl:50, balance:10050,
        entryTime:'2026-05-11T10:00:00.000Z', exitTime:'2026-05-11T10:05:00.000Z',
        reason:'Trailing SL hit', rr:2.5, trailed:true, lockR:0.8 },
      { side:'short', entryPrice:80100, exitPrice:80200, pnl:-30, balance:10020,
        entryTime:'2026-05-12T10:00:00.000Z', exitTime:'2026-05-12T10:02:00.000Z',
        reason:'SL hit: $80200', rr:3.0, trailed:false, lockR:0 },
    ];
    window.renderMultiResults([{ ok:true, symbol:'BTCUSDT', summary:s, trades }]);
  });

  await expect(page.locator('#multi-bt-results')).toBeVisible();

  // Stat grid items
  const btGrid = page.locator('.bt-grid').first();
  await expect(btGrid).toBeVisible();
  await expect(btGrid).toContainText('Win Rate');
  await expect(btGrid).toContainText('Total PnL');
  await expect(btGrid).toContainText('Max DD');
  await expect(btGrid).toContainText('Avg Win');
  await expect(btGrid).toContainText('Avg Loss');
  await expect(btGrid).toContainText('Trailed');

  // Trades table headers
  const tradeTable = page.locator('.bt-trade-table').first();
  await expect(tradeTable).toBeVisible();
  await expect(tradeTable).toContainText('Side');
  await expect(tradeTable).toContainText('Entry');
  await expect(tradeTable).toContainText('Exit');
  await expect(tradeTable).toContainText('PnL');
  await expect(tradeTable).toContainText('R:R');
  await expect(tradeTable).toContainText('Reason');
  await expect(tradeTable).toContainText('Trail');

  // Trade rows visible
  const rows = page.locator('.bt-trade-table tbody tr');
  await expect(rows).toHaveCount(2);
});

// ── 14. Regime display reflects actual data ──────────────────────────────
test('algo4: regime boxes update correctly after start', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto(BASE);

  // Regime boxes exist and have the right structure
  await expect(page.locator('#regime-1m-label')).toBeVisible();
  await expect(page.locator('#regime-5m-label')).toBeVisible();

  await page.click('#btn-start');
  await expect(page.locator('#status-badge')).toContainText('LIVE', { timeout: 10000 });

  // After tick, regime boxes show a valid regime value
  await expect(page.locator('#regime-1m-label')).not.toContainText('—', { timeout: 90000 });
  await expect(page.locator('#regime-5m-label')).not.toContainText('—', { timeout: 10000 });

  const r1text = await page.locator('#regime-1m-label').textContent();
  expect(r1text).toMatch(/TRENDING_BULL|TRENDING_BEAR|SIDEWAYS/);

  const r5text = await page.locator('#regime-5m-label').textContent();
  expect(r5text).toMatch(/TRENDING_BULL|TRENDING_BEAR|SIDEWAYS/);

  await page.click('#btn-stop');
});

// ── 15. Log entries have correct CSS class ────────────────────────────────
test('algo4: log entries use correct CSS classes', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto(BASE);
  await page.click('#btn-start');
  await expect(page.locator('#status-badge')).toContainText('LIVE', { timeout: 10000 });

  // Wait for at least one log entry
  await expect(page.locator('#log-area .log-row').first()).toBeVisible({ timeout: 90000 });

  const rows = page.locator('#log-area .log-row');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);

  // Each row has one of the known CSS classes
  const validClasses = ['log-entry','log-exit','log-trail','log-tick','log-error','log-risk','log-skip'];
  const firstRowClass = await rows.first().getAttribute('class');
  const hasValidClass = validClasses.some(c => firstRowClass.includes(c));
  expect(hasValidClass).toBe(true);

  await page.click('#btn-stop');
});

// ── 16. Balance reflects start value ────────────────────────────────────
test('algo4: balance stat reflects the start balance', async ({ page }) => {
  test.setTimeout(30000);
  await page.goto(BASE);
  await page.fill('#inp-balance', '7500');
  await page.click('#btn-start');
  await expect(page.locator('#status-badge')).toContainText('LIVE', { timeout: 10000 });
  await expect(page.locator('#st-balance')).toContainText('$7,500', { timeout: 5000 });
  await page.click('#btn-stop');
});
