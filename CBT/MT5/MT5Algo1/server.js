'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const readline = require('readline');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const session  = require('express-session');
const { OAuth2Client } = require('google-auth-library');
const {
  generateSignal, checkExitByPrice, computeTrailUpdate,
} = require('./algo');

// ── Config ────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '3014', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AUTH_REQUIRED    = !!GOOGLE_CLIENT_ID;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'cbt-mt5algo1-dev-secret';
const PYTHON_PATH      = process.env.PYTHON_PATH    || 'python';

const WA_INSTANCE = process.env.WA_INSTANCE || '';
const WA_TOKEN    = process.env.WA_TOKEN    || '';
const WA_GROUP    = process.env.WA_GROUP    || '';

// Fixed trade parameters (size=1 lot, SL=$100, TP=$500)
const FIXED_SIZE = 1;
const FIXED_SL   = 100;
const FIXED_TP   = 500;

const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(__dirname, 'logs');
[DATA_DIR, LOGS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── WhatsApp notifications (Green API) ───────────────────────────
function sendWhatsApp(text) {
  if (!WA_INSTANCE || !WA_TOKEN || !WA_GROUP) return;
  const chatId = WA_GROUP.includes('@') ? WA_GROUP : `${WA_GROUP}@g.us`;
  const body   = JSON.stringify({ chatId, message: text });
  const opts   = {
    hostname: 'api.green-api.com',
    path:     `/waInstance${WA_INSTANCE}/sendMessage/${WA_TOKEN}`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  const req = https.request(opts, res => {
    let raw = '';
    res.on('data', d => raw += d);
    res.on('end', () => {
      if (res.statusCode !== 200) console.error('[WA] send failed:', res.statusCode, raw);
    });
  });
  req.on('error', err => console.error('[WA] request error:', err.message));
  req.write(body);
  req.end();
}

function waEntry(side, symbol, timeframe, price, sl, tp, balance) {
  const dir   = side === 'long' ? '🟢' : '🔴';
  const label = side === 'long' ? 'LONG' : 'SHORT';
  const f     = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  sendWhatsApp(
    `${dir} *[MT5Algo1] ENTRY — ${label} ${symbol} ${timeframe}*\n` +
    `Price  : $${f(price)}\n` +
    `Size   : 1 lot (fixed)\n` +
    `SL     : $${f(sl)}  (fixed $${FIXED_SL} stop — trail starts at +$100)\n` +
    `TP     : $${f(tp)}  (fixed $${FIXED_TP} target)\n` +
    `Balance: $${f(balance)}`
  );
}

function waExit(side, symbol, timeframe, pnl, reason, balance, wins, totalTrades, trailed, lockProfit) {
  const win    = pnl > 0;
  const icon   = win ? '✅' : '❌';
  const label  = side === 'long' ? 'LONG' : 'SHORT';
  const wr     = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
  const f      = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pnlStr = `${pnl >= 0 ? '+' : ''}$${f(Math.abs(pnl))}`;
  sendWhatsApp(
    `${icon} *[MT5Algo1] EXIT — ${label} ${symbol} ${timeframe}*\n` +
    `Reason   : ${reason}\n` +
    `PnL      : *${pnlStr}*\n` +
    `Trailing : ${trailed ? `Yes (locked $${lockProfit})` : 'No'}\n` +
    `Balance  : $${f(balance)}\n` +
    `Win Rate : ${wr}% (${wins}/${totalTrades})`
  );
}

// ── Python MT5 Bridge (persistent subprocess) ─────────────────────
let bridgeProc   = null;
let mt5Connected = false;
let reqCounter   = 0;
const pendingReqs = new Map();

function startBridge() {
  if (bridgeProc) return;
  console.log('[MT5Algo1] Starting Python MT5 bridge…');

  bridgeProc = spawn(PYTHON_PATH, [path.join(__dirname, 'mt5_bridge.py')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  bridgeProc.stderr.on('data', d => console.error('[MT5Bridge]', d.toString().trim()));

  bridgeProc.on('close', (code) => {
    console.log(`[MT5Algo1] Bridge exited (code=${code}). Reconnecting in 5s…`);
    mt5Connected = false;
    bridgeProc   = null;
    // Reject all pending requests
    for (const [, { reject }] of pendingReqs) reject(new Error('Bridge disconnected'));
    pendingReqs.clear();
    setTimeout(startBridge, 5000);
  });

  const rl = readline.createInterface({ input: bridgeProc.stdout, crlfDelay: Infinity });
  let firstLine = true;

  rl.on('line', line => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (firstLine) {
      firstLine    = false;
      mt5Connected = msg.ok === true;
      console.log(`[MT5Algo1] Bridge ${mt5Connected ? '✓ MT5 connected' : '✗ ' + (msg.error || 'not ready')}`);
      return;
    }

    const id = msg._id;
    if (id !== undefined && pendingReqs.has(id)) {
      const { resolve } = pendingReqs.get(id);
      pendingReqs.delete(id);
      resolve(msg);
    }
  });
}

function bridgeCall(request, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!bridgeProc || !bridgeProc.stdin.writable) {
      return reject(new Error('MT5 bridge not running. Ensure Python and MetaTrader5 package are installed, and MT5 terminal is open.'));
    }
    const id    = ++reqCounter;
    const timer = setTimeout(() => {
      pendingReqs.delete(id);
      reject(new Error(`MT5 bridge timeout for cmd: ${request.cmd}`));
    }, timeout);
    pendingReqs.set(id, {
      resolve: (data) => { clearTimeout(timer); resolve(data); },
      reject:  (err)  => { clearTimeout(timer); reject(err); },
    });
    bridgeProc.stdin.write(JSON.stringify({ ...request, _id: id }) + '\n');
  });
}

// ── MT5 data / trading helpers ────────────────────────────────────
async function fetchCandlesFromMT5(symbol, tf, count) {
  const r = await bridgeCall({ cmd: 'get_candles', symbol, timeframe: tf, count });
  if (!r.ok) throw new Error(`MT5 candles error: ${r.error}`);
  return r.data;
}

async function fetchLivePrice(symbol) {
  try {
    const r = await bridgeCall({ cmd: 'get_price', symbol });
    if (r.ok) return (r.data.bid + r.data.ask) / 2;
  } catch {}
  // Fallback: latest forming candle close
  const candles = await fetchCandlesFromMT5(symbol, '1m', 2);
  return candles[candles.length - 1].close;
}

async function fetchCandlesHistoricalFromMT5(symbol, tf, months) {
  const r = await bridgeCall({ cmd: 'get_candles_historical', symbol, timeframe: tf, months },
    120000 /* 2-min timeout for large history */);
  if (!r.ok) throw new Error(`MT5 historical candles error: ${r.error}`);
  return r.data;
}

async function placeOrder(side, symbol, sl, tp, isLive) {
  if (!isLive) return { paper: true, orderId: `paper_${Date.now()}` };
  try {
    const r = await bridgeCall({
      cmd: 'place_order', type: side === 'long' ? 'BUY' : 'SELL',
      symbol, volume: FIXED_SIZE, sl, tp, comment: 'CBT MT5Algo1 Fixed-SL',
    });
    if (!r.ok) {
      console.error('[MT5Algo1] placeOrder failed:', r.error);
      return { paper: true, orderId: `paper_${Date.now()}`, error: r.error };
    }
    return { orderId: r.data.ticket, price: r.data.price, live: true };
  } catch (err) {
    console.error('[MT5Algo1] placeOrder error:', err.message);
    return { paper: true, orderId: `paper_${Date.now()}`, error: err.message };
  }
}

async function closeOrder(orderId, isLive) {
  if (!isLive || !orderId || String(orderId).startsWith('paper_')) return { paper: true };
  try {
    const r = await bridgeCall({ cmd: 'close_order', ticket: orderId });
    if (!r.ok) { console.error('[MT5Algo1] closeOrder failed:', r.error); return { error: r.error }; }
    if (r.data?.already_closed) console.log(`[MT5Algo1] closeOrder: ticket ${orderId} already closed by MT5 SL/TP`);
    return { closed: true };
  } catch (err) {
    console.error('[MT5Algo1] closeOrder error:', err.message);
    return { error: err.message };
  }
}

async function modifySL(orderId, newSl, isLive) {
  if (!isLive || !orderId || String(orderId).startsWith('paper_')) return;
  try {
    const r = await bridgeCall({ cmd: 'modify_sl', ticket: orderId, sl: newSl });
    if (!r.ok) console.error('[MT5Algo1] modifySL failed:', r.error);
    else console.log(`[MT5Algo1] SL modified: ticket=${orderId}, newSL=${newSl.toFixed(2)}`);
  } catch (err) {
    console.error('[MT5Algo1] modifySL error:', err.message);
  }
}

// Start bridge immediately
startBridge();

// ── Google auth client ────────────────────────────────────────────
const googleClient = AUTH_REQUIRED ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ── SQLite ────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'trades.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT,
    user_id       TEXT DEFAULT 'guest',
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
    mae           REAL DEFAULT 0,
    mt5_ticket    TEXT
  )
`);
['mae REAL DEFAULT 0', 'user_id TEXT DEFAULT "guest"', 'mt5_ticket TEXT'].forEach(col => {
  try { db.exec(`ALTER TABLE trades ADD COLUMN ${col}`); } catch {}
});

const stmtInsert = db.prepare(`
  INSERT INTO trades
    (session_id,user_id,type,side,symbol,timeframe,price,size,pnl,
     stop_loss,take_profit,reason,balance_after,timestamp,mae,mt5_ticket)
  VALUES
    (@session_id,@user_id,@type,@side,@symbol,@timeframe,@price,@size,@pnl,
     @stop_loss,@take_profit,@reason,@balance_after,@timestamp,@mae,@mt5_ticket)
`);

// ── Strategy registry ─────────────────────────────────────────────
const STRATEGIES = {
  'mt5-v1-trail25': {
    name: 'mt5-v1-trail25: EMA Ribbon Swing (MT5 Fixed-SL + $25 Trail)',
    description: 'EMA21/55/200 + ADX(25) + DI-spread≥15 + 6/7 conditions + Closed Candle Eval + No-Drift :01s Timer + Fixed SL $100 + Phase1: breakeven @$100 | Phase2: lock $100 @$175 | Phase3: trail $50/step @$200+ (10s scan) + Opposite-Signal Exit + $500 Hard Stop — Executes on local MT5 terminal via Python bridge',
  },
};

// ── Session management ────────────────────────────────────────────
const userSessions = new Map();
const CANDLE_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000 };

function defaultState() {
  return {
    running: false, symbol: 'BTCUSD', timeframe: '1m',
    strategyId: 'mt5-v1-trail25', mode: 'paper',
    balance: 10000, initialBalance: 10000,
    sessionId: null, sessionStart: null,
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: 10000, maxDrawdownDollar: 0, maxDrawdownPct: 0,
  };
}

function getSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      userId,
      state:          defaultState(),
      logs:           [],
      sseClients:     new Set(),
      ticker:         null,
      alignTimeout:   null,
      fastTicker:     null,
      tickBusy:       false,
      lastCandleTime: null,
    });
  }
  return userSessions.get(userId);
}

function broadcast(sess, obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sess.sseClients) {
    try { res.write(msg); } catch { sess.sseClients.delete(res); }
  }
}
function pushLog(sess, entry) {
  const row = { id: Date.now() + Math.random(), ...entry };
  sess.logs.unshift(row);
  if (sess.logs.length > 500) sess.logs.length = 500;
  broadcast(sess, { type: 'log', entry: row });
}
function publicState(state) {
  const {
    running, symbol, timeframe, strategyId, mode,
    balance, initialBalance, sessionId, sessionStart,
    pnl, totalTrades, wins, lastIndicators, lastSignal, error,
    peakBalance, maxDrawdownDollar, maxDrawdownPct,
  } = state;
  return {
    running, symbol, timeframe, strategyId, mode,
    balance, initialBalance, sessionId, sessionStart,
    pnl, totalTrades, wins, error, lastIndicators, lastSignal,
    position:          state.position ? { ...state.position } : null,
    winRate:           totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0',
    pnlPct:            ((pnl / (initialBalance || 10000)) * 100).toFixed(2),
    peakBalance,
    maxDrawdownDollar: parseFloat(maxDrawdownDollar.toFixed(2)),
    maxDrawdownPct:    parseFloat(maxDrawdownPct.toFixed(2)),
    mt5Connected,
  };
}
function updateDrawdown(state) {
  if (state.balance > state.peakBalance) state.peakBalance = state.balance;
  const dd    = state.peakBalance - state.balance;
  const ddPct = state.peakBalance > 0 ? (dd / state.peakBalance) * 100 : 0;
  if (dd > state.maxDrawdownDollar) {
    state.maxDrawdownDollar = dd;
    state.maxDrawdownPct    = ddPct;
  }
}

// ── Exit helper ───────────────────────────────────────────────────
async function handleExit(sess, position, exitPrice, exitReasonStr, indicators, ts) {
  const { state } = sess;
  const { side, entryPrice, stopLoss, takeProfit, mae, mt5Ticket, trailing, trailLockProfit } = position;

  const rawPnl = side === 'long'
    ? (exitPrice - entryPrice) * FIXED_SIZE
    : (entryPrice - exitPrice) * FIXED_SIZE;
  const pnl = parseFloat(rawPnl.toFixed(4));

  let closeResult = { paper: true };
  if (mt5Ticket && !String(mt5Ticket).startsWith('paper_')) {
    const isLive = sess.state.mode === 'live' && mt5Connected;
    closeResult = await closeOrder(mt5Ticket, isLive);
  }

  state.balance   += pnl;
  state.pnl       += pnl;
  if (pnl > 0) state.wins++;
  state.totalTrades++;
  updateDrawdown(state);
  state.position = null;

  const trade = {
    session_id: state.sessionId, user_id: sess.userId,
    type: 'exit', side, symbol: state.symbol, timeframe: state.timeframe,
    price: exitPrice, size: FIXED_SIZE, pnl,
    stop_loss: stopLoss, take_profit: takeProfit,
    reason: exitReasonStr,
    balance_after: parseFloat(state.balance.toFixed(4)),
    timestamp: ts,
    mae: parseFloat((mae || 0).toFixed(4)),
    mt5_ticket: closeResult.closed ? mt5Ticket : null,
  };
  stmtInsert.run(trade);
  waExit(side, state.symbol, state.timeframe, pnl, exitReasonStr, state.balance, state.wins, state.totalTrades, trailing || false, trailLockProfit || 0);
  pushLog(sess, { ts, type: 'EXIT', side, price: exitPrice, pnl,
                  mae: (mae || 0).toFixed(2), reason: [exitReasonStr], indicators });
  broadcast(sess, { type: 'trade', trade, state: publicState(state) });
}

// ── Fast ticker (5-second SL + trail poll) ────────────────────────
function stopFastTicker(sess) {
  if (sess.fastTicker) { clearInterval(sess.fastTicker); sess.fastTicker = null; }
}

function manageFastTicker(sess) {
  const { state } = sess;
  const pos = state.position;
  const needFast = state.running && pos &&
    ((pos.unrealizedPnl || 0) > 75 || pos.trailing);

  if (needFast && !sess.fastTicker) {
    console.log(`[MT5Algo1] Starting 10s trail scan (unrealPnl=${(pos.unrealizedPnl||0).toFixed(2)})`);
    sess.fastTicker = setInterval(() => fastTick(sess), 10000);
  } else if (!needFast && sess.fastTicker) {
    console.log('[MT5Algo1] Stopping fast poll');
    stopFastTicker(sess);
  }
}

async function runFastTick(sess) {
  const { state } = sess;
  if (!state.running || !state.position) { stopFastTicker(sess); return; }

  const ts = new Date().toISOString();
  try {
    const price = await fetchLivePrice(state.symbol);
    const pos   = state.position;
    const { side, entryPrice } = pos;

    const unrealPnl = side === 'long'
      ? (price - entryPrice) * FIXED_SIZE
      : (entryPrice - price) * FIXED_SIZE;
    pos.unrealizedPnl = parseFloat(unrealPnl.toFixed(4));
    if (unrealPnl < (pos.mae || 0)) pos.mae = unrealPnl;

    const slHit = side === 'long' ? price <= pos.stopLoss : price >= pos.stopLoss;
    if (slHit) {
      const reason = pos.trailing
        ? `Trailing SL hit: $${pos.stopLoss.toFixed(2)} (locked $${pos.trailLockProfit || 0} profit)`
        : `SL hit (fast): $${pos.stopLoss.toFixed(2)}`;
      await handleExit(sess, pos, pos.stopLoss, reason, state.lastIndicators || {}, ts);
      stopFastTicker(sess);
      return;
    }

    const trailUpdate = computeTrailUpdate(pos, unrealPnl);
    if (trailUpdate) {
      const { oldSl, newSl, lockProfit, phase, newWatermark } = trailUpdate;
      pos.stopLoss        = newSl;
      pos.trailing        = true;
      pos.trailLockProfit = lockProfit;
      if (phase === 3 && newWatermark != null) pos.trailWatermark = newWatermark;

      // Send SLTP modify to MT5 terminal
      if (pos.mt5Ticket) {
        const isLive = state.mode === 'live' && mt5Connected;
        modifySL(pos.mt5Ticket, newSl, isLive).catch(err =>
          console.error('[MT5Algo1] modifySL error in fastTick:', err.message)
        );
      }

      const phaseLabel = phase === 1 ? 'breakeven' : phase === 2 ? 'lock $100' : 'trail';
      const note = `SL → $${newSl.toFixed(2)} (${phaseLabel}, locks $${lockProfit} profit) [MT5 SLTP sent]`;
      console.log(`[MT5Algo1] TRAIL Ph${phase}: ${note}`);
      pushLog(sess, {
        ts, type: 'TICK', signal: 'TRAIL-UPDATE', price,
        indicators: { ...(state.lastIndicators || {}), price },
        reason: [note],
      });
    } else if (pos.trailing) {
      pushLog(sess, {
        ts, type: 'TICK', signal: 'TRAIL-WATCH', price,
        indicators: { ...(state.lastIndicators || {}), price },
        reason: [`Trailing active — locked $${pos.trailLockProfit || 0}, SL: $${pos.stopLoss.toFixed(2)}, PnL: $${unrealPnl.toFixed(2)}`],
      });
    }

    broadcast(sess, { type: 'tick', state: publicState(state) });
  } catch (err) {
    console.error('[MT5Algo1 fastTick]', err.message);
  }
}

async function fastTick(sess) {
  if (sess.tickBusy) return;
  sess.tickBusy = true;
  try { await runFastTick(sess); } finally {
    sess.tickBusy = false;
    manageFastTicker(sess);
  }
}

// ── Main candle-aligned tick ──────────────────────────────────────
async function runTick(sess) {
  const { state } = sess;
  const { symbol, timeframe, sessionId } = state;
  const userId = sess.userId;
  const ts     = new Date().toISOString();
  try {
    state.error = null;

    // Fetch 251 MT5 candles. copy_rates_from_pos returns oldest-first.
    // Last element is the forming (incomplete) candle.
    const allCandles    = await fetchCandlesFromMT5(symbol, timeframe, 251);
    const closedCandles = allCandles.slice(0, -1);
    const latestClosedTime = closedCandles[closedCandles.length - 1].time;
    const price            = closedCandles[closedCandles.length - 1].close;
    const livePrice        = allCandles[allCandles.length - 1].close;

    // ── Position management ───────────────────────────────────────
    if (state.position) {
      const pos = state.position;
      const { side, entryPrice } = pos;

      const unrealPnl = side === 'long'
        ? (livePrice - entryPrice) * FIXED_SIZE
        : (entryPrice - livePrice) * FIXED_SIZE;
      pos.unrealizedPnl = parseFloat(unrealPnl.toFixed(4));
      if (unrealPnl < (pos.mae || 0)) pos.mae = unrealPnl;

      const exitResult = checkExitByPrice(pos, livePrice);
      if (exitResult.exit) {
        const reason0 = exitResult.reasons[0] || '';
        let exitPrice = livePrice;
        if (reason0.startsWith('SL hit'))   exitPrice = pos.stopLoss;
        else if (reason0.startsWith('$500')) exitPrice = side === 'long'
          ? entryPrice - 500
          : entryPrice + 500;

        stopFastTicker(sess);
        await handleExit(sess, pos, exitPrice, reason0, state.lastIndicators || {}, ts);
        return;
      }

      // Belt-and-suspenders trail advance on candle close
      const trailUpdate = computeTrailUpdate(pos, unrealPnl);
      if (trailUpdate) {
        const { oldSl, newSl, lockProfit, phase, newWatermark } = trailUpdate;
        pos.stopLoss        = newSl;
        pos.trailing        = true;
        pos.trailLockProfit = lockProfit;
        if (phase === 3 && newWatermark != null) pos.trailWatermark = newWatermark;
        if (pos.mt5Ticket) modifySL(pos.mt5Ticket, newSl, state.mode === 'live' && mt5Connected).catch(() => {});
        const phaseLabel = phase === 1 ? 'breakeven' : phase === 2 ? 'lock $100' : 'trail';
        pushLog(sess, {
          ts, type: 'TICK', signal: 'TRAIL-UPDATE', price: livePrice,
          indicators: state.lastIndicators || {},
          reason: [`SL → $${newSl.toFixed(2)} (${phaseLabel}, locks $${lockProfit} profit) [MT5 SLTP sent]`],
        });
      }

      manageFastTicker(sess);
    }

    // ── New-candle guard ──────────────────────────────────────────
    const isNewCandle = latestClosedTime !== sess.lastCandleTime;
    if (!isNewCandle) {
      broadcast(sess, { type: 'tick', state: publicState(state) });
      return;
    }
    sess.lastCandleTime = latestClosedTime;

    // ── Signal from closed candles only ──────────────────────────
    const { signal, reason, indicators, buyScore, sellScore } = generateSignal(closedCandles);
    state.lastIndicators = indicators;
    state.lastSignal     = { signal, buyScore, sellScore };

    // ── Opposite-signal exit ──────────────────────────────────────
    if (state.position) {
      const { side } = state.position;
      const isOpposite = (side === 'long' && signal === 'SELL') || (side === 'short' && signal === 'BUY');
      if (isOpposite) {
        stopFastTicker(sess);
        await handleExit(sess, state.position, price, `Opposite signal: ${signal}`, indicators, ts);
        // Fall through to enter opposite
      } else {
        pushLog(sess, { ts, type: 'TICK', signal: `${signal} (B:${buyScore} S:${sellScore})`, price, indicators, reason });
        broadcast(sess, { type: 'tick', state: publicState(state) });
        return;
      }
    }

    // ── Entry ─────────────────────────────────────────────────────
    if (!state.position && (signal === 'BUY' || signal === 'SELL')) {
      const side = signal === 'BUY' ? 'long' : 'short';
      const sl   = side === 'long' ? price - FIXED_SL : price + FIXED_SL;
      const tp   = side === 'long' ? price + FIXED_TP : price - FIXED_TP;

      const isLive = state.mode === 'live' && mt5Connected;
      const orderResult = await placeOrder(side, symbol, sl, tp, isLive);

      // In live mode, if MT5 rejected the order — surface error, don't enter a fake position
      if (isLive && orderResult.paper) {
        const raw = orderResult.error || 'MT5 order rejected';
        const hint = raw.includes('10027') || raw.toLowerCase().includes('autotrading')
          ? `${raw} — Enable AutoTrading in MT5 toolbar (Algo Trading button)`
          : raw;
        state.error = `[LIVE] Order failed: ${hint}`;
        pushLog(sess, { ts, type: 'ERROR', message: state.error, indicators });
        broadcast(sess, { type: 'error', message: state.error, state: publicState(state) });
        return;
      }

      state.position = {
        side, entryPrice: price, size: FIXED_SIZE,
        stopLoss: sl, takeProfit: tp,
        entryTime: ts, unrealizedPnl: 0, mae: 0,
        trailing: false, trailLockProfit: 0, trailWatermark: null,
        mt5Ticket: orderResult.orderId,
      };

      const trade = {
        session_id: sessionId, user_id: userId,
        type: 'entry', side, symbol, timeframe,
        price, size: FIXED_SIZE, pnl: 0,
        stop_loss: sl, take_profit: tp,
        reason: reason.join(' | '),
        balance_after: parseFloat(state.balance.toFixed(4)),
        timestamp: ts, mae: 0,
        mt5_ticket: orderResult.orderId,
      };
      stmtInsert.run(trade);
      waEntry(side, symbol, timeframe, price, sl, tp, state.balance);
      pushLog(sess, { ts, type: 'ENTRY', side, signal, price, size: FIXED_SIZE,
                      stopLoss: sl, takeProfit: tp,
                      balance: state.balance.toFixed(4), reason, indicators,
                      mt5: orderResult });
      broadcast(sess, { type: 'trade', trade, state: publicState(state) });
    } else if (!state.position) {
      pushLog(sess, { ts, type: 'TICK', signal: `${signal} (B:${buyScore} S:${sellScore})`, price, indicators, reason });
      broadcast(sess, { type: 'tick', state: publicState(state) });
    }
  } catch (err) {
    state.error = err.message;
    pushLog(sess, { ts, type: 'ERROR', message: err.message });
    broadcast(sess, { type: 'error', message: err.message, state: publicState(state) });
  }
}

async function tick(sess) {
  if (sess.tickBusy) return;
  sess.tickBusy = true;
  try { await runTick(sess); } finally { sess.tickBusy = false; }
}

// ── No-drift self-rescheduling timer ─────────────────────────────
function scheduleNextTick(sess, intervalMs) {
  const now = Date.now();
  const msToNextBoundary = intervalMs - (now % intervalMs);
  const delay = msToNextBoundary + 1000;
  sess.ticker = setTimeout(() => {
    if (!sess.state.running) return;
    tick(sess);
    scheduleNextTick(sess, intervalMs);
  }, delay);
}

function startAlignedTicks(sess, intervalMs) {
  stopTicker(sess);
  scheduleNextTick(sess, intervalMs);
}

function stopTicker(sess) {
  if (sess.alignTimeout) { clearTimeout(sess.alignTimeout); sess.alignTimeout = null; }
  if (sess.ticker)       { clearTimeout(sess.ticker);       sess.ticker       = null; }
  stopFastTicker(sess);
}

// ── Backtest ──────────────────────────────────────────────────────
async function runBacktest(symbol, timeframe, months) {
  const allCandles = await fetchCandlesHistoricalFromMT5(symbol, timeframe, months);
  if (allCandles.length < 210) {
    throw new Error(`Need 210+ candles for EMA200. Got ${allCandles.length} — ensure MT5 history is downloaded.`);
  }

  const WINDOW = 250;
  let balance = 10000;
  const initialBalance = 10000;
  let pos = null, peakBal = balance, maxDD = 0;
  const trades = [];
  let wins = 0;

  for (let i = WINDOW; i < allCandles.length; i++) {
    const seg   = allCandles.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const price = allCandles[i].close;
    const canH  = allCandles[i].high;
    const canL  = allCandles[i].low;
    const sig   = generateSignal(seg);

    if (pos) {
      const peakPx  = pos.side === 'long' ? canH : canL;
      const peakPnl = pos.side === 'long'
        ? (peakPx - pos.entryPrice) * FIXED_SIZE
        : (pos.entryPrice - peakPx) * FIXED_SIZE;
      const tu = computeTrailUpdate(pos, peakPnl);
      if (tu) {
        pos.stopLoss        = tu.newSl;
        pos.trailing        = true;
        pos.trailLockProfit = tu.lockProfit;
      }

      const slHit      = pos.side === 'long' ? canL <= pos.stopLoss : canH >= pos.stopLoss;
      const adverseHit = pos.side === 'long'
        ? canL <= pos.entryPrice - 500
        : canH >= pos.entryPrice + 500;

      if (slHit || adverseHit) {
        let exitPrice, reason;
        if (adverseHit && (!slHit ||
            (pos.side === 'long' ? pos.entryPrice - 500 < pos.stopLoss : pos.entryPrice + 500 > pos.stopLoss))) {
          exitPrice = pos.side === 'long' ? pos.entryPrice - 500 : pos.entryPrice + 500;
          reason    = '$500 adverse stop';
        } else {
          exitPrice = pos.stopLoss;
          reason    = pos.trailing
            ? `Trailing SL hit: $${exitPrice.toFixed(2)} (locked $${pos.trailLockProfit})`
            : `SL hit: $${exitPrice.toFixed(2)}`;
        }
        const pnl = pos.side === 'long'
          ? (exitPrice - pos.entryPrice) * FIXED_SIZE
          : (pos.entryPrice - exitPrice) * FIXED_SIZE;
        balance += pnl;
        if (pnl > 0) wins++;
        if (balance > peakBal) peakBal = balance;
        const dd = peakBal - balance;
        if (dd > maxDD) maxDD = dd;
        trades.push({
          side: pos.side, entryPrice: +pos.entryPrice.toFixed(4), exitPrice: +exitPrice.toFixed(4),
          pnl: +pnl.toFixed(2), balance: +balance.toFixed(2),
          entryTime: new Date(pos.entryTime).toISOString(),
          exitTime:  new Date(allCandles[i].time).toISOString(),
          reason, mae: +(pos.mae || 0).toFixed(2), trailed: pos.trailing || false,
        });
        pos = null;
      } else if ((pos.side === 'long' && sig.signal === 'SELL') ||
                 (pos.side === 'short' && sig.signal === 'BUY')) {
        const pnl = pos.side === 'long'
          ? (price - pos.entryPrice) * FIXED_SIZE
          : (pos.entryPrice - price) * FIXED_SIZE;
        balance += pnl;
        if (pnl > 0) wins++;
        if (balance > peakBal) peakBal = balance;
        const dd = peakBal - balance;
        if (dd > maxDD) maxDD = dd;
        trades.push({
          side: pos.side, entryPrice: +pos.entryPrice.toFixed(4), exitPrice: +price.toFixed(4),
          pnl: +pnl.toFixed(2), balance: +balance.toFixed(2),
          entryTime: new Date(pos.entryTime).toISOString(),
          exitTime:  new Date(allCandles[i].time).toISOString(),
          reason: `Opposite signal: ${sig.signal}`, mae: +(pos.mae || 0).toFixed(2), trailed: pos.trailing || false,
        });
        pos = null;
      } else {
        const unrealPnl = pos.side === 'long'
          ? (price - pos.entryPrice) * FIXED_SIZE
          : (pos.entryPrice - price) * FIXED_SIZE;
        if (unrealPnl < (pos.mae || 0)) pos.mae = unrealPnl;
      }
    }

    if (!pos && (sig.signal === 'BUY' || sig.signal === 'SELL')) {
      const newSide = sig.signal === 'BUY' ? 'long' : 'short';
      pos = {
        side: newSide, entryPrice: price, size: FIXED_SIZE,
        stopLoss:   newSide === 'long' ? price - FIXED_SL : price + FIXED_SL,
        takeProfit: newSide === 'long' ? price + FIXED_TP : price - FIXED_TP,
        entryTime:  allCandles[i].time,
        mae: 0, trailing: false, trailLockProfit: 0,
      };
    }
  }

  if (pos) {
    const lp  = allCandles[allCandles.length - 1].close;
    const pnl = pos.side === 'long'
      ? (lp - pos.entryPrice) * FIXED_SIZE
      : (pos.entryPrice - lp) * FIXED_SIZE;
    balance += pnl;
    trades.push({
      side: pos.side, entryPrice: +pos.entryPrice.toFixed(4), exitPrice: +lp.toFixed(4),
      pnl: +pnl.toFixed(2), balance: +balance.toFixed(2),
      entryTime: new Date(pos.entryTime).toISOString(),
      exitTime: new Date(allCandles[allCandles.length - 1].time).toISOString(),
      reason: 'End of backtest', mae: +(pos.mae || 0).toFixed(2), trailed: pos.trailing || false,
    });
  }

  const total  = trades.length;
  const netPnl = balance - initialBalance;
  return {
    trades,
    summary: {
      totalTrades: total, wins, losses: total - wins,
      winRate:      total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0',
      totalPnl:     +netPnl.toFixed(2),
      pnlPct:       ((netPnl / initialBalance) * 100).toFixed(2),
      maxDrawdown:  +maxDD.toFixed(2),
      finalBalance: +balance.toFixed(2),
      candlesAnalyzed: allCandles.length,
      period: `${months} month${months > 1 ? 's' : ''}`,
      timeframe, symbol,
    },
  };
}

// ── Express app ────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'web')));

function requireAuth(req, res, next) {
  if (!AUTH_REQUIRED) { req.userId = 'guest'; return next(); }
  if (req.session.userId) { req.userId = req.session.userId; return next(); }
  res.status(401).json({ error: 'Not authenticated' });
}

app.get('/api/config', (req, res) => res.json({
  authRequired: AUTH_REQUIRED, googleClientId: GOOGLE_CLIENT_ID,
  user: req.session.user || null,
}));
app.post('/auth/google', async (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ ok: false, error: 'Auth not configured' });
  try {
    const { credential } = req.body;
    const ticket  = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    req.session.userId = payload.sub;
    req.session.user   = { id: payload.sub, email: payload.email, name: payload.name, picture: payload.picture };
    res.json({ ok: true, user: req.session.user });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.post('/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/health', (_, res) => res.json({ status: 'ok', strategy: 'mt5-v1-trail25' }));
app.get('/api/strategies', (_, res) =>
  res.json(Object.entries(STRATEGIES).map(([id, s]) => ({ id, ...s })))
);
app.get('/api/mt5', (_, res) => res.json({
  connected:   mt5Connected,
  bridgeAlive: !!bridgeProc,
}));

app.get('/api/state',  requireAuth, (req, res) => res.json(publicState(getSession(req.userId).state)));
app.get('/api/logs',   requireAuth, (req, res) => res.json(getSession(req.userId).logs));
app.get('/api/trades', requireAuth, (req, res) => {
  const { session } = req.query;
  const userId = req.userId;
  const sess   = getSession(userId);
  let rows;
  if (session) {
    rows = db.prepare('SELECT * FROM trades WHERE session_id=? AND user_id=? ORDER BY id DESC').all(session, userId);
  } else {
    rows = sess.state.sessionId
      ? db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(sess.state.sessionId)
      : [];
  }
  res.json(rows);
});

app.post('/api/start', requireAuth, (req, res) => {
  const sess = getSession(req.userId);
  if (sess.state.running) return res.json({ ok: false, msg: 'Already running' });
  const {
    symbol = 'BTCUSD', timeframe = '1m',
    balance = 10000, interval = 60,
    strategyId = 'mt5-v1-trail25', mode = 'paper',
  } = req.body || {};
  const ms  = Math.max(5000, parseInt(interval, 10) * 1000);
  const bal = parseFloat(balance);

  Object.assign(sess.state, {
    running: true, symbol, timeframe, strategyId, mode,
    balance: bal, initialBalance: bal,
    sessionId:    `s_${Date.now()}_${req.userId}`,
    sessionStart: new Date().toISOString(),
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: bal, maxDrawdownDollar: 0, maxDrawdownPct: 0,
    userId: req.userId,
  });
  sess.logs           = [];
  sess.lastCandleTime = null;

  tick(sess);
  startAlignedTicks(sess, ms);

  broadcast(sess, { type: 'started', state: publicState(sess.state) });
  res.json({ ok: true, state: publicState(sess.state) });
});

app.post('/api/stop', requireAuth, (req, res) => {
  const sess = getSession(req.userId);
  if (!sess.state.running) return res.json({ ok: false, msg: 'Not running' });
  stopTicker(sess);
  sess.state.running = false;
  broadcast(sess, { type: 'stopped', state: publicState(sess.state) });
  res.json({ ok: true, state: publicState(sess.state) });
});

app.post('/api/backtest', requireAuth, async (req, res) => {
  const { symbol = 'BTCUSD', timeframe = '1m', months = 3 } = req.body || {};
  const m = Math.max(1, Math.min(12, parseInt(months, 10) || 3));
  try {
    const result = await runBacktest(symbol, timeframe, m);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/events', (req, res) => {
  let userId = 'guest';
  if (AUTH_REQUIRED) {
    if (!req.session.userId) return res.status(401).end();
    userId = req.session.userId;
  }
  const sess = getSession(userId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected', state: publicState(sess.state), logs: sess.logs })}\n\n`);
  sess.sseClients.add(res);
  req.on('close', () => sess.sseClients.delete(res));
});

app.listen(PORT, () =>
  console.log(`CBT MT5Algo1 (MT5 SL $100 | BE@$100 | Lock$100@$175 | Trail$50@$200+) listening on :${PORT}`)
);
