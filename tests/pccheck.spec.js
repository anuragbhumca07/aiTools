// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:5000';

test.describe('PCcheck Monitor Server', () => {

  test('GET /health returns ok', async ({ request }) => {
    const res = await request.get(`${BASE}/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('GET /status before any heartbeat', async ({ request }) => {
    const res = await request.get(`${BASE}/status`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('pc_online');
    expect(body).toHaveProperty('alert_threshold_s');
    expect(body.alert_threshold_s).toBe(120);
  });

  test('POST /heartbeat marks PC online', async ({ request }) => {
    const res = await request.post(`${BASE}/heartbeat`, {
      data: { ts: new Date().toISOString() },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('ts');
  });

  test('GET /status after heartbeat shows PC online', async ({ request }) => {
    // Send heartbeat first
    await request.post(`${BASE}/heartbeat`, { data: { ts: new Date().toISOString() } });

    const res = await request.get(`${BASE}/status`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.pc_online).toBe(true);
    expect(body.last_heartbeat_utc).not.toBeNull();
    expect(body.last_heartbeat_ist).toMatch(/IST/);
    expect(typeof body.seconds_since_ping).toBe('number');
    expect(body.seconds_since_ping).toBeLessThan(10);
  });

  test('Multiple heartbeats keep PC online', async ({ request }) => {
    for (let i = 0; i < 3; i++) {
      const r = await request.post(`${BASE}/heartbeat`, { data: { ts: new Date().toISOString() } });
      expect(r.ok()).toBeTruthy();
    }
    const status = await (await request.get(`${BASE}/status`)).json();
    expect(status.pc_online).toBe(true);
  });

  test('/status seconds_since_ping is fresh after heartbeat', async ({ request }) => {
    await request.post(`${BASE}/heartbeat`, { data: { ts: new Date().toISOString() } });
    await new Promise(r => setTimeout(r, 1000));
    const body = await (await request.get(`${BASE}/status`)).json();
    expect(body.seconds_since_ping).toBeLessThanOrEqual(5);
  });

});
