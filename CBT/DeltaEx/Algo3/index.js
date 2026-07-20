'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const session  = require('express-session');

const {
  RF_SAMPLING_PERIOD, RF_MULT, MAX_LOSS, SL_ATR_MULT,
  TRAIL_START_PNL, TRAIL_STEP_PNL, MIN_ATR, ATR_LEN,
  WARMUP_BARS,
  generateSignal, initPosition, stepPosition,
} = require('./algo');

const delta = require('./delta');

// ── Config ────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '3011', 10);
const SESSION_SECRET   = process.env.SESSION_SECRET || 'cbt-delta-algo3-dev-secret';
const DELTA_API_KEY    = process.env.DELTA_API_KEY    || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';
const DEFAULT_SYMBOL   = process.env.DEFAULT_SYMBOL   || 'BTCUSD';

const WA_INSTANCE = process.env.WA_INSTANCE || '';
const WA_TOKEN    = process.env.WA_TOKEN    || '';
const WA_GROUP    = process.env.WA_GROUP    || '';

const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(__dirname, 'logs');
[DATA_DIR, LOGS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── WhatsApp notifications (optional) ────────────────────────────
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
  const req = https.request(opts, res => { res.on('data', () => {}); });
  req.on('error', () => {});
  req.write(body); req.end();
}
function waEntry(side, symbol, timeframe, price, size, sl, riskPerUnit, riskAmt, balance) {
  const dir   = side === 'long' ? '🟢' : '🔴';
  const label = side === 'long' ? 'LONG' : 'SHORT';
  const f     = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  sendWhatsApp(
    `${dir} *[Delta Algo3] ENTRY — ${label} ${symbol} ${timeframe}*\n` +
    `Price   : $${f(price)}\n` +
    `Size    : ${f(size, 5)} BTC\n` +
    `SL      : $${f(sl)}  (risk/unit $${f(riskPerUnit)})\n` +
    `Risk    : $${f(riskAmt)}  (fixed $${f(MAX_LOSS)} × sizeFactor)\n` +
    `Balance : $${f(balance)}`
  );
}
function waExit(side, symbol, timeframe, pnl, reason, balance, wins, totalTrades, trailed) {
  const win   = pnl > 0;
  const icon  = win ? '✅' : '❌';
  const label = side === 'long' ? 'LONG' : 'SHORT';
  const wr    = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
  const f     = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pnlStr= `${pnl >= 0 ? '+' : ''}$${f(Math.abs(pnl))}`;
  sendWhatsApp(
    `${icon} *[Delta Algo3] EXIT — ${label} ${symbol} ${timeframe}*\n` +
    `Reason   : ${reason}\n` +
    `PnL      : *${pnlStr}*\n` +
    `Trailing : ${trailed ? 'Yes' : 'No'}\n` +
    `Balance  : $${f(balance)}\n` +
    `Win Rate : ${wr}% (${wins}/${totalTrades})`
  );
}

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
    broker_order  TEXT,
    contracts     INTEGER
  )
`);
['mae REAL DEFAULT 0', 'broker_order TEXT', 'contracts INTEGER'].forEach(col => {
  try { db.exec(`ALTER TABLE trades ADD COLUMN ${col}`); } catch {}
});
const stmtInsert = db.prepare(`
  INSERT INTO trades
    (session_id,user_id,type,side,symbol,timeframe,price,size,pnl,
     stop_loss,take_profit,reason,balance_after,timestamp,mae,broker_order,contracts)
  VALUES
    (@session_id,@user_id,@type,@side,@symbol,@timeframe,@price,@size,@pnl,
     @stop_loss,@take_profit,@reason,@balance_after,@timestamp,@mae,@broker_order,@contracts)
`);

// ── Strategy registry ────────────────────────────────────────────
const STRATEGIES = {
  'rf-kama-v2': {
    name: 'rf-kama-v2: Range Filter + KAMA Cloud Strategy V2 (Delta)',
    description: `Range Filter (${RF_SAMPLING_PERIOD}, ${RF_MULT}×) + KAMA cloud gate + flag-candle triggers. Fixed-$${MAX_LOSS} sizing: SL = entry ± ${SL_ATR_MULT}×ATR; qty (BTC) = ($${MAX_LOSS} / (${SL_ATR_MULT}×ATR)) × sizeFactor. SL hit ≈ $${MAX_LOSS} × sizeFactor loss. Trailing @ +$${TRAIL_START_PNL}×sizeFactor (locks $${TRAIL_START_PNL - TRAIL_STEP_PNL}×sizeFactor), +$${TRAIL_STEP_PNL}×sizeFactor per step. Entries skipped when ATR < ${MIN_ATR}. Broker: Delta Exchange India — BTCUSD perp (1 contract = 0.001 BTC).`,
  },
};

// ── Delta adapter wrapper ────────────────────────────────────────
// Keeps API key/secret at module scope. `getCredentials()` returns the
// pair (falling back to env). Order helpers throw when creds are missing.
function creds() {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) throw new Error('DELTA_API_KEY/DELTA_API_SECRET not set');
  return [DELTA_API_KEY, DELTA_API_SECRET];
}

const brokerStatus = { connected: false, lastCheck: 0, error: null, wallet: null, mode: (DELTA_API_KEY && DELTA_API_SECRET) ? 'live' : 'paper' };
async function refreshBrokerStatus() {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) {
    brokerStatus.connected = false;
    brokerStatus.error = 'DELTA_API_KEY/SECRET not set';
    brokerStatus.wallet = null;
    return brokerStatus;
  }
  try {
    const r = await delta.getWallet(...creds());
    brokerStatus.connected = true;
    brokerStatus.error = null;
    // Delta wallet balances is an array of { asset_symbol, balance, available_balance, ... }
    const rows = (r?.result || []).map(w => ({
      asset:            w.asset_symbol || w.asset?.symbol || null,
      balance:          parseFloat(w.balance || 0),
      availableBalance: parseFloat(w.available_balance || 0),
    }));
    brokerStatus.wallet = rows;
  } catch (e) {
    brokerStatus.connected = false;
    brokerStatus.error = e.message;
    brokerStatus.wallet = null;
  }
  brokerStatus.lastCheck = Date.now();
  return brokerStatus;
}

// ── Session state ─────────────────────────────────────────────────
const userSessions = new Map();
const CANDLE_MS = delta.CANDLE_MS;

function defaultFlagState() {
  return { longFlag: false, longFlagLow: null, shortFlag: false, shortFlagHigh: null };
}
function defaultState() {
  return {
    running: false, symbol: DEFAULT_SYMBOL, timeframe: '1m',
    strategyId: 'rf-kama-v2', mode: 'live',
    balance: 10000, initialBalance: 10000,
    sessionId: null, sessionStart: null,
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: 10000, maxDrawdownDollar: 0, maxDrawdownPct: 0,
    flagState:    defaultFlagState(),
    pendingEntry: null,
    sizeFactor:   1,
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
      trailTicker:    null,
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
    flagState, pendingEntry, sizeFactor,
  } = state;
  return {
    running, symbol, timeframe, strategyId, mode,
    balance, initialBalance, sessionId, sessionStart,
    pnl, totalTrades, wins, error, lastIndicators, lastSignal,
    position:          state.position ? { ...state.position } : null,
    winRate:           totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0',
    pnlPct:            ((pnl / (initialBalance || 10000)) * 100).toFixed(2),
    peakBalance,
    maxDrawdownDollar: parseFloat((maxDrawdownDollar||0).toFixed(2)),
    maxDrawdownPct:    parseFloat((maxDrawdownPct||0).toFixed(2)),
    brokerConnected:   brokerStatus.connected,
    brokerMode:        brokerStatus.mode,
    sizeFactor:        typeof sizeFactor === 'number' ? sizeFactor : 1,
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

// ── Exit helper ──────────────────────────────────────────────────
async function handleExit(sess, position, exitPrice, exitReasonStr, indicators, ts) {
  const { state }     = sess;
  const { sessionId } = state;
  const userId        = sess.userId;
  const {
    side, entryPrice, size, slPrice, mae, brokerOrderId, contracts,
    trailing, trailStop,
  } = position;

  const rawPnl = side === 'long'
    ? (exitPrice - entryPrice) * size
    : (entryPrice - exitPrice) * size;
  const pnl = parseFloat(rawPnl.toFixed(4));

  // Place a real closing market order on Delta if we have creds and a real broker order.
  let closeResult = { paper: true };
  if (DELTA_API_KEY && DELTA_API_SECRET && brokerOrderId && !String(brokerOrderId).startsWith('paper_')) {
    try {
      const r = await delta.closePosition(...creds(), { symbol: state.symbol, side, contracts });
      closeResult = { closed: true, closeOrderId: r?.result?.id || null, raw: r };
    } catch (e) {
      closeResult = { error: e.message };
      pushLog(sess, { ts, type: 'ERROR', message: `Delta close failed: ${e.message}` });
    }
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
    broker_order: closeResult.closed ? brokerOrderId : null,
    contracts:    contracts || null,
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

// ── Main candle-aligned tick ─────────────────────────────────────
async function runTick(sess) {
  const { state } = sess;
  const { symbol, timeframe, sessionId } = state;
  const userId = sess.userId;
  const ts     = new Date().toISOString();

  try {
    state.error = null;
    const candles          = await delta.getRecentCandles(symbol, timeframe, WARMUP_BARS + 220);
    if (candles.length < WARMUP_BARS + 20) {
      throw new Error(`Need ${WARMUP_BARS + 20}+ candles for KAMA warmup, got ${candles.length}`);
    }
    const lastBar          = candles[candles.length - 1];
    const latestCandleTime = lastBar.time;
    const price            = lastBar.close;
    const isNewCandle      = latestCandleTime !== sess.lastCandleTime;

    // ── Fill pending entry at THIS new bar's open ─────────────
    if (isNewCandle && state.pendingEntry && !state.position) {
      const pe       = state.pendingEntry;
      const entryPx  = lastBar.open;
      const stopDist = SL_ATR_MULT * (pe.atr || 0);
      if (stopDist > 0) {
        const slPrice    = pe.side === 'long' ? entryPx - stopDist : entryPx + stopDist;
        const riskAmt    = MAX_LOSS;                              // fixed $150 baseline
        const sizeFactor = state.sizeFactor || 1;
        const rawBtc     = (riskAmt / stopDist) * sizeFactor;      // target BTC amount
        // Delta contract = 0.001 BTC, min 1 contract.
        const contracts  = Math.max(1, Math.round(rawBtc * 1000));
        const qty        = contracts / 1000;                       // actual BTC amount after rounding
        const pos        = initPosition(pe.side, entryPx, slPrice, qty, lastBar.time, pe.atr, sizeFactor);
        pos.contracts    = contracts;

        // Place Delta order (only when creds present)
        let orderResult;
        if (DELTA_API_KEY && DELTA_API_SECRET) {
          try {
            const r = await delta.placeMarketOrder(...creds(), {
              symbol, side: pe.side, contracts, clientOrderId: `algo3_${Date.now()}`,
            });
            orderResult = { orderId: r?.result?.id ? String(r.result.id) : null, live: true, raw: r };
          } catch (e) {
            orderResult = { paper: true, orderId: `paper_${Date.now()}`, error: e.message };
            pushLog(sess, { ts, type: 'ERROR', message: `Delta placeOrder failed: ${e.message}` });
          }
        } else {
          orderResult = { paper: true, orderId: `paper_${Date.now()}` };
        }
        pos.brokerOrderId = orderResult.orderId;
        state.position    = pos;

        const trade = {
          session_id: sessionId, user_id: userId,
          type: 'entry', side: pe.side, symbol, timeframe,
          price: entryPx, size: pos.size, pnl: 0,
          stop_loss: pos.slPrice, take_profit: null,
          reason: pe.reason || `RF+KAMA trigger — flag ref ${pe.side === 'long' ? 'low' : 'high'} ${pe.slPrice.toFixed(2)} · risk $${riskAmt.toFixed(2)}`,
          balance_after: parseFloat(state.balance.toFixed(4)),
          timestamp: ts, mae: 0,
          broker_order: orderResult.orderId,
          contracts,
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
            `Size ${qty.toFixed(6)} BTC = ${contracts} Delta contracts (contract=0.001 BTC) · sizeFactor ${sizeFactor}`,
            `SL $${pos.slPrice.toFixed(2)} = entry ± $${stopDist.toFixed(2)} · max loss on SL hit ≈ $${(riskAmt * sizeFactor).toFixed(2)}`,
            `Flag ${pe.side === 'long' ? 'low' : 'high'} ref: $${pe.slPrice.toFixed(2)} (trigger only, not SL)`,
            `Trail starts @ +$${pos.trailStart.toFixed(2)} PnL → locks $${(pos.trailStart - pos.trailStep).toFixed(2)}, then +$${pos.trailStep.toFixed(2)}/step (1s poll)`,
          ],
          indicators: state.lastIndicators,
          broker: orderResult,
        });
        broadcast(sess, { type: 'trade', trade, state: publicState(state) });
      } else {
        pushLog(sess, { ts, type: 'TICK', signal: 'ENTRY-SKIP', price: entryPx,
          reason: [`Pending ${pe.side} skipped — ATR ${(pe.atr||0).toFixed(2)} must be > 0`],
          indicators: state.lastIndicators });
      }
      state.pendingEntry = null;
    }

    // ── Step position with the new bar's OHLC ─────────────────
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

    // ── Generate signal on new candle close ───────────────────
    if (isNewCandle) {
      sess.lastCandleTime = latestCandleTime;
      const posSide = state.position ? state.position.side : null;
      const sig = generateSignal(candles, state.flagState, posSide);
      const ivMs = CANDLE_MS[timeframe] || 60000;
      sig.indicators.candleOpenTime  = sig.indicators.candleTime;
      sig.indicators.candleCloseTime = sig.indicators.candleTime + ivMs;
      state.flagState      = sig.flagState;
      state.lastIndicators = sig.indicators;
      state.lastSignal     = { signal: sig.signal, longFlag: sig.flagState.longFlag, shortFlag: sig.flagState.shortFlag };

      if (state.position && sig.entryHint && sig.entryHint.side !== state.position.side) {
        await handleExit(
          sess, state.position, lastBar.close,
          `Opposite ${sig.entryHint.side.toUpperCase()} trigger — reversing`,
          sig.indicators, ts
        );
        state.pendingEntry = { ...sig.entryHint, reason: sig.reason.join(' | ') + ' | (reversed)' };
        pushLog(sess, { ts, type: 'TICK', signal: `REVERSE-${sig.signal}`, price, indicators: sig.indicators, reason: sig.reason });
      } else if (!state.position && sig.entryHint) {
        state.pendingEntry = { ...sig.entryHint, reason: sig.reason.join(' | ') };
        pushLog(sess, { ts, type: 'TICK', signal: `TRIGGER-${sig.signal}`, price, indicators: sig.indicators, reason: sig.reason });
      } else if (!(state.position && state.position.trailing)) {
        pushLog(sess, { ts, type: 'TICK', signal: sig.signal, price, indicators: sig.indicators, reason: sig.reason });
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

// 1s trail poll — uses ticker (mark price) to check SL/trail intra-bar.
async function trailTick(sess) {
  const { state } = sess;
  if (!state.running || !state.position) {
    stopTrailTicker(sess);
    return;
  }
  if (sess.tickBusy) return;
  sess.tickBusy = true;
  try {
    const t = await delta.getTicker(state.symbol);
    const price = parseFloat(t?.mark_price || t?.close || 0);
    if (!price || !isFinite(price)) return;
    const wasTrailing   = state.position.trailing;
    const prevTrailStop = state.position.trailStop;
    const syntheticBar  = { high: price, low: price, close: price };
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
async function runBacktest(symbol, timeframe, months, sizeFactor = 1) {
  // Chunk-fetch enough historical bars to cover `months` + WARMUP_BARS.
  const ivMs  = CANDLE_MS[timeframe] || 60000;
  const ivSec = ivMs / 1000;
  const totalBarsWanted = Math.ceil(months * 30.44 * 24 * (3600 * 1000 / ivMs)) + WARMUP_BARS;
  const allCandles = await delta.getRecentCandles(symbol, timeframe, totalBarsWanted);
  if (allCandles.length < WARMUP_BARS + 20) {
    throw new Error(`Need ${WARMUP_BARS + 20}+ candles for KAMA warmup. Got ${allCandles.length} — try a shorter period or 1m timeframe.`);
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
    const seg = allCandles.slice(0, i + 1);

    if (pendingEntry && !pos) {
      const entryPx  = bar.open;
      const stopDist = SL_ATR_MULT * (pendingEntry.atr || 0);
      if (stopDist > 0) {
        const slPrice = pendingEntry.side === 'long' ? entryPx - stopDist : entryPx + stopDist;
        const qty     = (MAX_LOSS / stopDist) * sizeFactor;
        pos = initPosition(pendingEntry.side, entryPx, slPrice, qty, bar.time, pendingEntry.atr, sizeFactor);
        pos.entryIndex = i;
      }
      pendingEntry = null;
    }

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
          side: pos.side,
          entryPrice: +pos.entryPrice.toFixed(4),
          exitPrice:  +step.exitPrice.toFixed(4),
          pnl:        +pnl.toFixed(2),
          balance:    +balance.toFixed(2),
          entryTime:  new Date(pos.entryTime).toISOString(),
          exitTime:   new Date(bar.time).toISOString(),
          reason:     step.reason,
          mae:        +(pos.mae || 0).toFixed(2),
          trailed:    pos.trailing || false,
          slPrice:    +pos.slPrice.toFixed(4),
          trailLockProfit: +(step.trailLockProfit || 0).toFixed(2),
          riskPerUnit:+pos.riskPerUnit.toFixed(4),
        });
        pos = null;
      }
    }

    const sig = generateSignal(seg, flagState, pos ? pos.side : null);
    flagState = sig.flagState;

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
        side: pos.side,
        entryPrice: +pos.entryPrice.toFixed(4),
        exitPrice:  +exitPx.toFixed(4),
        pnl:        +pnl.toFixed(2),
        balance:    +balance.toFixed(2),
        entryTime:  new Date(pos.entryTime).toISOString(),
        exitTime:   new Date(bar.time).toISOString(),
        reason:     `Opposite ${sig.entryHint.side.toUpperCase()} trigger — reversing`,
        mae:        +(pos.mae || 0).toFixed(2),
        trailed:    pos.trailing || false,
        slPrice:    +pos.slPrice.toFixed(4),
        trailLockProfit: +(pos.trailLockProfit || 0).toFixed(2),
        riskPerUnit:+pos.riskPerUnit.toFixed(4),
      });
      pos = null;
      pendingEntry = { ...sig.entryHint, reason: sig.reason.join(' | ') + ' | (reversed)' };
    } else if (!pos && sig.entryHint) {
      pendingEntry = { ...sig.entryHint, reason: sig.reason.join(' | ') };
    }
  }

  if (pos) {
    const lp  = allCandles[allCandles.length - 1].close;
    const pnl = pos.side === 'long'
      ? (lp - pos.entryPrice) * pos.size
      : (pos.entryPrice - lp) * pos.size;
    balance += pnl;
    if (pnl > 0) wins++;
    trades.push({
      side: pos.side,
      entryPrice: +pos.entryPrice.toFixed(4),
      exitPrice:  +lp.toFixed(4),
      pnl:        +pnl.toFixed(2),
      balance:    +balance.toFixed(2),
      entryTime:  new Date(pos.entryTime).toISOString(),
      exitTime:   new Date(allCandles[allCandles.length - 1].time).toISOString(),
      reason:     'End of backtest',
      mae:        +(pos.mae || 0).toFixed(2),
      trailed:    pos.trailing || false,
      slPrice:    +pos.slPrice.toFixed(4),
      trailLockProfit: +(pos.trailLockProfit || 0).toFixed(2),
      riskPerUnit:+pos.riskPerUnit.toFixed(4),
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

// No Google auth on Delta service — single guest user. Keeps parity with the API surface.
function requireAuth(req, res, next) { req.userId = 'guest'; return next(); }

app.get('/health', (_, res) => res.json({ status: 'ok', strategy: 'rf-kama-v2', broker: 'delta-india' }));
app.get('/api/config', (req, res) => res.json({ authRequired: false, googleClientId: '', user: null }));
app.get('/api/strategies', (_, res) => res.json(Object.entries(STRATEGIES).map(([id, s]) => ({ id, ...s }))));

// Broker status / connection
app.get('/api/broker', async (_req, res) => {
  await refreshBrokerStatus();
  res.json({
    connected:  brokerStatus.connected,
    mode:       brokerStatus.mode,
    error:      brokerStatus.error,
    wallet:     brokerStatus.wallet,
    apiKeySet:  !!DELTA_API_KEY,
    secretSet:  !!DELTA_API_SECRET,
    host:       delta.HOST,
    testnet:    delta.IS_TESTNET,
    env:        delta.IS_TESTNET ? 'testnet (demo)' : 'production (real)',
    product:    delta.PRODUCT[DEFAULT_SYMBOL] || null,
    lastCheck:  brokerStatus.lastCheck,
  });
});

// Public: latest ticker
app.get('/api/delta/ticker', async (req, res) => {
  const sym = req.query.symbol || DEFAULT_SYMBOL;
  try { res.json({ ok: true, ticker: await delta.getTicker(sym) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// Public: last N recent candles (diagnostic — same shape as MetaApi diag-symbol)
app.get('/api/delta/candles', async (req, res) => {
  const sym = req.query.symbol   || DEFAULT_SYMBOL;
  const tf  = req.query.timeframe|| '1m';
  const n   = Math.max(1, Math.min(2000, parseInt(req.query.n || '20', 10)));
  const full= req.query.debug === '1' || req.query.full === '1';
  try {
    const rows = await delta.getRecentCandles(sym, tf, n);
    res.json({
      ok: true, symbol: sym, timeframe: tf, count: rows.length,
      first: rows[0], last: rows[rows.length - 1],
      ...(full ? { candles: rows } : {}),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Auth: open positions (Delta)
app.get('/api/delta/positions', async (_req, res) => {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) return res.json({ ok: false, error: 'creds missing' });
  try { res.json({ ok: true, positions: await delta.getPositions(...creds()) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// One-shot test: place a 1-contract market order and immediately close it.
// Used by Playwright + smoke tests. Guarded — only 1 contract, always reduce-only close.
app.post('/api/delta/test-order', async (req, res) => {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) return res.json({ ok: false, error: 'creds missing' });
  const symbol = (req.body && req.body.symbol) || DEFAULT_SYMBOL;
  const side   = ((req.body && req.body.side) || 'long').toLowerCase();
  try {
    const openR = await delta.placeMarketOrder(...creds(), { symbol, side, contracts: 1, clientOrderId: `test_${Date.now()}` });
    // Delta may take a moment to reflect the fill; small delay then close.
    await new Promise(r => setTimeout(r, 500));
    const closeR = await delta.closePosition(...creds(), { symbol, side, contracts: 1 });
    res.json({ ok: true, open: openR?.result || openR, close: closeR?.result || closeR });
  } catch (e) {
    res.json({ ok: false, error: e.message, status: e.status, body: e.body });
  }
});

// State + logs + trades
app.get('/api/state',  requireAuth, (req, res) => res.json(publicState(getSession(req.userId).state)));
app.get('/api/logs',   requireAuth, (req, res) => res.json(getSession(req.userId).logs));
app.get('/api/trades', requireAuth, (req, res) => {
  const sess = getSession(req.userId);
  const { session } = req.query;
  let rows;
  if (session) {
    rows = db.prepare('SELECT * FROM trades WHERE session_id=? AND user_id=? ORDER BY id DESC').all(session, req.userId);
  } else {
    rows = sess.state.sessionId
      ? db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(sess.state.sessionId)
      : [];
  }
  res.json(rows);
});

// Start / Stop / Reset / Backtest
app.post('/api/start', requireAuth, async (req, res) => {
  const sess = getSession(req.userId);
  if (sess.state.running) return res.json({ ok: false, msg: 'Already running' });
  const {
    symbol = DEFAULT_SYMBOL, timeframe = '1m',
    balance = 10000,
    strategyId = 'rf-kama-v2', mode = 'live',
    sizeFactor,
  } = req.body || {};
  const ms  = CANDLE_MS[timeframe] || 60000;
  const bal = parseFloat(balance);
  const sf  = Math.max(0.01, Math.min(10, parseFloat(sizeFactor) || 1));
  await refreshBrokerStatus();

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
    sizeFactor:   sf,
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
  const { symbol = DEFAULT_SYMBOL, timeframe = '1m', months = 1, sizeFactor } = req.body || {};
  const m  = Math.max(0.1, Math.min(3, parseFloat(months) || 1));
  const sf = Math.max(0.01, Math.min(10, parseFloat(sizeFactor) || 1));
  try {
    const result = await runBacktest(symbol, timeframe, m, sf);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Server-sent events for live UI updates
app.get('/events', (req, res) => {
  const sess = getSession('guest');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected', state: publicState(sess.state), logs: sess.logs })}\n\n`);
  sess.sseClients.add(res);
  req.on('close', () => sess.sseClients.delete(res));
});

// Warm the broker status once on boot so /api/broker isn't cold on first hit.
if (DELTA_API_KEY && DELTA_API_SECRET) refreshBrokerStatus().catch(() => {});

app.listen(PORT, () =>
  console.log(`CBT DeltaEx Algo3 (RF+KAMA v2) listening on :${PORT} | Delta: ${brokerStatus.mode} | key ${DELTA_API_KEY ? 'set' : 'missing'}`)
);
