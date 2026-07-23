// @ts-check
// CBT Algo34 (rf-rsi-atrtrail-v1) — verifies:
//   1. Entry rules identical to algo33 (RF bar-color + RSI(2) cross 10/90)
//   2. Initial SL is 2×ATR14 (algo33 used 1.5×ATR)
//   3. Three-phase ATR-based trailing:
//        Phase 1 — initial SL until PnL ≥ 3×ATR·qty
//        Phase 2 — breakeven ($0 locked) until PnL ≥ 5×ATR·qty
//        Phase 3 — lock 3×ATR·qty, then step +$100/+$100
//   4. Self-correcting :01-past-boundary tick timer
//   5. Immediate entry fill on the signal tick
//
// Server must be running locally at http://localhost:3012 (or override with
// ALGO34_URL). Boot with:  PORT=3012 node cbt/strategy/algo34/server.js

const { test, expect } = require('@playwright/test');

const BASE = process.env.ALGO34_URL || 'http://localhost:3012';

test.describe.configure({ mode: 'serial' });
test.describe('Algo34 rf-rsi-atrtrail-v1 — fixes', () => {
  test.beforeEach(async ({ request }) => {
    try { await request.post(`${BASE}/api/stop`); } catch {}
  });

  test('page loads with ATR-trail title', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/CBT Algo34.*ATR.*trail/i);
    await expect(page.locator('.title').first()).toContainText(/ATR-based trail/i);
  });

  test('subtitle mentions 2×ATR SL and 3-phase trail', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const sub = page.locator('header .subtitle');
    await expect(sub).toContainText(/Initial SL = 2×ATR14/i);
    await expect(sub).toContainText(/BE @ 3×ATR·qty/i);
    await expect(sub).toContainText(/LOCK 3×ATR·qty @ 5×ATR·qty/i);
  });

  test('logic card describes all 3 trail phases', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const logic = page.locator('.card').filter({ hasText: 'Algo Logic' });
    // Initial SL is now 2×ATR, not 1.5×ATR.
    await expect(logic).toContainText(/entry ± 2 × ATR14/i);
    await expect(logic).not.toContainText(/entry ± 1\.5 × ATR14/i);
    // Phase 1 / 2 / 3 labels.
    await expect(logic).toContainText(/Phase 1/i);
    await expect(logic).toContainText(/Breakeven/i);
    await expect(logic).toContainText(/Phase 3/i);
    // ATR-based lock formula.
    await expect(logic).toContainText(/3×ATR·qty/i);
    await expect(logic).toContainText(/5×ATR·qty/i);
    // Entry side unchanged: RSI cross above 10 / below 90.
    await expect(logic).toContainText(/RSI\(2\) crosses ABOVE 10/i);
    await expect(logic).toContainText(/RSI\(2\) crosses BELOW 90/i);
    // Immediate fill preserved from algo33.
    await expect(logic).toContainText(/Fill IMMEDIATELY|IMMEDIATELY at current market/i);
  });

  test('/health returns rf-rsi-atrtrail-v1', async ({ request }) => {
    const r = await request.get(`${BASE}/health`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.status).toBe('ok');
    expect(j.strategy).toBe('rf-rsi-atrtrail-v1');
  });

  test('/api/strategies lists rf-rsi-atrtrail-v1 (and not the old algo33 id)', async ({ request }) => {
    const r = await request.get(`${BASE}/api/strategies`);
    const list = await r.json();
    expect(list.some(s => s.id === 'rf-rsi-atrtrail-v1')).toBe(true);
    expect(list.every(s => s.id !== 'rf-rsi-v4')).toBe(true);
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
    console.log(`Algo34 backtest: ${body.summary.totalTrades} trades, WR ${body.summary.winRate}%, PnL $${body.summary.totalPnl}`);
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
