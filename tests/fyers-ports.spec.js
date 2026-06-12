// @ts-check
// Fyers port-up test — checks NSE dashboard (3010) + 6 NSE algos (3011-3016)
//                      and MCX dashboard (3020) + 6 MCX algos (3021-3026).
// Run: npx playwright test tests/fyers-ports.spec.js --reporter=list
// Dashboards must be running before executing this test.

const { test, expect } = require('@playwright/test');

const NSE_DASH  = 'http://localhost:3010';
const MCX_DASH  = 'http://localhost:3020';
const NSE_PORTS = [3011, 3012, 3013, 3014, 3015, 3016];
const MCX_PORTS = [3021, 3022, 3023, 3024, 3025, 3026];
const NSE_NAMES = ['RELIANCE', 'TCS', 'HDFC BANK', 'ICICI BANK', 'INFY', 'SBI'];
const MCX_NAMES = ['Gold', 'Silver', 'Crude Oil', 'Natural Gas', 'Copper', 'Aluminium'];

// Poll a /health endpoint until it responds or timeout
async function waitForPort(request, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request.get(`http://localhost:${port}/health`, { timeout: 2000 });
      if (r.ok()) return await r.json();
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// NSE Dashboard & Algo Ports (3010, 3011-3016)
// ══════════════════════════════════════════════════════════════════════
test.describe('NSE Dashboard — port 3010', () => {
  test('/health responds ok', async ({ request }) => {
    const r = await request.get(`${NSE_DASH}/health`, { timeout: 5000 });
    expect(r.ok(), 'NSE Dashboard :3010 should be reachable').toBeTruthy();
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.dashboard).toBe(true);
    expect(body.port).toBe(3010);
  });

  test('/api/slots returns 6 slots', async ({ request }) => {
    const r = await request.get(`${NSE_DASH}/api/slots`);
    expect(r.ok()).toBeTruthy();
    const slots = await r.json();
    expect(slots).toHaveLength(6);
    expect(slots.map(s => s.port)).toEqual(NSE_PORTS);
  });

  test('/api/summary returns valid structure', async ({ request }) => {
    const r = await request.get(`${NSE_DASH}/api/summary`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(typeof body.runningCount).toBe('number');
    expect(typeof body.totalPnl).toBe('number');
    expect(typeof body.isMarketOpen).toBe('boolean');
    expect(typeof body.fyersConnected).toBe('boolean');
  });

  test('/api/fyers/auth-url returns auth URL', async ({ request }) => {
    const r = await request.get(`${NSE_DASH}/api/fyers/auth-url`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.url).toContain('api-t1.fyers.in');
  });
});

test.describe('NSE Algo Ports — 3011 to 3016 (start all then verify)', () => {
  test.setTimeout(60000); // allow up to 60s for all 6 algos to start

  test('start-all launches all 6 NSE algo processes', async ({ request }) => {
    const r = await request.post(`${NSE_DASH}/api/start-all`, {
      data: { mode: 'paper' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(r.ok(), 'start-all should return 200').toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
  });

  for (let i = 0; i < NSE_PORTS.length; i++) {
    const port = NSE_PORTS[i];
    const name = NSE_NAMES[i];
    test(`Algo ${i + 1} — ${name} :${port} is up`, async ({ request }) => {
      const body = await waitForPort(request, port, 20000);
      expect(body, `Algo ${i + 1} (${name}) on :${port} did not come up within 20s`).not.toBeNull();
      expect(body.status).toBe('ok');
      expect(body.algoSlot).toBe(String(i + 1));
      expect(body.port).toBe(port);
    });
  }

  test('all 6 NSE algos report running state via dashboard', async ({ request }) => {
    // give algos a moment to start their strategy loop
    await new Promise(r => setTimeout(r, 5000));
    const r = await request.get(`${NSE_DASH}/api/slots`);
    const slots = await r.json();
    const running = slots.filter(s => s.running).length;
    expect(running, `Expected all 6 slots running, got ${running}`).toBe(6);
  });
});

// ══════════════════════════════════════════════════════════════════════
// MCX Dashboard & Algo Ports (3020, 3021-3026)
// ══════════════════════════════════════════════════════════════════════
test.describe('MCX Commodity Dashboard — port 3020', () => {
  test('/health responds ok', async ({ request }) => {
    const r = await request.get(`${MCX_DASH}/health`, { timeout: 5000 });
    expect(r.ok(), 'MCX Dashboard :3020 should be reachable').toBeTruthy();
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.dashboard).toBe('commodity');
    expect(body.port).toBe(3020);
  });

  test('/api/slots returns 6 MCX slots', async ({ request }) => {
    const r = await request.get(`${MCX_DASH}/api/slots`);
    expect(r.ok()).toBeTruthy();
    const slots = await r.json();
    expect(slots).toHaveLength(6);
    expect(slots.map(s => s.port)).toEqual(MCX_PORTS);
    // verify all symbols are MCX
    slots.forEach(s => expect(s.symbol).toContain('MCX:'));
  });

  test('/api/summary returns valid MCX structure', async ({ request }) => {
    const r = await request.get(`${MCX_DASH}/api/summary`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(typeof body.runningCount).toBe('number');
    expect(typeof body.isMarketOpen).toBe('boolean');
    expect(body.fyersAuthUrl).toContain('api-t1.fyers.in');
  });
});

test.describe('MCX Algo Ports — 3021 to 3026 (start all then verify)', () => {
  test.setTimeout(60000);

  test('start-all launches all 6 MCX algo processes', async ({ request }) => {
    const r = await request.post(`${MCX_DASH}/api/start-all`, {
      data: { mode: 'paper' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(r.ok(), 'MCX start-all should return 200').toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
  });

  for (let i = 0; i < MCX_PORTS.length; i++) {
    const port = MCX_PORTS[i];
    const name = MCX_NAMES[i];
    test(`MCX Algo ${i + 1} — ${name} :${port} is up`, async ({ request }) => {
      const body = await waitForPort(request, port, 20000);
      expect(body, `MCX Algo ${i + 1} (${name}) on :${port} did not come up within 20s`).not.toBeNull();
      expect(body.status).toBe('ok');
      expect(body.algoSlot).toBe(String(i + 1));
      expect(body.port).toBe(port);
    });
  }

  test('all 6 MCX algos report running state via dashboard', async ({ request }) => {
    await new Promise(r => setTimeout(r, 5000));
    const r = await request.get(`${MCX_DASH}/api/slots`);
    const slots = await r.json();
    const running = slots.filter(s => s.running).length;
    expect(running, `Expected all 6 MCX slots running, got ${running}`).toBe(6);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Quick port-sweep summary (all 14 ports in one test)
// ══════════════════════════════════════════════════════════════════════
test.describe('Full port sweep — all 14 endpoints', () => {
  test.setTimeout(30000);

  const ALL_PORTS = [
    { port: 3010, label: 'NSE Dashboard',    type: 'dashboard' },
    { port: 3011, label: 'NSE Algo 1 RELIANCE',   type: 'algo' },
    { port: 3012, label: 'NSE Algo 2 TCS',         type: 'algo' },
    { port: 3013, label: 'NSE Algo 3 HDFC BANK',   type: 'algo' },
    { port: 3014, label: 'NSE Algo 4 ICICI BANK',  type: 'algo' },
    { port: 3015, label: 'NSE Algo 5 INFY',        type: 'algo' },
    { port: 3016, label: 'NSE Algo 6 SBI',         type: 'algo' },
    { port: 3020, label: 'MCX Dashboard',    type: 'dashboard' },
    { port: 3021, label: 'MCX Algo 1 Gold',        type: 'algo' },
    { port: 3022, label: 'MCX Algo 2 Silver',      type: 'algo' },
    { port: 3023, label: 'MCX Algo 3 Crude Oil',   type: 'algo' },
    { port: 3024, label: 'MCX Algo 4 Nat Gas',     type: 'algo' },
    { port: 3025, label: 'MCX Algo 5 Copper',      type: 'algo' },
    { port: 3026, label: 'MCX Algo 6 Aluminium',   type: 'algo' },
  ];

  test('all 14 ports respond to /health', async ({ request }) => {
    const results = await Promise.all(
      ALL_PORTS.map(async ({ port, label }) => {
        try {
          const r = await request.get(`http://localhost:${port}/health`, { timeout: 5000 });
          const ok = r.ok();
          let body = null;
          try { body = await r.json(); } catch {}
          return { port, label, ok, status: body?.status, algoSlot: body?.algoSlot };
        } catch (e) {
          return { port, label, ok: false, error: e.message };
        }
      })
    );

    // Print a summary table to the console for visibility
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║          Fyers Port Health Check — All 14 Ports          ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    results.forEach(r => {
      const icon = r.ok ? '✅' : '❌';
      const detail = r.ok ? `status=${r.status}` : (r.error || 'not reachable');
      console.log(`║ ${icon} :${r.port}  ${r.label.padEnd(28)} ${detail.padEnd(14)} ║`);
    });
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
      const msg = failed.map(f => `:${f.port} (${f.label})`).join(', ');
      expect.soft(failed.length, `These ports are NOT up: ${msg}`).toBe(0);
    }

    // At minimum, both dashboards must be up
    const nse = results.find(r => r.port === 3010);
    const mcx = results.find(r => r.port === 3020);
    expect(nse?.ok, 'NSE Dashboard :3010 must be up').toBeTruthy();
    expect(mcx?.ok, 'MCX Dashboard :3020 must be up').toBeTruthy();
  });
});
