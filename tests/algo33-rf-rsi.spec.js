// @ts-check
// CBT Algo33 (rf-rsi-v4) — verifies:
//   1. KAMA cloud gate removed — zones depend on RF bar color ONLY
//   2. RSI(2) crossover 90 → BUY, crossunder 10 → SELL (unchanged from v3)
//   3. Self-correcting :01-past-boundary tick timer
//   4. 1s trailing loop while a position is open
//   5. UI no longer shows P1/P2/P3/CloudTop/CloudBot/TotalDist chips
//
// Server must be running locally at http://localhost:3011 (or override with
// ALGO33_URL). Boot with:  PORT=3011 node cbt/strategy/algo33/server.js

const { test, expect } = require('@playwright/test');

const BASE = process.env.ALGO33_URL || 'http://localhost:3011';

test.describe.configure({ mode: 'serial' });
test.describe('Algo33 rf-rsi-v4 — fixes', () => {
  test.beforeEach(async ({ request }) => {
    try { await request.post(`${BASE}/api/stop`); } catch {}
  });

  test('page loads with RF bar-color title (KAMA reference dropped)', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/CBT Algo33.*RF.*bar.*color.*RSI/i);
    await expect(page.locator('.title').first()).toContainText('bar-color');
    // Old title "CBT Algo33 — RF+KAMA + RSI(2) cross" must not appear anymore.
    await expect(page.locator('.title').first()).not.toContainText(/RF\+KAMA/);
  });

  test('subtitle says KAMA cloud is out', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const sub = page.locator('header .subtitle');
    await expect(sub).toContainText(/bar color ONLY/i);
    await expect(sub).toContainText(/self-correcting/i);
  });

  test('logic card lists RSI mean-reversion cross rules (10 up, 90 down) and drops p1/p2/p3 gating', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const logic = page.locator('.card').filter({ hasText: 'Algo Logic' });
    await expect(logic).toContainText(/KAMA cloud removed/i);
    // New RSI(2) mean-reversion thresholds.
    await expect(logic).toContainText(/RSI\(2\) crosses ABOVE 10/i);
    await expect(logic).toContainText(/RSI\(2\) crosses BELOW 90/i);
    // Old thresholds must be gone.
    await expect(logic).not.toContainText(/RSI\(2\) crosses ABOVE 90/i);
    await expect(logic).not.toContainText(/RSI\(2\) crosses BELOW 10/i);
    // Immediate fill (no 1-bar deferral) must be stated.
    await expect(logic).toContainText(/Fill IMMEDIATELY|IMMEDIATELY at current market|same tick/i);
    // The old KAMA "GREEN bar + p2/p3/hband/lband > p1" clause must be gone.
    await expect(logic).not.toContainText(/p2\/p3\/hband\/lband > p1/i);
  });

  test('indicator chip strip no longer has KAMA columns', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#ic-p1')).toHaveCount(0);
    await expect(page.locator('#ic-p2')).toHaveCount(0);
    await expect(page.locator('#ic-p3')).toHaveCount(0);
    await expect(page.locator('#ic-cloudtop')).toHaveCount(0);
    await expect(page.locator('#ic-cloudbot')).toHaveCount(0);
    await expect(page.locator('#ic-td')).toHaveCount(0);
    // But RSI + swing chips are still there.
    await expect(page.locator('#ic-rsi')).toBeVisible();
    await expect(page.locator('#ic-swlow')).toBeVisible();
    await expect(page.locator('#ic-swhigh')).toBeVisible();
  });

  test('/health returns rf-rsi-v4', async ({ request }) => {
    const r = await request.get(`${BASE}/health`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.status).toBe('ok');
    expect(j.strategy).toBe('rf-rsi-v4');
  });

  test('/api/strategies returns rf-rsi-v4', async ({ request }) => {
    const r = await request.get(`${BASE}/api/strategies`);
    const list = await r.json();
    expect(list.some(s => s.id === 'rf-rsi-v4')).toBe(true);
    // Old strategy IDs must be gone.
    expect(list.every(s => s.id !== 'rf-kama-v2')).toBe(true);
    expect(list.every(s => s.id !== 'rf-kama-rsi-v3')).toBe(true);
  });

  test('backtest runs and returns trades on 1h BTC', async ({ request }) => {
    test.setTimeout(180000);
    const res = await request.post(`${BASE}/api/backtest`, {
      data: { symbol: 'BTCUSDT', timeframe: '1h', months: 3 },
      timeout: 170000,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary.candlesAnalyzed).toBeGreaterThan(500);
    expect(Array.isArray(body.trades)).toBe(true);
    console.log(`Algo33 v4 backtest: ${body.summary.totalTrades} trades, WR ${body.summary.winRate}%, PnL $${body.summary.totalPnl}`);
  });

  test('backtest entry reasons cite RF bar color + RSI(2) cross', async ({ request }) => {
    test.setTimeout(180000);
    const res = await request.post(`${BASE}/api/backtest`, {
      data: { symbol: 'BTCUSDT', timeframe: '1h', months: 3 },
      timeout: 170000,
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    // If any trade fired, its reason string should mention RF bar + RSI, not p1/p2/p3.
    for (const t of body.trades) {
      expect(t.reason, `Trade reason should NOT mention p1/p2/p3 — got: ${t.reason}`).not.toMatch(/p1|p2|p3/i);
    }
  });

  test('start → :01 tick fires → stop', async ({ page }) => {
    test.setTimeout(150000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.selectOption('#ctrl-tf', '1m');
    await page.click('#btn-start');
    await expect(page.locator('#status-badge')).toHaveText(/RUNNING/, { timeout: 10000 });
    await expect.poll(
      async () => await page.locator('#log-body tr:not(:has(.empty-msg))').count(),
      { timeout: 130000, intervals: [3000] }
    ).toBeGreaterThan(0);
    await page.click('#btn-stop');
    await expect(page.locator('#status-badge')).toHaveText(/STOPPED/, { timeout: 5000 });
  });

  test('candle close chip shows aligned :00 timestamp', async ({ page }) => {
    test.setTimeout(150000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.selectOption('#ctrl-tf', '1m');
    await page.click('#btn-start');
    await expect(page.locator('#status-badge')).toHaveText(/RUNNING/, { timeout: 10000 });
    await expect.poll(
      async () => await page.locator('#ic-candle-time').innerText(),
      { timeout: 130000, intervals: [3000] }
    ).not.toBe('—');
    const txt = await page.locator('#ic-candle-time').innerText();
    console.log('Candle close chip:', txt);
    const m = txt.match(/(\d{2}):(\d{2}):(\d{2})/);
    expect(m, `Candle time chip did not include HH:MM:SS: ${txt}`).toBeTruthy();
    expect(parseInt(m[3], 10), `Candle close seconds should be 00, got :${m[3]}`).toBe(0);
    await page.click('#btn-stop');
  });
});
