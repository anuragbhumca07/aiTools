'use strict';
/**
 * Step 2: Find and use the Robinhood API key settings page.
 * The session cookies from step 1 are already in the browser — connect to it.
 */

const { chromium } = require('playwright');
const path = require('path');

const PUBLIC_KEY = 'B6mstAn+3YvqwfBPkmsBNKGa576uZfii/QU+vuMs5js=';

// URLs to try for crypto API settings
const API_URLS = [
  'https://robinhood.com/account/settings/',
  'https://robinhood.com/account/',
  'https://robinhood.com/crypto/api/',
  'https://robinhood.com/account/crypto/',
];

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const ctx     = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await ctx.newPage();

  // We need to log in again since we're in a new context
  const USERNAME = 'anurag.3816@gmail.com';
  const PASSWORD = 'SriMadhav12#';

  console.log('Logging in…');
  await page.goto('https://robinhood.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"], input[type="email"]', { timeout: 15000 });
  await page.fill('input[name="username"], input[type="email"]', USERNAME);
  await page.fill('input[name="password"], input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');

  console.log('Waiting for login… (complete any MFA in the browser)');
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 90000 });
  console.log('Logged in! URL:', page.url());

  // Navigate to Account Settings
  console.log('Going to Account Settings…');
  await page.goto('https://robinhood.com/account/settings/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const ss1 = path.join(__dirname, 'ss-settings.png');
  await page.screenshot({ path: ss1, fullPage: true });
  console.log('Screenshot:', ss1);

  // Search for "API" link on the settings page
  const apiLinks = await page.$$eval('a, button', els =>
    els.filter(e => /api|key/i.test(e.textContent || e.innerText || ''))
       .map(e => ({ text: (e.textContent || '').trim().slice(0,80), href: e.href || '' }))
  );
  console.log('API-related links/buttons:', JSON.stringify(apiLinks, null, 2));

  // Try clicking any API-related item
  if (apiLinks.length > 0) {
    try {
      const el = await page.$('a:has-text("API"), button:has-text("API"), a:has-text("api")');
      if (el) { await el.click(); await page.waitForTimeout(2000); }
    } catch {}
  }

  // Also check the Account menu
  await page.goto('https://robinhood.com/account/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  const ss2 = path.join(__dirname, 'ss-account.png');
  await page.screenshot({ path: ss2, fullPage: true });
  console.log('Screenshot:', ss2);

  const accountLinks = await page.$$eval('a', els =>
    els.map(e => ({ text: (e.textContent || '').trim().slice(0,60), href: e.href || '' }))
       .filter(e => e.text)
  );
  console.log('All account links:', JSON.stringify(accountLinks.slice(0, 40), null, 2));

  console.log('\nBrowser is open — please navigate to the API key settings manually.');
  console.log('Public Key to paste:', PUBLIC_KEY);
  await new Promise(() => {});
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
