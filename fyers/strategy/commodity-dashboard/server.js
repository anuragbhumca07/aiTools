'use strict';

const express = require('express');
const http    = require('http');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');
const { spawn } = require('child_process');
const crypto  = require('crypto');

// ── Config ────────────────────────────────────────────────────────
const DASHBOARD_PORT  = parseInt(process.env.DASHBOARD_PORT || '3020', 10);
const AUTH_PORT       = 8081; // separate port so NSE and MCX can run simultaneously
const FYERS_APP_ID    = process.env.FYERS_APP_ID    || 'KZZ4Y6S6F2-200';
const FYERS_SECRET_ID = process.env.FYERS_SECRET_ID || 'HaQvYYVPkQ0OAlYI';
const FYERS_APP_ID_HASH = crypto.createHash('sha256')
  .update(`${FYERS_APP_ID}:${FYERS_SECRET_ID}`)
  .digest('hex');

const DATA_DIR   = path.join(__dirname, '..', 'shared_data');
const TOKEN_FILE = path.join(DATA_DIR, 'fyers_token.json');
const ALGO_DIR   = path.join(__dirname, '..', 'algo1');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── MCX Commodity Algo Slot Configs ───────────────────────────────
const ALGO_SLOTS = [
  { id: 1, port: 3021, name: 'Gold',        symbol: 'MCX:GOLD25JUNFUT',       symbolLabel: 'GOLD' },
  { id: 2, port: 3022, name: 'Silver',       symbol: 'MCX:SILVER25JUNFUT',     symbolLabel: 'SILVER' },
  { id: 3, port: 3023, name: 'Crude Oil',    symbol: 'MCX:CRUDEOIL25JUNFUT',   symbolLabel: 'CRUDEOIL' },
  { id: 4, port: 3024, name: 'Natural Gas',  symbol: 'MCX:NATURALGAS25JUNFUT', symbolLabel: 'NATGAS' },
  { id: 5, port: 3025, name: 'Copper',       symbol: 'MCX:COPPER25JUNFUT',     symbolLabel: 'COPPER' },
  { id: 6, port: 3026, name: 'Aluminium',    symbol: 'MCX:ALUMINIUM25JUNFUT',  symbolLabel: 'ALUMINIUM' },
];

const slots = ALGO_SLOTS.map(cfg => ({
  ...cfg, process: null, pid: null, running: false,
  lastState: null, lastPoll: null, startedAt: null, logs: [], error: null,
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
    const body = JSON.stringify({ grant_type: 'authorization_code', appIdHash: FYERS_APP_ID_HASH, code: authCode });
    const opts = {
      hostname: 'api-t1.fyers.in', path: '/api/v3/validate-authcode', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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
    req.write(body); req.end();
  });
}

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: FYERS_APP_ID,
    redirect_uri: `http://127.0.0.1:${AUTH_PORT}/`,
    response_type: 'code',
    state: 'commodity-dashboard',
  });
  return `https://api-t1.fyers.in/api/v3/generate-authcode?${params}`;
}

// ── MCX Market hours (9:00 – 23:30 IST, Mon-Fri) ─────────────────
function isMarketOpen() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist   = new Date(utcMs + (5 * 60 + 30) * 60000);
  const day   = ist.getDay();
  if (day === 0 || day === 6) return false;
  const hhmm = ist.getHours() * 100 + ist.getMinutes();
  return hhmm >= 900 && hhmm < 2330;
}

function marketStatusMessage() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist   = new Date(utcMs + (5 * 60 + 30) * 60000);
  const day   = ist.getDay();
  const hhmm  = ist.getHours() * 100 + ist.getMinutes();
  const timeStr = `${ist.getHours().toString().padStart(2,'0')}:${ist.getMinutes().toString().padStart(2,'0')} IST`;
  if (day === 0 || day === 6) return `MCX closed — weekend (${timeStr})`;
  if (hhmm < 900)  return `Pre-market — MCX opens 9:00 IST (now ${timeStr})`;
  if (hhmm >= 2330) return `MCX closed (after hours) (${timeStr})`;
  return `MCX Market OPEN (${timeStr})`;
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
    EXCHANGE:       'MCX',
    FYERS_APP_ID,
    FYERS_SECRET_ID,
  };
  const proc = spawn('node', ['server.js'], { cwd: ALGO_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  slot.process = proc; slot.pid = proc.pid; slot.running = true;
  slot.startedAt = new Date().toISOString(); slot.error = null;

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
    slot.process = null; slot.pid = null; slot.running = false;
    slot.error = code !== 0 ? `Exited with code ${code}` : null;
    slot.lastState = null;
    broadcast({ type: 'slot_stopped', slotId: slot.id, code, signal });
  });
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
  const req = http.request({ hostname: '127.0.0.1', port: slot.port, path: '/api/state', method: 'GET', timeout: 3000 }, res => {
    let raw = '';
    res.on('data', d => raw += d);
    res.on('end', () => {
      try {
        slot.lastState = JSON.parse(raw); slot.lastPoll = Date.now();
        broadcast({ type: 'state_update', slotId: slot.id, state: slot.lastState });
      } catch {}
    });
  });
  req.on('error', () => {}); req.on('timeout', () => req.destroy()); req.end();
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
    if (s.lastState) { totalPnl += s.lastState.pnl || 0; totalTrades += s.lastState.totalTrades || 0; totalWins += s.lastState.wins || 0; }
  });
  return {
    runningCount, totalPnl: parseFloat(totalPnl.toFixed(2)), totalTrades, totalWins,
    winRate: totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0',
    marketStatus: marketStatusMessage(), isMarketOpen: isMarketOpen(),
    fyersConnected: !!loadToken(), fyersAuthUrl: buildAuthUrl(),
  };
}

function slotsPublic() {
  return slots.map(s => ({
    id: s.id, port: s.port, name: s.name, symbol: s.symbol, symbolLabel: s.symbolLabel,
    running: s.running, pid: s.pid, startedAt: s.startedAt, error: s.error,
    lastPoll: s.lastPoll, state: s.lastState, logs: s.logs.slice(0, 20),
  }));
}

// ── Express app ───────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/health', (_, res) => res.json({ status: 'ok', dashboard: 'commodity', port: DASHBOARD_PORT }));
app.get('/api/summary', (_, res) => res.json(dashboardSummary()));
app.get('/api/slots',   (_, res) => res.json(slotsPublic()));
app.get('/api/slot/:id', (req, res) => {
  const s = slots.find(s => s.id === parseInt(req.params.id));
  if (!s) return res.status(404).json({ error: 'Slot not found' });
  res.json({ ...s, process: undefined });
});

app.post('/api/slot/:id/start', (req, res) => {
  const slot = slots.find(s => s.id === parseInt(req.params.id));
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  if (req.body?.symbol) {
    slot.symbol = req.body.symbol;
    slot.symbolLabel = req.body.symbolLabel || req.body.symbol.split(':')[1] || req.body.symbol;
  }
  const result = startAlgoProcess(slot);
  if (!result.ok) return res.json(result);
  setTimeout(async () => {
    try {
      const startBody = JSON.stringify({ symbol: slot.symbol, timeframe: req.body?.timeframe || '1m', balance: req.body?.balance || 100000, mode: req.body?.mode || 'paper' });
      const sr = http.request({ hostname: '127.0.0.1', port: slot.port, path: '/api/start', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(startBody) } }, r => { r.resume(); });
      sr.on('error', () => {}); sr.write(startBody); sr.end();
    } catch {}
  }, 2500);
  res.json({ ok: true, slotId: slot.id });
});

app.post('/api/slot/:id/stop', (req, res) => {
  const slot = slots.find(s => s.id === parseInt(req.params.id));
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  if (slot.running) {
    try {
      const sr = http.request({ hostname: '127.0.0.1', port: slot.port, path: '/api/stop', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, r => { r.resume(); });
      sr.on('error', () => {}); sr.write('{}'); sr.end();
    } catch {}
    setTimeout(() => stopAlgoProcess(slot), 1500);
  }
  res.json({ ok: true });
});

app.post('/api/stop-all', (_, res) => {
  slots.forEach(slot => {
    if (slot.running) {
      try {
        const sr = http.request({ hostname: '127.0.0.1', port: slot.port, path: '/api/stop', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, r => { r.resume(); });
        sr.on('error', () => {}); sr.write('{}'); sr.end();
      } catch {}
      setTimeout(() => stopAlgoProcess(slot), 2000);
    }
  });
  res.json({ ok: true });
});

app.post('/api/start-all', (req, res) => {
  const mode = req.body?.mode || 'paper';
  const results = [];
  slots.forEach(slot => {
    if (!slot.running) {
      const r = startAlgoProcess(slot);
      if (r.ok) {
        setTimeout(() => {
          const startBody = JSON.stringify({ symbol: slot.symbol, timeframe: '1m', balance: 100000, mode });
          const sr = http.request({ hostname: '127.0.0.1', port: slot.port, path: '/api/start', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(startBody) } }, rr => { rr.resume(); });
          sr.on('error', () => {}); sr.write(startBody); sr.end();
        }, 2500);
      }
      results.push({ slotId: slot.id, ...r });
    }
  });
  res.json({ ok: true, results });
});

app.get('/api/fyers/auth-url', (_, res) => res.json({ url: buildAuthUrl(), connected: !!loadToken() }));

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'init', summary: dashboardSummary(), slots: slotsPublic() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.listen(DASHBOARD_PORT, () =>
  console.log(`[MCX Dashboard] Commodity Dashboard on :${DASHBOARD_PORT} | Auth callback on :${AUTH_PORT}`)
);

// ── Fyers OAuth callback ──────────────────────────────────────────
const authServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${AUTH_PORT}`);
  if (req.url === '/' || url.pathname === '/') {
    const authCode = url.searchParams.get('auth_code') || url.searchParams.get('code');
    const status   = url.searchParams.get('s');
    if (status === 'error' || !authCode) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body style="background:#0d1117;color:#f85149;font-family:monospace;padding:40px"><h2>⚠ Fyers Auth Failed</h2><a href="http://localhost:3020" style="color:#58a6ff">Return to Dashboard</a></body></html>');
    }
    try {
      const tokenData = await exchangeAuthCode(authCode);
      saveToken(tokenData);
      broadcast({ type: 'fyers_connected' });
      res.writeHead(302, { Location: `http://localhost:${DASHBOARD_PORT}/?auth=success` });
      res.end();
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="background:#0d1117;color:#f85149;font-family:monospace;padding:40px"><h2>Token Exchange Failed</h2><p>${err.message}</p></body></html>`);
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Fyers OAuth callback server running');
});

authServer.listen(AUTH_PORT, () =>
  console.log(`[MCX Dashboard] Fyers OAuth callback on :${AUTH_PORT}`)
);

process.on('SIGTERM', () => { slots.forEach(s => { if (s.process) s.process.kill('SIGTERM'); }); process.exit(0); });
process.on('SIGINT',  () => { slots.forEach(s => { if (s.process) s.process.kill('SIGTERM'); }); process.exit(0); });
