// @ts-check
// Fyers NSE Multi-Algo Dashboard tests
// Run: npx playwright test tests/fyers-algo.spec.js
// Requires: Dashboard (port 3010) and at least Algo 1 (port 3011) running.
//   cd aiTools/fyers/strategy/Dashboard && npm install && node server.js
//   (dashboard auto-manages algo processes; algo1 server.js used internally)

const { test, expect } = require('@playwright/test');

const DASH  = 'http://localhost:3010';
const ALGO1 = 'http://localhost:3011';

// ── Helpers ────────────────────────────────────────────────────────
async function isUp(request, url) {
  try {
    const r = await request.get(`${url}/health`, { timeout: 4000 });
    return r.ok();
  } catch { return false; }
}

// ══════════════════════════════════════════════════════════════════
// Dashboard API — no browser needed
// ══════════════════════════════════════════════════════════════════
test.describe('Dashboard API', () => {
  test.beforeAll(async ({ request }) => {
    const up = await isUp(request, DASH);
    if (!up) test.skip(true, 'Dashboard not running on :3010 — start it first');
  });

  test('/health returns ok', async ({ request }) => {
    const r = await request.get(`${DASH}/health`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.dashboard).toBe(true);
    expect(body.port).toBe(3010);
  });

  test('/api/summary returns expected shape', async ({ request }) => {
    const r = await request.get(`${DASH}/api/summary`);
    expect(r.ok()).toBeTruthy();
    const s = await r.json();
    expect(typeof s.runningCount).toBe('number');
    expect(typeof s.totalPnl).toBe('number');
    expect(typeof s.totalTrades).toBe('number');
    expect(typeof s.winRate).toBe('string');
    expect(typeof s.marketStatus).toBe('string');
    expect(typeof s.isMarketOpen).toBe('boolean');
    expect(typeof s.fyersConnected).toBe('boolean');
    expect(typeof s.fyersAuthUrl).toBe('string');
    expect(s.fyersAuthUrl).toContain('api-t2.fyers.in');
  });

  test('/api/slots returns exactly 6 slots with correct shape', async ({ request }) => {
    const r = await request.get(`${DASH}/api/slots`);
    expect(r.ok()).toBeTruthy();
    const slots = await r.json();
    expect(Array.isArray(slots)).toBeTruthy();
    expect(slots).toHaveLength(6);

    const expectedPorts = [3011, 3012, 3013, 3014, 3015, 3016];
    slots.forEach((s, i) => {
      expect(s.id).toBe(i + 1);
      expect(s.port).toBe(expectedPorts[i]);
      expect(typeof s.name).toBe('string');
      expect(typeof s.symbol).toBe('string');
      expect(s.symbol).toContain('NSE:');
      expect(typeof s.running).toBe('boolean');
    });
  });

  test('/api/slot/1 returns slot 1 config', async ({ request }) => {
    const r = await request.get(`${DASH}/api/slot/1`);
    expect(r.ok()).toBeTruthy();
    const s = await r.json();
    expect(s.id).toBe(1);
    expect(s.port).toBe(3011);
    expect(s.symbol).toBe('NSE:RELIANCE-EQ');
    expect(s.symbolLabel).toBe('RELIANCE');
  });

  test('/api/slot/99 returns 404', async ({ request }) => {
    const r = await request.get(`${DASH}/api/slot/99`);
    expect(r.status()).toBe(404);
  });

  test('/api/fyers/auth-url returns Fyers OAuth URL', async ({ request }) => {
    const r = await request.get(`${DASH}/api/fyers/auth-url`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(typeof body.url).toBe('string');
    expect(body.url).toContain('generate-authcode');
    expect(body.url).toContain('KZZ4Y6S6F2-200');
    expect(typeof body.connected).toBe('boolean');
  });

  test('/events SSE endpoint connects and sends init event', async ({ request }) => {
    const r = await request.get(`${DASH}/events`, {
      headers: { Accept: 'text/event-stream' },
      timeout: 5000,
    });
    expect(r.ok()).toBeTruthy();
    const contentType = r.headers()['content-type'] || '';
    expect(contentType).toContain('text/event-stream');
    const body = await r.text();
    expect(body).toContain('data:');
    expect(body).toContain('"type":"init"');
    expect(body).toContain('"slots"');
  });
});

// ══════════════════════════════════════════════════════════════════
// Dashboard UI
// ══════════════════════════════════════════════════════════════════
test.describe('Dashboard UI', () => {
  test.beforeAll(async ({ request }) => {
    const up = await isUp(request, DASH);
    if (!up) test.skip(true, 'Dashboard not running on :3010 — start it first');
  });

  test('loads with correct title and header', async ({ page }) => {
    await page.goto(DASH);
    await expect(page.locator('.hdr-title')).toContainText('Fyers NSE');
    await expect(page.locator('.hdr-title')).toContainText('Multi-Algo Dashboard');
    await expect(page.locator('.hdr-sub')).toContainText('6 independent algos');
    await expect(page.locator('.hdr-sub')).toContainText('EMA Ribbon Swing v2');
  });

  test('market status bar is present', async ({ page }) => {
    await page.goto(DASH);
    await expect(page.locator('#market-status-bar')).toBeVisible();
  });

  test('market badge renders in header', async ({ page }) => {
    await page.goto(DASH);
    await expect(page.locator('#market-badge')).toBeVisible();
    const text = await page.locator('#market-badge').textContent();
    expect(['MARKET OPEN', 'MARKET CLOSED'].some(s => text.includes(s))).toBeTruthy();
  });

  test('Fyers connection pill is visible', async ({ page }) => {
    await page.goto(DASH);
    await expect(page.locator('.fyers-pill')).toBeVisible();
    await expect(page.locator('#fyers-dot')).toBeVisible();
    await expect(page.locator('#fyers-lbl')).toBeVisible();
  });

  test('global stats bar shows 6 metrics', async ({ page }) => {
    await page.goto(DASH);
    await expect(page.locator('#gb-running')).toBeVisible();
    await expect(page.locator('#gb-pnl')).toBeVisible();
    await expect(page.locator('#gb-trades')).toBeVisible();
    await expect(page.locator('#gb-wr')).toBeVisible();
    await expect(page.locator('#gb-positions')).toBeVisible();
    await expect(page.locator('#gb-market')).toBeVisible();
    // Running count should show N / 6 pattern
    const running = await page.locator('#gb-running').textContent();
    expect(running).toMatch(/\d+ \/ 6/);
  });

  test('action bar has Start All, Stop All, and mode selector', async ({ page }) => {
    await page.goto(DASH);
    await expect(page.locator('.btn-start-all')).toBeVisible();
    await expect(page.locator('.btn-stop-all')).toBeVisible();
    await expect(page.locator('#global-mode')).toBeVisible();
    // Mode selector has paper and live options
    const opts = await page.locator('#global-mode option').allTextContents();
    expect(opts.some(o => o.toLowerCase().includes('paper'))).toBeTruthy();
    expect(opts.some(o => o.toLowerCase().includes('live'))).toBeTruthy();
    // "Open All Algo UIs" button
    await expect(page.locator('text=Open All Algo UIs')).toBeVisible();
  });

  test('algo grid renders 6 cards after init', async ({ page }) => {
    await page.goto(DASH);
    // Cards are injected by JS after fetch; wait up to 6s
    await page.waitForFunction(() => {
      return document.querySelectorAll('.algo-card').length === 6;
    }, { timeout: 6000 });
    const cards = page.locator('.algo-card');
    await expect(cards).toHaveCount(6);
  });

  test('each algo card has start, stop, and open UI buttons', async ({ page }) => {
    await page.goto(DASH);
    await page.waitForFunction(() => document.querySelectorAll('.algo-card').length === 6, { timeout: 6000 });

    for (let i = 1; i <= 6; i++) {
      const card = page.locator(`#card-${i}`);
      await expect(card).toBeVisible();
      await expect(card.locator('.btn-start')).toBeVisible();
      await expect(card.locator('.btn-stop')).toBeVisible();
    }
  });

  test('algo card 1 shows RELIANCE label', async ({ page }) => {
    await page.goto(DASH);
    await page.waitForFunction(() => document.querySelectorAll('.algo-card').length === 6, { timeout: 6000 });
    const card1 = page.locator('#card-1');
    await expect(card1).toContainText('RELIANCE');
    await expect(card1).toContainText('3011');
  });

  test('algo card 6 shows SBI label', async ({ page }) => {
    await page.goto(DASH);
    await page.waitForFunction(() => document.querySelectorAll('.algo-card').length === 6, { timeout: 6000 });
    const card6 = page.locator('#card-6');
    await expect(card6).toContainText('SBI');
    await expect(card6).toContainText('3016');
  });

  test('each card has a symbol dropdown with NSE stocks', async ({ page }) => {
    await page.goto(DASH);
    await page.waitForFunction(() => document.querySelectorAll('.algo-card').length === 6, { timeout: 6000 });
    // Check card 1 symbol selector
    const symSel = page.locator('#card-1 select').first();
    await expect(symSel).toBeVisible();
    const optCount = await symSel.locator('option').count();
    expect(optCount).toBeGreaterThan(5);
    const opts = await symSel.locator('option').allTextContents();
    expect(opts.some(o => o.includes('RELIANCE'))).toBeTruthy();
  });

  test('signal monitor section is present', async ({ page }) => {
    await page.goto(DASH);
    await expect(page.locator('.sig-monitor')).toBeVisible();
    await expect(page.locator('#sig-grid')).toBeVisible();
  });

  test('activity log section is present', async ({ page }) => {
    await page.goto(DASH);
    await expect(page.locator('.activity-log')).toBeVisible();
    await expect(page.locator('#activity-log-body')).toBeVisible();
  });

  test('auth banner renders and shows connect button', async ({ page }) => {
    await page.goto(DASH);
    // Auth banner may or may not be shown depending on token; but the element must exist
    await expect(page.locator('#auth-banner')).toBeAttached();
    // Check that it contains the connect button when visible
    const banner = page.locator('#auth-banner');
    const isShown = await banner.evaluate(el => el.classList.contains('show'));
    if (isShown) {
      await expect(banner.locator('.btn-auth')).toBeVisible();
      await expect(banner).toContainText('Connect Fyers Account');
    }
  });

  test('header time display updates', async ({ page }) => {
    await page.goto(DASH);
    // Time gets set by JS — wait for it to populate
    await expect(page.locator('#hdr-time')).not.toContainText('—', { timeout: 3000 });
    const timeText = await page.locator('#hdr-time').textContent();
    expect(timeText).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  test('screenshot — dashboard initial state', async ({ page }) => {
    await page.goto(DASH);
    await page.waitForFunction(() => document.querySelectorAll('.algo-card').length === 6, { timeout: 6000 });
    await page.screenshot({ path: 'tests/fyers-dashboard.png', fullPage: true });
  });
});

// ══════════════════════════════════════════════════════════════════
// Dashboard slot start/stop actions
// ══════════════════════════════════════════════════════════════════
test.describe('Dashboard slot management', () => {
  test.beforeAll(async ({ request }) => {
    const up = await isUp(request, DASH);
    if (!up) test.skip(true, 'Dashboard not running on :3010 — start it first');
  });

  test.afterAll(async ({ request }) => {
    // Stop all slots to clean up
    try { await request.post(`${DASH}/api/stop-all`); } catch {}
  });

  test('POST /api/slot/1/start spawns algo 1 process', async ({ request }) => {
    // Stop first just in case
    await request.post(`${DASH}/api/slot/1/stop`).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const r = await request.post(`${DASH}/api/slot/1/start`, {
      data: { mode: 'paper', timeframe: '15m', balance: 100000 },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.slotId).toBe(1);

    // Give process time to start
    await new Promise(res => setTimeout(res, 3000));

    // Slot should now show running
    const slotR = await request.get(`${DASH}/api/slot/1`);
    const slot = await slotR.json();
    expect(slot.running).toBe(true);
    expect(slot.pid).toBeTruthy();
  });

  test('algo 1 process responds to /health after start', async ({ request }) => {
    // Wait for algo1 to fully boot (may take a few seconds after dashboard start)
    let attempts = 0;
    while (attempts < 10) {
      const up = await isUp(request, ALGO1);
      if (up) break;
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
    const r = await request.get(`${ALGO1}/health`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.algoSlot).toBe('1');
    expect(body.port).toBe(3011);
  });

  test('POST /api/slot/1/stop stops algo 1 process', async ({ request }) => {
    const r = await request.post(`${DASH}/api/slot/1/stop`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);

    // Give it time to stop
    await new Promise(res => setTimeout(res, 3000));
    const slotR = await request.get(`${DASH}/api/slot/1`);
    const slot = await slotR.json();
    expect(slot.running).toBe(false);
  });

  test('POST /api/start-all and /api/stop-all complete without error', async ({ request }) => {
    const startR = await request.post(`${DASH}/api/start-all`, { data: { mode: 'paper' } });
    expect(startR.ok()).toBeTruthy();
    const startBody = await startR.json();
    expect(startBody.ok).toBe(true);

    // Brief pause then stop all
    await new Promise(r => setTimeout(r, 2000));

    const stopR = await request.post(`${DASH}/api/stop-all`);
    expect(stopR.ok()).toBeTruthy();
    const stopBody = await stopR.json();
    expect(stopBody.ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// Algo 1 API — standalone (started by dashboard or directly)
// ══════════════════════════════════════════════════════════════════
test.describe('Algo 1 API', () => {
  test.beforeAll(async ({ request }) => {
    // Try to start algo1 via dashboard if not already running
    const algoUp = await isUp(request, ALGO1);
    if (!algoUp) {
      const dashUp = await isUp(request, DASH);
      if (dashUp) {
        await request.post(`${DASH}/api/slot/1/start`, {
          data: { mode: 'paper', timeframe: '15m', balance: 100000 },
        });
        // Wait for algo1 to boot
        let attempts = 0;
        while (attempts < 12) {
          const up = await isUp(request, ALGO1);
          if (up) break;
          await new Promise(r => setTimeout(r, 1000));
          attempts++;
        }
      }
    }
    const up = await isUp(request, ALGO1);
    if (!up) test.skip(true, 'Algo 1 not running on :3011 — start dashboard first');
  });

  test('afterAll: stop algo 1', async ({ request }) => {
    try { await request.post(`${DASH}/api/slot/1/stop`); } catch {}
    try { await request.post(`${ALGO1}/api/stop`); } catch {}
  });

  test('/health returns algo1 identity', async ({ request }) => {
    const r = await request.get(`${ALGO1}/health`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.algoSlot).toBe('1');
    expect(body.port).toBe(3011);
    expect(typeof body.fyersConnected).toBe('boolean');
    expect(typeof body.marketStatus).toBe('string');
  });

  test('/api/config returns stocks array and strategies', async ({ request }) => {
    const r = await request.get(`${ALGO1}/api/config`);
    expect(r.ok()).toBeTruthy();
    const cfg = await r.json();
    expect(Array.isArray(cfg.stocks)).toBeTruthy();
    expect(cfg.stocks.length).toBeGreaterThan(10);
    // All stocks should be NSE format
    cfg.stocks.forEach(s => {
      expect(s.label).toBeTruthy();
      expect(s.value).toContain('NSE:');
      expect(s.value).toContain('-EQ');
    });
    // Should include RELIANCE
    expect(cfg.stocks.some(s => s.value === 'NSE:RELIANCE-EQ')).toBeTruthy();
    // Strategies array
    expect(Array.isArray(cfg.strategies)).toBeTruthy();
    expect(cfg.strategies.length).toBeGreaterThan(0);
    expect(cfg.strategies[0].id).toBe('swing-v2');
    // Fyers auth URL present
    expect(cfg.fyersAuthUrl).toContain('api-t2.fyers.in');
    expect(cfg.fyersAuthUrl).toContain('KZZ4Y6S6F2-200');
  });

  test('/api/state returns correct shape', async ({ request }) => {
    const r = await request.get(`${ALGO1}/api/state`);
    expect(r.ok()).toBeTruthy();
    const s = await r.json();
    expect(typeof s.running).toBe('boolean');
    expect(typeof s.balance).toBe('number');
    expect(typeof s.pnl).toBe('number');
    expect(typeof s.totalTrades).toBe('number');
    expect(typeof s.algoSlot).toBe('string');
    expect(s.algoSlot).toBe('1');
    expect(typeof s.port).toBe('number');
    expect(s.port).toBe(3011);
    expect(typeof s.fyersConnected).toBe('boolean');
    expect(typeof s.marketStatus).toBe('string');
    expect(typeof s.isMarketOpen).toBe('boolean');
    expect(s.symbol).toContain('NSE:');
  });

  test('/api/logs returns array', async ({ request }) => {
    const r = await request.get(`${ALGO1}/api/logs`);
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray(await r.json())).toBeTruthy();
  });

  test('/api/trades returns array', async ({ request }) => {
    const r = await request.get(`${ALGO1}/api/trades`);
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray(await r.json())).toBeTruthy();
  });

  test('/api/trades/all returns array (up to 200 rows)', async ({ request }) => {
    const r = await request.get(`${ALGO1}/api/trades/all`);
    expect(r.ok()).toBeTruthy();
    const rows = await r.json();
    expect(Array.isArray(rows)).toBeTruthy();
    expect(rows.length).toBeLessThanOrEqual(200);
  });

  test('/api/trades/export returns CSV content-type', async ({ request }) => {
    const r = await request.get(`${ALGO1}/api/trades/export`);
    expect(r.ok()).toBeTruthy();
    const ct = r.headers()['content-type'] || '';
    expect(ct).toContain('text/csv');
    const disposition = r.headers()['content-disposition'] || '';
    expect(disposition).toContain('algo1_trades.csv');
  });

  test('/events SSE endpoint connects and returns init payload', async ({ request }) => {
    const r = await request.get(`${ALGO1}/events`, {
      headers: { Accept: 'text/event-stream' },
      timeout: 5000,
    });
    expect(r.ok()).toBeTruthy();
    const ct = r.headers()['content-type'] || '';
    expect(ct).toContain('text/event-stream');
    const body = await r.text();
    expect(body).toContain('"type":"connected"');
    expect(body).toContain('"state"');
  });

  test('/auth/fyers redirects to Fyers OAuth (not auth error)', async ({ request }) => {
    const r = await request.get(`${ALGO1}/auth/fyers`, { maxRedirects: 0 });
    // Should be a redirect to Fyers OAuth URL
    expect([301, 302, 303]).toContain(r.status());
    const loc = r.headers()['location'] || '';
    expect(loc).toContain('api-t2.fyers.in');
    expect(loc).toContain('generate-authcode');
  });
});

// ══════════════════════════════════════════════════════════════════
// Algo 1 UI
// ══════════════════════════════════════════════════════════════════
test.describe('Algo 1 UI', () => {
  test.beforeAll(async ({ request }) => {
    const up = await isUp(request, ALGO1);
    if (!up) test.skip(true, 'Algo 1 not running on :3011');
  });

  test.afterAll(async ({ request }) => {
    try { await request.post(`${ALGO1}/api/stop`); } catch {}
  });

  test('loads with correct title and subtitle', async ({ page }) => {
    await page.goto(ALGO1);
    await expect(page.locator('#algo-title')).toContainText('Fyers Algo');
    await expect(page.locator('#algo-title')).toContainText('NSE Swing v2');
    await expect(page.locator('.subtitle')).toContainText('EMA21/55/200');
    await expect(page.locator('.subtitle')).toContainText('ADX Rising');
  });

  test('header badges are visible', async ({ page }) => {
    await page.goto(ALGO1);
    await expect(page.locator('#mode-badge')).toBeVisible();
    await expect(page.locator('#status-badge')).toBeVisible();
    await expect(page.locator('#market-badge')).toBeVisible();
    // Status should be STOPPED initially
    await expect(page.locator('#status-badge')).toContainText('STOPPED');
  });

  test('Fyers status indicator is present', async ({ page }) => {
    await page.goto(ALGO1);
    await expect(page.locator('.fyers-status')).toBeVisible();
    await expect(page.locator('#fyers-dot')).toBeVisible();
    await expect(page.locator('#fyers-label')).toBeVisible();
  });

  test('mode tabs are present and PAPER is active by default', async ({ page }) => {
    await page.goto(ALGO1);
    await expect(page.locator('#tab-paper')).toBeVisible();
    await expect(page.locator('#tab-live')).toBeVisible();
    await expect(page.locator('#tab-backtest')).toBeVisible();
    await expect(page.locator('#tab-paper')).toHaveClass(/active/);
  });

  test('trading controls are visible in paper mode', async ({ page }) => {
    await page.goto(ALGO1);
    await expect(page.locator('#trading-controls')).toBeVisible();
    await expect(page.locator('#ctrl-symbol')).toBeVisible();
    await expect(page.locator('#ctrl-tf')).toBeVisible();
    await expect(page.locator('#ctrl-balance')).toBeVisible();
    await expect(page.locator('#ctrl-interval')).toBeVisible();
    await expect(page.locator('#btn-start')).toBeVisible();
    await expect(page.locator('#btn-stop')).toBeVisible();
  });

  test('symbol dropdown is populated with NSE stocks', async ({ page }) => {
    await page.goto(ALGO1);
    // Wait for stocks to load from /api/config
    await page.waitForFunction(() => {
      const sel = document.getElementById('ctrl-symbol');
      return sel && sel.options.length > 5;
    }, { timeout: 5000 });
    const opts = await page.locator('#ctrl-symbol option').allTextContents();
    expect(opts.length).toBeGreaterThan(10);
    expect(opts.some(o => o.includes('RELIANCE'))).toBeTruthy();
    expect(opts.some(o => o.includes('TCS'))).toBeTruthy();
    expect(opts.some(o => o.includes('INFY'))).toBeTruthy();
    expect(opts.some(o => o.includes('SBI'))).toBeTruthy();
  });

  test('timeframe dropdown has expected options', async ({ page }) => {
    await page.goto(ALGO1);
    const opts = await page.locator('#ctrl-tf option').allTextContents();
    expect(opts.some(o => o.includes('15m'))).toBeTruthy();
    expect(opts.some(o => o.includes('1h'))).toBeTruthy();
    expect(opts.some(o => o.includes('5m'))).toBeTruthy();
  });

  test('start button is enabled and stop is disabled initially', async ({ page }) => {
    await page.goto(ALGO1);
    // Ensure stopped
    await expect(page.locator('#status-badge')).toContainText('STOPPED');
    await expect(page.locator('#btn-start')).not.toBeDisabled();
    await expect(page.locator('#btn-stop')).toBeDisabled();
  });

  test('backtest panel is hidden in paper mode', async ({ page }) => {
    await page.goto(ALGO1);
    await expect(page.locator('#backtest-panel')).not.toBeVisible();
  });

  test('clicking BACKTEST tab shows backtest panel and hides trading controls', async ({ page }) => {
    await page.goto(ALGO1);
    await page.click('#tab-backtest');
    await expect(page.locator('#backtest-panel')).toBeVisible();
    await expect(page.locator('#trading-controls')).not.toBeVisible();

    // Backtest controls present
    await expect(page.locator('#bt-symbol')).toBeVisible();
    await expect(page.locator('#bt-tf')).toBeVisible();
    await expect(page.locator('#bt-months')).toBeVisible();
    await expect(page.locator('#btn-run-bt')).toBeVisible();
  });

  test('clicking LIVE tab shows trading controls', async ({ page }) => {
    await page.goto(ALGO1);
    await page.click('#tab-live');
    await expect(page.locator('#trading-controls')).toBeVisible();
    await expect(page.locator('#backtest-panel')).not.toBeVisible();
    await expect(page.locator('#tab-live')).toHaveClass(/active-live/);
  });

  test('switching back to PAPER tab restores PAPER class', async ({ page }) => {
    await page.goto(ALGO1);
    await page.click('#tab-backtest');
    await page.click('#tab-paper');
    await expect(page.locator('#tab-paper')).toHaveClass(/active/);
    await expect(page.locator('#trading-controls')).toBeVisible();
  });

  test('PnL dashboard card shows initial values', async ({ page }) => {
    await page.goto(ALGO1);
    await expect(page.locator('#pnl-val')).toBeVisible();
    await expect(page.locator('#stat-balance')).toBeVisible();
    await expect(page.locator('#stat-trades')).toBeVisible();
    await expect(page.locator('#stat-wr')).toBeVisible();
    await expect(page.locator('#stat-maxdd')).toBeVisible();
    // Balance should show ₹ symbol
    await expect(page.locator('#stat-balance')).toContainText('₹');
    // Initial balance should be 1,00,000
    await expect(page.locator('#stat-balance')).toContainText('1,00,000');
  });

  test('equity curve SVG is present', async ({ page }) => {
    await page.goto(ALGO1);
    await expect(page.locator('#eq-svg')).toBeVisible();
  });

  test('position display shows FLAT when no position', async ({ page }) => {
    await page.goto(ALGO1);
    await expect(page.locator('#pos-display')).toContainText('FLAT');
  });

  test('market closed warning has correct text', async ({ page }) => {
    await page.goto(ALGO1);
    await expect(page.locator('#market-warn')).toBeAttached();
    const warn = page.locator('#market-warn');
    const text = await warn.textContent();
    expect(text).toContain('9:15');
    expect(text).toContain('15:30 IST');
  });

  test('auth panel is present with connect button', async ({ page }) => {
    await page.goto(ALGO1);
    await expect(page.locator('#auth-panel')).toBeAttached();
  });

  test('screenshot — algo 1 initial state', async ({ page }) => {
    await page.goto(ALGO1);
    await page.waitForFunction(() => {
      const sel = document.getElementById('ctrl-symbol');
      return sel && sel.options.length > 5;
    }, { timeout: 5000 });
    await page.screenshot({ path: 'tests/fyers-algo1.png', fullPage: true });
  });
});

// ══════════════════════════════════════════════════════════════════
// Algo ports 3012–3016 — smoke test (only if dashboard started them)
// ══════════════════════════════════════════════════════════════════
test.describe('Algo instances 2–6 (smoke)', () => {
  const extraPorts = [
    { id: 2, port: 3012, symbol: 'NSE:TCS-EQ',       name: 'Algo 2' },
    { id: 3, port: 3013, symbol: 'NSE:HDFCBANK-EQ',  name: 'Algo 3' },
    { id: 4, port: 3014, symbol: 'NSE:ICICIBANK-EQ', name: 'Algo 4' },
    { id: 5, port: 3015, symbol: 'NSE:INFY-EQ',      name: 'Algo 5' },
    { id: 6, port: 3016, symbol: 'NSE:SBIN-EQ',      name: 'Algo 6' },
  ];

  for (const { id, port, symbol, name } of extraPorts) {
    test(`Algo ${id} /health and /api/state (if running on :${port})`, async ({ request }) => {
      const up = await isUp(request, `http://localhost:${port}`);
      if (!up) {
        test.skip(true, `Algo ${id} not running on :${port} — start from dashboard`);
        return;
      }
      const health = await request.get(`http://localhost:${port}/health`);
      expect(health.ok()).toBeTruthy();
      const hBody = await health.json();
      expect(hBody.status).toBe('ok');
      expect(hBody.port).toBe(port);

      const state = await request.get(`http://localhost:${port}/api/state`);
      expect(state.ok()).toBeTruthy();
      const s = await state.json();
      expect(s.algoSlot).toBe(String(id));
      expect(s.symbol).toBe(symbol);
    });
  }
});

// ══════════════════════════════════════════════════════════════════
// OAuth callback server on port 8080
// ══════════════════════════════════════════════════════════════════
test.describe('Fyers OAuth callback server (:8080)', () => {
  test.beforeAll(async ({ request }) => {
    const up = await isUp(request, DASH);
    if (!up) test.skip(true, 'Dashboard not running; auth server on :8080 not started');
  });

  test('port 8080 returns a response (auth server is live)', async ({ request }) => {
    const r = await request.get('http://127.0.0.1:8080/', { timeout: 4000 });
    // With no auth_code, it returns 200 with error HTML
    expect(r.ok()).toBeTruthy();
    const body = await r.text();
    expect(body).toContain('Fyers');
  });

  test('port 8080 with error status returns auth failed page', async ({ request }) => {
    const r = await request.get('http://127.0.0.1:8080/?s=error', { timeout: 4000 });
    expect(r.ok()).toBeTruthy();
    const body = await r.text();
    expect(body).toContain('Auth Failed');
  });
});
