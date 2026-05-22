'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const { generateSignal, checkExit, fetchCandles } = require('./algo');

const app  = express();
const PORT = parseInt(process.env.PORT || '3006', 10);

// ── Persistence dirs ─────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(__dirname, 'logs');
[DATA_DIR, LOGS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── SQLite ───────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'trades.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT,
    type          TEXT,
    side          TEXT,
    symbol        TEXT,
    timeframe     TEXT,
    price         REAL,
    size          REAL,
    pnl           REAL,
    stop_loss     REAL,
    take_profit   REAL,
    reason        TEXT,
    balance_after REAL,
    timestamp     TEXT,
    mae           REAL DEFAULT 0
  )
`);
// Migrate existing deployments
try { db.exec('ALTER TABLE trades ADD COLUMN mae REAL DEFAULT 0'); } catch {}

const stmtInsert = db.prepare(`
  INSERT INTO trades
    (session_id,type,side,symbol,timeframe,price,size,pnl,stop_loss,take_profit,reason,balance_after,timestamp,mae)
  VALUES
    (@session_id,@type,@side,@symbol,@timeframe,@price,@size,@pnl,@stop_loss,@take_profit,@reason,@balance_after,@timestamp,@mae)
`);

// ── Runtime state ─────────────────────────────────────────────────
const state = {
  running:           false,
  symbol:            'BTCUSDT',
  timeframe:         '15m',
  balance:           10000,
  initialBalance:    10000,
  sessionId:         null,
  sessionStart:      null,
  position:          null,
  pnl:               0,
  totalTrades:       0,
  wins:              0,
  lastIndicators:    null,
  lastSignal:        null,
  error:             null,
  peakBalance:       10000,
  maxDrawdownDollar: 0,
  maxDrawdownPct:    0,
};

let logs       = [];
let sseClients = new Set();
let ticker     = null;
let tickBusy   = false;

// ── SSE helpers ───────────────────────────────────────────────────
function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

function pushLog(entry) {
  const row = { id: Date.now() + Math.random(), ...entry };
  logs.unshift(row);
  if (logs.length > 500) logs.length = 500;
  broadcast({ type: 'log', entry: row });
}

function publicState() {
  const {
    running, symbol, timeframe, balance, initialBalance, sessionId, sessionStart,
    pnl, totalTrades, wins, lastIndicators, lastSignal, error,
    peakBalance, maxDrawdownDollar, maxDrawdownPct,
  } = state;
  return {
    running, symbol, timeframe, balance, initialBalance, sessionId, sessionStart,
    pnl, totalTrades, wins, error,
    lastIndicators, lastSignal,
    position:          state.position ? { ...state.position } : null,
    winRate:           totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0',
    pnlPct:            ((pnl / (initialBalance || 10000)) * 100).toFixed(2),
    peakBalance,
    maxDrawdownDollar: parseFloat(maxDrawdownDollar.toFixed(2)),
    maxDrawdownPct:    parseFloat(maxDrawdownPct.toFixed(2)),
  };
}

function updateDrawdown() {
  if (state.balance > state.peakBalance) state.peakBalance = state.balance;
  const dd = state.peakBalance - state.balance;
  const ddPct = state.peakBalance > 0 ? (dd / state.peakBalance) * 100 : 0;
  if (dd > state.maxDrawdownDollar) {
    state.maxDrawdownDollar = dd;
    state.maxDrawdownPct    = ddPct;
  }
}

// ── Main algo tick ────────────────────────────────────────────────
async function runTick() {
  const { symbol, timeframe, sessionId } = state;
  const ts = new Date().toISOString();
  try {
    state.error = null;
    const candles = await fetchCandles(symbol, timeframe, 100);
    const price   = candles[candles.length - 1].close;

    // ── Exit check ───────────────────────────────────────────────
    if (state.position) {
      const exitResult = checkExit(state.position, candles);
      state.lastIndicators = exitResult.indicators;

      if (exitResult.exit) {
        const { side, entryPrice, size, stopLoss, takeProfit, mae } = state.position;
        const rawPnl = side === 'long'
          ? (price - entryPrice) * size
          : (entryPrice - price) * size;
        const pnl = parseFloat(rawPnl.toFixed(4));

        state.balance   += pnl;
        state.pnl       += pnl;
        if (pnl > 0) state.wins++;
        state.totalTrades++;
        updateDrawdown();
        state.position = null;

        const trade = {
          session_id: sessionId, type: 'exit', side, symbol, timeframe,
          price, size, pnl, stop_loss: stopLoss, take_profit: takeProfit,
          reason: exitResult.reasons.join(' | '),
          balance_after: parseFloat(state.balance.toFixed(4)),
          timestamp: ts,
          mae: parseFloat((mae || 0).toFixed(4)),
        };
        stmtInsert.run(trade);

        pushLog({ ts, type: 'EXIT', side, price, pnl, balance: state.balance.toFixed(4),
                  mae: (mae || 0).toFixed(2), reason: exitResult.reasons, indicators: state.lastIndicators });
        broadcast({ type: 'trade', trade, state: publicState() });
        return;
      }

      // Update unrealized PnL (live while in position)
      const { side, entryPrice, size } = state.position;
      state.position.unrealizedPnl = parseFloat(
        (side === 'long' ? (price - entryPrice) * size : (entryPrice - price) * size).toFixed(4)
      );
    }

    // ── Signal check ─────────────────────────────────────────────
    const { signal, reason, indicators, buyScore, sellScore } = generateSignal(candles);
    state.lastIndicators = indicators;
    state.lastSignal     = { signal, buyScore, sellScore };

    if (!state.position && (signal === 'BUY' || signal === 'SELL')) {
      const { atr } = indicators;
      // Wider stop: max(2×ATR, 0.15% of price) — prevents noise-induced stop hits
      const stopDist = Math.max(2 * atr, price * 0.0015);
      const riskAmt  = state.balance * 0.015;  // 1.5% risk per trade
      const size     = parseFloat((riskAmt / stopDist).toFixed(8));
      const side     = signal === 'BUY' ? 'long' : 'short';
      const sl       = side === 'long' ? price - stopDist : price + stopDist;
      const tp       = side === 'long' ? price + stopDist * 2 : price - stopDist * 2; // 2:1 R:R

      state.position = {
        side, entryPrice: price, size, stopLoss: sl, takeProfit: tp,
        entryTime: ts, unrealizedPnl: 0,
        phase: 1, candlesHeld: 0, lastCandleTime: null, mae: 0,
      };

      const trade = {
        session_id: sessionId, type: 'entry', side, symbol, timeframe,
        price, size, pnl: 0, stop_loss: sl, take_profit: tp,
        reason: reason.join(' | '),
        balance_after: parseFloat(state.balance.toFixed(4)),
        timestamp: ts, mae: 0,
      };
      stmtInsert.run(trade);

      pushLog({ ts, type: 'ENTRY', side, signal, price, size, stopLoss: sl, takeProfit: tp,
                balance: state.balance.toFixed(4), reason, indicators });
      broadcast({ type: 'trade', trade, state: publicState() });
    } else {
      pushLog({ ts, type: 'TICK', signal: `${signal} (B:${buyScore} S:${sellScore})`,
                price, indicators, reason });
      broadcast({ type: 'tick', state: publicState() });
    }
  } catch (err) {
    state.error = err.message;
    pushLog({ ts, type: 'ERROR', message: err.message });
    broadcast({ type: 'error', message: err.message, state: publicState() });
  }
}

async function tick() {
  if (tickBusy) return;
  tickBusy = true;
  try { await runTick(); } finally { tickBusy = false; }
}

// ── Routes ────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.get('/api/state', (_, res) => res.json(publicState()));
app.get('/api/logs',  (_, res) => res.json(logs));

app.get('/api/trades', (req, res) => {
  const { session, all } = req.query;
  let rows;
  if (all) {
    rows = db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 2000').all();
  } else if (session) {
    rows = db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(session);
  } else if (state.sessionId) {
    rows = db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(state.sessionId);
  } else {
    rows = [];
  }
  res.json(rows);
});

app.post('/api/start', (req, res) => {
  if (state.running) return res.json({ ok: false, msg: 'Already running' });
  const { symbol = 'BTCUSDT', timeframe = '15m', balance = 10000, interval = 30 } = req.body || {};
  const ms = Math.max(5000, parseInt(interval, 10) * 1000);
  const bal = parseFloat(balance);

  Object.assign(state, {
    running: true, symbol, timeframe,
    balance: bal, initialBalance: bal,
    sessionId: `s_${Date.now()}`, sessionStart: new Date().toISOString(),
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: bal, maxDrawdownDollar: 0, maxDrawdownPct: 0,
  });
  logs = [];

  ticker = setInterval(tick, ms);
  tick();
  broadcast({ type: 'started', state: publicState() });
  res.json({ ok: true, state: publicState() });
});

app.post('/api/stop', (_, res) => {
  if (!state.running) return res.json({ ok: false, msg: 'Not running' });
  clearInterval(ticker);
  ticker = null;
  state.running = false;
  broadcast({ type: 'stopped', state: publicState() });
  res.json({ ok: true, state: publicState() });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected', state: publicState(), logs })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.listen(PORT, () => console.log(`CBT Algo1 v2 listening on :${PORT}`));
