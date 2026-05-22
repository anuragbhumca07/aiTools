// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const schedulerHtml = fs.readFileSync(
  path.join(__dirname, '../Scheduler/web/index.html'),
  'utf8'
);

const MOCK_POSTING_ERROR_JOBS = {
  success: true,
  jobs: [
    {
      id: 1,
      status: 'done',
      video_url: 'http://example.com/video.mp4',
      question: 'What is 2 + 2?',
      options: JSON.stringify(['1', '2', '3', '4']),
      correct_idx: 3,
      error: null,
      created_at: new Date(Date.now() - 5 * 60000).toISOString(),
      sname: 'Daily Math Quiz',
      postings: [
        {
          id: 10,
          job_id: 1,
          platform: 'YouTube Shorts',
          status: 'error',
          post_url: null,
          error: 'OAuth token expired. Please re-authenticate your YouTube account.',
          created_at: new Date().toISOString(),
        },
      ],
    },
  ],
};

const MOCK_VIDEO_ERROR_JOBS = {
  success: true,
  jobs: [
    {
      id: 2,
      status: 'error',
      video_url: null,
      question: null,
      options: null,
      correct_idx: null,
      error: 'Quiz API returned 503: Service Unavailable. Failed after 3 retries.',
      created_at: new Date(Date.now() - 10 * 60000).toISOString(),
      sname: 'Science Videos',
      postings: [],
    },
  ],
};

const MOCK_BOTH_ERRORS = {
  success: true,
  jobs: [
    ...MOCK_POSTING_ERROR_JOBS.jobs,
    ...MOCK_VIDEO_ERROR_JOBS.jobs,
  ],
};

/**
 * Load the Scheduler HTML, then directly override window.api and call loadActivity()
 * without going through the Supabase auth flow.
 */
async function setupSchedulerPage(page, jobsResponse) {
  // Block the Supabase CDN — we don't need it for these tests
  await page.route('**cdn.jsdelivr.net/**supabase**', route =>
    route.fulfill({ contentType: 'application/javascript', body: '/* supabase blocked */' })
  );

  await page.setContent(schedulerHtml, { waitUntil: 'domcontentloaded' });

  // Now that all JS functions are defined, override api() and render the activity list directly
  await page.evaluate(async (jobs) => {
    // Override the api helper so loadActivity() returns our mock data
    window.api = async () => ({
      json: async () => jobs,
    });

    // Show app screen (bypassing auth entirely)
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-screen').style.display  = 'block';

    // Render the activity list
    await window.loadActivity();
  }, jobsResponse);

  await page.waitForSelector('.act-row', { timeout: 10000 });
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Scheduler – Recent Activity error tooltips', () => {

  test('posting failure: data-tip contains step + platform + error message', async ({ page }) => {
    await setupSchedulerPage(page, MOCK_POSTING_ERROR_JOBS);

    const failedSpan = page.locator('.act-row [data-tip]').filter({ hasText: 'failed' });
    await expect(failedSpan).toBeVisible();

    const tip = await failedSpan.getAttribute('data-tip');
    expect(tip).toContain('Step: Platform Posting');
    expect(tip).toContain('YouTube Shorts');
    expect(tip).toContain('OAuth token expired');
  });

  test('posting failure: uses data-tip (CSS tooltip), not native title attribute', async ({ page }) => {
    await setupSchedulerPage(page, MOCK_POSTING_ERROR_JOBS);

    const failedSpan = page.locator('.act-row [data-tip]').filter({ hasText: 'failed' });
    await expect(failedSpan).toBeVisible();

    // Must NOT fall back to native title attribute (old behaviour)
    const titleAttr = await failedSpan.getAttribute('title');
    expect(titleAttr).toBeNull();

    const dataTip = await failedSpan.getAttribute('data-tip');
    expect(dataTip).toBeTruthy();
  });

  test('video generation failure: data-tip contains step + full error text', async ({ page }) => {
    await setupSchedulerPage(page, MOCK_VIDEO_ERROR_JOBS);

    const errDiv = page.locator('.act-row [data-tip]');
    await expect(errDiv).toBeVisible();

    const tip = await errDiv.getAttribute('data-tip');
    expect(tip).toContain('Step: Video Generation');
    // Full error in tooltip, not just the truncated inline snippet
    expect(tip).toContain(MOCK_VIDEO_ERROR_JOBS.jobs[0].error);
  });

  test('video generation failure: tooltip carries more info than truncated inline text', async ({ page }) => {
    await setupSchedulerPage(page, MOCK_VIDEO_ERROR_JOBS);

    const errDiv = page.locator('.act-row [data-tip]');
    const inlineText = await errDiv.innerText();
    const tip        = await errDiv.getAttribute('data-tip');

    // Tooltip (step label + full error) must be longer than the truncated inline display
    expect((tip ?? '').length).toBeGreaterThan(inlineText.length);
  });

  test('CSS tooltip ::after is hidden by default and visible on hover', async ({ page }) => {
    await setupSchedulerPage(page, MOCK_POSTING_ERROR_JOBS);

    const failedSpan = page.locator('.act-row [data-tip]').filter({ hasText: 'failed' });
    await expect(failedSpan).toBeVisible();

    // Before hover — pseudo-element opacity should be 0
    const opacityBefore = await page.evaluate(() => {
      const el = document.querySelector('.act-row [data-tip]');
      return parseFloat(window.getComputedStyle(el, '::after').opacity);
    });
    expect(opacityBefore).toBe(0);

    await failedSpan.hover();

    // Wait for the 0.12s CSS transition to fully complete, then check opacity is 1
    await page.waitForFunction(() => {
      const el = document.querySelector('.act-row [data-tip]');
      return parseFloat(window.getComputedStyle(el, '::after').opacity) === 1;
    }, { timeout: 2000 });

    // Also verify the CSS rule that drives the hover-visible state is present in the stylesheet
    const hoverRuleExists = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText === '[data-tip]:hover::after' && rule.style.opacity === '1') {
              return true;
            }
          }
        } catch {}
      }
      return false;
    });
    expect(hoverRuleExists).toBe(true);
  });

  test('both error types render with distinct step labels simultaneously', async ({ page }) => {
    await setupSchedulerPage(page, MOCK_BOTH_ERRORS);

    const allTips = page.locator('.act-row [data-tip]');
    const count   = await allTips.count();
    expect(count).toBeGreaterThanOrEqual(2);

    const tips = await allTips.evaluateAll(els => els.map(el => el.getAttribute('data-tip')));
    expect(tips.some(t => (t ?? '').includes('Step: Platform Posting'))).toBe(true);
    expect(tips.some(t => (t ?? '').includes('Step: Video Generation'))).toBe(true);
  });

  test('screenshot: posting error activity row', async ({ page }) => {
    await setupSchedulerPage(page, MOCK_POSTING_ERROR_JOBS);
    await page.locator('#act-list').screenshot({ path: 'test-results/activity-posting-error.png' });
  });

  test('screenshot: video generation error activity row', async ({ page }) => {
    await setupSchedulerPage(page, MOCK_VIDEO_ERROR_JOBS);
    await page.locator('#act-list').screenshot({ path: 'test-results/activity-video-error.png' });
  });
});
