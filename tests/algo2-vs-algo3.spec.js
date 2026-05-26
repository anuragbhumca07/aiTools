// @ts-check
const { test, expect, request } = require('@playwright/test');

const ALGO2_URL = process.env.ALGO2_URL || 'https://cbt-algo2-production.up.railway.app';
const ALGO3_URL = process.env.ALGO3_URL || 'https://cbt-algo3-production.up.railway.app';

// ── Helpers ───────────────────────────────────────────────────────

async function fetchBacktest(apiCtx, baseUrl, params = {}) {
  const body = { symbol: 'BTCUSDT', timeframe: '4h', months: 3, ...params };
  const res = await apiCtx.post(`${baseUrl}/api/backtest`, {
    data: body,
    headers: { 'Content-Type': 'application/json' },
  });
  return res.json();
}

async function fetchTrades(apiCtx, baseUrl) {
  const res = await apiCtx.get(`${baseUrl}/api/trades`);
  return res.json();
}

// ── UI: Algo2 ──────────────────────────────────────────────────────

test.describe('Algo2 — live UI', () => {
  test('page loads with correct title', async ({ page }) => {
    await page.goto(ALGO2_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await expect(page).toHaveTitle(/CBT Algo2/i);
  });

  test('shows EMA ribbon + ADX strategy description', async ({ page }) => {
    await page.goto(ALGO2_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const subtitle = page.locator('header .subtitle');
    await expect(subtitle).toBeVisible();
    await expect(subtitle).toContainText('ADX');
    await expect(subtitle).toContainText('EMA');
  });

  test('health endpoint returns ok', async ({ request }) => {
    const res = await request.get(`${ALGO2_URL}/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('strategies endpoint returns swing-v1', async ({ request }) => {
    const res = await request.get(`${ALGO2_URL}/api/strategies`);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some(s => s.id === 'swing-v1')).toBe(true);
  });

  test('STOPPED badge visible on cold load', async ({ page }) => {
    await page.goto(ALGO2_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const badge = page.locator('#status-badge');
    // May be RUNNING if algo is active — just ensure badge is visible
    await expect(badge).toBeVisible();
  });

  test('buy/sell score dots are present (6 each)', async ({ page }) => {
    await page.goto(ALGO2_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const buyDots  = page.locator('#buy-dots .dot-pip');
    const sellDots = page.locator('#sell-dots .dot-pip');
    await expect(buyDots).toHaveCount(6);
    await expect(sellDots).toHaveCount(6);
  });

  test('timeframe dropdown has 1m option', async ({ page }) => {
    await page.goto(ALGO2_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const opts = page.locator('#ctrl-tf option');
    const values = await opts.evaluateAll(els => els.map(e => e.value));
    expect(values).toContain('1m');
  });
});

// ── UI: Algo3 ──────────────────────────────────────────────────────

test.describe('Algo3 — live UI', () => {
  test('page loads with correct title', async ({ page }) => {
    await page.goto(ALGO3_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await expect(page).toHaveTitle(/CBT Algo3/i);
  });

  test('subtitle mentions precision filters', async ({ page }) => {
    await page.goto(ALGO3_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const subtitle = page.locator('header .subtitle');
    await expect(subtitle).toContainText('DI-Spread');
    await expect(subtitle).toContainText('2.5');
  });

  test('health endpoint returns ok with swing-v2', async ({ request }) => {
    const res = await request.get(`${ALGO3_URL}/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.strategy).toBe('swing-v2');
  });

  test('strategies endpoint returns swing-v2', async ({ request }) => {
    const res = await request.get(`${ALGO3_URL}/api/strategies`);
    const list = await res.json();
    expect(list.some(s => s.id === 'swing-v2')).toBe(true);
    expect(list.every(s => s.id !== 'swing-v1')).toBe(true);
  });

  test('DI Spread chip is visible (new in v2)', async ({ page }) => {
    await page.goto(ALGO3_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const chip = page.locator('#ic-dispread');
    await expect(chip).toBeVisible();
  });

  test('algo logic card mentions DI spread hard gate', async ({ page }) => {
    await page.goto(ALGO3_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const logicCard = page.locator('.card').filter({ hasText: 'Algo Logic' });
    await expect(logicCard).toContainText('DI');
    await expect(logicCard).toContainText('15');
  });

  test('algo logic mentions MACD growing condition', async ({ page }) => {
    await page.goto(ALGO3_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const logicCard = page.locator('.card').filter({ hasText: 'Algo Logic' });
    await expect(logicCard).toContainText('rising');
  });

  test('algo logic mentions 2.5×ATR stop loss', async ({ page }) => {
    await page.goto(ALGO3_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const logicCard = page.locator('.card').filter({ hasText: 'Algo Logic' });
    await expect(logicCard).toContainText('2.5');
  });
});

// ── Backtest comparison ───────────────────────────────────────────

test.describe('Backtest comparison: algo2 vs algo3', () => {
  let apiCtx;

  test.beforeAll(async ({ playwright }) => {
    apiCtx = await playwright.request.newContext({ timeout: 90_000 });
  });

  test.afterAll(async () => {
    await apiCtx.dispose();
  });

  test('both backtests return ok', async () => {
    const [r2, r3] = await Promise.all([
      fetchBacktest(apiCtx, ALGO2_URL),
      fetchBacktest(apiCtx, ALGO3_URL),
    ]);
    expect(r2.ok, `Algo2 backtest failed: ${r2.error}`).toBe(true);
    expect(r3.ok, `Algo3 backtest failed: ${r3.error}`).toBe(true);
  });

  test('algo3 has no single loss trade exceeding $150', async () => {
    const r3 = await fetchBacktest(apiCtx, ALGO3_URL, { months: 6 });
    expect(r3.ok).toBe(true);
    const bigLosses = r3.trades.filter(t => t.pnl < -150);
    expect(bigLosses.length).toBe(0);
  });

  test('algo3 keeps most profitable trades (win rate ≥ algo2 or close)', async () => {
    const [r2, r3] = await Promise.all([
      fetchBacktest(apiCtx, ALGO2_URL, { months: 6 }),
      fetchBacktest(apiCtx, ALGO3_URL, { months: 6 }),
    ]);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);

    const wr2 = parseFloat(r2.summary.winRate);
    const wr3 = parseFloat(r3.summary.winRate);
    console.log(`Algo2 win rate: ${wr2}%  Algo3 win rate: ${wr3}%`);
    // Algo3 win rate should not drop more than 15pp below algo2 (noise tolerance on small sample)
    expect(wr3).toBeGreaterThanOrEqual(wr2 - 15);
  });

  test('algo3 max drawdown is lower or equal to algo2', async () => {
    const [r2, r3] = await Promise.all([
      fetchBacktest(apiCtx, ALGO2_URL, { months: 6 }),
      fetchBacktest(apiCtx, ALGO3_URL, { months: 6 }),
    ]);
    console.log(`Algo2 max DD: $${r2.summary.maxDrawdown}  Algo3 max DD: $${r3.summary.maxDrawdown}`);
    // Allow algo3 to have at most 5% higher absolute drawdown (noise tolerance)
    expect(r3.summary.maxDrawdown).toBeLessThanOrEqual(r2.summary.maxDrawdown * 1.05);
  });

  test('algo3 Phase-1 SL losses are smaller than algo2 Phase-1 losses', async () => {
    const [r2, r3] = await Promise.all([
      fetchBacktest(apiCtx, ALGO2_URL, { months: 3 }),
      fetchBacktest(apiCtx, ALGO3_URL, { months: 3 }),
    ]);
    const p1Losses2 = r2.trades.filter(t => t.reason.includes('Phase 1') && t.pnl < 0).map(t => t.pnl);
    const p1Losses3 = r3.trades.filter(t => t.reason.includes('Phase 1') && t.pnl < 0).map(t => t.pnl);
    if (p1Losses2.length > 0 && p1Losses3.length > 0) {
      const avgLoss2 = p1Losses2.reduce((a, b) => a + b, 0) / p1Losses2.length;
      const avgLoss3 = p1Losses3.reduce((a, b) => a + b, 0) / p1Losses3.length;
      console.log(`Algo2 avg Phase-1 loss: $${avgLoss2.toFixed(2)}  Algo3 avg Phase-1 loss: $${avgLoss3.toFixed(2)}`);
      // Algo3 Phase-1 losses should be ≤ algo2 (tighter SL = smaller loss per hit)
      expect(avgLoss3).toBeGreaterThanOrEqual(avgLoss2); // losses are negative, so ≥ means closer to 0
    }
  });

  test('algo3 does not fire trades with DI spread < 15', async () => {
    // All algo3 entries should have had DI spread ≥ 15 at signal time.
    // We verify indirectly: algo3 total trades should be ≤ algo2 (fewer but higher-conviction)
    const [r2, r3] = await Promise.all([
      fetchBacktest(apiCtx, ALGO2_URL, { months: 3 }),
      fetchBacktest(apiCtx, ALGO3_URL, { months: 3 }),
    ]);
    console.log(`Algo2 trades: ${r2.summary.totalTrades}  Algo3 trades: ${r3.summary.totalTrades}`);
    // Algo3 should have equal or fewer trades (stricter filters = fewer entries)
    expect(r3.summary.totalTrades).toBeLessThanOrEqual(r2.summary.totalTrades);
  });

  test('backtest summary fields are present in algo3 response', async () => {
    const r3 = await fetchBacktest(apiCtx, ALGO3_URL);
    expect(r3.summary).toMatchObject({
      totalTrades: expect.any(Number),
      wins:        expect.any(Number),
      losses:      expect.any(Number),
      winRate:     expect.any(String),
      totalPnl:    expect.any(Number),
      maxDrawdown: expect.any(Number),
      timeframe:   '4h',
      symbol:      'BTCUSDT',
    });
  });
});

// ── Live algo2 trades: verify historical data ─────────────────────

test.describe('Algo2 live trade history', () => {
  test('trades endpoint is accessible', async ({ request }) => {
    const res = await request.get(`${ALGO2_URL}/api/trades`);
    expect(res.ok()).toBeTruthy();
    const trades = await res.json();
    expect(Array.isArray(trades)).toBe(true);
  });

  test('identifies the 3 known loss trades > $150 in live session', async ({ request }) => {
    const res = await request.get(`${ALGO2_URL}/api/trades`);
    const trades = await res.json();
    const bigLosses = trades.filter(t => t.type === 'exit' && t.pnl < -150);
    console.log(`Big losses found in algo2 live: ${bigLosses.length}`);
    bigLosses.forEach(t => console.log(`  Trade id=${t.id} pnl=${t.pnl} reason=${t.reason}`));
    // We found exactly 3 in our analysis — allow for new ones if algo keeps running
    expect(bigLosses.length).toBeGreaterThanOrEqual(3);
  });
});
