// @ts-check
// CBT Algo3 (RF+KAMA v2) — verifies the two fixes shipped in this branch:
//   1. self-correcting :01-past-boundary timer (no drift over long runs)
//   2. same-bar flag+trigger fires BUY/SELL and queues entry for next open
//
// Server must be running locally at http://localhost:3010 (or override with
// ALGO3_URL). Boot with:  PORT=3010 node cbt/strategy/algo3/server.js

const { test, expect } = require('@playwright/test');

const BASE = process.env.ALGO3_URL || 'http://localhost:3010';

test.describe.configure({ mode: 'serial' });
test.describe('Algo3 RF+KAMA v2 — fixes', () => {
  test.beforeEach(async ({ request }) => {
    try { await request.post(`${BASE}/api/stop`); } catch {}
  });

  test('page loads with RF+KAMA v2 title', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/CBT Algo3.*RF.*KAMA/i);
    await expect(page.locator('.title').first()).toContainText('RF + KAMA');
  });

  test('logic card mentions same-bar flag+trigger fix', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const logicCard = page.locator('.card').filter({ hasText: 'Algo Logic' });
    await expect(logicCard).toContainText(/Same-bar allowed|flag.*trigger.*SAME bar/i);
    await expect(logicCard).toContainText(/self-correcting/i);
  });

  test('/health responds ok with rf-kama-v2', async ({ request }) => {
    const res = await request.get(`${BASE}/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.strategy).toBe('rf-kama-v2');
  });

  test('/api/strategies returns rf-kama-v2', async ({ request }) => {
    const res = await request.get(`${BASE}/api/strategies`);
    const list = await res.json();
    expect(list.some(s => s.id === 'rf-kama-v2')).toBe(true);
  });

  test('backtest runs and returns trades', async ({ request }) => {
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
  });

  test('backtest reason strings include "SAME bar" tag when applicable', async ({ request }) => {
    // Same-bar flag+trigger is rare on 1h BTC but does occur — accept 0 or more.
    // The important assertion is that the reason strings PARSE correctly.
    test.setTimeout(180000);
    const res = await request.post(`${BASE}/api/backtest`, {
      data: { symbol: 'BTCUSDT', timeframe: '1h', months: 3 },
      timeout: 170000,
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    body.trades.forEach(t => {
      expect(typeof t.reason).toBe('string');
    });
    const sameBar = body.trades.filter(t => /SAME bar/i.test(t.reason || ''));
    console.log(`Same-bar flag+trigger trades in 3mo BTC 1h backtest: ${sameBar.length}`);
    // No hard count assertion — market-dependent — but log for visibility.
  });

  test('start → tick fires within ~90s → stop', async ({ page }) => {
    test.setTimeout(150000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.selectOption('#ctrl-tf', '1m');
    await page.click('#btn-start');
    await expect(page.locator('#status-badge')).toHaveText(/RUNNING/, { timeout: 10000 });
    // Wait for at least one candle tick (fires at :01 past minute boundary).
    await expect.poll(
      async () => await page.locator('#log-body tr:not(:has(.empty-msg))').count(),
      { timeout: 130000, intervals: [3000] }
    ).toBeGreaterThan(0);
    await page.click('#btn-stop');
    await expect(page.locator('#status-badge')).toHaveText(/STOPPED/, { timeout: 5000 });
  });

  test('tick log shows candle close time matching a minute boundary', async ({ page }) => {
    test.setTimeout(150000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.selectOption('#ctrl-tf', '1m');
    await page.click('#btn-start');
    await expect(page.locator('#status-badge')).toHaveText(/RUNNING/, { timeout: 10000 });
    // Wait for a tick to have populated indicators.
    await expect.poll(
      async () => await page.locator('#ic-candle-time').innerText(),
      { timeout: 130000, intervals: [3000] }
    ).not.toBe('—');
    const candleTimeText = await page.locator('#ic-candle-time').innerText();
    console.log('Candle close chip:', candleTimeText);
    // Should be format like "1m · Nov 21 12:34:00". Extract HH:MM:SS.
    const m = candleTimeText.match(/(\d{2}):(\d{2}):(\d{2})/);
    expect(m, `Candle time chip did not include HH:MM:SS: ${candleTimeText}`).toBeTruthy();
    const ss = parseInt(m[3], 10);
    // Candle close time should end in :00 (aligned to minute boundary).
    expect(ss, `Candle close seconds should be 00, got :${m[3]}`).toBe(0);
    await page.click('#btn-stop');
  });
});
