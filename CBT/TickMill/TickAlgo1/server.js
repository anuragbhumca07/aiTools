'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const session  = require('express-session');
const { OAuth2Client } = require('google-auth-library');
const {
  computeIndicators, generateSignal, checkExitByPrice, computeTrailUpdate,
} = require('./algo');

// ── Config ────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '3013', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AUTH_REQUIRED    = !!GOOGLE_CLIENT_ID;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'cbt-tickalgo1-dev-secret';

const METAAPI_TOKEN      = process.env.METAAPI_TOKEN      || '';
const METAAPI_ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID || '';
const METAAPI_REGION     = process.env.METAAPI_REGION     || 'new-york';

const WA_INSTANCE = process.env.WA_INSTANCE || '';
const WA_TOKEN    = process.env.WA_TOKEN    || '';
const WA_GROUP    = process.env.WA_GROUP    || '';

// Fixed trade parameters (size=1 lot, SL=$50, TP=$150)
const FIXED_SIZE = 1;
const FIXED_SL   = 50;
const FIXED_TP   = 150;

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
    `${dir} *[TickAlgo1] ENTRY — ${label} ${symbol} ${timeframe}*\n` +
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
    `${icon} *[TickAlgo1] EXIT — ${label} ${symbol} ${timeframe}*\n` +
    `Reason   : ${reason}\n` +
    `PnL      : *${pnlStr}*\n` +
    `Trailing : ${trailed ? `Yes (locked $${lockProfit})` : 'No'}\n` +
    `Balance  : $${f(balance)}\n` +
    `Win Rate : ${wr}% (${wins}/${totalTrades})`
  );
}

// ── MetaAPI REST helpers ──────────────────────────────────────────
function metaApiGet(apiPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: `mt-client-api-v1.${METAAPI_REGION}.agiliumtrade.ai`,
      path:     apiPath,
      method:   'GET',
      headers:  { 'auth-token': METAAPI_TOKEN, 'Content-Type': 'application/json' },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function metaApiPost(apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: `mt-client-api-v1.${METAAPI_REGION}.agiliumtrade.ai`,
      path:     apiPath,
      method:   'POST',
      headers:  {
        'auth-token':     METAAPI_TOKEN,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Tickmill data fetch via MetaAPI ──────────────────────────────
function normaliseCandle(c) {
  return {
    time:   new Date(c.time).getTime(),
    open:   parseFloat(c.open),
    high:   parseFloat(c.high),
    low:    parseFloat(c.low),
    close:  parseFloat(c.close),
    volume: parseFloat(c.tickVolume || c.volume || 0),
  };
}

async function fetchCandlesFromTickmill(symbol, tf, count) {
  if (!METAAPI_TOKEN || !METAAPI_ACCOUNT_ID) {
    throw new Error('MetaAPI not configured. Set METAAPI_TOKEN and METAAPI_ACCOUNT_ID env vars.');
  }
  const raw = await metaApiGet(
    `/users/current/accounts/${METAAPI_ACCOUNT_ID}/historical-candles/${symbol}/${tf}?limit=${count}`
  );
  const arr = Array.isArray(raw) ? raw : (raw.candles || []);
  if (!arr.length) throw new Error(`No candles from MetaAPI for ${symbol} ${tf}`);
  // MetaAPI returns newest-first; reverse to oldest-first for indicators
  return arr.slice().reverse().map(normaliseCandle);
}

async function fetchLivePrice(symbol) {
  // Try live quote endpoint first
  try {
    const data = await metaApiGet(
      `/users/current/accounts/${METAAPI_ACCOUNT_ID}/price/${symbol}`
    );
    if (typeof data.bid === 'number' && typeof data.ask === 'number') {
      return (data.bid + data.ask) / 2;
    }
    if (typeof data.price === 'number') return data.price;
  } catch {}
  // Fallback: latest forming candle close
  const candles = await fetchCandlesFromTickmill(symbol, '1m', 2);
  return candles[candles.length - 1].close;
}

async function fetchCandlesHistoricalFromTickmill(symbol, tf, months) {
  const CANDLE_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000 };
  const intervalMs  = CANDLE_MS[tf] || 60000;
  const totalNeeded = Math.ceil((months * 30 * 24 * 3600 * 1000) / intervalMs) + 300;
  const PAGE = 1000;
  const all  = [];
  let startTime = new Date().toISOString();

  while (all.length < totalNeeded) {
    const raw  = await metaApiGet(
      `/users/current/accounts/${METAAPI_ACCOUNT_ID}/historical-candles/${symbol}/${tf}?startTime=${encodeURIComponent(startTime)}&limit=${PAGE}`
    );
    const page = Array.isArray(raw) ? raw : (raw.candles || []);
    if (!page.length) break;
    all.push(...page);
    startTime = page[page.length - 1].time; // oldest candle on this page
    if (page.length < PAGE) break;
    await new Promise(r => setTimeout(r, 250)); // avoid rate limits
  }

  all.sort((a, b) => new Date(a.time) - new Date(b.time));
  return all.slice(0, totalNeeded).map(normaliseCandle);
}

// ── MetaAPI trade execution ───────────────────────────────────────
let metaapiConnected = false;

async function initMetaApi() {
  if (!METAAPI_TOKEN || !METAAPI_ACCOUNT_ID) {
    console.log('[TickAlgo1] MetaAPI not configured — paper mode only');
    return;
  }
  try {
    const status = await metaApiGet(`/users/current/accounts/${METAAPI_ACCOUNT_ID}`);
    metaapiConnected = !!(status && status.state === 'deployed');
    console.log(`[TickAlgo1] MetaAPI ${metaapiConnected ? '✓ connected' : '✗ not deployed'}`);
  } catch (err) {
    console.error('[TickAlgo1] MetaAPI init error:', err.message);
  }
}
initMetaApi().catch(() => {});

async function placeOrder(side, symbol, sl, tp) {
  if (!metaapiConnected) return { paper: true, orderId: `paper_${Date.now()}` };
  try {
    const tradeType = side === 'long' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
    const result    = await metaApiPost(
      `/users/current/accounts/${METAAPI_ACCOUNT_ID}/trade`,
      { actionType: tradeType, symbol, volume: FIXED_SIZE, stopLoss: sl, takeProfit: tp, comment: 'CBT TickAlgo1 Fixed-SL' }
    );
    return { orderId: result.positionId || result.orderId, live: true };
  } catch (err) {
    console.error('[TickAlgo1] placeOrder error:', err.message);
    return { paper: true, orderId: `paper_${Date.now()}`, error: err.message };
  }
}

async function closeOrder(orderId) {
  if (!metaapiConnected || !orderId || orderId.startsWith('paper_')) return { paper: true };
  try {
    await metaApiPost(
      `/users/current/accounts/${METAAPI_ACCOUNT_ID}/trade`,
      { actionType: 'POSITION_CLOSE_ID', positionId: orderId }
    );
    return { closed: true };
  } catch (err) {
    console.error('[TickAlgo1] closeOrder error:', err.message);
    return { error: err.message };
  }
}

async function modifySL(orderId, newSl) {
  if (!metaapiConnected || !orderId || orderId.startsWith('paper_')) return;
  try {
    await metaApiPost(
      `/users/current/accounts/${METAAPI_ACCOUNT_ID}/trade`,
      { actionType: 'POSITION_MODIFY', positionId: orderId, stopLoss: newSl }
    );
    console.log(`[TickAlgo1] POSITION_MODIFY: id=${orderId}, newSL=${newSl.toFixed(2)}`);
  } catch (err) {
    console.error('[TickAlgo1] modifySL error:', err.message);
  }
}

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
    tickmill_order TEXT
  )
`);
['mae REAL DEFAULT 0', 'user_id TEXT DEFAULT "guest"', 'tickmill_order TEXT'].forEach(col => {
  try { db.exec(`ALTER TABLE trades ADD COLUMN ${col}`); } catch {}
});

const stmtInsert = db.prepare(`
  INSERT INTO trades
    (session_id,user_id,type,side,symbol,timeframe,price,size,pnl,
     stop_loss,take_profit,reason,balance_after,timestamp,mae,tickmill_order)
  VALUES
    (@session_id,@user_id,@type,@side,@symbol,@timeframe,@price,@size,@pnl,
     @stop_loss,@take_profit,@reason,@balance_after,@timestamp,@mae,@tickmill_order)
`);

// ── Strategy registry ─────────────────────────────────────────────
const STRATEGIES = {
  'tick-v1-trail25': {
    name: 'tick-v1-trail25: EMA Ribbon Swing (Tickmill Fixed-SL + $25 Trail)',
    description: 'EMA21/55/200 + ADX(25) + DI-spread≥15 + 6/7 conditions + Closed Candle Eval + No-Drift :01s Timer + Fixed SL $50 + Trailing $25/step after $100 profit + 5s fast poll + Opposite-Signal Exit + $500 Hard Stop',
  },
};

// ── Session management ────────────────────────────────────────────
const userSessions = new Map();

const CANDLE_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };

function defaultState() {
  return {
    running: false, symbol: 'BTCUSD', timeframe: '1m',
    strategyId: 'tick-v1-trail25', mode: 'paper',
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
      fastTicker:     null,    // 5-second trailing poll
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
    metaapiConnected,
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
  const userId    = sess.userId;
  const { side, entryPrice, stopLoss, takeProfit, mae, tickmillOrderId, trailing, trailLockProfit } = position;

  const rawPnl = side === 'long'
    ? (exitPrice - entryPrice) * FIXED_SIZE
    : (entryPrice - exitPrice) * FIXED_SIZE;
  const pnl = parseFloat(rawPnl.toFixed(4));

  let closeResult = { paper: true };
  if (tickmillOrderId && !tickmillOrderId.startsWith('paper_')) {
    closeResult = await closeOrder(tickmillOrderId);
  }

  state.balance   += pnl;
  state.pnl       += pnl;
  if (pnl > 0) state.wins++;
  state.totalTrades++;
  updateDrawdown(state);
  state.position = null;

  const trade = {
    session_id: state.sessionId, user_id: userId,
    type: 'exit', side, symbol: state.symbol, timeframe: state.timeframe,
    price: exitPrice, size: FIXED_SIZE, pnl,
    stop_loss: stopLoss, take_profit: takeProfit,
    reason: exitReasonStr,
    balance_after: parseFloat(state.balance.toFixed(4)),
    timestamp: ts,
    mae: parseFloat((mae || 0).toFixed(4)),
    tickmill_order: closeResult.closed ? tickmillOrderId : null,
  };
  stmtInsert.run(trade);
  waExit(side, state.symbol, state.timeframe, pnl, exitReasonStr, state.balance, state.wins, state.totalTrades, trailing || false, trailLockProfit || 0);
  pushLog(sess, { ts, type: 'EXIT', side, price: exitPrice, pnl,
                  mae: (mae || 0).toFixed(2),
                  reason: [exitReasonStr], indicators });
  broadcast(sess, { type: 'trade', trade, state: publicState(state) });
}

// ── Fast ticker (5-second SL + trail poll) ────────────────────────
function stopFastTicker(sess) {
  if (sess.fastTicker) { clearInterval(sess.fastTicker); sess.fastTicker = null; }
}

function manageFastTicker(sess) {
  const { state } = sess;
  const pos = state.position;
  // Start 5s fast poll when unrealPnl > $75 (25 before $100 trail threshold) or already trailing
  const needFast = state.running && pos &&
    ((pos.unrealizedPnl || 0) > 75 || pos.trailing);

  if (needFast && !sess.fastTicker) {
    console.log(`[TickAlgo1] Starting fast 5s poll (unrealPnl=${(pos.unrealizedPnl||0).toFixed(2)})`);
    sess.fastTicker = setInterval(() => fastTick(sess), 5000);
  } else if (!needFast && sess.fastTicker) {
    console.log('[TickAlgo1] Stopping fast poll');
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
    const { side, entryPrice, stopLoss } = pos;

    const unrealPnl = side === 'long'
      ? (price - entryPrice) * FIXED_SIZE
      : (entryPrice - price) * FIXED_SIZE;
    pos.unrealizedPnl = parseFloat(unrealPnl.toFixed(4));
    if (unrealPnl < (pos.mae || 0)) pos.mae = unrealPnl;

    // SL check
    const slHit = side === 'long' ? price <= pos.stopLoss : price >= pos.stopLoss;
    if (slHit) {
      const reason = pos.trailing
        ? `Trailing SL hit: $${pos.stopLoss.toFixed(2)} (locked $${pos.trailLockProfit || 0} profit)`
        : `SL hit (fast): $${pos.stopLoss.toFixed(2)}`;
      await handleExit(sess, pos, pos.stopLoss, reason, state.lastIndicators || {}, ts);
      stopFastTicker(sess);
      return;
    }

    // Trailing SL update
    const trailUpdate = computeTrailUpdate(pos, unrealPnl);
    if (trailUpdate) {
      const { oldSl, newSl, lockProfit } = trailUpdate;
      pos.stopLoss        = newSl;
      pos.trailing        = true;
      pos.trailLockProfit = lockProfit;

      // Update broker SL via MetaAPI POSITION_MODIFY
      if (pos.tickmillOrderId) {
        modifySL(pos.tickmillOrderId, newSl).catch(err =>
          console.error('[TickAlgo1] modifySL error in fastTick:', err.message)
        );
      }

      const note = `SL updated: $${oldSl.toFixed(2)} → $${newSl.toFixed(2)} (locks $${lockProfit} profit)`;
      console.log(`[TickAlgo1] TRAIL: ${note}`);
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
    console.error('[TickAlgo1 fastTick]', err.message);
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

    if (!METAAPI_TOKEN || !METAAPI_ACCOUNT_ID) {
      throw new Error('MetaAPI not configured. Set METAAPI_TOKEN and METAAPI_ACCOUNT_ID env vars.');
    }

    // Fetch 251 Tickmill candles; last one is the forming (incomplete) candle.
    // closedCandles = 250 fully-closed candles; signal uses only these.
    const allCandles    = await fetchCandlesFromTickmill(symbol, timeframe, 251);
    const closedCandles = allCandles.slice(0, -1);
    const latestClosedTime = closedCandles[closedCandles.length - 1].time;
    const price            = closedCandles[closedCandles.length - 1].close; // closed-candle reference price
    const livePrice        = allCandles[allCandles.length - 1].close;       // forming candle — for unrealPnL display

    // ── Position exit check ───────────────────────────────────────
    if (state.position) {
      const pos = state.position;

      // Update unrealized PnL using live price
      const { side, entryPrice } = pos;
      const unrealPnl = side === 'long'
        ? (livePrice - entryPrice) * FIXED_SIZE
        : (entryPrice - livePrice) * FIXED_SIZE;
      pos.unrealizedPnl = parseFloat(unrealPnl.toFixed(4));
      if (unrealPnl < (pos.mae || 0)) pos.mae = unrealPnl;

      // Check for SL or $500 adverse stop using live price
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

      // Belt-and-suspenders: advance trailing SL on candle close too
      const trailUpdate = computeTrailUpdate(pos, unrealPnl);
      if (trailUpdate) {
        const { oldSl, newSl, lockProfit } = trailUpdate;
        pos.stopLoss        = newSl;
        pos.trailing        = true;
        pos.trailLockProfit = lockProfit;
        if (pos.tickmillOrderId) {
          modifySL(pos.tickmillOrderId, newSl).catch(() => {});
        }
        pushLog(sess, {
          ts, type: 'TICK', signal: 'TRAIL-UPDATE', price: livePrice,
          indicators: state.lastIndicators || {},
          reason: [`SL updated: $${oldSl.toFixed(2)} → $${newSl.toFixed(2)} (locks $${lockProfit} profit)`],
        });
      }

      manageFastTicker(sess);
    }

    // ── New-candle guard uses closed-candle time ──────────────────
    const isNewCandle = latestClosedTime !== sess.lastCandleTime;
    if (!isNewCandle) {
      broadcast(sess, { type: 'tick', state: publicState(state) });
      return;
    }
    sess.lastCandleTime = latestClosedTime;

    // ── Generate signal from closed candles only ──────────────────
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
        // Fall through to enter opposite position
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

      const orderResult = await placeOrder(side, symbol, sl, tp);

      state.position = {
        side, entryPrice: price, size: FIXED_SIZE,
        stopLoss: sl, takeProfit: tp,
        entryTime: ts, unrealizedPnl: 0, mae: 0,
        trailing: false, trailLockProfit: 0,
        tickmillOrderId: orderResult.orderId,
      };

      const trade = {
        session_id: sessionId, user_id: userId,
        type: 'entry', side, symbol, timeframe,
        price, size: FIXED_SIZE, pnl: 0,
        stop_loss: sl, take_profit: tp,
        reason: reason.join(' | '),
        balance_after: parseFloat(state.balance.toFixed(4)),
        timestamp: ts, mae: 0,
        tickmill_order: orderResult.orderId,
      };
      stmtInsert.run(trade);
      waEntry(side, symbol, timeframe, price, sl, tp, state.balance);
      pushLog(sess, { ts, type: 'ENTRY', side, signal, price, size: FIXED_SIZE,
                      stopLoss: sl, takeProfit: tp,
                      balance: state.balance.toFixed(4), reason, indicators,
                      tickmill: orderResult });
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
  const delay = msToNextBoundary + 1000; // 1s after candle boundary
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
  const allCandles = await fetchCandlesHistoricalFromTickmill(symbol, timeframe, months);
  if (allCandles.length < 210) {
    throw new Error(`Need 210+ candles for EMA200. Got ${allCandles.length} — try longer duration.`);
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
      // Check trailing advancement using candle high/low for realistic simulation
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
      exitTime:  new Date(allCandles[allCandles.length - 1].time).toISOString(),
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
  authRequired:   AUTH_REQUIRED,
  googleClientId: GOOGLE_CLIENT_ID,
  user:           req.session.user || null,
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

app.get('/health', (_, res) => res.json({ status: 'ok', strategy: 'tick-v1-trail25' }));
app.get('/api/strategies', (_, res) =>
  res.json(Object.entries(STRATEGIES).map(([id, s]) => ({ id, ...s })))
);
app.get('/api/metaapi', (_, res) => res.json({
  connected:         metaapiConnected,
  configured:        !!(METAAPI_TOKEN && METAAPI_ACCOUNT_ID),
  region:            METAAPI_REGION,
  accountId:         METAAPI_ACCOUNT_ID ? `...${METAAPI_ACCOUNT_ID.slice(-6)}` : null,
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
    strategyId = 'tick-v1-trail25', mode = 'paper',
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
  console.log(`CBT TickAlgo1 (Tickmill Fixed-SL + Trail $25) listening on :${PORT} | MetaAPI: ${metaapiConnected ? 'connected' : 'paper'}`)
);
