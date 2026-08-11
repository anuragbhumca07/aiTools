// @ts-check
import { test, expect } from '@playwright/test';

// Smoke + integration tests for CBT DeltaEx Algo1 (EMA Ribbon Swing + Commodities).
// Expects server running at http://localhost:3012 (or DELTA_ALGO1_BASE_URL env var).
//
// Start locally:
//   DELTA_API_KEY=... DELTA_API_SECRET=... PORT=3012 node server.js
// from CBT/DeltaEx/Algo1/

const BASE = process.env.DELTA_ALGO1_BASE_URL || 'http://localhost:3012';

test.describe.configure({ mode: 'serial' });
test.describe('DeltaEx Algo1 — EMA Ribbon Swing', () => {

  test.beforeEach(async ({ request }) => {
    try { await request.post(`${BASE}/api/stop`); } catch {}
  });

  // ── Health & config ────────────────────────────────────────────
  test('/health responds ok with correct strategy info', async ({ request }) => {
    const r = await request.get(`${BASE}/health`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.status).toBe('ok');
    expect(j.strategy).toBe('swing-v3-delta');
    expect(j.broker).toBe('delta-india');
    expect(Array.isArray(j.supportedSymbols)).toBeTruthy();
    expect(j.supportedSymbols).toContain('BTCUSD');
    expect(j.supportedSymbols).toContain('XAUUSD');
  });

  test('/api/symbols returns crypto + commodity list', async ({ request }) => {
    const r = await request.get(`${BASE}/api/symbols`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(Array.isArray(j)).toBeTruthy();
    const symbols = j.map(s => s.symbol);
    // Crypto live
    expect(symbols).toContain('BTCUSD');
    expect(symbols).toContain('ETHUSD');
    // Commodities paper
    expect(symbols).toContain('XAUUSD');
    expect(symbols).toContain('XAGUSD');
    expect(symbols).toContain('WTIUSD');
    // Verify data source labelling
    const btc  = j.find(s => s.symbol === 'BTCUSD');
    const gold = j.find(s => s.symbol === 'XAUUSD');
    expect(btc.live).toBeTruthy();
    expect(btc.dataSource).toBe('delta');
    expect(gold.live).toBeFalsy();
    expect(gold.dataSource).toBe('yahoo-finance');
  });

  // ── Page load & UI ────────────────────────────────────────────
  test('page loads with correct title and controls', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('.title')).toContainText('EMA Ribbon Swing');
    await expect(page.locator('#ctrl-symbol')).toBeVisible();
    await expect(page.locator('#ctrl-tf')).toBeVisible();
    await expect(page.locator('#ctrl-balance')).toBeVisible();
    await expect(page.locator('#btn-start')).toBeVisible();
    await expect(page.locator('#btn-backtest')).toBeVisible();
    await expect(page.locator('#btn-test-order')).toBeVisible();
    await expect(page.locator('#broker-pill')).toBeVisible();
    await expect(page.locator('#run-pill')).toBeVisible();
  });

  test('commodity symbols are present in dropdown', async ({ page }) => {
    await page.goto(BASE);
    const options = await page.locator('#ctrl-symbol option').allInnerTexts();
    const labels  = options.join(' ');
    expect(labels).toContain('Gold');
    expect(labels).toContain('Silver');
    expect(labels).toContain('Crude Oil');
    expect(labels).toContain('Natural Gas');
    expect(labels).toContain('BTCUSD');
    expect(labels).toContain('ETHUSD');
  });

  test('selecting commodity shows paper badge and data-source info', async ({ page }) => {
    await page.goto(BASE);
    await page.selectOption('#ctrl-symbol', 'XAUUSD');
    await expect(page.locator('#paper-badge')).toBeVisible();
    const info = await page.locator('#datasource-info').innerText();
    expect(info).toContain('Yahoo Finance');
    expect(info).toContain('paper');
  });

  test('selecting BTCUSD hides paper badge', async ({ page }) => {
    await page.goto(BASE);
    await page.selectOption('#ctrl-symbol', 'XAUUSD'); // set to commodity first
    await page.selectOption('#ctrl-symbol', 'BTCUSD');
    await expect(page.locator('#paper-badge')).toBeHidden();
    const info = await page.locator('#datasource-info').innerText();
    expect(info).toContain('Delta Exchange');
  });

  // ── Broker & credential check ──────────────────────────────────
  test('/api/broker returns Delta credential status', async ({ request }) => {
    const r = await request.get(`${BASE}/api/broker`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.host).toBe('api.india.delta.exchange');
    expect(typeof j.apiKeySet).toBe('boolean');
    expect(typeof j.secretSet).toBe('boolean');
    expect(Array.isArray(j.liveSymbols)).toBeTruthy();
    expect(j.liveSymbols).toContain('BTCUSD');
    expect(Array.isArray(j.paperSymbols)).toBeTruthy();
    expect(j.paperSymbols).toContain('XAUUSD');
  });

  // ── Candle data endpoints ──────────────────────────────────────
  test('/api/delta/candles returns BTCUSD data', async ({ request }) => {
    const r = await request.get(`${BASE}/api/delta/candles?symbol=BTCUSD&timeframe=1m&n=10`, { timeout: 30000 });
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.ok).toBeTruthy();
    expect(j.count).toBeGreaterThanOrEqual(5);
    expect(j.last).toHaveProperty('close');
    expect(j.last).toHaveProperty('time');
  });

  test('/api/candles returns Gold (XAUUSD) data via Yahoo Finance', async ({ request }) => {
    let r;
    try {
      r = await request.get(`${BASE}/api/candles?symbol=XAUUSD&timeframe=1h&n=10`, { timeout: 45000 });
    } catch (e) {
      test.info().annotations.push({ type: 'skip', description: `Network/timeout: ${e.message}` });
      return;
    }
    const j = await r.json();
    if (j.ok) {
      expect(j.count).toBeGreaterThanOrEqual(1);
      expect(j.last).toHaveProperty('close');
    } else {
      test.info().annotations.push({ type: 'skip', description: `Yahoo Finance unavailable: ${j.error}` });
    }
  });

  test('/api/candles returns Silver (XAGUSD) data via Yahoo Finance', async ({ request }) => {
    let r;
    try {
      r = await request.get(`${BASE}/api/candles?symbol=XAGUSD&timeframe=1h&n=5`, { timeout: 45000 });
    } catch (e) {
      test.info().annotations.push({ type: 'skip', description: `Network/timeout: ${e.message}` });
      return;
    }
    const j = await r.json();
    if (j.ok) {
      expect(j.count).toBeGreaterThanOrEqual(1);
      expect(j.last).toHaveProperty('close');
    } else {
      test.info().annotations.push({ type: 'skip', description: `Yahoo Finance unavailable: ${j.error}` });
    }
  });

  // ── State & strategy API ───────────────────────────────────────
  test('/api/state returns valid initial state', async ({ request }) => {
    const r = await request.get(`${BASE}/api/state`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(typeof j.running).toBe('boolean');
    expect(typeof j.balance).toBe('number');
    expect(typeof j.winRate).toBe('string');
  });

  test('/api/strategies lists swing-v3-delta', async ({ request }) => {
    const r = await request.get(`${BASE}/api/strategies`);
    const j = await r.json();
    expect(Array.isArray(j)).toBeTruthy();
    const ids = j.map(s => s.id);
    expect(ids).toContain('swing-v3-delta');
  });

  // ── Start / Stop (chromium-only to avoid cross-browser session race) ──
  test('start → running → stop (BTCUSD)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Run on chromium only to avoid shared-session race');
    test.setTimeout(120000);
    await page.goto(BASE);
    await page.selectOption('#ctrl-symbol', 'BTCUSD');
    await page.click('#btn-start');
    await expect(page.locator('#run-pill')).toHaveText(/RUNNING/, { timeout: 15000 });
    await expect.poll(
      async () => await page.locator('#log-body tr:not(:has(.empty-msg))').count(),
      { timeout: 90000, intervals: [2000] }
    ).toBeGreaterThan(0);
    // Use page.request so stop goes to the same session the page started
    await page.request.post(`${BASE}/api/stop`);
    await expect(page.locator('#run-pill')).toHaveText(/Idle/, { timeout: 5000 });
  });

  test('start → paper mode for Gold (XAUUSD)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Run on chromium only to avoid shared-session race');
    test.setTimeout(60000);
    await page.goto(BASE);
    await page.selectOption('#ctrl-symbol', 'XAUUSD');
    await page.selectOption('#ctrl-tf', '1h');
    await page.click('#btn-start');
    await expect(page.locator('#run-pill')).toHaveText(/RUNNING/, { timeout: 15000 });
    const mode = await page.locator('#mode-pill').innerText();
    expect(mode).toContain('paper');
    // Use page.request so stop goes to the same session the page started
    await page.request.post(`${BASE}/api/stop`);
    await expect(page.locator('#run-pill')).toHaveText(/Idle/, { timeout: 10000 });
  });

  // ── Backtest ──────────────────────────────────────────────────
  test('backtest BTCUSD returns summary', async ({ request }) => {
    const r = await request.post(`${BASE}/api/backtest`, {
      data: { symbol: 'BTCUSD', timeframe: '1m', months: 0.1 },
      timeout: 120000,
    });
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.ok).toBeTruthy();
    expect(j.summary).toHaveProperty('totalTrades');
    expect(j.summary).toHaveProperty('winRate');
    expect(j.summary).toHaveProperty('totalPnl');
    expect(j.summary.candlesAnalyzed).toBeGreaterThan(200);
  });

  test('backtest Gold (XAUUSD) on 1h returns summary or clear error', async ({ request }) => {
    const r = await request.post(`${BASE}/api/backtest`, {
      data: { symbol: 'XAUUSD', timeframe: '1h', months: 1 },
      timeout: 120000,
    });
    const j = await r.json();
    if (j.ok) {
      expect(j.summary.symbol).toBe('XAUUSD');
      expect(j.summary).toHaveProperty('totalTrades');
    } else {
      // Acceptable if Yahoo Finance returns insufficient data
      expect(j.error).toBeTruthy();
      console.log('Gold backtest skipped:', j.error);
    }
  });

  // ── Live order test (Delta) ───────────────────────────────────
  test('real order test — requires Delta creds + IP allowlist', async ({ request }) => {
    const r = await request.post(`${BASE}/api/delta/test-order`, {
      data: { symbol: 'BTCUSD', side: 'long' },
      timeout: 30000,
    });
    const j = await r.json();
    console.log('test-order result:', JSON.stringify(j, null, 2).slice(0, 600));
    if (j.ok) {
      expect(j.open).toBeTruthy();
      expect(j.close).toBeTruthy();
    } else {
      expect(j.error).toBeTruthy();
      test.info().annotations.push({ type: 'expected-blocker', description: j.error });
    }
  });

  test('test-order rejected for commodity symbols', async ({ request }) => {
    const r = await request.post(`${BASE}/api/delta/test-order`, {
      data: { symbol: 'XAUUSD', side: 'long' },
      timeout: 10000,
    });
    const j = await r.json();
    expect(j.ok).toBeFalsy();
    // When creds missing: "creds missing"; when creds set but paper symbol: "paper-only"
    expect(j.error).toMatch(/paper-only|creds missing/);
  });

  // ── Reset ─────────────────────────────────────────────────────
  test('reset clears trades and returns ok', async ({ request }) => {
    const r = await request.post(`${BASE}/api/reset`);
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.ok).toBeTruthy();
    expect(typeof j.tradesCleared).toBe('number');
  });
});
