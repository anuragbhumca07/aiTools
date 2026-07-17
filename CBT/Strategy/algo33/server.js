'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const session  = require('express-session');
const { OAuth2Client } = require('google-auth-library');
const {
  RF_SAMPLING_PERIOD, RF_MULT, MAX_LOSS, RISK_FRAC, SL_ATR_MULT,
  TRAIL_START_PNL, TRAIL_STEP_PNL, ATR_LEN,
  RSI_LEN, RSI_BUY_LEVEL, RSI_SELL_LEVEL, SWING_BARS,
  WARMUP_BARS,
  generateSignal, initPosition, stepPosition,
  fetchCandles, fetchCandlesHistorical, fetchCurrentPrice,
} = require('./algo');

// ── Config ────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '3010', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AUTH_REQUIRED    = !!GOOGLE_CLIENT_ID;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'cbt-algo3-dev-secret';

const METAAPI_TOKEN      = process.env.METAAPI_TOKEN      || '';
const METAAPI_ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID || '';
const METAAPI_REGION     = process.env.METAAPI_REGION     || 'new-york';

const WA_INSTANCE = process.env.WA_INSTANCE || '';
const WA_TOKEN    = process.env.WA_TOKEN    || '';
const WA_GROUP    = process.env.WA_GROUP    || '';

const TICKMILL_DEMO = {
  accountNumber: '25326583',
  accountType:   'Classic',
  currency:      'USD',
};

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

function waEntry(side, symbol, timeframe, price, size, sl, riskPerUnit, riskAmt, balance) {
  const dir   = side === 'long' ? '🟢' : '🔴';
  const label = side === 'long' ? 'LONG' : 'SHORT';
  const sym   = symbol.replace('USDT', '/USDT');
  const f     = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  sendWhatsApp(
    `${dir} *[Algo33 RSI-cross] ENTRY — ${label} ${sym} ${timeframe}*\n` +
    `Price      : $${f(price)}\n` +
    `Size       : ${f(size, 5)} ${symbol.replace('USDT', '')}\n` +
    `Initial SL : $${f(sl)}  (swing ${side === 'long' ? 'low' : 'high'}, risk/unit $${f(riskPerUnit)})\n` +
    `Risk       : $${f(riskAmt)}  (min balance×${(RISK_FRAC*100).toFixed(1)}%, $${f(MAX_LOSS)})\n` +
    `Trail      : starts @ +$${f(TRAIL_START_PNL, 0)} → locks $${f(TRAIL_START_PNL - TRAIL_STEP_PNL, 0)}, then +$${f(TRAIL_STEP_PNL, 0)}/step\n` +
    `Balance    : $${f(balance)}`
  );
}

function waExit(side, symbol, timeframe, pnl, reason, balance, wins, totalTrades, trailed) {
  const win    = pnl > 0;
  const icon   = win ? '✅' : '❌';
  const label  = side === 'long' ? 'LONG' : 'SHORT';
  const sym    = symbol.replace('USDT', '/USDT');
  const wr     = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
  const f      = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pnlStr = `${pnl >= 0 ? '+' : ''}$${f(Math.abs(pnl))}`;
  sendWhatsApp(
    `${icon} *[Algo33 RSI-cross] EXIT — ${label} ${sym} ${timeframe}*\n` +
    `Reason   : ${reason}\n` +
    `PnL      : *${pnlStr}*\n` +
    `Trailing : ${trailed ? 'Yes' : 'No'}\n` +
    `Balance  : $${f(balance)}\n` +
    `Win Rate : ${wr}% (${wins}/${totalTrades})`
  );
}

// ── Google auth client ─────────────────────────────────────────────
const googleClient = AUTH_REQUIRED ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ── SQLite ─────────────────────────────────────────────────────────
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

// ── Strategy registry ──────────────────────────────────────────────
const STRATEGIES = {
  'rf-kama-v2': {
    name: 'rf-kama-rsi-v3: RF+KAMA zone + RSI(2) cross entry',
    description: `Zone gate: Range Filter (${RF_SAMPLING_PERIOD}, ${RF_MULT}×) + KAMA cloud. BUY when zone green & RSI(${RSI_LEN}) crosses above ${RSI_BUY_LEVEL}; SELL when zone red & RSI(${RSI_LEN}) crosses below ${RSI_SELL_LEVEL}. Algo1-style fixed-risk sizing: SL = entry ± ${SL_ATR_MULT}×ATR, qty = min(balance×${(RISK_FRAC*100).toFixed(1)}%, $${MAX_LOSS}) / (${SL_ATR_MULT}×ATR) → SL hit = $${MAX_LOSS} loss exactly. ${SWING_BARS}-bar swing low/high is a trigger reference only. Trailing starts at +$${TRAIL_START_PNL} PnL (locks $${TRAIL_START_PNL - TRAIL_STEP_PNL}), then locks +$${TRAIL_STEP_PNL} per +$${TRAIL_STEP_PNL} PnL step. SL & trailing scanned every 1s from entry. Exits on opposite trigger.`,
  },
};

// ── Tickmill / MetaApi Adapter ─────────────────────────────────────
const tickmill = {
  connected:   false,
  mode:        METAAPI_TOKEN ? 'metaapi' : 'paper-kraken',
  openOrders:  new Map(),

  async init() {
    if (!METAAPI_TOKEN || !METAAPI_ACCOUNT_ID) {
      console.log('[Algo33] MetaApi not configured — running in paper-Kraken mode');
      return;
    }
    try {
      const status = await this._apiGet(`/users/current/accounts/${METAAPI_ACCOUNT_ID}`);
      this.connected = status && status.state === 'deployed';
      console.log(`[Algo33] MetaApi ${this.connected ? '✓ connected' : '✗ not deployed'}`);
    } catch (err) {
      console.error('[Algo33] MetaApi connection error:', err.message);
    }
  },

  _apiGet(path) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: `mt-client-api-v1.${METAAPI_REGION}.agiliumtrade.ai`,
        path,
        method: 'GET',
        headers: { 'auth-token': METAAPI_TOKEN, 'Content-Type': 'application/json' },
      };
      const req = https.request(opts, res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
      });
      req.on('error', reject);
      req.end();
    });
  },

  _apiPost(path, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const opts = {
        hostname: `mt-client-api-v1.${METAAPI_REGION}.agiliumtrade.ai`,
        path,
        method: 'POST',
        headers: {
          'auth-token': METAAPI_TOKEN,
          'Content-Type': 'application/json',
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
  },

  async placeOrder(side, symbol, lots, stopLoss, takeProfit, comment) {
    if (!this.connected) return { paper: true, orderId: `paper_${Date.now()}` };
    try {
      const tradeType = side === 'long' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
      const tkSymbol  = symbol.replace('USDT', 'USD');
      const result = await this._apiPost(
        `/users/current/accounts/${METAAPI_ACCOUNT_ID}/trade`,
        { actionType: tradeType, symbol: tkSymbol, volume: lots, stopLoss, takeProfit, comment }
      );
      return { orderId: result.orderId || result.positionId, live: true };
    } catch (err) {
      console.error('[Algo33] placeOrder error:', err.message);
      return { paper: true, orderId: `paper_${Date.now()}`, error: err.message };
    }
  },

  async closeOrder(orderId) {
    if (!this.connected || !orderId || orderId.startsWith('paper_')) return { paper: true };
    try {
      await this._apiPost(
        `/users/current/accounts/${METAAPI_ACCOUNT_ID}/trade`,
        { actionType: 'POSITION_CLOSE_ID', positionId: orderId }
      );
      return { closed: true };
    } catch (err) {
      console.error('[Algo33] closeOrder error:', err.message);
      return { error: err.message };
    }
  },
};

tickmill.init().catch(() => {});

// ── Per-user session management ────────────────────────────────────
const userSessions = new Map();

const CANDLE_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };

function defaultFlagState() {
  return { longFlag: false, longFlagLow: null, shortFlag: false, shortFlagHigh: null };
}

function defaultState() {
  return {
    running: false, symbol: 'BTCUSDT', timeframe: '1m',
    strategyId: 'rf-kama-rsi-v3', mode: 'paper',
    balance: 10000, initialBalance: 10000,
    sessionId: null, sessionStart: null,
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: 10000, maxDrawdownDollar: 0, maxDrawdownPct: 0,
    flagState:    defaultFlagState(),
    pendingEntry: null,
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
    flagState, pendingEntry,
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
    tickmillConnected: tickmill.connected,
    tickmillMode:      tickmill.mode,
    flagState,
    pendingEntry,
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
  const { state }     = sess;
  const { sessionId } = state;
  const userId        = sess.userId;
  const {
    side, entryPrice, size, slPrice, mae, tickmillOrderId,
    trailing, trailStop,
  } = position;

  const rawPnl = side === 'long'
    ? (exitPrice - entryPrice) * size
    : (entryPrice - exitPrice) * size;
  const pnl = parseFloat(rawPnl.toFixed(4));

  let closeResult = { paper: true };
  if (tickmillOrderId && !tickmillOrderId.startsWith('paper_')) {
    closeResult = await tickmill.closeOrder(tickmillOrderId);
  }

  state.balance   += pnl;
  state.pnl       += pnl;
  if (pnl > 0) state.wins++;
  state.totalTrades++;
  updateDrawdown(state);
  state.position = null;

  const trade = {
    session_id: sessionId, user_id: userId,
    type: 'exit', side, symbol: state.symbol, timeframe: state.timeframe,
    price: exitPrice, size, pnl,
    stop_loss: trailing ? trailStop : slPrice,
    take_profit: null,
    reason: exitReasonStr,
    balance_after: parseFloat(state.balance.toFixed(4)),
    timestamp: ts,
    mae: parseFloat((mae || 0).toFixed(4)),
    tickmill_order: closeResult.closed ? tickmillOrderId : null,
  };
  stmtInsert.run(trade);
  waExit(side, state.symbol, state.timeframe, pnl, exitReasonStr, state.balance, state.wins, state.totalTrades, !!trailing);
  pushLog(sess, {
    ts, type: 'EXIT', side, price: exitPrice, pnl,
    mae: (mae || 0).toFixed(2),
    reason: [exitReasonStr], indicators,
  });
  broadcast(sess, { type: 'trade', trade, state: publicState(state) });
}

// ── Main candle-aligned tick ──────────────────────────────────────
async function runTick(sess) {
  const { state } = sess;
  const { symbol, timeframe, sessionId } = state;
  const userId = sess.userId;
  const ts     = new Date().toISOString();

  try {
    state.error = null;
    const candles          = await fetchCandles(symbol, timeframe, WARMUP_BARS + 220);
    if (candles.length < WARMUP_BARS + 20) {
      throw new Error(`Need ${WARMUP_BARS + 20}+ candles for KAMA warmup, got ${candles.length}`);
    }
    const lastBar          = candles[candles.length - 1];
    const latestCandleTime = lastBar.time;
    const price            = lastBar.close;

    const isNewCandle = latestCandleTime !== sess.lastCandleTime;

    // ── Fill pending entry at THIS new bar's open ─────────────────
    if (isNewCandle && state.pendingEntry && !state.position) {
      const pe       = state.pendingEntry;
      const entryPx  = lastBar.open;
      const stopDist = SL_ATR_MULT * (pe.atr || 0);   // Fixed SL distance = 1.5 × ATR (algo1-style)
      if (stopDist > 0) {
        // Algo1-style: SL sits at entry ± 1.5×ATR so that qty × stopDist = riskAmt exactly.
        // Swing low/high from the signal is retained as a trigger reference only.
        const slPrice = pe.side === 'long' ? entryPx - stopDist : entryPx + stopDist;
        const riskAmt = Math.min(state.balance * RISK_FRAC, MAX_LOSS);
        const qty     = parseFloat((riskAmt / stopDist).toFixed(8));
        const pos = initPosition(pe.side, entryPx, slPrice, qty, lastBar.time, pe.atr);
        const lots = parseFloat((riskAmt / (entryPx * 100)).toFixed(2));
        const orderResult = await tickmill.placeOrder(pe.side, symbol, lots, pos.slPrice, null, 'CBT Algo33 RSI-cross');
        pos.tickmillOrderId = orderResult.orderId;
        state.position      = pos;

        const trade = {
          session_id: sessionId, user_id: userId,
          type: 'entry', side: pe.side, symbol, timeframe,
          price: entryPx, size: pos.size, pnl: 0,
          stop_loss: pos.slPrice, take_profit: null,
          reason: pe.reason || `RSI(${RSI_LEN}) cross — swing ref ${pe.side === 'long' ? 'low' : 'high'} ${pe.slPrice.toFixed(2)} · risk $${riskAmt.toFixed(2)}`,
          balance_after: parseFloat(state.balance.toFixed(4)),
          timestamp: ts, mae: 0,
          tickmill_order: orderResult.orderId,
        };
        stmtInsert.run(trade);
        waEntry(pe.side, symbol, timeframe, entryPx, pos.size, pos.slPrice, pos.riskPerUnit, riskAmt, state.balance);
        pushLog(sess, {
          ts, type: 'ENTRY', side: pe.side, signal: pe.side === 'long' ? 'BUY' : 'SELL',
          price: entryPx, size: pos.size,
          stopLoss: pos.slPrice, takeProfit: null,
          balance: state.balance.toFixed(4),
          reason: [
            `Filled @ open ${entryPx.toFixed(2)}`,
            `Risk $${riskAmt.toFixed(2)} (min balance×${(RISK_FRAC*100).toFixed(1)}%, $${MAX_LOSS}) / (${SL_ATR_MULT}×ATR ${stopDist.toFixed(2)}) → qty ${qty}`,
            `Initial SL $${pos.slPrice.toFixed(2)} = entry ± $${stopDist.toFixed(2)} (fixed $${riskAmt.toFixed(0)} max loss on hit)`,
            `Swing ${pe.side === 'long' ? 'low' : 'high'} ref: $${pe.slPrice.toFixed(2)} (trigger only, not SL)`,
            `Trail starts @ +$${TRAIL_START_PNL.toFixed(0)} PnL → locks $${(TRAIL_START_PNL - TRAIL_STEP_PNL).toFixed(0)}, then +$${TRAIL_STEP_PNL.toFixed(0)}/step (1s scan from entry)`,
          ],
          indicators: state.lastIndicators,
          tickmill: orderResult,
        });
        broadcast(sess, { type: 'trade', trade, state: publicState(state) });
      } else {
        pushLog(sess, { ts, type: 'TICK', signal: 'ENTRY-SKIP', price: entryPx,
          reason: [`Pending ${pe.side} skipped — ATR ${(pe.atr||0).toFixed(2)} must be > 0`],
          indicators: state.lastIndicators });
      }
      state.pendingEntry = null;
    }

    // ── Step position with the new bar's OHLC ─────────────────────
    if (isNewCandle && state.position) {
      const wasTrailing  = state.position.trailing;
      const prevTrailStop = state.position.trailStop;
      const step = stepPosition(state.position, lastBar);
      state.position.trailing        = step.trailing;
      state.position.trailStop       = step.trailStop;
      state.position.trailLockProfit = step.trailLockProfit;
      state.position.stopLoss        = step.trailing ? step.trailStop : state.position.slPrice;
      if (step.unrealPnl != null) {
        state.position.unrealizedPnl = parseFloat(step.unrealPnl.toFixed(4));
      }
      if (step.worstPnl != null && step.worstPnl < (state.position.mae || 0)) {
        state.position.mae = step.worstPnl;
      }

      if (step.exit) {
        await handleExit(sess, state.position, step.exitPrice, step.reason, state.lastIndicators || {}, ts);
      } else if (step.trailing && (!wasTrailing || step.trailStop !== prevTrailStop)) {
        pushLog(sess, {
          ts, type: 'TICK', signal: wasTrailing ? 'TRAIL-UPDATE' : 'TRAIL-START',
          price,
          indicators: state.lastIndicators,
          reason: [`${wasTrailing ? 'Trail advanced' : 'Trail activated'} — stop $${step.trailStop.toFixed(2)}, locked $${step.trailLockProfit.toFixed(0)}, unrealPnl $${step.unrealPnl.toFixed(2)}`],
        });
      }
    }

    // ── Generate signal on new candle close ───────────────────────
    if (isNewCandle) {
      sess.lastCandleTime = latestCandleTime;
      const posSide = state.position ? state.position.side : null;
      const sig = generateSignal(candles, state.flagState, posSide);
      // Enrich with candle close time (candleTime is the OPEN of the bar; close = open + interval)
      const ivMs = CANDLE_MS[timeframe] || 60000;
      sig.indicators.candleOpenTime  = sig.indicators.candleTime;
      sig.indicators.candleCloseTime = sig.indicators.candleTime + ivMs;
      state.flagState      = sig.flagState;
      state.lastIndicators = sig.indicators;
      state.lastSignal     = { signal: sig.signal, longFlag: sig.flagState.longFlag, shortFlag: sig.flagState.shortFlag };

      // Opposite-trigger exit: close current position at this bar's close,
      // then queue the new entry to fill at the next open.
      if (state.position && sig.entryHint && sig.entryHint.side !== state.position.side) {
        await handleExit(
          sess, state.position, lastBar.close,
          `Opposite ${sig.entryHint.side.toUpperCase()} trigger — reversing`,
          sig.indicators, ts
        );
        state.pendingEntry = { ...sig.entryHint, reason: sig.reason.join(' | ') + ' | (reversed)' };
        pushLog(sess, {
          ts, type: 'TICK', signal: `REVERSE-${sig.signal}`,
          price, indicators: sig.indicators, reason: sig.reason,
        });
      } else if (!state.position && sig.entryHint) {
        state.pendingEntry = { ...sig.entryHint, reason: sig.reason.join(' | ') };
        pushLog(sess, {
          ts, type: 'TICK', signal: `TRIGGER-${sig.signal}`,
          price, indicators: sig.indicators, reason: sig.reason,
        });
      } else if (!(state.position && state.position.trailing)) {
        // Suppress normal candle-close TICK log while trailing —
        // only TRAIL-UPDATE (above) and EXIT are logged during trail phase.
        pushLog(sess, {
          ts, type: 'TICK', signal: sig.signal, price,
          indicators: sig.indicators, reason: sig.reason,
        });
      }
    }

    broadcast(sess, { type: 'tick', state: publicState(state) });
  } catch (err) {
    state.error = err.message;
    pushLog(sess, { ts, type: 'ERROR', message: err.message });
    broadcast(sess, { type: 'error', message: err.message, state: publicState(state) });
  }
}

async function tick(sess) {
  if (sess.tickBusy) return;
  sess.tickBusy = true;
  try {
    await runTick(sess);
    ensureTrailTicker(sess);
  } finally { sess.tickBusy = false; }
}

// Align main tick to fire at :01 after each candle close (was :02).
function startAlignedTicks(sess, intervalMs) {
  stopTicker(sess);
  const now   = Date.now();
  const delay = (Math.ceil(now / intervalMs) * intervalMs) - now + 1000;
  sess.alignTimeout = setTimeout(() => {
    tick(sess);
    sess.ticker = setInterval(() => tick(sess), intervalMs);
  }, delay);
}

function stopTicker(sess) {
  if (sess.alignTimeout) { clearTimeout(sess.alignTimeout);  sess.alignTimeout = null; }
  if (sess.ticker)       { clearInterval(sess.ticker);       sess.ticker       = null; }
  stopTrailTicker(sess);
}

// ── 1s trail loop: fires whenever a position is open so trailing can
// activate on the tick that first crosses +$300 PnL (not just at candle close).
async function trailTick(sess) {
  const { state } = sess;
  if (!state.running || !state.position) {
    stopTrailTicker(sess);
    return;
  }
  if (sess.tickBusy) return;   // don't race the main candle tick
  sess.tickBusy = true;
  try {
    const price = await fetchCurrentPrice(state.symbol);
    if (!price || !isFinite(price)) return;
    const wasTrailing   = state.position.trailing;
    const prevTrailStop = state.position.trailStop;
    const syntheticBar = { high: price, low: price, close: price };
    const step = stepPosition(state.position, syntheticBar);
    state.position.trailing        = step.trailing;
    state.position.trailStop       = step.trailStop;
    state.position.trailLockProfit = step.trailLockProfit;
    state.position.stopLoss        = step.trailing ? step.trailStop : state.position.slPrice;
    if (step.unrealPnl != null) {
      state.position.unrealizedPnl = parseFloat(step.unrealPnl.toFixed(4));
    }
    if (step.worstPnl != null && step.worstPnl < (state.position.mae || 0)) {
      state.position.mae = step.worstPnl;
    }

    if (step.exit) {
      const ts = new Date().toISOString();
      await handleExit(sess, state.position, step.exitPrice, `${step.reason} (1s poll)`, state.lastIndicators || {}, ts);
      stopTrailTicker(sess);
    } else if (step.trailing && (!wasTrailing || step.trailStop !== prevTrailStop)) {
      const ts = new Date().toISOString();
      pushLog(sess, {
        ts, type: 'TICK', signal: wasTrailing ? 'TRAIL-UPDATE' : 'TRAIL-START',
        price,
        indicators: state.lastIndicators,
        reason: [`${wasTrailing ? 'Trail advanced' : 'Trail activated'} — stop $${step.trailStop.toFixed(2)}, locked $${step.trailLockProfit.toFixed(0)}, unrealPnl $${step.unrealPnl.toFixed(2)} (1s poll)`],
      });
    }
    broadcast(sess, { type: 'tick', state: publicState(state) });
  } catch (err) {
    console.error('[trailTick]', err.message);
  } finally { sess.tickBusy = false; }
}

function ensureTrailTicker(sess) {
  const shouldRun = sess.state.running && sess.state.position;
  if (shouldRun && !sess.trailTicker) {
    sess.trailTicker = setInterval(() => trailTick(sess), 1000);
  } else if (!shouldRun) {
    stopTrailTicker(sess);
  }
}
function stopTrailTicker(sess) {
  if (sess.trailTicker) { clearInterval(sess.trailTicker); sess.trailTicker = null; }
}

// ── Backtest ──────────────────────────────────────────────────────
async function runBacktest(symbol, timeframe, months) {
  const allCandles = await fetchCandlesHistorical(symbol, timeframe, months);
  if (allCandles.length < WARMUP_BARS + 20) {
    throw new Error(`Need ${WARMUP_BARS + 20}+ candles for KAMA warmup. Got ${allCandles.length} — try a longer duration.`);
  }

  let balance = 10000;
  const initialBalance = 10000;
  let peakBal = balance, maxDD = 0;
  const trades = [];
  let wins = 0;

  let flagState = defaultFlagState();
  let pendingEntry = null;
  let pos = null;

  for (let i = WARMUP_BARS; i < allCandles.length; i++) {
    const bar = allCandles[i];
    const seg = allCandles.slice(0, i + 1);   // full history matters (KAMA/RF are recursive)

    // 1. Fill any pending entry at THIS bar's open
    if (pendingEntry && !pos) {
      const entryPx  = bar.open;
      const stopDist = SL_ATR_MULT * (pendingEntry.atr || 0);
      if (stopDist > 0) {
        // Algo1-style: SL = entry ± 1.5×ATR, qty = riskAmt / stopDist → loss on SL = riskAmt exactly.
        const slPrice = pendingEntry.side === 'long' ? entryPx - stopDist : entryPx + stopDist;
        const riskAmt = Math.min(balance * RISK_FRAC, MAX_LOSS);
        const qty     = riskAmt / stopDist;
        pos = initPosition(pendingEntry.side, entryPx, slPrice, qty, bar.time, pendingEntry.atr);
        pos.entryIndex = i;
      }
      pendingEntry = null;
    }

    // 2. Step position intra-bar
    if (pos) {
      const step = stepPosition(pos, bar);
      pos.trailing  = step.trailing;
      pos.trailStop = step.trailStop;
      pos.stopLoss  = step.trailing ? step.trailStop : pos.slPrice;
      if ((step.worstPnl || 0) < (pos.mae || 0)) pos.mae = step.worstPnl;

      if (step.exit) {
        const pnl = step.exitPnl;
        balance += pnl;
        if (pnl > 0) wins++;
        if (balance > peakBal) peakBal = balance;
        const dd = peakBal - balance;
        if (dd > maxDD) maxDD = dd;
        trades.push({
          side:            pos.side,
          entryPrice:      +pos.entryPrice.toFixed(4),
          exitPrice:       +step.exitPrice.toFixed(4),
          pnl:             +pnl.toFixed(2),
          balance:         +balance.toFixed(2),
          entryTime:       new Date(pos.entryTime).toISOString(),
          exitTime:        new Date(bar.time).toISOString(),
          reason:          step.reason,
          mae:             +(pos.mae || 0).toFixed(2),
          trailed:         pos.trailing || false,
          slPrice:         +pos.slPrice.toFixed(4),
          trailLockProfit: +(step.trailLockProfit || 0).toFixed(2),
          riskPerUnit:     +pos.riskPerUnit.toFixed(4),
        });
        pos = null;
      }
    }

    // 3. Signal — update flag state, possibly set new pendingEntry
    const sig = generateSignal(seg, flagState, pos ? pos.side : null);
    flagState = sig.flagState;

    // 3a. Opposite-trigger exit: close at this bar's close, queue reverse entry.
    if (pos && sig.entryHint && sig.entryHint.side !== pos.side) {
      const exitPx = bar.close;
      const pnl    = pos.side === 'long'
        ? (exitPx - pos.entryPrice) * pos.size
        : (pos.entryPrice - exitPx) * pos.size;
      balance += pnl;
      if (pnl > 0) wins++;
      if (balance > peakBal) peakBal = balance;
      const dd = peakBal - balance;
      if (dd > maxDD) maxDD = dd;
      trades.push({
        side:            pos.side,
        entryPrice:      +pos.entryPrice.toFixed(4),
        exitPrice:       +exitPx.toFixed(4),
        pnl:             +pnl.toFixed(2),
        balance:         +balance.toFixed(2),
        entryTime:       new Date(pos.entryTime).toISOString(),
        exitTime:        new Date(bar.time).toISOString(),
        reason:          `Opposite ${sig.entryHint.side.toUpperCase()} trigger — reversing`,
        mae:             +(pos.mae || 0).toFixed(2),
        trailed:         pos.trailing || false,
        slPrice:         +pos.slPrice.toFixed(4),
        trailLockProfit: +(pos.trailLockProfit || 0).toFixed(2),
        riskPerUnit:     +pos.riskPerUnit.toFixed(4),
      });
      pos = null;
      pendingEntry = { ...sig.entryHint, reason: sig.reason.join(' | ') + ' | (reversed)' };
    } else if (!pos && sig.entryHint) {
      pendingEntry = { ...sig.entryHint, reason: sig.reason.join(' | ') };
    }
  }

  // Close open position at last close
  if (pos) {
    const lp  = allCandles[allCandles.length - 1].close;
    const pnl = pos.side === 'long'
      ? (lp - pos.entryPrice) * pos.size
      : (pos.entryPrice - lp) * pos.size;
    balance += pnl;
    if (pnl > 0) wins++;
    trades.push({
      side:            pos.side,
      entryPrice:      +pos.entryPrice.toFixed(4),
      exitPrice:       +lp.toFixed(4),
      pnl:             +pnl.toFixed(2),
      balance:         +balance.toFixed(2),
      entryTime:       new Date(pos.entryTime).toISOString(),
      exitTime:        new Date(allCandles[allCandles.length - 1].time).toISOString(),
      reason:          'End of backtest',
      mae:             +(pos.mae || 0).toFixed(2),
      trailed:         pos.trailing || false,
      slPrice:         +pos.slPrice.toFixed(4),
      trailLockProfit: +(pos.trailLockProfit || 0).toFixed(2),
      riskPerUnit:     +pos.riskPerUnit.toFixed(4),
    });
  }

  const total  = trades.length;
  const netPnl = balance - initialBalance;
  return {
    trades,
    summary: {
      totalTrades:     total,
      wins,
      losses:          total - wins,
      winRate:         total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0',
      totalPnl:        +netPnl.toFixed(2),
      pnlPct:          ((netPnl / initialBalance) * 100).toFixed(2),
      maxDrawdown:     +maxDD.toFixed(2),
      finalBalance:    +balance.toFixed(2),
      candlesAnalyzed: allCandles.length,
      warmupBars:      WARMUP_BARS,
      period:          `${months} month${months > 1 ? 's' : ''}`,
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

app.get('/health', (_, res) => res.json({ status: 'ok', strategy: 'rf-kama-rsi-v3' }));
app.get('/api/strategies', (_, res) =>
  res.json(Object.entries(STRATEGIES).map(([id, s]) => ({ id, ...s })))
);
app.get('/api/tickmill', (_, res) => res.json({
  connected:     tickmill.connected,
  mode:          tickmill.mode,
  accountNumber: TICKMILL_DEMO.accountNumber,
  accountType:   TICKMILL_DEMO.accountType,
  currency:      TICKMILL_DEMO.currency,
  metaapiConfigured: !!(METAAPI_TOKEN && METAAPI_ACCOUNT_ID),
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
    symbol = 'BTCUSDT', timeframe = '1m',
    balance = 10000,
    strategyId = 'rf-kama-v2', mode = 'paper',
  } = req.body || {};
  // Main tick must fire ONCE per closed candle (at :01s past the candle boundary),
  // regardless of any user-supplied interval. Otherwise signals fire mid-bar.
  const ms  = CANDLE_MS[timeframe] || 60000;
  const bal = parseFloat(balance);

  Object.assign(sess.state, {
    running: true, symbol, timeframe, strategyId, mode,
    balance: bal, initialBalance: bal,
    sessionId:    `s_${Date.now()}_${req.userId}`,
    sessionStart: new Date().toISOString(),
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: bal, maxDrawdownDollar: 0, maxDrawdownPct: 0,
    flagState:    defaultFlagState(),
    pendingEntry: null,
    userId:       req.userId,
  });
  sess.logs           = [];
  sess.lastCandleTime = null;

  tick(sess);
  startAlignedTicks(sess, ms);

  broadcast(sess, { type: 'started', state: publicState(sess.state) });
  res.json({ ok: true, state: publicState(sess.state) });
});

app.post('/api/reset', requireAuth, (req, res) => {
  const sess = getSession(req.userId);
  if (sess.state.running) return res.json({ ok: false, msg: 'Stop the algo before resetting' });
  const info = db.prepare('DELETE FROM trades WHERE user_id=?').run(req.userId);
  sess.logs = [];
  sess.lastCandleTime = null;
  sess.state = defaultState();
  sess.state.userId = req.userId;
  broadcast(sess, { type: 'reset', state: publicState(sess.state) });
  res.json({ ok: true, tradesCleared: info.changes });
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
  const { symbol = 'BTCUSDT', timeframe = '1m', months = 3 } = req.body || {};
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
  console.log(`CBT Algo33 (RF+KAMA + RSI(${RSI_LEN}) cross) listening on :${PORT} | MetaApi: ${tickmill.mode}`)
);
