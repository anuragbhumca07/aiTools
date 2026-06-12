'use strict';
/**
 * Creates a new Robinhood Crypto API key using the provided public key.
 */
const { chromium } = require('playwright');
const path = require('path');

const USERNAME   = 'anurag.3816@gmail.com';
const PASSWORD   = 'SriMadhav12#';
const PUBLIC_KEY = 'B6mstAn+3YvqwfBPkmsBNKGa576uZfii/QU+vuMs5js=';
const KEY_LABEL  = 'algo-trading';

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const ctx     = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await ctx.newPage();

  // Login
  await page.goto('https://robinhood.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"], input[type="email"]', { timeout: 15000 });
  await page.fill('input[name="username"], input[type="email"]', USERNAME);
  await page.fill('input[name="password"], input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  console.log('Logging in… (complete any MFA in the browser window)');
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 90000 });
  console.log('Logged in!');

  // Navigate to crypto API page
  await page.goto('https://robinhood.com/account/crypto', { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Wait for page content to render (API Trading section)
  await page.waitForSelector('h2, h1, [class*="section"], main', { timeout: 15000 });
  await page.waitForTimeout(4000);

  // Click "+ Add key" — wait up to 10s for it to appear
  console.log('Looking for "+ Add key" button…');
  let addBtn = null;
  for (let i = 0; i < 10; i++) {
    addBtn = await page.$('button:has-text("Add key"), button:has-text("Add Key"), button:has-text("add key")');
    if (addBtn) break;
    await page.waitForTimeout(1000);
    console.log(`  Waiting… attempt ${i+1}`);
  }
  // Dump all buttons to see what's there
  const btns = await page.$$eval('button', els => els.map(e => (e.textContent||'').trim()).filter(Boolean));
  console.log('All buttons:', JSON.stringify(btns));
  if (!addBtn) {
    console.error('ERROR: Add key button not found');
    await page.screenshot({ path: path.join(__dirname, 'ss-add-btn-notfound.png'), fullPage: true });
    return;
  }
  console.log('Clicking "+ Add key"…');
  await addBtn.click();
  await page.waitForTimeout(2000);

  // Take screenshot to see the modal/form
  await page.screenshot({ path: path.join(__dirname, 'ss-add-key-modal.png'), fullPage: true });
  console.log('Modal screenshot saved');

  // Find the public key input field
  const inputs = await page.$$('input, textarea');
  console.log('Input fields found:', inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    const placeholder = await inputs[i].getAttribute('placeholder');
    const name = await inputs[i].getAttribute('name');
    const type = await inputs[i].getAttribute('type');
    console.log(`  Input[${i}]: type=${type}, name=${name}, placeholder=${placeholder}`);
  }

  // Fill key name
  const nameInput = await page.$('input[name="keyName"]');
  if (nameInput) { console.log('Filling key name…'); await nameInput.fill(KEY_LABEL); }

  // Check ALL permission checkboxes — custom Robinhood component, need to click the visual element
  console.log('Checking all permission checkboxes…');
  // Click visible checkbox wrappers
  const checkDivs = await page.$$('[data-testid="rh-Checkbox-visibleCheckbox"], [data-testid*="checkbox" i], label:has(input[type="checkbox"])');
  console.log('Found', checkDivs.length, 'checkbox elements');
  for (const el of checkDivs) {
    try { await el.click({ force: true }); await page.waitForTimeout(100); } catch {}
  }
  // Also try forcing the hidden inputs directly
  const hiddenCbs = await page.$$('input[type="checkbox"]');
  for (const cb of hiddenCbs) {
    try {
      const isChecked = await cb.evaluate(el => el.checked);
      if (!isChecked) await cb.evaluate(el => { el.click(); el.dispatchEvent(new Event('change', { bubbles: true })); });
    } catch {}
  }
  console.log('Done checking boxes');

  // Fill public key
  const keyInput = await page.$('input[name="publicKey"]');
  if (keyInput) { console.log('Filling public key…'); await keyInput.fill(PUBLIC_KEY); }

  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(__dirname, 'ss-add-key-filled.png'), fullPage: true });
  console.log('Form filled — screenshot saved');

  // Click Save
  const saveBtn = await page.$('button:has-text("Save"), button:has-text("Add key"), button:has-text("Create")');
  if (!saveBtn) { console.error('Save button not found'); return; }
  console.log('Clicking Save…');
  await saveBtn.click();
  await page.waitForTimeout(3000);

  // Screenshot after save
  await page.screenshot({ path: path.join(__dirname, 'ss-after-save.png'), fullPage: true });
  console.log('Post-save screenshot saved');

  // Try to capture the new API key ID from the page
  const bodyText = await page.textContent('body');
  const keyIdMatch = bodyText.match(/rh-api-[a-f0-9-]{36}/i);
  if (keyIdMatch) {
    console.log('\n✓ NEW API KEY ID:', keyIdMatch[0]);
    console.log('\nUpdate Robinhood/.env:');
    console.log('  RH_API_KEY_ID=' + keyIdMatch[0]);
    console.log('  RH_API_PRIVATE_KEY=wUqNRu7iverbgUxutNyxosNj9+Rl2VWZ9f8lSFCyGjI=');
  } else {
    console.log('Could not auto-detect new key ID — check browser window.');
  }

  await new Promise(() => {});
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
