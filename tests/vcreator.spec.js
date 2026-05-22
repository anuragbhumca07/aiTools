// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = 'https://vcreator-production.up.railway.app';

const QUOTE_SHORT = 'Believe you can and you are halfway there.';
const QUOTE_LONG  =
  'The only way to do great work is to love what you do. ' +
  'If you have not found it yet, keep looking. Do not settle.';

test.describe('vCreator', () => {

  test('health endpoint returns ok', async ({ request }) => {
    const resp = await request.get(`${BASE_URL}/health`);
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('vCreator');
  });

  test('API rejects missing quotes', async ({ request }) => {
    const resp = await request.post(`${BASE_URL}/api/generate`, {
      multipart: { format: '16:9' },
    });
    expect(resp.status()).toBe(400);
  });

  test('generates a video from a single quote', async ({ request }) => {
    const resp = await request.post(`${BASE_URL}/api/generate`, {
      multipart: {
        quotes: QUOTE_SHORT,
        format: '16:9',
        music:  'none',
      },
      timeout: 120_000,
    });

    console.log('Status:', resp.status());
    const body = await resp.json();
    console.log('Body:', JSON.stringify(body));

    expect(resp.ok(), `Expected 200: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.videos).toBeDefined();
    expect(body.videos.length).toBe(1);
    expect(body.videos[0].url).toMatch(/\.mp4$/);
    expect(body.videos[0].quote).toBe(QUOTE_SHORT);

    // Verify MP4 is accessible and non-empty
    const videoResp = await request.get(`${BASE_URL}${body.videos[0].url}`);
    expect(videoResp.ok()).toBeTruthy();
    const buf = await videoResp.body();
    expect(buf.length).toBeGreaterThan(50_000);
    console.log(`Video size: ${(buf.length / 1024).toFixed(1)} KB — PASS`);
  });

  test('generates a 9:16 portrait video', async ({ request }) => {
    const resp = await request.post(`${BASE_URL}/api/generate`, {
      multipart: {
        quotes: 'Push yourself because no one else is going to do it for you.',
        format: '9:16',
        music:  'none',
      },
      timeout: 120_000,
    });
    const body = await resp.json();
    expect(resp.ok(), JSON.stringify(body)).toBeTruthy();
    expect(body.videos[0].url).toMatch(/\.mp4$/);
    console.log('9:16 video:', body.videos[0].url, '— PASS');
  });

  test('generates multiple videos from multi-line input', async ({ request }) => {
    const multiQuotes = [
      'Dream big and dare to fail.',
      'Success is not final, failure is not fatal: it is the courage to continue that counts.',
    ].join('\n');

    const resp = await request.post(`${BASE_URL}/api/generate`, {
      multipart: {
        quotes: multiQuotes,
        format: '16:9',
        music:  'none',
      },
      timeout: 180_000,
    });
    const body = await resp.json();
    console.log('Multi-quote body:', JSON.stringify(body));
    expect(resp.ok(), JSON.stringify(body)).toBeTruthy();
    expect(body.videos.length).toBe(2);
    console.log('Multi-quote: 2 videos generated — PASS');
  });

  test('generates video from long quote', async ({ request }) => {
    const resp = await request.post(`${BASE_URL}/api/generate`, {
      multipart: {
        quotes: QUOTE_LONG,
        format: '16:9',
        music:  'none',
      },
      timeout: 120_000,
    });
    const body = await resp.json();
    expect(resp.ok(), JSON.stringify(body)).toBeTruthy();
    const buf = await request.get(`${BASE_URL}${body.videos[0].url}`).then(r => r.body());
    expect(buf.length).toBeGreaterThan(50_000);
    console.log(`Long quote video: ${(buf.length / 1024).toFixed(1)} KB — PASS`);
  });

});
