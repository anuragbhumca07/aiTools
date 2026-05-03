// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

const BASE_URL = 'https://ai-bhakti-production.up.railway.app';
const TEST_IMAGE = path.join(__dirname, 'bhakti-test-image.bmp');

// Story with smart quotes, em-dash, ellipsis and length >200 chars — mirrors real user copy-paste
const SHORT_STORY =
  '\u201cIn the sacred land of Vrindavan,\u201d Lord Krishna played his flute\u2026 ' +
  'The sweet melody floated across the Yamuna river\u2014reaching every heart. ' +
  'Devotees gathered on the banks, their eyes filled with tears of joy and devotion. ' +
  'The divine music carried the message: \u201cSurrender to love, and all sorrow shall fade.\u201d';

// Hindi story for language-detection + Hindi TTS test
const HINDI_STORY =
  'भगवान श्री कृष्ण ने अर्जुन को गीता का दिव्य ज्ञान दिया। ' +
  'यह ज्ञान प्रेम, शांति और सत्य का मार्ग दिखाता है। ' +
  'हर मनुष्य को इस ज्ञान से प्रेरणा लेनी चाहिए।';

test.describe('aiBhakti', () => {

  test('health endpoint returns ok', async ({ request }) => {
    const resp = await request.get(`${BASE_URL}/health`);
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('aiBhakti');
  });

  test('API rejects missing story', async ({ request }) => {
    const form = new FormData();
    // no stories field
    const blob = new Blob(['fake'], { type: 'image/jpeg' });
    form.append('images', blob, 'test.jpg');
    const resp = await request.post(`${BASE_URL}/api/generate`, { multipart: {
      images: { name: 'test.jpg', mimeType: 'image/bmp', buffer: Buffer.from('fake') },
    }});
    // should fail with 400
    expect(resp.status()).toBe(400);
  });

  test('generates a video from a single short story', async ({ request }) => {
    const imageBuffer = require('fs').readFileSync(TEST_IMAGE);

    const resp = await request.post(`${BASE_URL}/api/generate`, {
      multipart: {
        stories: SHORT_STORY,
        images:  { name: 'test.jpg', mimeType: 'image/bmp', buffer: imageBuffer },
      },
      timeout: 120_000,   // video generation can take up to 2 min
    });

    console.log('Status:', resp.status());
    const body = await resp.json();
    console.log('Body:', JSON.stringify(body));

    expect(resp.ok(), `Expected 200 but got ${resp.status()}: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.videos).toBeDefined();
    expect(body.videos.length).toBe(1);
    expect(body.videos[0].url).toMatch(/\.mp4$/);

    // Verify the MP4 file is actually accessible and non-empty
    const videoUrl = `${BASE_URL}${body.videos[0].url}`;
    const videoResp = await request.get(videoUrl);
    expect(videoResp.ok()).toBeTruthy();
    const videoBuffer = await videoResp.body();
    expect(videoBuffer.length).toBeGreaterThan(50_000); // at least 50 KB for a real video
    console.log(`Video size: ${(videoBuffer.length / 1024).toFixed(1)} KB — PASS`);
  });

  test('generates a video from Hindi story (Hindi TTS)', async ({ request }) => {
    const imageBuffer = require('fs').readFileSync(TEST_IMAGE);

    const resp = await request.post(`${BASE_URL}/api/generate`, {
      multipart: {
        stories: HINDI_STORY,
        images:  { name: 'test.jpg', mimeType: 'image/bmp', buffer: imageBuffer },
      },
      timeout: 180_000,
    });

    console.log('Hindi status:', resp.status());
    const body = await resp.json();
    console.log('Hindi body:', JSON.stringify(body));

    expect(resp.ok(), `Hindi TTS failed: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.videos).toBeDefined();
    expect(body.videos.length).toBe(1);
    expect(body.videos[0].url).toMatch(/\.mp4$/);

    const videoUrl  = `${BASE_URL}${body.videos[0].url}`;
    const videoResp = await request.get(videoUrl);
    expect(videoResp.ok()).toBeTruthy();
    const videoBuffer = await videoResp.body();
    expect(videoBuffer.length).toBeGreaterThan(50_000);
    console.log(`Hindi video size: ${(videoBuffer.length / 1024).toFixed(1)} KB — PASS`);
  });

  test('generates multiple videos from multi-story input', async ({ request }) => {
    const imageBuffer = require('fs').readFileSync(TEST_IMAGE);
    const twoStories = [
      'Rama lifted the divine bow and the earth trembled with joy.',
      'Hanuman crossed the ocean with the name of Rama in his heart.',
    ].join('\n---\n');

    const resp = await request.post(`${BASE_URL}/api/generate`, {
      multipart: {
        stories: twoStories,
        images:  { name: 'test.jpg', mimeType: 'image/bmp', buffer: imageBuffer },
      },
      timeout: 180_000,
    });

    const body = await resp.json();
    console.log('Multi-story body:', JSON.stringify(body));
    expect(resp.ok(), JSON.stringify(body)).toBeTruthy();
    expect(body.videos.length).toBe(2);
    console.log('Multi-story: 2 videos generated — PASS');
  });

});
