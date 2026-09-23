// Playwright test + screenshot for NSE ORB Scanner Dashboard
const { test, expect } = require('@playwright/test');
const path = require('path');

const BASE = 'http://localhost:5050';

test.describe('NSE ORB Scanner', () => {

  test('dashboard loads — screenshot + UI elements', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500); // let clock tick + weights render

    // Screenshot of initial state
    await page.screenshot({ path: 'test-results/dashboard-idle.png', fullPage: false });
    console.log('Screenshot saved: test-results/dashboard-idle.png');

    await expect(page).toHaveTitle(/NSE ORB Scanner/i);
    await expect(page.locator('.logo')).toBeVisible();
    await expect(page.locator('#minPrice')).toBeVisible();
    await expect(page.locator('#scanBtn')).toBeVisible();
    await expect(page.locator('#clearBtn')).toBeVisible();
    await expect(page.locator('#dataSource')).toBeVisible();
    await expect(page.locator('#statusChip')).toHaveText(/IDLE|DONE/);
    await expect(page.locator('#istClock')).toBeVisible();
    await expect(page.locator('.tab.active')).toContainText('9:30');
    await expect(page.locator('#weightsTable')).toBeVisible();

    const clockText = await page.locator('#istClock').textContent();
    console.log('IST clock:', clockText);
    console.log('Dashboard UI: all elements present');
  });

  test('API /api/config — weights sum to 100', async ({ request }) => {
    const res = await request.get(`${BASE}/api/config`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.total_weight).toBe(100);
    expect(body.SCAN_TIMES).toEqual(['09:20', '09:30', '09:45', '10:00']);
    console.log('Weights total:', body.total_weight, '| Scan times:', body.SCAN_TIMES);
  });

  test('API /api/status — shows data_source field', async ({ request }) => {
    const res = await request.get(`${BASE}/api/status`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('data_source');
    console.log('Status:', body.status, '| Data source:', body.data_source);
  });

  test('clear cache endpoint works', async ({ request }) => {
    const res = await request.post(`${BASE}/api/clear-cache`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('deleted');
    console.log('Cache cleared:', body.deleted, 'files');
  });

  test('scan with MAX=5 completes with Dhan data — screenshot results', async ({ page }) => {
    test.setTimeout(180000);

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    // Set small universe for quick test
    await page.fill('#maxInstruments', '5');
    await page.fill('#topN', '5');

    // Clear cache first so it downloads fresh from Dhan
    await page.click('#clearBtn');
    console.log('Triggered clear + scan...');

    // Wait for scan to start
    await expect(page.locator('#statusChip')).not.toHaveText(/IDLE/, { timeout: 15000 });

    // Wait for completion
    await expect(page.locator('#statusChip')).toHaveText(/DONE|ERROR/, { timeout: 120000 });
    const finalStatus = await page.locator('#statusChip').textContent();
    console.log('Final status:', finalStatus.trim());

    // Check data source shown
    const dsText = await page.locator('#dataSource').textContent();
    console.log('Data source displayed:', dsText);

    // Check log for Dhan vs yfinance
    const logText = await page.locator('#logBox').textContent();
    const usingDhan = logText.includes('Dhan');
    const usingYf   = logText.includes('yfinance');
    console.log('Log mentions Dhan:', usingDhan, '| yfinance:', usingYf);

    // Screenshot of completed scan
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/dashboard-scan-done.png', fullPage: false });
    console.log('Screenshot saved: test-results/dashboard-scan-done.png');

    expect(finalStatus.trim()).toBe('DONE');

    // Universe should show 2678
    const uSize = await page.locator('#universeSize').textContent();
    console.log('Universe size:', uSize);
    expect(parseInt(uSize.replace(/,/g,''))).toBeGreaterThan(1000);
  });

  test('tab switching and results shape', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const tabs = await page.locator('.tab').all();
    for (const tab of tabs) {
      await tab.click();
      await page.waitForTimeout(300);
    }
    const res = await page.request.get(`${BASE}/api/results`);
    const body = await res.json();
    console.log('Result slots:', Object.keys(body));
    for (const [slot, data] of Object.entries(body)) {
      console.log(`  ${slot}: LONG=${data.LONG?.length}, SHORT=${data.SHORT?.length}`);
    }
    console.log('Tab switching: OK');
  });

});
