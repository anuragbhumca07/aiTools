// @ts-check
'use strict';

// Force all tests in this file to run on a single worker so the shared
// server processes (ports 4000–4006) are started exactly once.
const { test, expect } = require('@playwright/test');
test.describe.configure({ mode: 'serial' });

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const RH_DIR = path.join(__dirname, '..', 'Robinhood');

const HUB_PORT  = 4000;
const HUB_URL   = `http://localhost:${HUB_PORT}`;

const ALGOS = [
  { symbol: 'BTCUSDT',  name: 'Bitcoin',  port: 4001 },
  { symbol: 'ETHUSDT',  name: 'Ethereum', port: 4002 },
  { symbol: 'SOLUSDT',  name: 'Solana',   port: 4003 },
  { symbol: 'DOGEUSDT', name: 'Dogecoin', port: 4004 },
  { symbol: 'XRPUSDT',  name: 'XRP',      port: 4005 },
  { symbol: 'ADAUSDT',  name: 'Cardano',  port: 4006 },
];

const servers = [];

async function waitForUrl(url, maxMs = 30000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 800));
  }
  return false;
}

function startServer(script, env) {
  const proc = spawn('node', [script], {
    cwd:         RH_DIR,
    env:         { ...process.env, ...env },
    stdio:       ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  servers.push(proc);
  return proc;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);

  // npm install if needed
  const nmPath = path.join(RH_DIR, 'node_modules');
  if (!fs.existsSync(nmPath)) {
    console.log('[robinhood.spec] Running npm install…');
    execSync('npm install', { cwd: RH_DIR, stdio: 'inherit' });
  }

  // Start hub dashboard
  startServer(path.join('dashboard', 'server.js'), { PORT: String(HUB_PORT) });

  // Start each algo server
  for (const { symbol, port } of ALGOS) {
    startServer(path.join('algo', 'server.js'), { PORT: String(port), SYMBOL: symbol });
  }

  // Wait for hub and all algo health endpoints
  const allUrls = [
    `${HUB_URL}/health`,
    ...ALGOS.map(a => `http://localhost:${a.port}/health`),
  ];
  console.log('[robinhood.spec] Waiting for all 7 servers to be ready…');
  const results = await Promise.all(allUrls.map(u => waitForUrl(u, 40000)));
  const allUp = results.every(Boolean);
  if (!allUp) {
    const down = allUrls.filter((_, i) => !results[i]);
    console.warn('[robinhood.spec] Some servers not ready:', down.join(', '));
  }

  // Ensure all algo sessions are stopped (servers may have been left running from a prior session)
  console.log('[robinhood.spec] Resetting algo sessions to stopped state…');
  await Promise.all(ALGOS.map(async ({ port }) => {
    try { await fetch(`http://localhost:${port}/api/stop`, { method: 'POST' }); } catch {}
  }));
});

test.afterAll(() => {
  servers.forEach(proc => {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
      } else {
        proc.kill('SIGTERM');
      }
    } catch {}
  });
});

// ── Hub dashboard ─────────────────────────────────────────────────

test.describe('Hub Dashboard', () => {
  test('loads on port 4000 with correct title', async ({ page }) => {
    await page.goto(HUB_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await expect(page).toHaveTitle(/Robinhood/i);
  });

  test('shows all 6 crypto cards', async ({ page }) => {
    await page.goto(HUB_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const cards = page.locator('.algo-card');
    await expect(cards).toHaveCount(6);
  });

  test('shows Bitcoin card', async ({ page }) => {
    await page.goto(HUB_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await expect(page.getByText('Bitcoin')).toBeVisible();
  });

  test('shows all 6 crypto names', async ({ page }) => {
    await page.goto(HUB_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    for (const { name } of ALGOS) {
      await expect(page.locator(`.coin-name:has-text("${name}")`)).toBeVisible();
    }
  });

  test('each card has an Open button', async ({ page }) => {
    await page.goto(HUB_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const openBtns = page.locator('button.btn-open');
    await expect(openBtns).toHaveCount(6);
  });

  test('each card has a port badge', async ({ page }) => {
    await page.goto(HUB_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    for (const { port } of ALGOS) {
      await expect(page.getByText(`:${port}`)).toBeVisible();
    }
  });

  test('hub /health returns ok', async ({ request }) => {
    const res  = await request.get(`${HUB_URL}/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('hub /api/algos returns 6 entries', async ({ request }) => {
    const res  = await request.get(`${HUB_URL}/api/algos`);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(6);
    expect(list.map(a => a.ticker)).toEqual(expect.arrayContaining(['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'ADA']));
  });

  test('cards update status after polling (STOPPED/OFFLINE badges visible)', async ({ page }) => {
    await page.goto(HUB_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(6000); // wait one 5s poll cycle
    const statusBadges = page.locator('.status-badge');
    await expect(statusBadges).toHaveCount(6);
    // All should be STOPPED (not OFFLINE) since servers are running
    for (const badge of await statusBadges.all()) {
      const txt = await badge.textContent();
      expect(txt).toMatch(/STOPPED|RUNNING/);
    }
  });

  test('Start button fires /api/start on algo server', async ({ request }) => {
    // Trigger start on BTC algo and verify it responds
    const res = await request.post(`http://localhost:4001/api/start`, {
      data: { symbol: 'BTCUSDT', timeframe: '4h', balance: 10000, interval: 14400 },
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.running).toBe(true);

    // Stop it again
    await request.post(`http://localhost:4001/api/stop`);
  });
});

// ── Individual algo servers ───────────────────────────────────────

test.describe('Algo servers — health and API', () => {
  for (const { symbol, name, port } of ALGOS) {
    test(`${name} (port ${port}) — health endpoint`, async ({ request }) => {
      const res  = await request.get(`http://localhost:${port}/health`);
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.symbol).toBe(symbol);
      expect(body.port).toBe(port);
    });

    test(`${name} — /api/symbol returns correct pair`, async ({ request }) => {
      const res  = await request.get(`http://localhost:${port}/api/symbol`);
      const body = await res.json();
      expect(body.symbol).toBe(symbol);
    });

    test(`${name} — /api/state returns default state`, async ({ request }) => {
      const res   = await request.get(`http://localhost:${port}/api/state`);
      const state = await res.json();
      expect(state.running).toBe(false);
      expect(state.symbol).toBe(symbol);
      expect(state.balance).toBeGreaterThan(0);
    });

    test(`${name} — /api/strategies returns swing-v2`, async ({ request }) => {
      const res  = await request.get(`http://localhost:${port}/api/strategies`);
      const list = await res.json();
      expect(Array.isArray(list)).toBe(true);
      expect(list.some(s => s.id === 'swing-v2')).toBe(true);
    });

    test(`${name} — /api/status (CORS) accessible from hub`, async ({ request }) => {
      const res  = await request.get(`http://localhost:${port}/api/status`);
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body.symbol).toBe(symbol);
      expect(typeof body.running).toBe('boolean');
      expect(typeof body.balance).toBe('number');
    });
  }
});

// ── Per-algo UI ───────────────────────────────────────────────────

test.describe('Algo UI pages', () => {
  test('BTC algo page loads and shows Swing v2', async ({ page }) => {
    await page.goto('http://localhost:4001', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await expect(page.locator('#page-title')).toContainText('Swing v2');
  });

  test('BTC algo page shows ← Hub back link', async ({ page }) => {
    await page.goto('http://localhost:4001', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await expect(page.getByText('← Hub')).toBeVisible();
  });

  test('BTC algo page shows BTC/USD in title after symbol load', async ({ page }) => {
    await page.goto('http://localhost:4001', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(1500);
    await expect(page.locator('#page-title')).toContainText('BTC/USD');
  });

  test('ETH algo page shows ETH/USD in title', async ({ page }) => {
    await page.goto('http://localhost:4002', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(1500);
    await expect(page.locator('#page-title')).toContainText('ETH/USD');
  });

  test('algo page shows STOPPED badge on cold load', async ({ page }) => {
    await page.goto('http://localhost:4003', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const badge = page.locator('#status-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('STOPPED');
  });

  test('algo page shows score dots (7 each for 6/7 model)', async ({ page }) => {
    await page.goto('http://localhost:4001', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const buyDots  = page.locator('#buy-dots .dot-pip');
    const sellDots = page.locator('#sell-dots .dot-pip');
    await expect(buyDots).toHaveCount(7);
    await expect(sellDots).toHaveCount(7);
  });

  test('algo page Start/Stop buttons are present', async ({ page }) => {
    await page.goto('http://localhost:4001', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await expect(page.locator('#btn-start')).toBeVisible();
    await expect(page.locator('#btn-stop')).toBeVisible();
  });

  test('backtest mode shows backtest panel', async ({ page }) => {
    await page.goto('http://localhost:4001', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.click('#tab-backtest');
    await expect(page.locator('#backtest-panel')).toHaveClass(/show/);
    await expect(page.locator('#btn-run-bt')).toBeVisible();
  });

  test('Hub back link navigates to port 4000', async ({ page }) => {
    await page.goto('http://localhost:4001', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const btn = page.locator('button.hub-link');
    await expect(btn).toBeVisible();
    // Verify the onclick attribute points to hub port 4000
    const onclick = await btn.getAttribute('onclick');
    expect(onclick).toContain('4000');
  });
});

// ── Start / Stop flow ─────────────────────────────────────────────

test.describe('Start / Stop trading session', () => {
  test('SOL algo — start returns running state', async ({ request }) => {
    const res = await request.post('http://localhost:4003/api/start', {
      data: { symbol: 'SOLUSDT', timeframe: '4h', balance: 5000, interval: 14400 },
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.running).toBe(true);
    expect(body.state.symbol).toBe('SOLUSDT');
    expect(body.state.balance).toBe(5000);
  });

  test('SOL algo — stop while running returns ok', async ({ request }) => {
    const res  = await request.post('http://localhost:4003/api/stop');
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.running).toBe(false);
  });

  test('double stop returns not-running error', async ({ request }) => {
    const res  = await request.post('http://localhost:4003/api/stop');
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.msg).toBeTruthy();
  });

  test('/api/trades returns array', async ({ request }) => {
    const res  = await request.get('http://localhost:4001/api/trades');
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ── Robinhood Live Trading API ────────────────────────────────────

test.describe('Robinhood Live Trading API', () => {
  test('/api/rh-status returns connected:false when not authenticated', async ({ request }) => {
    const res  = await request.get('http://localhost:4001/api/rh-status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body.connected).toBe('boolean');
    expect(body.connected).toBe(false);
  });

  test('/api/rh-auth with missing credentials returns error', async ({ request }) => {
    const res  = await request.post('http://localhost:4001/api/rh-auth', {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test('starting in live mode without RH auth returns error', async ({ request }) => {
    const res = await request.post('http://localhost:4001/api/start', {
      data: { symbol: 'BTCUSDT', timeframe: '4h', balance: 10000, interval: 14400, mode: 'live' },
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.msg).toMatch(/Robinhood/i);
  });

  test('/api/rh-logout clears auth state', async ({ request }) => {
    const res  = await request.post('http://localhost:4001/api/rh-logout');
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Verify status still shows not connected after logout
    const status = await request.get('http://localhost:4001/api/rh-status').then(r => r.json());
    expect(status.connected).toBe(false);
  });
});
