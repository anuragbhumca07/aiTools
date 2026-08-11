'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const session  = require('express-session');
const { OAuth2Client } = require('google-auth-library');
const {
  EMA_LEN, MAX_LOSS, MAX_QTY, SL_ATR_MULT, CONSEC_BARS_MIN,
  WARMUP_BARS,
  generateSignal, initPosition, stepPosition,
  fetchCandles, fetchCandlesHistorical, fetchCurrentPrice,
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

function waEntry(side, symbol, timeframe, price, size, sl, riskAmt, balance) {
  const dir   = side === 'long' ? '🟢' : '🔴';
  const label = side === 'long' ? 'LONG' : 'SHORT';
  const sym   = symbol.replace('USDT', '/USDT');
  const f     = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  sendWhatsApp(
    `${dir} *[Algo4 10EMA+RF+KAMA] ENTRY — ${label} ${sym} ${timeframe}*\n` +
    `Price : $${f(price)}\n` +
    `Size  : ${f(size, 5)} ${symbol.replace('USDT', '')}\n` +
    `SL    : $${f(sl)}  (risk $${f(riskAmt)})\n` +
    `Trail : BE @ +$200 → $100 locked @ +$250 → $200 locked @ +$300 → +$100/+$100 above\n` +
    `Balance: $${f(balance)}`
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
    `${icon} *[Algo4 10EMA+RF+KAMA] EXIT — ${label} ${sym} ${timeframe}*\n` +
    `Reason  : ${reason}\n` +
    `PnL     : *${pnlStr}*\n` +
    `Trailing: ${trailed ? 'Yes' : 'No'}\n` +
    `Balance : $${f(balance)}\n` +
    `Win Rate: ${wr}% (${wins}/${totalTrades})`
  );
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
  '10ema-crossover-v1': {
    name: '10ema-crossover-v1: 10 EMA + RF + KAMA Zone Crossover',
    description: `EMA(${EMA_LEN}) crossover on 15m with RF+KAMA zone filter. BUY: ≥${CONSEC_BARS_MIN} bars below EMA → strong green candle closes above EMA AND in greenZone. SELL: opposite AND in sellZone. SL = ${SL_ATR_MULT}×ATR14. qty = min(${MAX_QTY}, $${MAX_LOSS}/(${SL_ATR_MULT}×ATR)). Trailing: BE @ +$200 → $100 locked @ +$250 → $200 locked @ +$300 → +$100/+$100. 1s poll. No fixed TP.`,
  },
};

// ── Tickmill / MetaApi Adapter ────────────────────────────────────
const tickmill = {
  connected:  false,
  mode:       METAAPI_TOKEN ? 'metaapi' : 'paper-kraken',
  openOrders: new Map(),

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
        path, method: 'GET',
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
        path, method: 'POST',
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

// ── Per-user session management ───────────────────────────────────
const userSessions = new Map();
const CANDLE_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };

function defaultState() {
  return {
    running: false, symbol: 'BTCUSDT', timeframe: '15m',
    strategyId: '10ema-crossover-v1', mode: 'paper',
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
      trailTicker:    null,
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

// ── Exit helper ───────────────────────────────────────────────────
async function handleExit(sess, position, exitPrice, exitReasonStr, indicators, ts) {
  const { state } = sess;
  const { sessionId } = state;
  const userId = sess.userId;
  const { side, entryPrice, size, slPrice, mae, tickmillOrderId, trailing, trailStop } = position;

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
    stop_loss: trailing ? trailStop : slPrice, take_profit: null,
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
    const candles          = await fetchCandles(symbol, timeframe, WARMUP_BARS + 50);
    if (candles.length < WARMUP_BARS + 10) {
      throw new Error(`Need ${WARMUP_BARS + 10}+ candles for warmup, got ${candles.length}`);
    }
    const lastBar          = candles[candles.length - 1];
    const latestCandleTime = lastBar.time;
    const price            = lastBar.close;

    const isNewCandle = latestCandleTime !== sess.lastCandleTime;

    // ── Step position on new closed candle ──────────────────────
    if (isNewCandle && state.position) {
      const wasTrailing   = state.position.trailing;
      const prevTrailStop = state.position.trailStop;
      const step = stepPosition(state.position, lastBar);
      state.position.trailing        = step.trailing;
      state.position.trailStop       = step.trailStop;
      state.position.trailLockProfit = step.trailLockProfit;
      state.position.stopLoss        = step.trailing ? step.trailStop : state.position.slPrice;
      if (step.unrealPnl != null) state.position.unrealizedPnl = parseFloat(step.unrealPnl.toFixed(4));
      if (step.worstPnl  != null && step.worstPnl < (state.position.mae || 0)) state.position.mae = step.worstPnl;

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

    // ── Generate signal on new candle close ───────────────────
    if (isNewCandle) {
      sess.lastCandleTime = latestCandleTime;
      const posSide = state.position ? state.position.side : null;
      const sig     = generateSignal(candles, posSide);

      const ivMs = CANDLE_MS[timeframe] || 60000;
      sig.indicators.candleOpenTime  = sig.indicators.candleTime;
      sig.indicators.candleCloseTime = sig.indicators.candleTime + ivMs;
      state.lastIndicators = sig.indicators;
      state.lastSignal     = { signal: sig.signal };

      // Opposite-signal exit
      if (state.position && sig.entryHint && sig.entryHint.side !== state.position.side) {
        await handleExit(
          sess, state.position, lastBar.close,
          `Opposite ${sig.entryHint.side.toUpperCase()} signal — reversing`,
          sig.indicators, ts
        );
      }

      // Entry
      if (!state.position && sig.signal !== 'HOLD' && sig.entryHint) {
        const { side: entrySide, slPrice: slRef, atr } = sig.entryHint;
        const atrDist  = SL_ATR_MULT * (atr || 0);
        if (atrDist > 0) {
          const qty      = parseFloat(Math.min(MAX_QTY, MAX_LOSS / atrDist).toFixed(8));
          const stopDist = MAX_LOSS / qty;
          const slPrice  = entrySide === 'long' ? price - stopDist : price + stopDist;
          const riskAmt  = MAX_LOSS;
          const pos      = initPosition(entrySide, price, slPrice, qty, lastBar.time, atr);

          const lots = parseFloat((riskAmt / (price * 100)).toFixed(2));
          const orderResult = await tickmill.placeOrder(entrySide, symbol, lots, pos.slPrice, null, 'CBT Algo4 10EMA+RF+KAMA');
          pos.tickmillOrderId = orderResult.orderId;
          state.position = pos;

          const trade = {
            session_id: sessionId, user_id: userId,
            type: 'entry', side: entrySide, symbol, timeframe,
            price, size: pos.size, pnl: 0,
            stop_loss: pos.slPrice, take_profit: null,
            reason: sig.reason.join(' | '),
            balance_after: parseFloat(state.balance.toFixed(4)),
            timestamp: ts, mae: 0,
            tickmill_order: orderResult.orderId,
          };
          stmtInsert.run(trade);
          waEntry(entrySide, symbol, timeframe, price, pos.size, pos.slPrice, riskAmt, state.balance);
          pushLog(sess, {
            ts, type: 'ENTRY', side: entrySide, signal: sig.signal,
            price, size: pos.size,
            stopLoss: pos.slPrice, takeProfit: null,
            balance: state.balance.toFixed(4),
            reason: [
              `Entry @ close ${price.toFixed(2)} [greenZone/sellZone confirmed]`,
              `Risk $${riskAmt.toFixed(2)} · qty = min(${MAX_QTY}, $${MAX_LOSS}/(${SL_ATR_MULT}×ATR ${atrDist.toFixed(2)})) → ${qty}`,
              `Initial SL $${pos.slPrice.toFixed(2)} = entry ± $${stopDist.toFixed(2)} (fixed $${MAX_LOSS} loss on hit) · swing ref $${slRef.toFixed(2)}`,
              `Trail: BE @ +$200 → $100 locked @ +$250 → $200 locked @ +$300 → +$100/+$100 above`,
              ...sig.reason,
            ],
            indicators: state.lastIndicators,
            tickmill: orderResult,
          });
          broadcast(sess, { type: 'trade', trade, state: publicState(state) });
        }
      } else if (!(state.position && state.position.trailing)) {
        pushLog(sess, {
          ts, type: 'TICK', signal: sig.signal, price,
          indicators: sig.indicators, reason: sig.reason,
        });
      }
    }

    ensureTrailTicker(sess);
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

function startAlignedTicks(sess, intervalMs) {
  stopTicker(sess);
  sess.tickIntervalMs = intervalMs;
  scheduleNextAlignedTick(sess);
}

function scheduleNextAlignedTick(sess) {
  const intervalMs = sess.tickIntervalMs;
  if (!intervalMs || !sess.state.running) return;
  const now          = Date.now();
  const nextBoundary = Math.ceil(now / intervalMs) * intervalMs;
  let fireAt         = nextBoundary + 1000;
  if (fireAt - now < 50) fireAt += intervalMs;
  const delay = fireAt - now;
  sess.alignTimeout = setTimeout(async () => {
    sess.alignTimeout = null;
    try { await tick(sess); }
    finally { scheduleNextAlignedTick(sess); }
  }, delay);
}

function stopTicker(sess) {
  if (sess.alignTimeout) { clearTimeout(sess.alignTimeout);  sess.alignTimeout = null; }
  if (sess.ticker)       { clearInterval(sess.ticker);       sess.ticker       = null; }
  sess.tickIntervalMs = null;
  stopTrailTicker(sess);
}

// ── 1s trail poll — activates trail and catches SL hits between candle closes ──
async function trailTick(sess) {
  const { state } = sess;
  if (!state.running || !state.position) { stopTrailTicker(sess); return; }
  if (sess.tickBusy) return;
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
    if (step.unrealPnl != null) state.position.unrealizedPnl = parseFloat(step.unrealPnl.toFixed(4));
    if (step.worstPnl  != null && step.worstPnl < (state.position.mae || 0)) state.position.mae = step.worstPnl;

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
    throw new Error(`Need ${WARMUP_BARS + 20}+ candles for warmup. Got ${allCandles.length} — try longer duration.`);
  }

  let balance = 10000;
  const initialBalance = 10000;
  let peakBal = balance, maxDD = 0;
  const trades = [];
  let wins = 0;
  let pos = null;

  for (let i = WARMUP_BARS; i < allCandles.length; i++) {
    const bar = allCandles[i];
    const seg = allCandles.slice(0, i + 1);

    // 1. Step existing position with milestone trailing
    if (pos) {
      const step = stepPosition(pos, bar);
      pos.trailing        = step.trailing;
      pos.trailStop       = step.trailStop;
      pos.trailLockProfit = step.trailLockProfit;
      if (step.worstPnl != null && step.worstPnl < (pos.mae || 0)) pos.mae = step.worstPnl;

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
          slPrice:         +pos.slPrice.toFixed(4),
          trailLockProfit: +(step.trailLockProfit || 0).toFixed(2),
          riskPerUnit:     +pos.riskPerUnit.toFixed(4),
          mae:             +(pos.mae || 0).toFixed(2),
          trailed:         pos.trailing || false,
        });
        pos = null;
        continue; // don't enter on the same bar we exited
      }
    }

    // 2. Generate signal — enter if no position
    if (!pos) {
      const sig = generateSignal(seg, null);
      if (sig.signal === 'BUY' || sig.signal === 'SELL') {
        const { slPrice: slRef, atr } = sig.entryHint;
        const atrDist  = SL_ATR_MULT * (atr || 0);
        if (atrDist > 0) {
          const side     = sig.signal === 'BUY' ? 'long' : 'short';
          const qty      = Math.min(MAX_QTY, MAX_LOSS / atrDist);
          const stopDist = MAX_LOSS / qty;
          const slPrice  = side === 'long' ? bar.close - stopDist : bar.close + stopDist;
          pos = initPosition(side, bar.close, slPrice, qty, bar.time, atr);
        }
      }
    }
  }

  // Close open position at end of data
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
      slPrice:         +pos.slPrice.toFixed(4),
      trailLockProfit: +(pos.trailLockProfit || 0).toFixed(2),
      riskPerUnit:     +pos.riskPerUnit.toFixed(4),
      mae:             +(pos.mae || 0).toFixed(2),
      trailed:         pos.trailing || false,
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

// ── Express app ───────────────────────────────────────────────────
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

app.get('/health', (_, res) => res.json({ status: 'ok', strategy: '10ema-crossover-v1' }));
app.get('/api/strategies', (_, res) =>
  res.json(Object.entries(STRATEGIES).map(([id, s]) => ({ id, ...s })))
);
app.get('/api/tickmill', (_, res) => res.json({
  connected:         tickmill.connected,
  mode:              tickmill.mode,
  accountNumber:     TICKMILL_DEMO.accountNumber,
  accountType:       TICKMILL_DEMO.accountType,
  currency:          TICKMILL_DEMO.currency,
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
    symbol = 'BTCUSDT', timeframe = '15m',
    balance = 10000,
    strategyId = '10ema-crossover-v1', mode = 'paper',
  } = req.body || {};
  const ms  = CANDLE_MS[timeframe] || 900000;
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
  const { symbol = 'BTCUSDT', timeframe = '15m', months = 3 } = req.body || {};
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
  console.log(`CBT Algo4 (10 EMA Crossover — 15m, 1% risk, 2:1 R:R) listening on :${PORT} | MetaApi: ${tickmill.mode}`)
);
