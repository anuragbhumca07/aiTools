'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const session  = require('express-session');
const { OAuth2Client } = require('google-auth-library');
const {
  computeIndicators, generateSignal, checkExit, computeTrailUpdate,
  fetchCandles, fetchCandlesHistorical, fetchCurrentPrice,
} = require('./algo');

// ── Config ────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '3017', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AUTH_REQUIRED    = !!GOOGLE_CLIENT_ID;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'cbt-algo55-dev-secret';

// MetaAPI credentials — same env vars as algo66
const METAAPI_TOKEN      = process.env.METAAPI_TOKEN      || '';
const METAAPI_ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID || '';
const METAAPI_REGION     = process.env.METAAPI_REGION     || 'new-york';

// Multi-account support (same pattern as algo66)
// METAAPI_ACCOUNTS = JSON array: [{"id":"...","label":"Tickmill Demo 1 (#25329025)"},...]
// Falls back to single METAAPI_ACCOUNT_ID for backward compat.
let MT5_ACCOUNTS = [];
try {
  const raw = process.env.METAAPI_ACCOUNTS || '';
  if (raw) MT5_ACCOUNTS = JSON.parse(raw);
} catch {}
if (!MT5_ACCOUNTS.length && METAAPI_ACCOUNT_ID) {
  MT5_ACCOUNTS = [{ id: METAAPI_ACCOUNT_ID, label: 'Default Account' }];
}

const WA_INSTANCE = process.env.WA_INSTANCE || '';
const WA_TOKEN    = process.env.WA_TOKEN    || '';
const WA_GROUP    = process.env.WA_GROUP    || '';

// Sizing limits for small account (Rs. 10000 / ~$120, 1:500 leverage)
const MIN_LOTS = 0.01;
const MAX_LOTS = 0.30;
const RISK_PCT = 0.02; // risk 2% of balance per trade

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

function waEntry(side, symbol, timeframe, price, lots, sl, tp, riskAmt, balance, trailTrigger, trailStep) {
  const dir   = side === 'long' ? '🟢' : '🔴';
  const label = side === 'long' ? 'LONG' : 'SHORT';
  const sym   = symbol.replace('USDT', '/USDT');
  const f     = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  sendWhatsApp(
    `${dir} *[Algo55] ENTRY — ${label} ${sym} ${timeframe}*\n` +
    `Price  : $${f(price)}\n` +
    `Lots   : ${f(lots, 2)} (max ${MAX_LOTS})\n` +
    `SL     : $${f(sl)}  (1.5×ATR)\n` +
    `Init TP: $${f(tp)}  (3×ATR)\n` +
    `Risk   : $${f(riskAmt)} (${(RISK_PCT*100).toFixed(0)}% of balance)\n` +
    `Trail  : starts at $${f(trailTrigger,1)}, step $${f(trailStep,1)}\n` +
    `Balance: $${f(balance)}`
  );
}

function waExit(side, symbol, timeframe, pnl, reason, balance, wins, totalTrades, trailed, lockProfit) {
  const win    = pnl > 0;
  const icon   = win ? '✅' : '❌';
  const label  = side === 'long' ? 'LONG' : 'SHORT';
  const sym    = symbol.replace('USDT', '/USDT');
  const wr     = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
  const f      = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pnlStr = `${pnl >= 0 ? '+' : ''}$${f(Math.abs(pnl))}`;
  sendWhatsApp(
    `${icon} *[Algo55] EXIT — ${label} ${sym} ${timeframe}*\n` +
    `Reason   : ${reason}\n` +
    `PnL      : *${pnlStr}*\n` +
    `Trailing : ${trailed ? `Yes (locked $${f(lockProfit,1)})` : 'No'}\n` +
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
  'swing-v2-trailing': {
    name: 'swing-v2-trailing: EMA Ribbon Swing (Dynamic Sizing, max 0.3 lots)',
    description: `EMA21/55/200 + ADX(25) + DI-spread≥20 + |EMA21-slope|≥12 + macro gate + RSI-short≤50 + 6/7 conditions + dynamic lots (${MIN_LOTS}–${MAX_LOTS}, 2% risk) + 1.5×ATR SL + auto-scaled trailing (2× risk trigger, 0.3× risk step) + Opposite Signal Exit + 5×ATR adverse stop`,
  },
};

// ── MetaAPI / Tickmill Adapter ─────────────────────────────────────
const tickmill = {
  connected:   false,
  mode:        METAAPI_TOKEN ? 'metaapi' : 'paper-kraken',
  openOrders:  new Map(),

  async init() {
    if (!METAAPI_TOKEN || !METAAPI_ACCOUNT_ID) {
      console.log('[Algo55] MetaApi not configured — running in paper-Kraken mode');
      return;
    }
    try {
      const status = await this._apiGet(`/users/current/accounts/${METAAPI_ACCOUNT_ID}`);
      this.connected = status && status.state === 'deployed';
      console.log(`[Algo55] MetaApi ${this.connected ? '✓ connected' : '✗ not deployed'}`);
    } catch (err) {
      console.error('[Algo55] MetaApi connection error:', err.message);
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

  async placeOrder(side, symbol, lots, stopLoss, takeProfit, comment, accountId) {
    if (!this.connected) return { paper: true, orderId: `paper_${Date.now()}` };
    const acctId = accountId || MT5_ACCOUNTS[0]?.id || METAAPI_ACCOUNT_ID;
    try {
      const tradeType = side === 'long' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
      const tkSymbol  = symbol.replace('USDT', 'USD');
      const result = await this._apiPost(
        `/users/current/accounts/${acctId}/trade`,
        { actionType: tradeType, symbol: tkSymbol, volume: lots, stopLoss, takeProfit, comment }
      );
      return { orderId: result.orderId || result.positionId, live: true };
    } catch (err) {
      console.error('[Algo55] placeOrder error:', err.message);
      return { paper: true, orderId: `paper_${Date.now()}`, error: err.message };
    }
  },

  async closeOrder(orderId, accountId) {
    if (!this.connected || !orderId || orderId.startsWith('paper_')) return { paper: true };
    const acctId = accountId || MT5_ACCOUNTS[0]?.id || METAAPI_ACCOUNT_ID;
    try {
      await this._apiPost(
        `/users/current/accounts/${acctId}/trade`,
        { actionType: 'POSITION_CLOSE_ID', positionId: orderId }
      );
      return { closed: true };
    } catch (err) {
      console.error('[Algo55] closeOrder error:', err.message);
      return { error: err.message };
    }
  },
};

tickmill.init().catch(() => {});

// ── MT5 account info (6-retry, same as algo66) ─────────────────────
async function mt5GetAccountInfo(accountId) {
  const acctId = accountId || MT5_ACCOUNTS[0]?.id || METAAPI_ACCOUNT_ID;
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const result = await new Promise((resolve, reject) => {
      const opts = {
        hostname: `mt-client-api-v1.${METAAPI_REGION}.agiliumtrade.ai`,
        path:     `/users/current/accounts/${acctId}/account-information`,
        method:   'GET',
        headers:  { 'auth-token': METAAPI_TOKEN, 'Content-Type': 'application/json' },
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
      req.setTimeout(30000, () => req.destroy(new Error('MetaAPI timeout')));
      req.end();
    });
    if (result.status === 200) return result.body;
    lastErr = `MetaAPI account-info error ${result.status}: ${JSON.stringify(result.body).slice(0, 200)}`;
    if (attempt < 6) await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(lastErr);
}

// ── Sizing helpers ─────────────────────────────────────────────────
// Returns { lots, size, initialRisk, trailTrigger, trailStep, adverseStop }
// lots   = MetaAPI volume (clamped to [MIN_LOTS, MAX_LOTS])
// size   = same as lots (for crypto CFD: 1 lot = 1 unit of base asset)
// trailTrigger = 2× initial risk in dollars  (start trailing when profit ≥ 2× what we risked)
// trailStep    = 0.3× initial risk, min $0.50 (dollar step to advance SL)
// adverseStop  = 5× ATR in price units        (hard gap-stop backstop)
function calcSizing(balance, atr, stopDist) {
  const riskAmt = balance * RISK_PCT;
  let lots = riskAmt / stopDist;
  lots = parseFloat(Math.max(MIN_LOTS, Math.min(MAX_LOTS, lots)).toFixed(2));
  const size         = lots;
  const initialRisk  = parseFloat((lots * stopDist).toFixed(4));
  const trailTrigger = parseFloat(Math.max(1, initialRisk * 2).toFixed(2));
  const trailStep    = parseFloat(Math.max(0.50, initialRisk * 0.30).toFixed(2));
  const adverseStop  = parseFloat((5 * atr).toFixed(4)); // price units
  return { lots, size, initialRisk, trailTrigger, trailStep, adverseStop, riskAmt };
}

// ── Per-user session management ────────────────────────────────────
const userSessions = new Map();

const CANDLE_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };

function defaultState() {
  return {
    running: false, symbol: 'BTCUSDT', timeframe: '4h',
    strategyId: 'swing-v2-trailing', mode: 'paper',
    balance: 10000, initialBalance: 10000,
    sessionId: null, sessionStart: null,
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: 10000, maxDrawdownDollar: 0, maxDrawdownPct: 0,
    selectedAccountId:    MT5_ACCOUNTS[0]?.id    || '',
    selectedAccountLabel: MT5_ACCOUNTS[0]?.label || '',
    mt5Balance: null, mt5Equity: null, mt5Leverage: null, mt5AccountState: null,
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
    tickmillConnected: tickmill.connected,
    tickmillMode:      tickmill.mode,
    sizingLimits:      { minLots: MIN_LOTS, maxLots: MAX_LOTS, riskPct: RISK_PCT },
    selectedAccountId:    state.selectedAccountId,
    selectedAccountLabel: state.selectedAccountLabel,
    mt5Accounts:     MT5_ACCOUNTS,
    mt5Balance:      state.mt5Balance,
    mt5Equity:       state.mt5Equity,
    mt5Leverage:     state.mt5Leverage,
    mt5AccountState: state.mt5AccountState,
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
  const { sessionId } = state;
  const userId = sess.userId;
  const { side, entryPrice, size, stopLoss, takeProfit, mae, tickmillOrderId, trailing, trailLockProfit } = position;

  const rawPnl = side === 'long'
    ? (exitPrice - entryPrice) * size
    : (entryPrice - exitPrice) * size;
  const pnl = parseFloat(rawPnl.toFixed(4));

  let closeResult = { paper: true };
  if (tickmillOrderId && !tickmillOrderId.startsWith('paper_')) {
    closeResult = await tickmill.closeOrder(tickmillOrderId, state.selectedAccountId);
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

// ── Fast ticker (10-second trailing poll) ─────────────────────────

function stopFastTicker(sess) {
  if (sess.fastTicker) { clearInterval(sess.fastTicker); sess.fastTicker = null; }
}

function manageFastTicker(sess) {
  const { state } = sess;
  const pos = state.position;
  // Start fast polling when within 80% of the trail trigger, or trailing already active
  const nearTrigger = pos ? (pos.unrealizedPnl || 0) > (pos.trailTrigger || 300) * 0.8 : false;
  const needFast = state.running && pos && (nearTrigger || pos.trailing);

  if (needFast && !sess.fastTicker) {
    console.log(`[Algo55] Starting fast 10s poll (unrealPnl=${(pos.unrealizedPnl||0).toFixed(2)}, trigger=${pos.trailTrigger})`);
    sess.fastTicker = setInterval(() => fastTick(sess), 10000);
  } else if (!needFast && sess.fastTicker) {
    console.log('[Algo55] Stopping fast poll');
    stopFastTicker(sess);
  }
}

async function runFastTick(sess) {
  const { state } = sess;
  if (!state.running || !state.position) {
    stopFastTicker(sess);
    return;
  }

  const ts = new Date().toISOString();
  try {
    const price = await fetchCurrentPrice(state.symbol);
    const pos   = state.position;
    const { side, entryPrice, size, stopLoss } = pos;

    const unrealPnl = side === 'long'
      ? (price - entryPrice) * size
      : (entryPrice - price) * size;
    pos.unrealizedPnl = parseFloat(unrealPnl.toFixed(4));
    if (unrealPnl < (pos.mae || 0)) pos.mae = unrealPnl;

    const slHit = side === 'long' ? price <= pos.stopLoss : price >= pos.stopLoss;
    if (slHit) {
      const reason = pos.trailing
        ? `Trailing SL hit: $${pos.stopLoss.toFixed(2)} (locked $${(pos.trailLockProfit || 0).toFixed(2)} profit)`
        : `SL hit (fast): $${pos.stopLoss.toFixed(2)}`;
      await handleExit(sess, pos, pos.stopLoss, reason, state.lastIndicators || {}, ts);
      stopFastTicker(sess);
      return;
    }

    const trailUpdate = computeTrailUpdate(pos, unrealPnl);
    if (trailUpdate) {
      const { oldSl, newSl, lockProfit } = trailUpdate;
      pos.stopLoss        = newSl;
      pos.trailing        = true;
      pos.trailLockProfit = lockProfit;

      const note = `SL updated: $${oldSl.toFixed(2)} → $${newSl.toFixed(2)} (locks $${lockProfit.toFixed(2)} profit)`;
      console.log(`[Algo55] TRAIL: ${note}`);
      pushLog(sess, {
        ts, type: 'TICK', signal: 'TRAIL-UPDATE', price,
        indicators: { ...(state.lastIndicators || {}), price },
        reason: [note],
      });
    } else if (pos.trailing) {
      pushLog(sess, {
        ts, type: 'TICK', signal: 'TRAIL-WATCH', price,
        indicators: { ...(state.lastIndicators || {}), price },
        reason: [`Trailing active — locked $${(pos.trailLockProfit || 0).toFixed(2)}, SL: $${pos.stopLoss.toFixed(2)}, PnL: $${unrealPnl.toFixed(2)}`],
      });
    }

    broadcast(sess, { type: 'tick', state: publicState(state) });
  } catch (err) {
    console.error('[Algo55 fastTick]', err.message);
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
    const raw              = await fetchCandles(symbol, timeframe, 251);
    const candles          = raw.slice(0, -1); // drop forming candle — evaluate on closed bar
    const latestCandleTime = candles[candles.length - 1].time;
    const price            = candles[candles.length - 1].close;

    // ── Static SL / adverse stop exit ──────────────────────────────
    if (state.position) {
      const exitResult = checkExit(state.position, candles);
      state.lastIndicators = exitResult.indicators;

      if (exitResult.exit) {
        const reason0 = exitResult.reasons[0] || '';
        let exitPrice = price;
        if (reason0.startsWith('SL hit')) {
          exitPrice = state.position.stopLoss;
        } else if (reason0.startsWith('Adverse stop')) {
          const adStop = state.position.adverseStop || 1000;
          exitPrice = state.position.side === 'long'
            ? state.position.entryPrice - adStop
            : state.position.entryPrice + adStop;
        }

        const pos = state.position;
        const rawPnl = pos.side === 'long'
          ? (exitPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - exitPrice) * pos.size;
        const pnl = parseFloat(rawPnl.toFixed(4));

        let closeResult = { paper: true };
        if (pos.tickmillOrderId && !pos.tickmillOrderId.startsWith('paper_')) {
          closeResult = await tickmill.closeOrder(pos.tickmillOrderId, state.selectedAccountId);
        }

        state.balance   += pnl;
        state.pnl       += pnl;
        if (pnl > 0) state.wins++;
        state.totalTrades++;
        updateDrawdown(state);
        state.position = null;
        stopFastTicker(sess);

        const trade = {
          session_id: sessionId, user_id: userId,
          type: 'exit', side: pos.side, symbol, timeframe,
          price: exitPrice, size: pos.size, pnl,
          stop_loss: pos.stopLoss, take_profit: pos.takeProfit,
          reason: exitResult.reasons.join(' | '),
          balance_after: parseFloat(state.balance.toFixed(4)),
          timestamp: ts,
          mae: parseFloat((pos.mae || 0).toFixed(4)),
          tickmill_order: closeResult.closed ? pos.tickmillOrderId : null,
        };
        stmtInsert.run(trade);
        waExit(pos.side, symbol, timeframe, pnl, exitResult.reasons[0] || '', state.balance, state.wins, state.totalTrades, pos.trailing || false, pos.trailLockProfit || 0);
        pushLog(sess, { ts, type: 'EXIT', side: pos.side, price: exitPrice, pnl,
                        mae: (pos.mae || 0).toFixed(2),
                        reason: exitResult.reasons, indicators: exitResult.indicators });
        broadcast(sess, { type: 'trade', trade, state: publicState(state) });
        return;
      }

      // Update unrealized PnL
      const { side, entryPrice, size } = state.position;
      const unrealPnl = side === 'long' ? (price - entryPrice) * size : (entryPrice - price) * size;
      state.position.unrealizedPnl = parseFloat(unrealPnl.toFixed(4));
      if (unrealPnl < (state.position.mae || 0)) state.position.mae = unrealPnl;

      // Belt-and-suspenders trailing SL advance on candle close
      const trailUpdate = computeTrailUpdate(state.position, unrealPnl);
      if (trailUpdate) {
        const { oldSl, newSl, lockProfit } = trailUpdate;
        state.position.stopLoss        = newSl;
        state.position.trailing        = true;
        state.position.trailLockProfit = lockProfit;
        pushLog(sess, {
          ts, type: 'TICK', signal: 'TRAIL-UPDATE', price,
          indicators: state.lastIndicators,
          reason: [`SL updated: $${oldSl.toFixed(2)} → $${newSl.toFixed(2)} (locks $${lockProfit.toFixed(2)} profit)`],
        });
      }

      manageFastTicker(sess);
    }

    const isNewCandle = latestCandleTime !== sess.lastCandleTime;
    if (!isNewCandle) {
      broadcast(sess, { type: 'tick', state: publicState(state) });
      return;
    }
    sess.lastCandleTime = latestCandleTime;

    // ── Generate signal on every new candle ──────────────────────────
    const { signal, reason, indicators, buyScore, sellScore } = generateSignal(candles);
    state.lastIndicators = indicators;
    state.lastSignal     = { signal, buyScore, sellScore };

    // ── Opposite-signal exit ──────────────────────────────────────────
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

    // ── Entry logic ───────────────────────────────────────────────────
    if (!state.position && (signal === 'BUY' || signal === 'SELL')) {
      // Block entry if candle closed more than 2 minutes ago
      const candleIntervalMs = CANDLE_MS[timeframe] || 14400000;
      const msSinceClose     = Date.now() - (latestCandleTime + candleIntervalMs);
      if (msSinceClose > 120000) {
        pushLog(sess, { ts, type: 'TICK', signal: 'SKIP', price, indicators,
          reason: [`Entry skipped — ${Math.round(msSinceClose / 1000)}s since candle close (>2 min), :01s rule`] });
        broadcast(sess, { type: 'tick', state: publicState(state) });
        return;
      }

      const { atr } = indicators;
      const side     = signal === 'BUY' ? 'long' : 'short';
      const stopDist = 1.5 * atr;
      const { lots, size, initialRisk, trailTrigger, trailStep, adverseStop, riskAmt } =
        calcSizing(state.balance, atr, stopDist);
      const sl = side === 'long' ? price - stopDist : price + stopDist;
      const tp = side === 'long' ? price + 3 * atr  : price - 3 * atr;

      const orderResult = await tickmill.placeOrder(side, symbol, lots, sl, tp, 'CBT Algo55 Dynamic Sizing', state.selectedAccountId);

      state.position = {
        side, entryPrice: price, size, stopLoss: sl, takeProfit: tp,
        entryTime: ts, unrealizedPnl: 0, mae: 0,
        trailing: false, trailLockProfit: 0,
        trailTrigger, trailStep, adverseStop,
        tickmillOrderId: orderResult.orderId,
      };

      const trade = {
        session_id: sessionId, user_id: userId,
        type: 'entry', side, symbol, timeframe,
        price, size, pnl: 0,
        stop_loss: sl, take_profit: tp,
        reason: reason.join(' | '),
        balance_after: parseFloat(state.balance.toFixed(4)),
        timestamp: ts, mae: 0,
        tickmill_order: orderResult.orderId,
      };
      stmtInsert.run(trade);
      waEntry(side, symbol, timeframe, price, lots, sl, tp, riskAmt, state.balance, trailTrigger, trailStep);
      pushLog(sess, { ts, type: 'ENTRY', side, signal, price, size,
                      stopLoss: sl, takeProfit: tp,
                      balance: state.balance.toFixed(4), reason, indicators,
                      lots, initialRisk, trailTrigger, trailStep,
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

// No-drift self-rescheduling timer: fires at :01s after each candle boundary
function scheduleNextTick(sess, intervalMs) {
  const now   = Date.now();
  const delay = intervalMs - (now % intervalMs) + 1000;
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
  const allCandles = await fetchCandlesHistorical(symbol, timeframe, months);
  if (allCandles.length < 210) {
    throw new Error(`Need 210+ candles for EMA200. Got ${allCandles.length} — try longer duration.`);
  }

  const WINDOW = 250;
  let balance = 10000; // backtest starting balance
  const initialBalance = balance;
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
      // Advance trailing SL using candle peak
      const peakPx  = pos.side === 'long' ? canH : canL;
      const peakPnl = pos.side === 'long'
        ? (peakPx - pos.entryPrice) * pos.size
        : (pos.entryPrice - peakPx) * pos.size;
      const tu = computeTrailUpdate(pos, peakPnl);
      if (tu) {
        pos.stopLoss        = tu.newSl;
        pos.trailing        = true;
        pos.trailLockProfit = tu.lockProfit;
      }

      const adverseStop = pos.adverseStop || 1000;
      const slHit      = pos.side === 'long' ? canL <= pos.stopLoss  : canH >= pos.stopLoss;
      const adverseHit = pos.side === 'long'
        ? canL <= pos.entryPrice - adverseStop
        : canH >= pos.entryPrice + adverseStop;

      if (slHit || adverseHit) {
        let exitPrice, reason;
        if (adverseHit && (!slHit ||
            (pos.side === 'long' ? pos.entryPrice - adverseStop < pos.stopLoss : pos.entryPrice + adverseStop > pos.stopLoss))) {
          exitPrice = pos.side === 'long' ? pos.entryPrice - adverseStop : pos.entryPrice + adverseStop;
          reason    = 'Adverse stop';
        } else {
          exitPrice = pos.stopLoss;
          reason    = pos.trailing
            ? `Trailing SL hit: $${exitPrice.toFixed(2)} (locked $${pos.trailLockProfit.toFixed(2)})`
            : `SL hit: $${exitPrice.toFixed(2)}`;
        }
        const pnl = pos.side === 'long'
          ? (exitPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - exitPrice) * pos.size;
        balance += pnl;
        if (pnl > 0) wins++;
        if (balance > peakBal) peakBal = balance;
        const dd = peakBal - balance;
        if (dd > maxDD) maxDD = dd;
        trades.push({
          side: pos.side, entryPrice: +pos.entryPrice.toFixed(4), exitPrice: +exitPrice.toFixed(4),
          pnl: +pnl.toFixed(2), balance: +balance.toFixed(2),
          lots: pos.size,
          entryTime: new Date(pos.entryTime).toISOString(),
          exitTime:  new Date(allCandles[i].time).toISOString(),
          reason, mae: +(pos.mae || 0).toFixed(2), trailed: pos.trailing || false,
        });
        pos = null;

      } else if ((pos.side === 'long' && sig.signal === 'SELL') ||
                 (pos.side === 'short' && sig.signal === 'BUY')) {
        const pnl = pos.side === 'long'
          ? (price - pos.entryPrice) * pos.size
          : (pos.entryPrice - price) * pos.size;
        balance += pnl;
        if (pnl > 0) wins++;
        if (balance > peakBal) peakBal = balance;
        const dd = peakBal - balance;
        if (dd > maxDD) maxDD = dd;
        trades.push({
          side: pos.side, entryPrice: +pos.entryPrice.toFixed(4), exitPrice: +price.toFixed(4),
          pnl: +pnl.toFixed(2), balance: +balance.toFixed(2),
          lots: pos.size,
          entryTime: new Date(pos.entryTime).toISOString(),
          exitTime:  new Date(allCandles[i].time).toISOString(),
          reason: `Opposite signal: ${sig.signal}`, mae: +(pos.mae || 0).toFixed(2), trailed: pos.trailing || false,
        });
        pos = null;

      } else {
        const unrealPnl = pos.side === 'long'
          ? (price - pos.entryPrice) * pos.size
          : (pos.entryPrice - price) * pos.size;
        if (unrealPnl < (pos.mae || 0)) pos.mae = unrealPnl;
      }
    }

    if (!pos && (sig.signal === 'BUY' || sig.signal === 'SELL')) {
      const newSide  = sig.signal === 'BUY' ? 'long' : 'short';
      const { atr }  = sig.indicators;
      const stopDist = 1.5 * atr;
      const { size, trailTrigger, trailStep, adverseStop } =
        calcSizing(balance, atr, stopDist);
      pos = {
        side: newSide, entryPrice: price, size,
        stopLoss:       newSide === 'long' ? price - stopDist : price + stopDist,
        takeProfit:     newSide === 'long' ? price + 3 * atr  : price - 3 * atr,
        entryTime:      allCandles[i].time,
        mae: 0, trailing: false, trailLockProfit: 0,
        trailTrigger, trailStep, adverseStop,
      };
    }
  }

  if (pos) {
    const lp  = allCandles[allCandles.length - 1].close;
    const pnl = pos.side === 'long'
      ? (lp - pos.entryPrice) * pos.size
      : (pos.entryPrice - lp) * pos.size;
    balance += pnl;
    trades.push({
      side: pos.side, entryPrice: +pos.entryPrice.toFixed(4), exitPrice: +lp.toFixed(4),
      pnl: +pnl.toFixed(2), balance: +balance.toFixed(2),
      lots: pos.size,
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
      sizingNote: `Dynamic lots (${MIN_LOTS}–${MAX_LOTS}), 2% risk per trade, trail auto-scaled to initial risk`,
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

app.get('/health', (_, res) => res.json({ status: 'ok', strategy: 'swing-v2-trailing', version: 'algo55-dynamic-sizing' }));
app.get('/api/strategies', (_, res) =>
  res.json(Object.entries(STRATEGIES).map(([id, s]) => ({ id, ...s })))
);
app.get('/api/tickmill', (_, res) => res.json({
  connected:          tickmill.connected,
  mode:               tickmill.mode,
  metaapiConfigured:  !!(METAAPI_TOKEN && METAAPI_ACCOUNT_ID),
  metaapiAccountId:   METAAPI_ACCOUNT_ID ? `...${METAAPI_ACCOUNT_ID.slice(-6)}` : 'not set',
  minLots:            MIN_LOTS,
  maxLots:            MAX_LOTS,
  riskPct:            RISK_PCT,
}));

// ── MT5 account management endpoints (same as algo66) ──────────────
app.get('/api/mt5/accounts', requireAuth, (req, res) => {
  res.json({ ok: true, accounts: MT5_ACCOUNTS, region: METAAPI_REGION });
});

app.get('/api/mt5/status', requireAuth, async (req, res) => {
  if (!METAAPI_TOKEN || !MT5_ACCOUNTS.length) {
    return res.json({ ok: false, error: 'METAAPI_TOKEN / METAAPI_ACCOUNTS env vars not set' });
  }
  const accountId = req.query.id || MT5_ACCOUNTS[0].id;
  const acct = MT5_ACCOUNTS.find(a => a.id === accountId) || MT5_ACCOUNTS[0];
  try {
    const info = await mt5GetAccountInfo(acct.id);
    res.json({
      ok: true, accountId: acct.id, label: acct.label, region: METAAPI_REGION,
      accountInfo: info,
      provisioning: { state: 'DEPLOYED', server: info.broker || 'Tickmill-Demo', login: info.login },
    });
  } catch (e) {
    res.json({ ok: false, softError: true, accountId: acct.id, label: acct.label, region: METAAPI_REGION, error: e.message });
  }
});

app.post('/api/mt5/deploy', requireAuth, (req, res) => {
  res.json({ ok: true, dashboardUrl: 'https://app.metaapi.cloud/accounts' });
});

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
    symbol = 'BTCUSDT', timeframe = '4h',
    balance = 10000, interval = 14400,
    strategyId = 'swing-v2-trailing', mode = 'paper',
    accountId,
  } = req.body || {};
  const ms   = Math.max(5000, parseInt(interval, 10) * 1000);
  const bal  = parseFloat(balance);
  const acct = (accountId && MT5_ACCOUNTS.find(a => a.id === accountId))
    || MT5_ACCOUNTS[0] || { id: METAAPI_ACCOUNT_ID, label: 'Default' };

  Object.assign(sess.state, {
    running: true, symbol, timeframe, strategyId, mode,
    balance: bal, initialBalance: bal,
    sessionId:    `s_${Date.now()}_${req.userId}`,
    sessionStart: new Date().toISOString(),
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: bal, maxDrawdownDollar: 0, maxDrawdownPct: 0,
    userId: req.userId,
    selectedAccountId:    acct.id,
    selectedAccountLabel: acct.label,
    mt5Balance: null, mt5Equity: null, mt5Leverage: null, mt5AccountState: null,
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
  const { symbol = 'BTCUSDT', timeframe = '4h', months = 3 } = req.body || {};
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
  console.log(`CBT Algo55 (Swing v2 · Dynamic Sizing ${MIN_LOTS}–${MAX_LOTS} lots · 2% risk · MetaAPI) listening on :${PORT} | Mode: ${tickmill.mode}`)
);
