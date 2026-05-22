// @ts-check
// CBT Algo1 tests — run with a single worker to avoid shared-server races
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE = 'http://localhost:3006';

// Ensure the algo is stopped before every test
test.beforeEach(async ({ request }) => {
  try { await request.post(`${BASE}/api/stop`); } catch { /* already stopped */ }
});

test.afterAll(async ({ request }) => {
  try { await request.post(`${BASE}/api/stop`); } catch { /* ignore */ }
});

test('CBT app loads with correct UI structure', async ({ page }) => {
  await page.goto(BASE);

  await expect(page.locator('text=CBT Algo1')).toBeVisible();
  await expect(page.locator('.subtitle')).toContainText('ADX-Gated');
  await expect(page.locator('.badge-paper')).toBeVisible();

  // Controls
  await expect(page.locator('#ctrl-symbol')).toBeVisible();
  await expect(page.locator('#ctrl-tf')).toBeVisible();
  await expect(page.locator('#ctrl-balance')).toBeVisible();
  await expect(page.locator('#ctrl-interval')).toBeVisible();
  await expect(page.locator('#btn-start')).toBeVisible();
  await expect(page.locator('#btn-stop')).toBeVisible();

  // Algo Logic section
  await expect(page.locator('text=BUY (LONG)')).toBeVisible();
  await expect(page.locator('text=SELL (SHORT)')).toBeVisible();
  await expect(page.locator('text=LONG EXIT')).toBeVisible();
  await expect(page.locator('text=SHORT EXIT')).toBeVisible();

  // Indicator chips
  await expect(page.locator('#ic-price')).toBeVisible();
  await expect(page.locator('#ic-rsi')).toBeVisible();
  await expect(page.locator('#ic-macd')).toBeVisible();

  // Tables
  await expect(page.locator('#trades-tbl')).toBeVisible();
  await expect(page.locator('#log-tbl')).toBeVisible();
});

test('initial state is STOPPED and start button is enabled', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('#status-badge')).toContainText('STOPPED');
  await expect(page.locator('#btn-start')).not.toBeDisabled();
  await expect(page.locator('#btn-stop')).toBeDisabled();
});

test('start algo, receive ticks, then stop', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(BASE);

  // Confirm stopped before interacting
  await expect(page.locator('#ctrl-symbol')).not.toBeDisabled({ timeout: 5000 });

  // Configure for fast ticks
  await page.selectOption('#ctrl-symbol', 'BTCUSDT');
  await page.selectOption('#ctrl-tf', '1m');
  await page.fill('#ctrl-balance', '5000');
  await page.fill('#ctrl-interval', '5');

  // Start
  await page.click('#btn-start');

  // Status flips to RUNNING
  await expect(page.locator('#status-badge')).toContainText('RUNNING', { timeout: 8000 });
  await expect(page.locator('#btn-start')).toBeDisabled();
  await expect(page.locator('#btn-stop')).not.toBeDisabled();
  await expect(page.locator('#ctrl-symbol')).toBeDisabled();

  // Wait for first tick — up to 30s (Binance fetch + 5s interval)
  await expect(page.locator('#log-body tr').first()).not.toContainText('Waiting', { timeout: 30000 });

  // Indicators should be populated
  await expect(page.locator('#ic-price')).not.toContainText('—', { timeout: 30000 });
  await expect(page.locator('#ic-rsi')).not.toContainText('—');
  await expect(page.locator('#ic-macd')).not.toContainText('—');

  // Log count updates
  await expect(page.locator('#log-count')).not.toContainText('(0 / 500)');

  // Signal label appears
  await expect(page.locator('#last-signal-txt')).not.toContainText('—');

  // Wait for second tick
  await page.waitForTimeout(7000);

  // Stop
  await page.click('#btn-stop');
  await expect(page.locator('#status-badge')).toContainText('STOPPED', { timeout: 8000 });
  await expect(page.locator('#btn-start')).not.toBeDisabled();
  await expect(page.locator('#btn-stop')).toBeDisabled();

  // Log rows persist after stop
  const rowCount = await page.locator('#log-body tr').count();
  expect(rowCount).toBeGreaterThan(0);

  // Balance visible
  await expect(page.locator('#stat-balance')).toContainText('$');
  await expect(page.locator('#pnl-val')).toBeVisible();

  await page.screenshot({ path: 'tests/cbt-algo-running.png', fullPage: true });
});

test('API endpoints respond correctly', async ({ request }) => {
  const health = await request.get(`${BASE}/health`);
  expect(health.ok()).toBeTruthy();
  expect((await health.json()).status).toBe('ok');

  const state = await request.get(`${BASE}/api/state`);
  expect(state.ok()).toBeTruthy();
  const s = await state.json();
  expect(typeof s.running).toBe('boolean');
  expect(typeof s.balance).toBe('number');
  expect(typeof s.pnl).toBe('number');

  const logs = await request.get(`${BASE}/api/logs`);
  expect(Array.isArray(await logs.json())).toBeTruthy();

  const trades = await request.get(`${BASE}/api/trades`);
  expect(Array.isArray(await trades.json())).toBeTruthy();
});

test('algo logic section shows all 4 rule blocks', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('text=EMA20 > EMA50')).toBeVisible();
  await expect(page.locator('text=RSI ∈ [50–67]')).toBeVisible();
  // MACD 2-bar confirmation text
  await expect(page.locator('.logic-box').first().locator('text=MACD')).toBeVisible();
  await expect(page.locator('text=RSI > 75')).toBeVisible();
  await expect(page.locator('text=RSI < 25')).toBeVisible();
  // ADX hard gate description
  await expect(page.locator('text=ADX(14)').first()).toBeVisible();
  // Phase SL ratchet described
  await expect(page.locator('text=breakeven').first()).toBeVisible();
});

test('main page has CBT Algo Trading card (if server running)', async ({ page }) => {
  try {
    await page.goto('http://localhost:3000', { timeout: 5000 });
  } catch {
    test.skip(true, 'main-page server not running on :3000');
    return;
  }
  await expect(page.locator('text=CBT Algo Trading')).toBeVisible();
});
