'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const session  = require('express-session');
const { OAuth2Client } = require('google-auth-library');
const {
  computeIndicators, generateSignal, checkExit,
  fetchCandles, fetchCandlesHistorical,
} = require('./algo');

// ── Config ────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '3011', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AUTH_REQUIRED    = !!GOOGLE_CLIENT_ID;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'cbt-algo4-dev-secret';

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

function waEntry(side, symbol, timeframe, price, size, sl, tp, riskAmt, balance) {
  const dir   = side === 'long' ? '🟢' : '🔴';
  const label = side === 'long' ? 'LONG' : 'SHORT';
  const sym   = symbol.replace('USDT', '/USDT');
  const f     = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  sendWhatsApp(
    `${dir} *[Algo4] ENTRY — ${label} ${sym} ${timeframe}*\n` +
    `Price  : $${f(price)}\n` +
    `Size   : ${f(size, 5)} ${symbol.replace('USDT', '')}\n` +
    `SL     : $${f(sl)}  (1.5×ATR)\n` +
    `TP     : $${f(tp)}  (3×ATR)\n` +
    `Risk   : $${f(riskAmt)}\n` +
    `Balance: $${f(balance)}`
  );
}

function waExit(side, symbol, timeframe, pnl, reason, balance, wins, totalTrades) {
  const win    = pnl > 0;
  const icon   = win ? '✅' : '❌';
  const label  = side === 'long' ? 'LONG' : 'SHORT';
  const sym    = symbol.replace('USDT', '/USDT');
  const wr     = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
  const f      = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pnlStr = `${pnl >= 0 ? '+' : ''}$${f(Math.abs(pnl))}`;
  sendWhatsApp(
    `${icon} *[Algo4] EXIT — ${label} ${sym} ${timeframe}*\n` +
    `Reason  : ${reason}\n` +
    `PnL     : *${pnlStr}*\n` +
    `Balance : $${f(balance)}\n` +
    `Win Rate: ${wr}% (${wins}/${totalTrades})`
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
  'swing-v2-fixed': {
    name: 'swing-v2-fixed: EMA Ribbon Swing (Fixed SL/TP)',
    description: 'EMA21/55/200 + ADX(25) + DI-spread≥15 + 6/7 conditions + 1.5×ATR SL + 3×ATR TP + Opposite Signal Exit + $1000 Hard Stop',
  },
};

// ── Tickmill / MetaApi Adapter ─────────────────────────────────────
const tickmill = {
  connected:   false,
  mode:        METAAPI_TOKEN ? 'metaapi' : 'paper-kraken',
  openOrders:  new Map(),

  async init() {
    if (!METAAPI_TOKEN || !METAAPI_ACCOUNT_ID) {
      console.log('[Algo4] MetaApi not configured — running in paper-Kraken mode');
      return;
    }
    try {
      const status = await this._apiGet(`/users/current/accounts/${METAAPI_ACCOUNT_ID}`);
      this.connected = status && status.state === 'deployed';
      console.log(`[Algo4] MetaApi ${this.connected ? '✓ connected' : '✗ not deployed'}`);
    } catch (err) {
      console.error('[Algo4] MetaApi connection error:', err.message);
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
      console.error('[Algo4] placeOrder error:', err.message);
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
      console.error('[Algo4] closeOrder error:', err.message);
      return { error: err.message };
    }
  },
};

tickmill.init().catch(() => {});

// ── Per-user session management ────────────────────────────────────
const userSessions = new Map();

const CANDLE_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };

function defaultState() {
  return {
    running: false, symbol: 'BTCUSDT', timeframe: '4h',
    strategyId: 'swing-v2-fixed', mode: 'paper',
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

// ── Exit helper (shared by static exits and opposite-signal exit) ─
async function handleExit(sess, position, price, exitReasonStr, indicators, ts) {
  const { state } = sess;
  const { sessionId } = state;
  const userId = sess.userId;
  const { side, entryPrice, size, stopLoss, takeProfit, mae, tickmillOrderId } = position;

  const rawPnl = side === 'long'
    ? (price - entryPrice) * size
    : (entryPrice - price) * size;
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
    price, size, pnl,
    stop_loss: stopLoss, take_profit: takeProfit,
    reason: exitReasonStr,
    balance_after: parseFloat(state.balance.toFixed(4)),
    timestamp: ts,
    mae: parseFloat((mae || 0).toFixed(4)),
    tickmill_order: closeResult.closed ? tickmillOrderId : null,
  };
  stmtInsert.run(trade);
  waExit(side, state.symbol, state.timeframe, pnl, exitReasonStr, state.balance, state.wins, state.totalTrades);
  pushLog(sess, { ts, type: 'EXIT', side, price, pnl,
                  mae: (mae || 0).toFixed(2),
                  reason: [exitReasonStr], indicators });
  broadcast(sess, { type: 'trade', trade, state: publicState(state) });
}

// ── Main swing tick ───────────────────────────────────────────────
async function runTick(sess) {
  const { state } = sess;
  const { symbol, timeframe, sessionId } = state;
  const userId = sess.userId;
  const ts     = new Date().toISOString();
  try {
    state.error = null;
    const candles          = await fetchCandles(symbol, timeframe, 250);
    const latestCandleTime = candles[candles.length - 1].time;
    const price            = candles[candles.length - 1].close;

    // ── Static exit checks (SL / TP / $1000 adverse) ────────────────
    if (state.position) {
      const exitResult = checkExit(state.position, candles);
      state.lastIndicators = exitResult.indicators;

      if (exitResult.exit) {
        // Use level price for SL/TP accuracy
        const reason0 = exitResult.reasons[0] || '';
        let exitPrice = price;
        if (reason0.startsWith('SL hit'))         exitPrice = state.position.stopLoss;
        else if (reason0.startsWith('TP hit'))     exitPrice = state.position.takeProfit;
        else if (reason0.startsWith('$1000'))      exitPrice = state.position.side === 'long'
          ? state.position.entryPrice - 1000
          : state.position.entryPrice + 1000;

        const pos = state.position;
        const rawPnl = pos.side === 'long'
          ? (exitPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - exitPrice) * pos.size;
        const pnl = parseFloat(rawPnl.toFixed(4));

        let closeResult = { paper: true };
        if (pos.tickmillOrderId && !pos.tickmillOrderId.startsWith('paper_')) {
          closeResult = await tickmill.closeOrder(pos.tickmillOrderId);
        }

        state.balance   += pnl;
        state.pnl       += pnl;
        if (pnl > 0) state.wins++;
        state.totalTrades++;
        updateDrawdown(state);
        state.position = null;

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
        waExit(pos.side, symbol, timeframe, pnl, exitResult.reasons[0] || '', state.balance, state.wins, state.totalTrades);
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
        const exitReasonStr = `Opposite signal: ${signal}`;
        await handleExit(sess, state.position, price, exitReasonStr, indicators, ts);
        // Fall through to entry logic so the triggering signal also opens a new position
      } else {
        pushLog(sess, { ts, type: 'TICK', signal: `${signal} (B:${buyScore} S:${sellScore})`, price, indicators, reason });
        broadcast(sess, { type: 'tick', state: publicState(state) });
        return;
      }
    }

    // ── Entry logic ───────────────────────────────────────────────────
    if (!state.position && (signal === 'BUY' || signal === 'SELL')) {
      const { atr } = indicators;
      const side     = signal === 'BUY' ? 'long' : 'short';
      const stopDist = 1.5 * atr;
      const riskAmt  = Math.min(state.balance * 0.015, 150);
      const size     = parseFloat((riskAmt / stopDist).toFixed(8));
      const sl       = side === 'long' ? price - stopDist : price + stopDist;
      const tp       = side === 'long' ? price + 3 * atr  : price - 3 * atr;
      const lots     = parseFloat((riskAmt / (price * 100)).toFixed(2));

      const orderResult = await tickmill.placeOrder(side, symbol, lots, sl, tp, 'CBT Algo4 Fixed SL/TP');

      state.position = {
        side, entryPrice: price, size, stopLoss: sl, takeProfit: tp,
        entryTime: ts, unrealizedPnl: 0, mae: 0,
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
      waEntry(side, symbol, timeframe, price, size, sl, tp, riskAmt, state.balance);
      pushLog(sess, { ts, type: 'ENTRY', side, signal, price, size,
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

function startAlignedTicks(sess, intervalMs) {
  stopTicker(sess);
  const now   = Date.now();
  const delay = (Math.ceil(now / intervalMs) * intervalMs) - now + 2000;
  sess.alignTimeout = setTimeout(() => {
    tick(sess);
    sess.ticker = setInterval(() => tick(sess), intervalMs);
  }, delay);
}

function stopTicker(sess) {
  if (sess.alignTimeout) { clearTimeout(sess.alignTimeout);  sess.alignTimeout = null; }
  if (sess.ticker)       { clearInterval(sess.ticker);       sess.ticker       = null; }
}

// ── Backtest ──────────────────────────────────────────────────────
async function runBacktest(symbol, timeframe, months) {
  const allCandles = await fetchCandlesHistorical(symbol, timeframe, months);
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
    const sig   = generateSignal(seg);

    if (pos) {
      const ex = checkExit(pos, seg);
      if (ex.exit) {
        const reason0 = ex.reasons[0] || '';
        let exitPrice = price;
        if (reason0.startsWith('SL hit'))       exitPrice = pos.stopLoss;
        else if (reason0.startsWith('TP hit'))  exitPrice = pos.takeProfit;
        else if (reason0.startsWith('$1000'))   exitPrice = pos.side === 'long'
          ? pos.entryPrice - 1000 : pos.entryPrice + 1000;

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
          entryTime: new Date(pos.entryTime).toISOString(),
          exitTime:  new Date(allCandles[i].time).toISOString(),
          reason: reason0, mae: +(pos.mae || 0).toFixed(2),
        });
        pos = null;

      } else if ((pos.side === 'long' && sig.signal === 'SELL') ||
                 (pos.side === 'short' && sig.signal === 'BUY')) {
        // Opposite signal exit — use candle close price
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
          entryTime: new Date(pos.entryTime).toISOString(),
          exitTime:  new Date(allCandles[i].time).toISOString(),
          reason: `Opposite signal: ${sig.signal}`, mae: +(pos.mae || 0).toFixed(2),
        });
        pos = null;
        // Fall through to enter opposite direction below

      } else {
        const unreal = pos.side === 'long'
          ? (price - pos.entryPrice) * pos.size
          : (pos.entryPrice - price) * pos.size;
        if (unreal < (pos.mae || 0)) pos.mae = unreal;
      }
    }

    if (!pos && (sig.signal === 'BUY' || sig.signal === 'SELL')) {
      const newSide  = sig.signal === 'BUY' ? 'long' : 'short';
      const { atr }  = sig.indicators;
      const stopDist = 1.5 * atr;
      const riskAmt  = Math.min(balance * 0.015, 150);
      const size     = riskAmt / stopDist;
      pos = {
        side: newSide, entryPrice: price, size,
        stopLoss:   newSide === 'long' ? price - stopDist : price + stopDist,
        takeProfit: newSide === 'long' ? price + 3 * atr  : price - 3 * atr,
        entryTime:  allCandles[i].time,
        mae: 0,
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
      entryTime: new Date(pos.entryTime).toISOString(),
      exitTime: new Date(allCandles[allCandles.length - 1].time).toISOString(),
      reason: 'End of backtest', mae: +(pos.mae || 0).toFixed(2),
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

app.get('/health', (_, res) => res.json({ status: 'ok', strategy: 'swing-v2-fixed' }));
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
    symbol = 'BTCUSDT', timeframe = '4h',
    balance = 10000, interval = 14400,
    strategyId = 'swing-v2-fixed', mode = 'paper',
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
  console.log(`CBT Algo4 (Fixed SL/TP + Opposite Signal Exit) listening on :${PORT} | MetaApi: ${tickmill.mode}`)
);
