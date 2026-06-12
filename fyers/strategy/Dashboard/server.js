'use strict';

const express = require('express');
const http    = require('http');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');
const { spawn, execSync } = require('child_process');
const crypto  = require('crypto');

// ── Config ────────────────────────────────────────────────────────
const DASHBOARD_PORT  = parseInt(process.env.DASHBOARD_PORT || '3010', 10);
const AUTH_PORT       = 8080; // matches Fyers redirect URL
const FYERS_APP_ID    = process.env.FYERS_APP_ID    || 'KZZ4Y6S6F2-200';
const FYERS_SECRET_ID = process.env.FYERS_SECRET_ID || 'HaQvYYVPkQ0OAlYI';
const FYERS_APP_ID_HASH = crypto.createHash('sha256')
  .update(`${FYERS_APP_ID}:${FYERS_SECRET_ID}`)
  .digest('hex');

const DATA_DIR   = path.join(__dirname, '..', 'shared_data');
const TOKEN_FILE = path.join(DATA_DIR, 'fyers_token.json');
const ALGO_DIR   = path.join(__dirname, '..', 'algo1');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── 6 Algo Slot Configs ───────────────────────────────────────────
const ALGO_SLOTS = [
  { id: 1, port: 3011, name: 'Algo 1', symbol: 'NSE:RELIANCE-EQ',   symbolLabel: 'RELIANCE' },
  { id: 2, port: 3012, name: 'Algo 2', symbol: 'NSE:TCS-EQ',        symbolLabel: 'TCS' },
  { id: 3, port: 3013, name: 'Algo 3', symbol: 'NSE:HDFCBANK-EQ',   symbolLabel: 'HDFC BANK' },
  { id: 4, port: 3014, name: 'Algo 4', symbol: 'NSE:ICICIBANK-EQ',  symbolLabel: 'ICICI BANK' },
  { id: 5, port: 3015, name: 'Algo 5', symbol: 'NSE:INFY-EQ',       symbolLabel: 'INFY' },
  { id: 6, port: 3016, name: 'Algo 6', symbol: 'NSE:SBIN-EQ',       symbolLabel: 'SBI' },
];

// Runtime state per slot
const slots = ALGO_SLOTS.map(cfg => ({
  ...cfg,
  process:    null,
  pid:        null,
  running:    false,
  lastState:  null,
  lastPoll:   null,
  startedAt:  null,
  logs:       [],
  error:      null,
}));

// ── SSE clients ───────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ── Token helpers ─────────────────────────────────────────────────
function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (!t.access_token || Date.now() > (t.expires_at || 0)) return null;
    return t.access_token;
  } catch { return null; }
}

function saveToken(data) {
  const expires_at = Date.now() + 23 * 60 * 60 * 1000;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...data, expires_at }, null, 2));
}

async function exchangeAuthCode(authCode) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'authorization_code',
      appIdHash:  FYERS_APP_ID_HASH,
      code:       authCode,
    });
    const opts = {
      hostname: 'api-t1.fyers.in',
      path:     '/api/v3/validate-authcode',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.s === 'error') return reject(new Error(json.message || 'Token exchange failed'));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id:     FYERS_APP_ID,
    redirect_uri:  `http://127.0.0.1:${AUTH_PORT}/`,
    response_type: 'code',
    state:         'dashboard',
  });
  return `https://api-t1.fyers.in/api/v3/generate-authcode?${params}`;
}

// ── Market hours ──────────────────────────────────────────────────
function isMarketOpen() {
  const now = new Date();
  const istOffset = 5 * 60 + 30;
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist   = new Date(utcMs + istOffset * 60000);
  const day   = ist.getDay();
  if (day === 0 || day === 6) return false;
  const hhmm = ist.getHours() * 100 + ist.getMinutes();
  return hhmm >= 915 && hhmm < 1530;
}

function marketStatusMessage() {
  const now = new Date();
  const istOffset = 5 * 60 + 30;
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist   = new Date(utcMs + istOffset * 60000);
  const day   = ist.getDay();
  const hhmm  = ist.getHours() * 100 + ist.getMinutes();
  const timeStr = `${ist.getHours().toString().padStart(2,'0')}:${ist.getMinutes().toString().padStart(2,'0')} IST`;
  if (day === 0 || day === 6) return `Market closed — weekend (${timeStr})`;
  if (hhmm < 915)  return `Pre-market — opens 9:15 IST (now ${timeStr})`;
  if (hhmm >= 1530) return `Market closed after hours (${timeStr})`;
  return `Market OPEN (${timeStr})`;
}

// ── Algo process management ───────────────────────────────────────
function startAlgoProcess(slot) {
  if (slot.process) return { ok: false, msg: 'Already running' };

  const env = {
    ...process.env,
    PORT:           String(slot.port),
    ALGO_SLOT:      String(slot.id),
    ALGO_NAME:      slot.name,
    DEFAULT_SYMBOL: slot.symbol,
    FYERS_APP_ID,
    FYERS_SECRET_ID,
  };

  const proc = spawn('node', ['server.js'], {
    cwd: ALGO_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  slot.process   = proc;
  slot.pid       = proc.pid;
  slot.running   = true;
  slot.startedAt = new Date().toISOString();
  slot.error     = null;

  proc.stdout.on('data', data => {
    const line = data.toString().trim();
    if (line) {
      slot.logs.unshift({ ts: new Date().toISOString(), msg: line });
      if (slot.logs.length > 100) slot.logs.length = 100;
      broadcast({ type: 'log', slotId: slot.id, line });
    }
  });
  proc.stderr.on('data', data => {
    const line = data.toString().trim();
    if (line) {
      slot.logs.unshift({ ts: new Date().toISOString(), msg: `[ERR] ${line}` });
      if (slot.logs.length > 100) slot.logs.length = 100;
      broadcast({ type: 'log', slotId: slot.id, line: `[ERR] ${line}` });
    }
  });
  proc.on('exit', (code, signal) => {
    slot.process  = null;
    slot.pid      = null;
    slot.running  = false;
    slot.error    = code !== 0 ? `Exited with code ${code} (signal: ${signal})` : null;
    slot.lastState = null;
    broadcast({ type: 'slot_stopped', slotId: slot.id, code, signal });
    console.log(`[Dashboard] Slot ${slot.id} process exited: code=${code} signal=${signal}`);
  });

  console.log(`[Dashboard] Started Slot ${slot.id} (${slot.name}) on port ${slot.port} PID=${proc.pid}`);
  broadcast({ type: 'slot_started', slotId: slot.id, pid: proc.pid });
  return { ok: true };
}

function stopAlgoProcess(slot) {
  if (!slot.process) return { ok: false, msg: 'Not running' };
  slot.process.kill('SIGTERM');
  setTimeout(() => { if (slot.process) slot.process.kill('SIGKILL'); }, 5000);
  return { ok: true };
}

// ── Poll algo states ──────────────────────────────────────────────
function pollSlot(slot) {
  if (!slot.running) return;
  const opts = {
    hostname: '127.0.0.1',
    port:     slot.port,
    path:     '/api/state',
    method:   'GET',
    timeout:  3000,
  };
  const req = http.request(opts, res => {
    let raw = '';
    res.on('data', d => raw += d);
    res.on('end', () => {
      try {
        slot.lastState = JSON.parse(raw);
        slot.lastPoll  = Date.now();
        broadcast({ type: 'state_update', slotId: slot.id, state: slot.lastState });
      } catch {}
    });
  });
  req.on('error', () => {}); // algo might still be starting
  req.on('timeout', () => req.destroy());
  req.end();
}

setInterval(() => {
  slots.forEach(s => pollSlot(s));
  broadcast({ type: 'heartbeat', marketStatus: marketStatusMessage(), isMarketOpen: isMarketOpen(), fyersConnected: !!loadToken() });
}, 5000);

// ── Dashboard summary ─────────────────────────────────────────────
function dashboardSummary() {
  const runningCount = slots.filter(s => s.running).length;
  let totalPnl = 0, totalTrades = 0, totalWins = 0;
  slots.forEach(s => {
    if (s.lastState) {
      totalPnl    += s.lastState.pnl || 0;
      totalTrades += s.lastState.totalTrades || 0;
      totalWins   += s.lastState.wins || 0;
    }
  });
  return {
    runningCount,
    totalPnl:    parseFloat(totalPnl.toFixed(2)),
    totalTrades,
    totalWins,
    winRate:     totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0',
    marketStatus: marketStatusMessage(),
    isMarketOpen: isMarketOpen(),
    fyersConnected: !!loadToken(),
    fyersAuthUrl: buildAuthUrl(),
  };
}

function slotsPublic() {
  return slots.map(s => ({
    id:        s.id,
    port:      s.port,
    name:      s.name,
    symbol:    s.symbol,
    symbolLabel: s.symbolLabel,
    running:   s.running,
    pid:       s.pid,
    startedAt: s.startedAt,
    error:     s.error,
    lastPoll:  s.lastPoll,
    state:     s.lastState,
    logs:      s.logs.slice(0, 20),
  }));
}

// ── Express dashboard app ─────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/health', (_, res) => res.json({ status: 'ok', dashboard: true, port: DASHBOARD_PORT }));

app.get('/api/summary',   (_, res) => res.json(dashboardSummary()));
app.get('/api/slots',     (_, res) => res.json(slotsPublic()));
app.get('/api/slot/:id',  (req, res) => {
  const s = slots.find(s => s.id === parseInt(req.params.id));
  if (!s) return res.status(404).json({ error: 'Slot not found' });
  res.json({ ...s, process: undefined });
});

// Proxy /api/state, /api/logs, /api/trades to the actual algo process
app.get('/api/slot/:id/proxy/*', (req, res) => {
  const slot = slots.find(s => s.id === parseInt(req.params.id));
  if (!slot || !slot.running) return res.status(503).json({ error: 'Slot not running' });
  const proxyPath = '/' + req.params[0] + (req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?')[1] : '');
  const opts = { hostname: '127.0.0.1', port: slot.port, path: proxyPath, method: 'GET' };
  const pr = http.request(opts, pres => {
    res.status(pres.statusCode);
    pres.pipe(res);
  });
  pr.on('error', e => res.status(502).json({ error: e.message }));
  pr.end();
});

// Start algo
app.post('/api/slot/:id/start', (req, res) => {
  const slot = slots.find(s => s.id === parseInt(req.params.id));
  if (!slot) return res.status(404).json({ error: 'Slot not found' });

  // Allow overriding symbol from request body
  if (req.body && req.body.symbol) {
    slot.symbol      = req.body.symbol;
    slot.symbolLabel = req.body.symbolLabel || req.body.symbol.split(':')[1]?.replace('-EQ','') || req.body.symbol;
  }

  const result = startAlgoProcess(slot);
  if (!result.ok) return res.json(result);

  // Wait for process to start then send start command
  setTimeout(async () => {
    try {
      const startBody = JSON.stringify({
        symbol:    slot.symbol,
        timeframe: req.body?.timeframe || '1m',
        balance:   req.body?.balance   || 100000,
        mode:      req.body?.mode      || 'paper',
      });
      const startReq = http.request({
        hostname: '127.0.0.1', port: slot.port, path: '/api/start', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(startBody) },
      }, r => { r.resume(); });
      startReq.on('error', () => {});
      startReq.write(startBody);
      startReq.end();
    } catch {}
  }, 2500);

  res.json({ ok: true, slotId: slot.id });
});

// Stop algo
app.post('/api/slot/:id/stop', (req, res) => {
  const slot = slots.find(s => s.id === parseInt(req.params.id));
  if (!slot) return res.status(404).json({ error: 'Slot not found' });

  // Try graceful stop first
  if (slot.running) {
    try {
      const stopReq = http.request({
        hostname: '127.0.0.1', port: slot.port, path: '/api/stop', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
      }, r => { r.resume(); });
      stopReq.on('error', () => {});
      stopReq.write('{}');
      stopReq.end();
    } catch {}
    setTimeout(() => stopAlgoProcess(slot), 1500);
  }

  res.json({ ok: true });
});

// Stop all
app.post('/api/stop-all', (_, res) => {
  slots.forEach(slot => {
    if (slot.running) {
      try {
        const stopReq = http.request({
          hostname: '127.0.0.1', port: slot.port, path: '/api/stop', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
        }, r => { r.resume(); });
        stopReq.on('error', () => {});
        stopReq.write('{}');
        stopReq.end();
      } catch {}
      setTimeout(() => stopAlgoProcess(slot), 2000);
    }
  });
  res.json({ ok: true });
});

// Start all
app.post('/api/start-all', (req, res) => {
  const mode = req.body?.mode || 'paper';
  const results = [];
  slots.forEach(slot => {
    if (!slot.running) {
      const r = startAlgoProcess(slot);
      if (r.ok) {
        setTimeout(() => {
          const startBody = JSON.stringify({ symbol: slot.symbol, timeframe: '1m', balance: 100000, mode });
          const sr = http.request({
            hostname: '127.0.0.1', port: slot.port, path: '/api/start', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(startBody) },
          }, rr => { rr.resume(); });
          sr.on('error', () => {});
          sr.write(startBody); sr.end();
        }, 2500);
      }
      results.push({ slotId: slot.id, ...r });
    }
  });
  res.json({ ok: true, results });
});

// Fyers auth URL
app.get('/api/fyers/auth-url', (_, res) => res.json({ url: buildAuthUrl(), connected: !!loadToken() }));

// SSE
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const init = { type: 'init', summary: dashboardSummary(), slots: slotsPublic() };
  res.write(`data: ${JSON.stringify(init)}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.listen(DASHBOARD_PORT, () =>
  console.log(`[Dashboard] Fyers NSE Dashboard on :${DASHBOARD_PORT} | Auth callback on :${AUTH_PORT}`)
);

// ── Fyers OAuth callback server on port 8080 ──────────────────────
const authServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${AUTH_PORT}`);

  if (req.url === '/' || url.pathname === '/') {
    const authCode = url.searchParams.get('auth_code') || url.searchParams.get('code');
    const status   = url.searchParams.get('s');

    if (status === 'error' || !authCode) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body style="background:#0d1117;color:#f85149;font-family:monospace;padding:40px"><h2>⚠ Fyers Auth Failed</h2><p>Check your credentials. <a href="http://localhost:3010" style="color:#58a6ff">Return to Dashboard</a></p></body></html>');
    }

    try {
      const tokenData = await exchangeAuthCode(authCode);
      saveToken(tokenData);
      console.log('[Dashboard] Fyers token saved successfully');
      broadcast({ type: 'fyers_connected' });
      res.writeHead(302, { Location: `http://localhost:${DASHBOARD_PORT}/?auth=success` });
      res.end();
    } catch (err) {
      console.error('[Dashboard] Token exchange error:', err.message);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="background:#0d1117;color:#f85149;font-family:monospace;padding:40px"><h2>Token Exchange Failed</h2><p>${err.message}</p><a href="http://localhost:3010" style="color:#58a6ff">Return to Dashboard</a></body></html>`);
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Fyers OAuth callback server running');
});

authServer.listen(AUTH_PORT, () =>
  console.log(`[Dashboard] Fyers OAuth callback listening on :${AUTH_PORT}`)
);

// ── Graceful shutdown ──────────────────────────────────────────────
process.on('SIGTERM', () => {
  slots.forEach(s => { if (s.process) s.process.kill('SIGTERM'); });
  process.exit(0);
});
process.on('SIGINT', () => {
  slots.forEach(s => { if (s.process) s.process.kill('SIGTERM'); });
  process.exit(0);
});
