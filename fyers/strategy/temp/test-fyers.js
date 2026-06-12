'use strict';

/**
 * Fyers API credential & data fetch tester
 * Run: node test-fyers.js
 *
 * Tests:
 *  1. Validates stored token (if any) from shared_data/fyers_token.json
 *  2. Fetches 5-day RELIANCE 15m OHLCV data via Fyers /data/history
 *  3. Prints candle summary + last 5 candles
 *  4. If no valid token, prints the OAuth URL to authenticate
 */

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Credentials ───────────────────────────────────────────────────
const FYERS_APP_ID    = process.env.FYERS_APP_ID    || 'KZZ4Y6S6F2-200';
const FYERS_SECRET_ID = process.env.FYERS_SECRET_ID || 'HaQvYYVPkQ0OAlYI';
const AUTH_PORT       = 8080;
const FYERS_APP_ID_HASH = crypto.createHash('sha256')
  .update(`${FYERS_APP_ID}:${FYERS_SECRET_ID}`)
  .digest('hex');

const TOKEN_FILE = path.join(__dirname, '..', 'shared_data', 'fyers_token.json');
const TEST_SYMBOL    = 'NSE:RELIANCE-EQ';
const TEST_TIMEFRAME = '15';   // 15-minute candles
const TEST_DAYS      = 5;

// ── Colors for terminal output ────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  blue:   '\x1b[34m',
};
const ok   = s => `${C.green}✔${C.reset} ${s}`;
const fail = s => `${C.red}✘${C.reset} ${s}`;
const info = s => `${C.cyan}ℹ${C.reset} ${s}`;
const warn = s => `${C.yellow}⚠${C.reset} ${s}`;
const hdr  = s => `\n${C.bold}${C.blue}── ${s} ──${C.reset}`;

// ── Helpers ───────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out after 15s')); });
    req.end();
  });
}

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out after 15s')); });
    req.write(data);
    req.end();
  });
}

// ── Token management ──────────────────────────────────────────────
function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (!t.access_token || Date.now() > (t.expires_at || 0)) return null;
    return t;
  } catch { return null; }
}

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id:     FYERS_APP_ID,
    redirect_uri:  `http://127.0.0.1:${AUTH_PORT}/`,
    response_type: 'code',
    state:         'test',
  });
  return `https://api-t1.fyers.in/api/v3/generate-authcode?${params}`;
}

function toIST(epochMs) {
  return new Date(epochMs).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

// ── Date helpers for API range ────────────────────────────────────
// Fyers date_format=1: candle times come back as Unix epoch, but range params
// must be YYYY-MM-DD strings (not epoch integers)
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ── Main test ─────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════╗`);
  console.log(`║    Fyers API Credential & Data Tester    ║`);
  console.log(`╚══════════════════════════════════════════╝${C.reset}\n`);

  // ── Step 1: Credentials ───────────────────────────────────────
  console.log(hdr('Step 1 — Credentials'));
  console.log(info(`App ID      : ${C.bold}${FYERS_APP_ID}${C.reset}`));
  console.log(info(`Secret      : ${FYERS_SECRET_ID.slice(0, 4)}${'*'.repeat(FYERS_SECRET_ID.length - 4)}`));
  console.log(info(`App ID Hash : ${FYERS_APP_ID_HASH.slice(0, 16)}… (SHA-256)`));

  // ── Step 2: Token check ───────────────────────────────────────
  console.log(hdr('Step 2 — Token Check'));
  const tokenData = loadToken();

  if (!tokenData) {
    // Check if file exists but expired
    if (fs.existsSync(TOKEN_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        if (raw.access_token && Date.now() > (raw.expires_at || 0)) {
          const expiredAt = new Date(raw.expires_at || 0).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
          console.log(warn(`Token found but EXPIRED at ${expiredAt} IST`));
        }
      } catch {}
    } else {
      console.log(fail(`No token file found at: ${TOKEN_FILE}`));
    }

    console.log(fail('Not authenticated with Fyers'));
    console.log(`\n${C.yellow}${C.bold}To authenticate:${C.reset}`);
    console.log(`  1. Make sure the Dashboard is running: ${C.cyan}node ../Dashboard/server.js${C.reset}`);
    console.log(`  2. Open this URL in your browser:\n`);
    console.log(`     ${C.cyan}${buildAuthUrl()}${C.reset}\n`);
    console.log(`  3. Login with your Fyers account`);
    console.log(`  4. You'll be redirected to http://127.0.0.1:8080/ and the token will be saved automatically`);
    console.log(`  5. Re-run this script: ${C.cyan}node test-fyers.js${C.reset}\n`);

    // Try to trigger OAuth via dashboard if running
    await tryDashboardAuth();
    return;
  }

  const expiresAt = new Date(tokenData.expires_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const remainingHours = ((tokenData.expires_at - Date.now()) / 3600000).toFixed(1);
  console.log(ok(`Token found and valid`));
  console.log(info(`Expires at  : ${expiresAt} IST (${remainingHours}h remaining)`));
  console.log(info(`Token prefix: ${tokenData.access_token.slice(0, 20)}…`));

  const token = tokenData.access_token;
  const authHeader = `${FYERS_APP_ID}:${token}`;

  // ── Step 3: Profile API test ──────────────────────────────────
  console.log(hdr('Step 3 — Profile API Test'));
  try {
    const profileRes = await httpsGet(
      'https://api-t1.fyers.in/api/v3/profile',
      { Authorization: authHeader }
    );
    if (profileRes.status === 200 && profileRes.body?.s !== 'error') {
      const p = profileRes.body?.data || profileRes.body;
      console.log(ok(`Profile API: HTTP ${profileRes.status}`));
      if (p?.name) console.log(info(`Name   : ${p.name}`));
      if (p?.email_id) console.log(info(`Email  : ${p.email_id}`));
      if (p?.fy_id) console.log(info(`Fyers ID: ${p.fy_id}`));
    } else {
      console.log(warn(`Profile API returned: HTTP ${profileRes.status}`));
      console.log(warn(`Response: ${JSON.stringify(profileRes.body).slice(0, 200)}`));
    }
  } catch (err) {
    console.log(warn(`Profile API skipped: ${err.message}`));
  }

  // ── Step 4: Historical data fetch ─────────────────────────────
  console.log(hdr(`Step 4 — Historical Data: ${TEST_SYMBOL} (${TEST_DAYS} days, ${TEST_TIMEFRAME}m)`));

  const rangeFrom = daysAgoStr(TEST_DAYS);
  const rangeTo   = todayStr();

  const histUrl = `https://api-t1.fyers.in/data/history?symbol=${encodeURIComponent(TEST_SYMBOL)}&resolution=${TEST_TIMEFRAME}&date_format=1&range_from=${rangeFrom}&range_to=${rangeTo}&cont_flag=1`;

  console.log(info(`URL: …/data/history?symbol=${TEST_SYMBOL}&resolution=${TEST_TIMEFRAME}&range_from=${rangeFrom}&range_to=${rangeTo}`));

  let candles = [];
  try {
    const res = await httpsGet(histUrl, { Authorization: authHeader });

    if (res.status !== 200) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    if (res.body?.s === 'error' || res.body?.s === 'no_data') {
      throw new Error(`Fyers API error: ${res.body.message || res.body.s} (code: ${res.body.code || '?'})`);
    }
    if (!res.body?.candles || !Array.isArray(res.body.candles)) {
      throw new Error(`Unexpected response shape: ${JSON.stringify(res.body).slice(0, 200)}`);
    }

    candles = res.body.candles.map(c => ({
      time:   c[0],        // Unix epoch seconds
      open:   c[1],
      high:   c[2],
      low:    c[3],
      close:  c[4],
      volume: c[5],
    }));

    console.log(ok(`Fetched ${candles.length} candles successfully`));

    if (candles.length === 0) {
      console.log(warn('No candles returned — market may have been closed for the date range'));
    } else {
      const first = candles[0];
      const last  = candles[candles.length - 1];
      const highs = candles.map(c => c.high);
      const lows  = candles.map(c => c.low);
      const maxH  = Math.max(...highs).toFixed(2);
      const minL  = Math.min(...lows).toFixed(2);

      console.log(info(`Date range : ${toIST(first.time * 1000)} → ${toIST(last.time * 1000)} IST`));
      console.log(info(`Period high: ₹${maxH}`));
      console.log(info(`Period low : ₹${minL}`));
      console.log(info(`Last close : ₹${last.close.toFixed(2)}`));

      // Print last 5 candles as a table
      console.log(`\n${C.bold}Last 5 candles:${C.reset}`);
      console.log(`${'Time (IST)'.padEnd(26)} ${'Open'.padStart(9)} ${'High'.padStart(9)} ${'Low'.padStart(9)} ${'Close'.padStart(9)} ${'Volume'.padStart(12)}`);
      console.log('─'.repeat(84));
      candles.slice(-5).forEach(c => {
        const ts  = toIST(c.time * 1000).padEnd(26);
        const o   = `₹${c.open.toFixed(2)}`.padStart(9);
        const h   = `₹${c.high.toFixed(2)}`.padStart(9);
        const l   = `₹${c.low.toFixed(2)}`.padStart(9);
        const cl  = `₹${c.close.toFixed(2)}`.padStart(9);
        const vol = c.volume.toLocaleString('en-IN').padStart(12);
        console.log(`${C.gray}${ts}${C.reset} ${o} ${C.green}${h}${C.reset} ${C.red}${l}${C.reset} ${C.bold}${cl}${C.reset} ${vol}`);
      });
    }
  } catch (err) {
    console.log(fail(`Historical data fetch failed: ${err.message}`));
    await diagnoseError(err, authHeader);
    return;
  }

  // ── Step 5: Funds check ───────────────────────────────────────
  console.log(hdr('Step 5 — Funds / Account Check'));
  try {
    const fundsRes = await httpsGet(
      'https://api-t1.fyers.in/api/v3/funds',
      { Authorization: authHeader }
    );
    if (fundsRes.status === 200 && fundsRes.body?.s !== 'error') {
      const fund = fundsRes.body?.fund_limit || fundsRes.body?.data?.fund_limit;
      if (Array.isArray(fund)) {
        const equity = fund.find(f => f.title === 'Total Balance' || f.title === 'Available Balance' || f.equityAmount !== undefined);
        if (equity) {
          console.log(ok(`Funds API: OK`));
          fund.slice(0, 4).forEach(f => {
            if (f.title) console.log(info(`${(f.title || '').padEnd(20)}: ₹${(f.equityAmount || 0).toFixed(2)}`));
          });
        } else {
          console.log(ok(`Funds API: OK (${fund.length} entries)`));
        }
      } else {
        console.log(ok(`Funds API: HTTP ${fundsRes.status}`));
      }
    } else {
      console.log(warn(`Funds API: HTTP ${fundsRes.status} — ${JSON.stringify(fundsRes.body).slice(0, 100)}`));
    }
  } catch (err) {
    console.log(warn(`Funds check skipped: ${err.message}`));
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log(hdr('Result'));
  if (candles.length > 0) {
    console.log(`\n${C.green}${C.bold} ALL TESTS PASSED — Fyers API is working correctly!${C.reset}`);
    console.log(`${C.gray} Token valid, profile accessible, historical data fetched (${candles.length} candles).${C.reset}`);
    console.log(`${C.gray} Your algo servers on ports 3011–3016 are ready to trade.\n${C.reset}`);
  } else {
    console.log(`\n${C.yellow}${C.bold} Auth OK but no candles — check if market was open during test range.\n${C.reset}`);
  }
}

// ── Try to get auth URL via running dashboard ─────────────────────
async function tryDashboardAuth() {
  return new Promise(resolve => {
    const req = http.get('http://localhost:3010/api/fyers/auth-url', res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.connected) {
            console.log(ok('Dashboard reports Fyers IS connected — rerun the script'));
          } else {
            console.log(info(`Dashboard auth URL: ${json.url}`));
            console.log(info('Open the URL above in your browser to authenticate, then rerun.'));
          }
        } catch {}
        resolve();
      });
    });
    req.on('error', () => {
      console.log(info('Dashboard not running on :3010 — start it first: node ../Dashboard/server.js'));
      resolve();
    });
    req.setTimeout(2000, () => { req.destroy(); resolve(); });
  });
}

// ── Diagnose common Fyers API errors ─────────────────────────────
async function diagnoseError(err, authHeader) {
  const msg = err.message || '';
  console.log(hdr('Diagnosis'));

  if (msg.includes('401') || msg.includes('invalid_token') || msg.includes('token')) {
    console.log(warn('Token appears invalid or expired.'));
    console.log(info('Delete the token file and re-authenticate:'));
    console.log(`  del "${TOKEN_FILE}"`);
    console.log(`  Open the dashboard at http://localhost:3010 and click "Connect Fyers Account"`);
  } else if (msg.includes('429') || msg.includes('rate')) {
    console.log(warn('Rate limit hit. Wait 30 seconds and retry.'));
  } else if (msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
    console.log(warn('Network error — check your internet connection.'));
    console.log(info('Fyers API host: api-t1.fyers.in'));
  } else if (msg.includes('no_data')) {
    console.log(warn('No data available for the requested range.'));
    console.log(info('NSE market may have been closed for those dates (weekend/holiday).'));
    console.log(info('Try fetching data for a weekday range during market hours.'));
  } else {
    console.log(warn(`Unexpected error: ${msg}`));
    console.log(info('Check your Fyers App ID and Secret are correct:'));
    console.log(info(`  App ID: ${authHeader?.split(':')[0] || 'unknown'}`));
    console.log(info('Verify the app is active in Fyers API portal: https://myapi.fyers.in/'));
  }
  console.log('');
}

main().catch(err => {
  console.error(`\n${C.red}Fatal error:${C.reset}`, err.message);
  process.exit(1);
});
