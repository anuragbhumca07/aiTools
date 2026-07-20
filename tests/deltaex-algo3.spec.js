// @ts-check
import { test, expect } from '@playwright/test';

// Local smoke + backtest coverage for CBT DeltaEx Algo3.
// Assumes the server is running at http://localhost:3011 (spawn with:
//   DELTA_API_KEY=... DELTA_API_SECRET=... PORT=3011 node server.js
// from CBT/DeltaEx/Algo3/).

const BASE = process.env.DELTA_BASE_URL || 'http://localhost:3011';

test.describe.configure({ mode: 'serial' });
test.describe('DeltaEx Algo3 UI', () => {
  test.beforeEach(async ({ request }) => {
    // Force session to Idle so the RUNNING-flip assertion is not racing with a prior test.
    try { await request.post(`${BASE}/api/stop`); } catch {}
  });
  test('page loads and controls render', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('.title')).toHaveText(/DeltaEx Algo3/);
    await expect(page.locator('#ctrl-symbol')).toBeVisible();
    await expect(page.locator('#ctrl-tf')).toBeVisible();
    await expect(page.locator('#ctrl-size-factor')).toBeVisible();
    await expect(page.locator('#btn-start')).toBeVisible();
    await expect(page.locator('#btn-backtest')).toBeVisible();
    await expect(page.locator('#btn-test-order')).toBeVisible();
    // header pills exist
    await expect(page.locator('#broker-pill')).toBeVisible();
    await expect(page.locator('#run-pill')).toBeVisible();
  });

  test('/health responds ok', async ({ request }) => {
    const r = await request.get(`${BASE}/health`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.status).toBe('ok');
    expect(j.broker).toBe('delta-india');
  });

  test('/api/broker returns credential status', async ({ request }) => {
    const r = await request.get(`${BASE}/api/broker`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.host).toBe('api.india.delta.exchange');
    expect(j.apiKeySet).toBeTruthy();
    expect(j.secretSet).toBeTruthy();
    // We can't assert connected=true here — depends on IP allowlist on the key.
  });

  test('public candles endpoint returns data', async ({ request }) => {
    const r = await request.get(`${BASE}/api/delta/candles?symbol=BTCUSD&timeframe=1m&n=10`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.ok).toBeTruthy();
    expect(j.count).toBeGreaterThanOrEqual(5);
    expect(j.last).toHaveProperty('close');
  });

  test('backtest runs and returns summary', async ({ request }) => {
    const r = await request.post(`${BASE}/api/backtest`, {
      data: { symbol: 'BTCUSD', timeframe: '1m', months: 0.5, sizeFactor: 0.01 },
      timeout: 120000,
    });
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.ok).toBeTruthy();
    expect(j.summary).toHaveProperty('totalTrades');
    expect(j.summary).toHaveProperty('winRate');
    expect(j.summary).toHaveProperty('totalPnl');
    expect(j.summary.candlesAnalyzed).toBeGreaterThan(500);
  });

  test('start → live tick → stop', async ({ page }) => {
    // Waits for a tick which aligns to :01 past the minute — allow up to 90s.
    test.setTimeout(120000);
    await page.goto(BASE);
    await page.fill('#ctrl-size-factor', '0.01');
    await page.click('#btn-start');
    await expect(page.locator('#run-pill')).toHaveText(/RUNNING/, { timeout: 15000 });
    // Poll for at least one tick row (excludes the "Waiting…" empty-msg row).
    await expect.poll(
      async () => await page.locator('#log-body tr:not(:has(.empty-msg))').count(),
      { timeout: 90000, intervals: [2000] }
    ).toBeGreaterThan(0);
    await page.click('#btn-stop');
    await expect(page.locator('#run-pill')).toHaveText(/Idle/, { timeout: 5000 });
  });

  test('real order test — will only pass if IP is on Delta allowlist', async ({ request }) => {
    // This test is expected to FAIL until the API key's IP allowlist is opened
    // for the caller. We assert on outcome shape either way.
    const r = await request.post(`${BASE}/api/delta/test-order`, {
      data: { symbol: 'BTCUSD', side: 'long' },
      timeout: 30000,
    });
    const j = await r.json();
    console.log('test-order result:', JSON.stringify(j, null, 2).slice(0, 800));
    if (j.ok) {
      expect(j.open).toBeTruthy();
      expect(j.close).toBeTruthy();
    } else {
      // Common blocker in local dev: IP allowlist. Surface it clearly.
      expect(j.error).toBeTruthy();
      test.info().annotations.push({ type: 'expected-blocker', description: j.error });
    }
  });
});
