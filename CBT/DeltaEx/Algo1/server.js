'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const session  = require('express-session');

const { computeIndicators, generateSignal, checkExit, computeTrailUpdate } = require('./algo');
const delta = require('./delta');

// ── Config ────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '3012', 10);
const SESSION_SECRET   = process.env.SESSION_SECRET || 'cbt-deltaex-algo1-dev-secret';
const DELTA_API_KEY    = process.env.DELTA_API_KEY    || '';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || '';
const DEFAULT_SYMBOL   = process.env.DEFAULT_SYMBOL   || 'XAUUSD';

const WA_INSTANCE = process.env.WA_INSTANCE || '';
const WA_TOKEN    = process.env.WA_TOKEN    || '';
const WA_GROUP    = process.env.WA_GROUP    || '';

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
  const req = https.request(opts, res => { res.on('data', () => {}); });
  req.on('error', () => {});
  req.write(body); req.end();
}

function waEntry(side, symbol, timeframe, price, size, sl, tp, riskAmt, balance, isLive) {
  const dir   = side === 'long' ? '🟢' : '🔴';
  const label = side === 'long' ? 'LONG' : 'SHORT';
  const f     = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  sendWhatsApp(
    `${dir} *[DeltaEx Algo1] ENTRY — ${label} ${symbol} ${timeframe}*\n` +
    `Price  : ${f(price)}\n` +
    `Size   : ${f(size, 6)} units\n` +
    `SL     : ${f(sl)}  (1.5×ATR → BE@$200, lock$100@$250, lock$200@$300, +$100/step)\n` +
    `Init TP: ${f(tp)}  (3×ATR — trailing SL takes over)\n` +
    `Risk   : $${f(riskAmt)}\n` +
    `Balance: $${f(balance)}\n` +
    `Mode   : ${isLive ? 'LIVE (Delta)' : 'PAPER'}`
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
    `${icon} *[DeltaEx Algo1] EXIT — ${label} ${symbol} ${timeframe}*\n` +
    `Reason   : ${reason}\n` +
    `PnL      : *${pnlStr}*\n` +
    `Trailing : ${trailed ? `Yes (locked $${lockProfit})` : 'No'}\n` +
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

// ── Strategy registry ─────────────────────────────────────────────
const STRATEGIES = {
  'swing-v3-delta': {
    name: 'swing-v3-delta: EMA Ribbon Swing V3 (Delta Exchange + Commodities)',
    description: 'EMA21/55/200 + ADX(25) + DI-spread≥15 + 6/7 conditions + 1.5×ATR SL + Trail: BE@$200 → lock$100@$250 → lock$200@$300 → $100/step + Opposite Signal Exit + $1000 Hard Stop. Live trading: BTCUSD/ETHUSD on Delta India. Commodities (Gold/Silver/Oil/Gas): paper-only via Yahoo Finance.',
  },
};

// ── Delta broker status ───────────────────────────────────────────
const brokerStatus = {
  connected: false, error: null, wallet: null, lastCheck: 0,
  mode: (DELTA_API_KEY && DELTA_API_SECRET) ? 'live' : 'paper',
};

function creds() {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) throw new Error('DELTA_API_KEY/DELTA_API_SECRET not set');
  return [DELTA_API_KEY, DELTA_API_SECRET];
}

function isLiveSymbol(symbol) {
  return delta.DELTA_LIVE_SYMBOLS.has(symbol) && !!(DELTA_API_KEY && DELTA_API_SECRET);
}

async function refreshBrokerStatus() {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) {
    brokerStatus.connected = false;
    brokerStatus.error     = 'DELTA_API_KEY/SECRET not set — paper mode';
    brokerStatus.wallet    = null;
    return brokerStatus;
  }
  try {
    const r = await delta.getWallet(...creds());
    brokerStatus.connected = true;
    brokerStatus.error     = null;
    brokerStatus.wallet    = (r?.result || []).map(w => ({
      asset:            w.asset_symbol || w.asset?.symbol || null,
      balance:          parseFloat(w.balance || 0),
      availableBalance: parseFloat(w.available_balance || 0),
    }));
  } catch (e) {
    brokerStatus.connected = false;
    brokerStatus.error     = e.message;
    brokerStatus.wallet    = null;
  }
  brokerStatus.lastCheck = Date.now();
  return brokerStatus;
}

// ── Per-user session management ───────────────────────────────────
const userSessions = new Map();
const CANDLE_MS    = delta.CANDLE_MS;

function defaultState() {
  return {
    running: false, symbol: DEFAULT_SYMBOL, timeframe: '1m',
    strategyId: 'swing-v3-delta', mode: 'paper',
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
    maxDrawdownDollar: parseFloat((maxDrawdownDollar || 0).toFixed(2)),
    maxDrawdownPct:    parseFloat((maxDrawdownPct    || 0).toFixed(2)),
    brokerConnected:   brokerStatus.connected,
    brokerMode:        brokerStatus.mode,
    isLiveSymbol:      delta.DELTA_LIVE_SYMBOLS.has(symbol),
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
    side, entryPrice, size, stopLoss, takeProfit,
    mae, brokerOrderId, contracts, trailing, trailLockProfit,
  } = position;

  let closeResult = { paper: true };
  let fillPrice   = exitPrice; // signal/SL-TP-trigger price — fallback for paper/failed-live trades
  if (isLiveSymbol(state.symbol) && brokerOrderId && !String(brokerOrderId).startsWith('paper_')) {
    try {
      const r = await delta.closePosition(...creds(), { symbol: state.symbol, side, contracts: contracts || 1 });
      closeResult = { closed: true, closeOrderId: r?.result?.id || null };
      const avgFill = parseFloat(r?.result?.average_fill_price);
      if (Number.isFinite(avgFill) && avgFill > 0) fillPrice = avgFill;
    } catch (e) {
      closeResult = { error: e.message };
      pushLog(sess, { ts, type: 'ERROR', message: `Delta close failed: ${e.message}` });
    }
  }

  const rawPnl = side === 'long'
    ? (fillPrice - entryPrice) * size
    : (entryPrice - fillPrice) * size;
  const pnl = parseFloat(rawPnl.toFixed(4));

  state.balance   += pnl;
  state.pnl       += pnl;
  if (pnl > 0) state.wins++;
  state.totalTrades++;
  updateDrawdown(state);
  state.position = null;

  const trade = {
    session_id: sessionId, user_id: userId,
    type: 'exit', side, symbol: state.symbol, timeframe: state.timeframe,
    price: fillPrice, size, pnl,
    stop_loss: stopLoss, take_profit: takeProfit,
    reason: exitReasonStr,
    balance_after: parseFloat(state.balance.toFixed(4)),
    timestamp: ts,
    mae: parseFloat((mae || 0).toFixed(4)),
    broker_order: closeResult.closed ? brokerOrderId : null,
    contracts: contracts || null,
  };
  stmtInsert.run(trade);
  waExit(side, state.symbol, state.timeframe, pnl, exitReasonStr, state.balance, state.wins, state.totalTrades, trailing || false, trailLockProfit || 0);
  pushLog(sess, { ts, type: 'EXIT', side, price: fillPrice, pnl,
                  mae: (mae || 0).toFixed(4), reason: [exitReasonStr], indicators });
  broadcast(sess, { type: 'trade', trade, state: publicState(state) });
}

// ── Fast ticker (10-second trailing poll) ─────────────────────────
function stopFastTicker(sess) {
  if (sess.fastTicker) { clearInterval(sess.fastTicker); sess.fastTicker = null; }
}

function manageFastTicker(sess) {
  const { state } = sess;
  const pos       = state.position;
  const needFast  = state.running && pos &&
    ((pos.unrealizedPnl || 0) > 150 || pos.trailing);
  if (needFast && !sess.fastTicker) {
    sess.fastTicker = setInterval(() => fastTick(sess), 10000);
  } else if (!needFast && sess.fastTicker) {
    stopFastTicker(sess);
  }
}

async function runFastTick(sess) {
  const { state } = sess;
  if (!state.running || !state.position) { stopFastTicker(sess); return; }
  const ts = new Date().toISOString();
  try {
    const price = await delta.getCurrentPriceForSymbol(state.symbol);
    const pos   = state.position;
    const { side, entryPrice, size } = pos;

    const unrealPnl = side === 'long'
      ? (price - entryPrice) * size
      : (entryPrice - price) * size;
    pos.unrealizedPnl = parseFloat(unrealPnl.toFixed(4));
    if (unrealPnl < (pos.mae || 0)) pos.mae = unrealPnl;

    const slHit = side === 'long' ? price <= pos.stopLoss : price >= pos.stopLoss;
    if (slHit) {
      const reason = pos.trailing
        ? `Trailing SL hit: ${pos.stopLoss.toFixed(4)} (locked $${pos.trailLockProfit || 0} profit)`
        : `SL hit (fast tick): ${pos.stopLoss.toFixed(4)}`;
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
      const note = `SL updated: ${oldSl.toFixed(4)} → ${newSl.toFixed(4)} (locks $${lockProfit} profit)`;
      pushLog(sess, { ts, type: 'TICK', signal: 'TRAIL-UPDATE', price,
                      indicators: { ...(state.lastIndicators || {}), price }, reason: [note] });
    } else if (pos.trailing) {
      pushLog(sess, { ts, type: 'TICK', signal: 'TRAIL-WATCH', price,
                      indicators: { ...(state.lastIndicators || {}), price },
                      reason: [`Trailing active — locked $${pos.trailLockProfit || 0}, SL: ${pos.stopLoss.toFixed(4)}, PnL: $${unrealPnl.toFixed(2)}`] });
    }
    broadcast(sess, { type: 'tick', state: publicState(state) });
  } catch (err) {
    console.error('[Algo1 fastTick]', err.message);
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

    // Fetch 251 candles: last is forming. Closed = first 250.
    const allCandles    = await delta.getRecentCandlesForSymbol(symbol, timeframe, 251);
    if (allCandles.length < 210) {
      throw new Error(`Need 210+ closed candles for EMA200. Got ${allCandles.length} — try a longer timeframe.`);
    }
    const closedCandles     = allCandles.slice(0, -1);
    const latestClosedTime  = closedCandles[closedCandles.length - 1].time;
    const price             = closedCandles[closedCandles.length - 1].close;
    const livePrice         = allCandles[allCandles.length - 1].close;

    // ── Static SL / $1000 adverse exit (using closed candle) ─────
    if (state.position) {
      const exitResult = checkExit(state.position, closedCandles);
      state.lastIndicators = exitResult.indicators;

      if (exitResult.exit) {
        const reason0 = exitResult.reasons[0] || '';
        let exitPrice = livePrice;
        if (reason0.startsWith('SL hit'))    exitPrice = state.position.stopLoss;
        else if (reason0.startsWith('$1000')) exitPrice = state.position.side === 'long'
          ? state.position.entryPrice - 1000
          : state.position.entryPrice + 1000;

        const pos    = state.position;
        const rawPnl = pos.side === 'long'
          ? (exitPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - exitPrice) * pos.size;
        const pnl = parseFloat(rawPnl.toFixed(4));

        state.balance   += pnl;
        state.pnl       += pnl;
        if (pnl > 0) state.wins++;
        state.totalTrades++;
        updateDrawdown(state);

        let closeResult = { paper: true };
        if (isLiveSymbol(symbol) && pos.brokerOrderId && !String(pos.brokerOrderId).startsWith('paper_')) {
          try {
            const r = await delta.closePosition(...creds(), { symbol, side: pos.side, contracts: pos.contracts || 1 });
            closeResult = { closed: true };
          } catch (e) {
            pushLog(sess, { ts, type: 'ERROR', message: `Delta close failed: ${e.message}` });
          }
        }

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
          broker_order: closeResult.closed ? pos.brokerOrderId : null,
          contracts: pos.contracts || null,
        };
        stmtInsert.run(trade);
        waExit(pos.side, symbol, timeframe, pnl, exitResult.reasons[0] || '', state.balance, state.wins, state.totalTrades, pos.trailing || false, pos.trailLockProfit || 0);
        pushLog(sess, { ts, type: 'EXIT', side: pos.side, price: exitPrice, pnl,
                        mae: (pos.mae || 0).toFixed(4),
                        reason: exitResult.reasons, indicators: exitResult.indicators });
        broadcast(sess, { type: 'trade', trade, state: publicState(state) });
        return;
      }

      // Update unrealized PnL + advance trailing on candle close
      const { side, entryPrice, size } = state.position;
      const unrealPnl = side === 'long'
        ? (livePrice - entryPrice) * size
        : (entryPrice - livePrice) * size;
      state.position.unrealizedPnl = parseFloat(unrealPnl.toFixed(4));
      if (unrealPnl < (state.position.mae || 0)) state.position.mae = unrealPnl;

      const trailUpdate = computeTrailUpdate(state.position, unrealPnl);
      if (trailUpdate) {
        const { oldSl, newSl, lockProfit } = trailUpdate;
        state.position.stopLoss        = newSl;
        state.position.trailing        = true;
        state.position.trailLockProfit = lockProfit;
        pushLog(sess, {
          ts, type: 'TICK', signal: 'TRAIL-UPDATE', price: livePrice,
          indicators: exitResult ? exitResult.indicators : state.lastIndicators,
          reason: [`SL updated: ${oldSl.toFixed(4)} → ${newSl.toFixed(4)} (locks $${lockProfit} profit)`],
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
        // fall through to enter opposite
      } else {
        pushLog(sess, { ts, type: 'TICK', signal: `${signal} (B:${buyScore} S:${sellScore})`, price, indicators, reason });
        broadcast(sess, { type: 'tick', state: publicState(state) });
        return;
      }
    }

    // ── Entry ─────────────────────────────────────────────────────
    if (!state.position && (signal === 'BUY' || signal === 'SELL')) {
      const { atr } = indicators;
      const side     = signal === 'BUY' ? 'long' : 'short';
      const stopDist = 1.5 * atr;
      const riskAmt  = Math.min(state.balance * 0.015, 150);
      const size     = parseFloat((riskAmt / stopDist).toFixed(8));

      // Live order (only for Delta-supported symbols with creds)
      let orderResult = { paper: true, orderId: `paper_${Date.now()}` };
      let contracts   = null;
      let fillPrice   = price; // signal (closed-candle) price — fallback for paper/failed-live trades
      if (isLiveSymbol(symbol)) {
        contracts = Math.max(1, Math.round(size * 1000)); // 1 contract = 0.001 unit (BTC/XAUT)
        try {
          const r = await delta.placeMarketOrder(...creds(), {
            symbol, side, contracts, clientOrderId: `algo1_${Date.now()}`,
          });
          orderResult = { orderId: r?.result?.id ? String(r.result.id) : null, live: true };
          const avgFill = parseFloat(r?.result?.average_fill_price);
          if (Number.isFinite(avgFill) && avgFill > 0) fillPrice = avgFill;
        } catch (e) {
          orderResult = { paper: true, orderId: `paper_${Date.now()}`, error: e.message };
          pushLog(sess, { ts, type: 'ERROR', message: `Delta placeOrder failed: ${e.message}` });
        }
      }

      // SL/TP computed off the actual fill price so they match what's really open on Delta
      const sl = side === 'long' ? fillPrice - stopDist : fillPrice + stopDist;
      const tp = side === 'long' ? fillPrice + 3 * atr   : fillPrice - 3 * atr;

      state.position = {
        side, entryPrice: fillPrice, size, stopLoss: sl, takeProfit: tp,
        entryTime: ts, unrealizedPnl: 0, mae: 0,
        trailing: false, trailLockProfit: 0,
        brokerOrderId: orderResult.orderId,
        contracts,
      };

      const trade = {
        session_id: sessionId, user_id: userId,
        type: 'entry', side, symbol, timeframe,
        price: fillPrice, size, pnl: 0,
        stop_loss: sl, take_profit: tp,
        reason: reason.join(' | '),
        balance_after: parseFloat(state.balance.toFixed(4)),
        timestamp: ts, mae: 0,
        broker_order: orderResult.orderId,
        contracts,
      };
      stmtInsert.run(trade);
      waEntry(side, symbol, timeframe, fillPrice, size, sl, tp, riskAmt, state.balance, isLiveSymbol(symbol));
      pushLog(sess, { ts, type: 'ENTRY', side, signal, price: fillPrice, size,
                      stopLoss: sl, takeProfit: tp,
                      balance: state.balance.toFixed(4),
                      reason, indicators, broker: orderResult });
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

// ── No-drift self-rescheduling timer ──────────────────────────────
function scheduleNextTick(sess, intervalMs) {
  const now   = Date.now();
  const delay = (intervalMs - (now % intervalMs)) + 1000;
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
  if (sess.alignTimeout) { clearTimeout(sess.alignTimeout);  sess.alignTimeout = null; }
  if (sess.ticker)       { clearTimeout(sess.ticker);        sess.ticker       = null; }
  stopFastTicker(sess);
}

// ── Backtest ──────────────────────────────────────────────────────
async function runBacktest(symbol, timeframe, months) {
  const allCandles = await delta.getHistoricalCandlesForSymbol(symbol, timeframe, months);
  if (allCandles.length < 210) {
    throw new Error(
      `Need 210+ candles for EMA200 warmup. Got ${allCandles.length} candles.\n` +
      (delta.YAHOO_TICKER[symbol]
        ? `Note: ${symbol} uses Yahoo Finance — 1m data limited to 7 days, 5m/15m to 60 days.`
        : 'Try a longer period or shorter timeframe.')
    );
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
      // Advance trailing SL using bar high/low
      const peakPx  = pos.side === 'long' ? canH : canL;
      const peakPnl = pos.side === 'long'
        ? (peakPx - pos.entryPrice) * pos.size
        : (pos.entryPrice - peakPx) * pos.size;
      const tu = computeTrailUpdate(pos, peakPnl);
      if (tu) { pos.stopLoss = tu.newSl; pos.trailing = true; pos.trailLockProfit = tu.lockProfit; }

      const slHit      = pos.side === 'long' ? canL <= pos.stopLoss  : canH >= pos.stopLoss;
      const adverseHit = pos.side === 'long'
        ? canL <= pos.entryPrice - 1000 : canH >= pos.entryPrice + 1000;

      if (slHit || adverseHit) {
        let exitPrice, reason;
        if (adverseHit && (!slHit ||
            (pos.side === 'long' ? pos.entryPrice - 1000 < pos.stopLoss : pos.entryPrice + 1000 > pos.stopLoss))) {
          exitPrice = pos.side === 'long' ? pos.entryPrice - 1000 : pos.entryPrice + 1000;
          reason    = '$1000 adverse stop';
        } else {
          exitPrice = pos.stopLoss;
          reason    = pos.trailing
            ? `Trailing SL hit: ${exitPrice.toFixed(4)} (locked $${pos.trailLockProfit})`
            : `SL hit: ${exitPrice.toFixed(4)}`;
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
      const riskAmt  = Math.min(balance * 0.015, 150);
      const size     = riskAmt / stopDist;
      pos = {
        side: newSide, entryPrice: price, size,
        stopLoss:   newSide === 'long' ? price - stopDist : price + stopDist,
        takeProfit: newSide === 'long' ? price + 3 * atr  : price - 3 * atr,
        entryTime:  allCandles[i].time,
        mae: 0, trailing: false, trailLockProfit: 0,
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
      exitTime:  new Date(allCandles[allCandles.length - 1].time).toISOString(),
      reason: 'End of backtest', mae: +(pos.mae || 0).toFixed(2), trailed: pos.trailing || false,
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
  saveUninitialized: true,
  cookie: { httpOnly: true, secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'web')));

function requireAuth(req, res, next) {
  req.userId = req.session?.id || 'guest';
  return next();
}

app.get('/health', (_, res) => res.json({
  status: 'ok', strategy: 'swing-v3-delta', broker: 'delta-india',
  supportedSymbols: [...delta.DELTA_LIVE_SYMBOLS, ...Object.keys(delta.YAHOO_TICKER)],
}));

app.get('/api/config', (req, res) => res.json({ authRequired: false, user: null }));

app.get('/api/myip', async (_req, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const j = await r.json();
    res.json({ ip: j.ip });
  } catch (e) {
    res.json({ error: e.message });
  }
});
app.get('/api/strategies', (_, res) => res.json(Object.entries(STRATEGIES).map(([id, s]) => ({ id, ...s }))));
app.get('/api/symbols', (_, res) => res.json(Object.entries(delta.SYMBOL_LABEL).map(([symbol, label]) => ({
  symbol, label,
  live: delta.DELTA_LIVE_SYMBOLS.has(symbol),
  dataSource: delta.DELTA_LIVE_SYMBOLS.has(symbol) ? 'delta' : 'yahoo-finance',
}))));

// Broker status
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
    lastCheck:  brokerStatus.lastCheck,
    liveSymbols: [...delta.DELTA_LIVE_SYMBOLS],
    paperSymbols: Object.keys(delta.YAHOO_TICKER),
  });
});

// Public: candles (works for any supported symbol)
app.get('/api/candles', async (req, res) => {
  const sym = req.query.symbol    || DEFAULT_SYMBOL;
  const tf  = req.query.timeframe || '1m';
  const n   = Math.max(1, Math.min(500, parseInt(req.query.n || '20', 10)));
  try {
    const rows = await delta.getRecentCandlesForSymbol(sym, tf, n);
    res.json({ ok: true, symbol: sym, timeframe: tf, count: rows.length,
               first: rows[0], last: rows[rows.length - 1] });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Legacy alias for test compatibility
app.get('/api/delta/candles', async (req, res) => {
  const sym = req.query.symbol    || DEFAULT_SYMBOL;
  const tf  = req.query.timeframe || '1m';
  const n   = Math.max(1, Math.min(500, parseInt(req.query.n || '20', 10)));
  try {
    const rows = await delta.getRecentCandlesForSymbol(sym, tf, n);
    res.json({ ok: true, symbol: sym, timeframe: tf, count: rows.length,
               first: rows[0], last: rows[rows.length - 1] });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Test order (Delta live symbols only)
app.post('/api/delta/test-order', async (req, res) => {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) return res.json({ ok: false, error: 'creds missing' });
  const symbol = (req.body?.symbol) || DEFAULT_SYMBOL;
  const side   = ((req.body?.side) || 'long').toLowerCase();
  if (!delta.DELTA_LIVE_SYMBOLS.has(symbol))
    return res.json({ ok: false, error: `${symbol} is paper-only; test orders not supported` });
  try {
    const openR = await delta.placeMarketOrder(...creds(), { symbol, side, contracts: 1, clientOrderId: `test_${Date.now()}` });
    await new Promise(r => setTimeout(r, 500));
    const closeR = await delta.closePosition(...creds(), { symbol, side, contracts: 1 });
    res.json({ ok: true, open: openR?.result || openR, close: closeR?.result || closeR });
  } catch (e) {
    res.json({ ok: false, error: e.message, status: e.status, body: e.body });
  }
});

// Delta live positions
app.get('/api/delta/positions', async (_req, res) => {
  if (!DELTA_API_KEY || !DELTA_API_SECRET) return res.json({ ok: false, error: 'creds missing' });
  try { res.json({ ok: true, positions: await delta.getPositions(...creds()) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// State / logs / trades
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

// Start
app.post('/api/start', requireAuth, async (req, res) => {
  const sess = getSession(req.userId);
  if (sess.state.running) return res.json({ ok: false, msg: 'Already running' });
  const {
    symbol    = DEFAULT_SYMBOL,
    timeframe = '1m',
    balance   = 10000,
  } = req.body || {};

  const ivMs = CANDLE_MS[timeframe] || 60000;
  const bal  = parseFloat(balance);
  refreshBrokerStatus().catch(() => {}); // non-blocking — don't stall start on Delta RTT

  Object.assign(sess.state, {
    running: true, symbol, timeframe, strategyId: 'swing-v3-delta',
    mode: isLiveSymbol(symbol) ? 'live' : 'paper',
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
  startAlignedTicks(sess, ivMs);
  broadcast(sess, { type: 'started', state: publicState(sess.state) });
  res.json({ ok: true, state: publicState(sess.state) });
});

// Stop
app.post('/api/stop', requireAuth, (req, res) => {
  const sess = getSession(req.userId);
  if (!sess.state.running) return res.json({ ok: false, msg: 'Not running' });
  stopTicker(sess);
  sess.state.running = false;
  broadcast(sess, { type: 'stopped', state: publicState(sess.state) });
  res.json({ ok: true, state: publicState(sess.state) });
});

// Reset
app.post('/api/reset', requireAuth, (req, res) => {
  const sess = getSession(req.userId);
  if (sess.state.running) return res.json({ ok: false, msg: 'Stop the algo before resetting' });
  const info = db.prepare('DELETE FROM trades WHERE user_id=?').run(req.userId);
  sess.logs           = [];
  sess.lastCandleTime = null;
  sess.state          = defaultState();
  sess.state.userId   = req.userId;
  broadcast(sess, { type: 'reset', state: publicState(sess.state) });
  res.json({ ok: true, tradesCleared: info.changes });
});

// Backtest
app.post('/api/backtest', requireAuth, async (req, res) => {
  const { symbol = DEFAULT_SYMBOL, timeframe = '1m', months = 1 } = req.body || {};
  const m = Math.max(0.1, Math.min(12, parseFloat(months) || 1));
  try {
    const result = await runBacktest(symbol, timeframe, m);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// SSE
app.get('/events', (req, res) => {
  const sess = getSession(req.session?.id || 'guest');
  res.setHeader('Content-Type',     'text/event-stream');
  res.setHeader('Cache-Control',    'no-cache');
  res.setHeader('Connection',       'keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected', state: publicState(sess.state), logs: sess.logs })}\n\n`);
  sess.sseClients.add(res);
  req.on('close', () => sess.sseClients.delete(res));
});

if (DELTA_API_KEY && DELTA_API_SECRET) refreshBrokerStatus().catch(() => {});

app.listen(PORT, () =>
  console.log(`DeltaEx Algo1 (EMA Ribbon Swing) on :${PORT} | Delta: ${brokerStatus.mode} | key ${DELTA_API_KEY ? 'set' : 'missing'}`)
);
