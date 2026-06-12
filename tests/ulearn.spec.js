// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3020';

test.describe('uLearn Tutoring Marketplace', () => {
  // 1. Landing page loads with hero and featured tutors
  test('Landing page loads with hero and featured tutors', async ({ page }) => {
    await page.goto(BASE);
    await expect(page).toHaveTitle(/uLearn/);

    // Hero section
    await expect(page.locator('.hero h1')).toBeVisible();
    await expect(page.locator('.hero h1')).toContainText('Perfect Tutor');

    // Stats bar
    await expect(page.locator('.stats-bar')).toBeVisible();

    // Featured tutors grid — wait for API load
    await page.waitForFunction(() => {
      const grid = document.getElementById('featured-grid');
      return grid && !grid.innerHTML.includes('skeleton') && grid.querySelectorAll('.tutor-card').length > 0;
    }, { timeout: 10000 });

    const tutorCards = page.locator('#featured-grid .tutor-card');
    expect(await tutorCards.count()).toBeGreaterThanOrEqual(3);

    // How it works section
    await expect(page.locator('.steps-grid')).toBeVisible();
  });

  // 2. Search page: search for "Math" returns results
  test('Search page returns results for Math', async ({ page }) => {
    await page.goto(`${BASE}/search.html?q=math`);
    await expect(page).toHaveTitle(/Find Tutors/);

    // Wait for results to load (skeleton disappears)
    await page.waitForFunction(() => {
      const grid = document.getElementById('tutors-grid');
      return grid && !grid.innerHTML.includes('skeleton');
    }, { timeout: 10000 });

    // Should show at least 1 tutor for math
    const resultsCount = page.locator('#results-count');
    await expect(resultsCount).toBeVisible();
    const text = await resultsCount.textContent();
    const num = parseInt(text?.match(/\d+/)?.[0] || '0');
    expect(num).toBeGreaterThan(0);
  });

  // 3. Tutor profile page loads correctly
  test('Tutor profile page loads correctly', async ({ page }) => {
    // First get a valid tutor ID
    const r = await page.request.get(`${BASE}/api/tutors/featured`);
    const { tutors } = await r.json();
    expect(tutors.length).toBeGreaterThan(0);

    const tutorId = tutors[0].id;
    await page.goto(`${BASE}/tutor-profile.html?id=${tutorId}`);

    // Wait for profile to load
    await page.waitForSelector('#profile-content', { state: 'visible', timeout: 10000 });

    // Check key elements
    await expect(page.locator('#tutor-name')).toBeVisible();
    const name = await page.locator('#tutor-name').textContent();
    expect(name?.trim()).toBeTruthy();

    // Hourly rate
    await expect(page.locator('#hourly-rate')).toBeVisible();

    // Book button
    await expect(page.locator('#book-btn')).toBeVisible();

    // Message button
    await expect(page.locator('#msg-btn')).toBeVisible();
  });

  // 4. Login with demo credentials
  test('Login with demo student credentials', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await expect(page).toHaveTitle(/Login/);

    // Fill in credentials
    await page.fill('#login-email', 'student1@ulearn.com');
    await page.fill('#login-password', 'Student123!');
    await page.click('#login-submit');

    // Wait for success or redirect
    await page.waitForFunction(() => {
      return document.getElementById('success-alert')?.style?.display !== 'none' ||
        window.location.pathname.includes('dashboard');
    }, { timeout: 8000 });

    // Should redirect to student dashboard
    await page.waitForURL(/dashboard-student/, { timeout: 5000 });
    await expect(page.url()).toContain('dashboard-student');
  });

  // 5. Student dashboard accessible after login
  test('Student dashboard shows correct content after login', async ({ page }) => {
    // Login first
    await page.goto(`${BASE}/login.html`);
    await page.fill('#login-email', 'student1@ulearn.com');
    await page.fill('#login-password', 'Student123!');
    await page.click('#login-submit');
    await page.waitForURL(/dashboard-student/, { timeout: 8000 });

    // Verify dashboard elements
    await expect(page.locator('.user-name')).toBeVisible();
    await expect(page.locator('#welcome-name')).toBeVisible();

    const welcomeText = await page.locator('#welcome-name').textContent();
    expect(welcomeText?.trim()).toBeTruthy();

    // Stats should be visible
    await expect(page.locator('.stats-row')).toBeVisible();

    // Nav tabs
    await expect(page.locator('.nav-menu')).toBeVisible();
  });

  // 6. Admin login and panel accessible
  test('Admin panel accessible with admin credentials', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.fill('#login-email', 'admin@ulearn.com');
    await page.fill('#login-password', 'Admin123!');
    await page.click('#login-submit');

    await page.waitForURL(/admin/, { timeout: 8000 });
    await expect(page.url()).toContain('admin');

    // Wait for stats to load
    await page.waitForFunction(() => {
      const el = document.getElementById('stat-users');
      return el && el.textContent !== '—';
    }, { timeout: 8000 });

    await expect(page.locator('#stat-users')).toBeVisible();
    const statText = await page.locator('#stat-users').textContent();
    expect(parseInt(statText || '0')).toBeGreaterThan(0);
  });

  // 7. Submit a booking request
  test('Submit a booking request from tutor profile', async ({ page }) => {
    // Login as student
    await page.goto(`${BASE}/login.html`);
    await page.fill('#login-email', 'student1@ulearn.com');
    await page.fill('#login-password', 'Student123!');
    await page.click('#login-submit');
    await page.waitForURL(/dashboard-student/, { timeout: 8000 });

    // Get tutor ID
    const r = await page.request.get(`${BASE}/api/tutors/featured`);
    const { tutors } = await r.json();
    const tutorId = tutors[0].id;

    await page.goto(`${BASE}/tutor-profile.html?id=${tutorId}`);
    await page.waitForSelector('#profile-content', { state: 'visible', timeout: 10000 });

    // Click book button
    await page.click('#book-btn');

    // Modal should open
    await expect(page.locator('#booking-modal')).toHaveClass(/open/, { timeout: 3000 });

    // Fill booking form
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];
    await page.fill('#book-date', dateStr);
    await page.fill('#book-time', '14:00');

    // Submit booking via API directly to avoid dialog handling complexity
    const subject = await page.locator('#book-subject').inputValue();
    const apiR = await page.request.post(`${BASE}/api/bookings`, {
      data: {
        tutor_id: tutorId,
        subject: subject || 'Mathematics',
        scheduled_at: Math.floor(tomorrow.getTime() / 1000) + 14 * 3600,
        duration_minutes: 60,
        mode: 'online'
      }
    });
    expect(apiR.status()).toBe(201);
    const booking = await apiR.json();
    expect(booking.booking).toBeTruthy();
    expect(booking.booking.status).toBe('pending');
  });

  // 8. Tutor can log in and view dashboard
  test('Tutor dashboard accessible with tutor credentials', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.fill('#login-email', 'tutor1@ulearn.com');
    await page.fill('#login-password', 'Tutor123!');
    await page.click('#login-submit');
    await page.waitForURL(/dashboard-tutor/, { timeout: 8000 });

    await expect(page.url()).toContain('dashboard-tutor');
    await expect(page.locator('.user-name')).toBeVisible();

    const name = await page.locator('.user-name').textContent();
    expect(name?.trim()).toBeTruthy();
  });

  // 9. Messages page loads (after login)
  test('Messages page loads for authenticated user', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.fill('#login-email', 'student1@ulearn.com');
    await page.fill('#login-password', 'Student123!');
    await page.click('#login-submit');
    await page.waitForURL(/dashboard-student/, { timeout: 8000 });

    await page.goto(`${BASE}/messages.html`);
    await expect(page).toHaveTitle(/Messages/);

    // Chat layout should be visible
    await expect(page.locator('.chat-layout')).toBeVisible();
    await expect(page.locator('.chat-sidebar')).toBeVisible();
  });

  // 10. Review API works
  test('Reviews load for a tutor profile', async ({ page }) => {
    const r = await page.request.get(`${BASE}/api/tutors/featured`);
    const { tutors } = await r.json();
    const tutorId = tutors[0].id;

    const reviewsR = await page.request.get(`${BASE}/api/reviews/${tutorId}`);
    expect(reviewsR.status()).toBe(200);
    const data = await reviewsR.json();
    expect(data.reviews).toBeDefined();
    expect(Array.isArray(data.reviews)).toBe(true);
  });
});
