'use strict';
const { chromium } = require('playwright');
const path = require('path');

const USERNAME   = 'anurag.3816@gmail.com';
const PASSWORD   = 'SriMadhav12#';
const PUBLIC_KEY = 'B6mstAn+3YvqwfBPkmsBNKGa576uZfii/QU+vuMs5js=';

const URLS_TO_CHECK = [
  'https://robinhood.com/account/crypto',
  'https://robinhood.com/crypto/trading',
  'https://api.robinhood.com/crypto/api_key/',
  'https://robinhood.com/account/security',
  'https://robinhood.com/account/settings/security-privacy',
];

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const ctx     = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await ctx.newPage();

  // Login
  await page.goto('https://robinhood.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"], input[type="email"]', { timeout: 15000 });
  await page.fill('input[name="username"], input[type="email"]', USERNAME);
  await page.fill('input[name="password"], input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  console.log('Waiting for login… (complete any MFA in the browser window)');
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 90000 });
  console.log('Logged in! URL:', page.url());

  // Try each URL
  for (const url of URLS_TO_CHECK) {
    console.log('\n--- Checking:', url);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
      const title = await page.title();
      const body  = await page.textContent('body');
      const hasApi = /api.?key|api.?access|api.?trading|developer/i.test(body);
      console.log('Title:', title);
      console.log('Has API content:', hasApi);
      if (hasApi) {
        const ssPath = path.join(__dirname, 'ss-api-found.png');
        await page.screenshot({ path: ssPath, fullPage: true });
        console.log('API PAGE FOUND! Screenshot:', ssPath);
      }
    } catch (e) {
      console.log('Error:', e.message.slice(0, 80));
    }
  }

  // Also try via Account > Crypto nav tab
  console.log('\n--- Checking Account > Crypto tab');
  await page.goto('https://robinhood.com/account/crypto', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);
  const ssPath2 = path.join(__dirname, 'ss-account-crypto.png');
  await page.screenshot({ path: ssPath2, fullPage: true });
  console.log('Screenshot:', ssPath2);

  // Dump all links on the page
  const links = await page.$$eval('a, button', els =>
    els.map(e => ({ text: (e.textContent||'').trim().slice(0,60), href: e.href||'' })).filter(e=>e.text));
  console.log('Links on crypto page:', JSON.stringify(links, null, 2));

  console.log('\nPublic Key to paste when creating API key:', PUBLIC_KEY);
  console.log('Browser stays open — navigate manually if needed.');
  await new Promise(() => {});
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
