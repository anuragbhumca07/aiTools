// @ts-check
// CBT TradingHome + every deployed algo Railway URL — full live smoke suite.
const { test, expect } = require('@playwright/test');

const HOME = 'https://trading-home-production.up.railway.app';

const ALGOS = [
  { name: 'Algo1',    group: 'Strategy',  url: 'https://cbt-algo1-production.up.railway.app',  titleContains: 'CBT' },
  { name: 'Algo2',    group: 'Strategy',  url: 'https://cbt-algo2-production.up.railway.app',  titleContains: 'Kronos' },
  { name: 'Algo3',    group: 'Strategy',  url: 'https://cbt-algo3-production.up.railway.app',  titleContains: 'CBT' },
  { name: 'Algo4',    group: 'Strategy',  url: 'https://algo4-production.up.railway.app',      titleContains: 'Algo4' },
  { name: 'Algo5',    group: 'Strategy',  url: 'https://algo5-production.up.railway.app',      titleContains: 'Algo5' },
  { name: 'Algo6',    group: 'Strategy',  url: 'https://cbt-algo6-production.up.railway.app',  titleContains: 'Algo' },
  { name: 'Algo11',   group: 'Strategy',  url: 'https://algo11-production.up.railway.app',     titleContains: 'Algo' },
  { name: 'Algo44',   group: 'Strategy',  url: 'https://algo44-production.up.railway.app',     titleContains: 'Algo44' },
  { name: 'Algo55',   group: 'Strategy',  url: 'https://algo55-production.up.railway.app',     titleContains: 'Algo55' },
  { name: 'Algo66',   group: 'Strategy',  url: 'https://algo66-production.up.railway.app',     titleContains: 'Algo' },
  { name: 'RobAlgo6', group: 'Robinhood', url: 'https://rob-algo6-production.up.railway.app',  titleContains: 'Rob' },
];

// Algos that should NOT show Date/Time (algo2 has no Time column at all).
const ALGOS_WITHOUT_DATE_TIME = new Set(['Algo2']);

// ─── TradingHome home page tests ──────────────────────────────────────────
test.describe('TradingHome home page', () => {
  test('home page loads and shows header', async ({ page }) => {
    await page.goto(HOME);
    await expect(page).toHaveTitle(/TradingHome|Algo Hub/);
    await expect(page.locator('header .title')).toContainText('CBT TradingHome');
    await expect(page.locator('#stat-total')).toContainText('14');
    await expect(page.locator('#stat-live')).toContainText('11');
  });

  test('home page renders all 5 groups', async ({ page }) => {
    await page.goto(HOME);
    await expect(page.locator('#group-tickmill')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#group-strategy')).toBeVisible();
    await expect(page.locator('#group-mt5')).toBeVisible();
    await expect(page.locator('#group-fyers')).toBeVisible();
    await expect(page.locator('#group-robinhood')).toBeVisible();
  });

  test('Strategy group has 10 algo cards', async ({ page }) => {
    await page.goto(HOME);
    await expect(page.locator('#group-strategy .algo-card')).toHaveCount(10, { timeout: 10000 });
  });

  test('Robinhood group has 1 deployed algo card with live status', async ({ page }) => {
    await page.goto(HOME);
    await expect(page.locator('#group-robinhood .algo-card.deployed')).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('#group-robinhood .algo-card[data-name="RobAlgo6"]')).toBeVisible();
  });

  test('Tickmill / MT5 / Fyers show LOCAL ONLY status', async ({ page }) => {
    await page.goto(HOME);
    await expect(page.locator('#group-tickmill .algo-card.local-only')).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('#group-mt5 .algo-card.local-only')).toHaveCount(1);
    await expect(page.locator('#group-fyers .algo-card.local-only')).toHaveCount(1);
    const localBadges = page.locator('.status-local');
    expect(await localBadges.count()).toBeGreaterThanOrEqual(3);
  });

  test('all 11 deployed cards flip from CHECKING to LIVE after probe', async ({ page }) => {
    test.setTimeout(60000);
    await page.goto(HOME);
    // Wait until every deployed card shows LIVE (probe finishes within ~30s)
    await expect.poll(
      async () => page.locator('.algo-card.deployed .status-live').count(),
      { timeout: 50000, intervals: [500, 1000, 2000] },
    ).toBe(11);
  });

  test('each deployed card has an OPEN link with the right https URL', async ({ page }) => {
    await page.goto(HOME);
    for (const a of ALGOS) {
      const card = page.locator(`.algo-card[data-name="${a.name}"]`);
      await expect(card).toBeVisible();
      const link = card.locator(`a[data-test="open-${a.name}"]`);
      await expect(link).toHaveAttribute('href', a.url);
      await expect(link).toHaveAttribute('target', '_blank');
    }
  });

  test('home page /health endpoint', async ({ request }) => {
    const r = await request.get(HOME + '/health');
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.status).toBe('ok');
    expect(j.service).toBe('cbt-trading-home');
    expect(j.algos).toBe(14);
    expect(j.deployed).toBe(11);
  });

  test('home page /api/algos returns full registry', async ({ request }) => {
    const r = await request.get(HOME + '/api/algos');
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.groups).toEqual(['Tickmill', 'Strategy', 'MT5', 'Fyers', 'Robinhood']);
    expect(j.algos.length).toBe(14);
  });

  test('home page screenshot', async ({ page }) => {
    test.setTimeout(60000);
    await page.goto(HOME);
    await expect(page.locator('#refresh-btn')).not.toBeDisabled({ timeout: 50000 });
    await page.screenshot({ path: 'tests/trading-home.png', fullPage: true });
  });
});

// ─── Per-algo Railway URL smoke tests ────────────────────────────────────
test.describe('Every deployed algo Railway URL', () => {
  for (const a of ALGOS) {
    test(`${a.group}/${a.name} (${a.url}) responds to /health`, async ({ request }) => {
      const r = await request.get(`${a.url}/health`, { timeout: 15000 });
      expect(r.ok()).toBeTruthy();
      const j = await r.json();
      expect(j.status).toBe('ok');
    });

    test(`${a.group}/${a.name} root page loads`, async ({ page }) => {
      await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const title = await page.title();
      expect(title.length).toBeGreaterThan(0);
      // Page should contain its name or a recognizable string
      expect(title.toLowerCase()).toContain(a.titleContains.toLowerCase());
    });

    if (!ALGOS_WITHOUT_DATE_TIME.has(a.name)) {
      test(`${a.group}/${a.name} ships the new Date/Time formatting`, async ({ request }) => {
        // Read raw HTML — algo4 renders its Date/Time <th> via JS only after backtest runs,
        // so we check the source instead of the live DOM.
        const r = await request.get(a.url, { timeout: 20000 });
        expect(r.ok()).toBeTruthy();
        const html = await r.text();
        const hits = (html.match(/Date\/Time/g) || []).length;
        expect(hits).toBeGreaterThanOrEqual(1);
      });
    }
  }
});

// ─── End-to-end: click an OPEN link from the home page, land on the algo ──
test('end-to-end: click Algo44 card OPEN link from home page', async ({ context, page }) => {
  test.setTimeout(60000);
  await page.goto(HOME);
  const [newPage] = await Promise.all([
    context.waitForEvent('page'),
    page.click('a[data-test="open-Algo44"]'),
  ]);
  await newPage.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await expect(newPage).toHaveURL(/algo44-production\.up\.railway\.app/);
  await expect(newPage).toHaveTitle(/Algo44/);
});
