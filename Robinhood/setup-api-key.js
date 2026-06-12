'use strict';
/**
 * Automates Robinhood API key creation.
 * Logs in, navigates to Crypto API settings, and registers the public key.
 * Run: node Robinhood/setup-api-key.js
 */

const { chromium } = require('playwright');

const USERNAME   = 'anurag.3816@gmail.com';
const PASSWORD   = 'SriMadhav12#';
const PUBLIC_KEY = 'B6mstAn+3YvqwfBPkmsBNKGa576uZfii/QU+vuMs5js=';

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 400 });
  const ctx     = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await ctx.newPage();

  console.log('Opening Robinhood login…');
  await page.goto('https://robinhood.com/login', { waitUntil: 'domcontentloaded' });

  // Fill login form
  await page.waitForSelector('input[name="username"], input[type="email"]', { timeout: 15000 });
  await page.fill('input[name="username"], input[type="email"]', USERNAME);
  await page.fill('input[name="password"], input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');

  console.log('Logging in… (complete any MFA prompt in the browser window)');

  // Wait for MFA or home page (up to 90s for manual MFA entry)
  try {
    await page.waitForURL('**/home*', { timeout: 90000 });
  } catch {
    // Might be redirected elsewhere after login
    await page.waitForTimeout(3000);
  }

  console.log('Navigating to Crypto API settings…');
  await page.goto('https://robinhood.com/account/crypto-api-trading/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait a moment for the page to load
  await page.waitForTimeout(3000);

  // Take a screenshot to see what's on the page
  const screenshotPath = require('path').join(__dirname, 'api-settings-screenshot.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('Screenshot saved:', screenshotPath);

  // Try to find and click "Add API Key" or "Create" button
  const buttonSelectors = [
    'button:has-text("Add API Key")',
    'button:has-text("Create")',
    'button:has-text("New")',
    'button:has-text("Generate")',
    '[data-testid*="add"], [data-testid*="create"]',
    'a:has-text("Add API")',
  ];

  let clicked = false;
  for (const sel of buttonSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        console.log(`Found button: ${sel}`);
        await el.click();
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    console.log('\n⚠  Could not find "Add API Key" button automatically.');
    console.log('Please click it manually in the browser window.\n');
  }

  await page.waitForTimeout(3000);
  await page.screenshot({ path: screenshotPath.replace('.png', '-2.png'), fullPage: true });

  // Try to fill in the public key field
  const keyFieldSelectors = [
    'textarea',
    'input[placeholder*="key" i]',
    'input[name*="key" i]',
    'input[placeholder*="public" i]',
  ];

  for (const sel of keyFieldSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        console.log(`Found key input: ${sel}`);
        await el.fill(PUBLIC_KEY);
        break;
      }
    } catch {}
  }

  // Take final screenshot
  await page.waitForTimeout(2000);
  await page.screenshot({ path: screenshotPath.replace('.png', '-3.png'), fullPage: true });
  console.log('Public key pasted. Check the browser window to confirm and click submit.');
  console.log('\nPublic Key to paste: ' + PUBLIC_KEY);
  console.log('\nLeaving browser open — press Ctrl+C here when done.');

  // Keep browser open indefinitely
  await new Promise(() => {});
})().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
