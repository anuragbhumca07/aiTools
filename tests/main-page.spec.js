// @ts-check
const { test, expect } = require('@playwright/test');

const HUB      = 'http://localhost:3000';
const SERVICES = [
  { name: 'Quiz Video Generator', url: 'http://localhost:3001' },
  { name: 'Social Media Uploader', url: 'http://localhost:3005' },
  { name: 'AI Explainer',          url: 'http://localhost:3002' },
  { name: 'Quiz Scheduler',        url: 'http://localhost:3003' },
  { name: 'Question Creator',      url: 'http://localhost:3004' },
  { name: 'vCreator',              url: 'http://localhost:3008' },
  { name: 'aiBhakti',             url: 'http://localhost:3007' },
];

test.describe('AI Tools Hub — localhost', () => {

  test('main page loads with correct title and hub header', async ({ page }) => {
    await page.goto(HUB);
    await expect(page).toHaveTitle(/AI Hub/);
    await expect(page.locator('h1')).toContainText('AI Tools');
    await expect(page.locator('.stat-num').first()).toHaveText('6');
  });

  test('all 7 live tool cards are visible with localhost URLs', async ({ page }) => {
    await page.goto(HUB);
    const cards = page.locator('.tool-card:not(.soon)');
    await expect(cards).toHaveCount(7);

    for (const { name, url } of SERVICES) {
      const card = page.locator(`.tool-card[href="${url}"]`);
      await expect(card).toBeVisible();
      await expect(card.locator('h2')).toContainText(name);
    }
  });

  test('no Railway or Cloudflare Pages URLs remain in tool cards', async ({ page }) => {
    await page.goto(HUB);
    const cards = page.locator('.tool-card:not(.soon)');
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      const href = await cards.nth(i).getAttribute('href');
      expect(href).toMatch(/^http:\/\/localhost:/);
    }
  });

  test('auth modal opens and closes', async ({ page }) => {
    await page.goto(HUB);
    await page.click('button:has-text("Sign In to AI Hub")');
    await expect(page.locator('.auth-overlay')).toHaveClass(/show/);
    await page.click('.auth-close');
    await expect(page.locator('.auth-overlay')).not.toHaveClass(/show/);
  });

  test.describe('individual service health', () => {
    for (const { name, url } of SERVICES) {
      // aiExplainer has no root route — check /health instead
      const checkUrl = url === 'http://localhost:3002' ? `${url}/health` : url;
      test(`${name} responds 200`, async ({ request }) => {
        const resp = await request.get(checkUrl, { timeout: 8000 });
        expect(resp.ok()).toBeTruthy();
      });
    }
  });

});
