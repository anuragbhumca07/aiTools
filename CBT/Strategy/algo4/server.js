'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const session  = require('express-session');
const { OAuth2Client } = require('google-auth-library');
const {
  generateSignal, computeTrailUpdate, checkForcedExit,
  vwapCalc, fetchCandles, fetchCandlesHistorical, fetchCurrentPrice,
  TRAIL_LADDER, SL_MIN_PIPS, SL_MAX_PIPS, MIN_RR, MAX_LOTS, RISK_PCT,
} = require('./algo');

// ── Config ────────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '3011', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AUTH_REQUIRED    = !!GOOGLE_CLIENT_ID;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'cbt-algo4-dev';

const WA_INSTANCE = process.env.WA_INSTANCE || '';
const WA_TOKEN    = process.env.WA_TOKEN    || '';
const WA_GROUP    = process.env.WA_GROUP    || '';

const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(__dirname, 'logs');
[DATA_DIR, LOGS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── WhatsApp ──────────────────────────────────────────────────────────
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
    let raw = ''; res.on('data', d => raw += d);
    res.on('end', () => { if (res.statusCode !== 200) console.error('[WA]', res.statusCode, raw); });
  });
  req.on('error', e => console.error('[WA]', e.message));
  req.write(body); req.end();
}

function waEntry(side, symbol, price, size, sl, tp, rr, R, regime, balance) {
  const f = (n, d=2) => Number(n).toLocaleString('en-US', { minimumFractionDigits:d, maximumFractionDigits:d });
  sendWhatsApp(
    `${side==='long'?'🟢':'🔴'} *[Algo4] ENTRY — ${side.toUpperCase()} ${symbol}*\n` +
    `Price  : $${f(price)}\nSize   : ${f(size,4)} lots\n` +
    `SL     : $${f(sl)}  (dist: $${f(Math.abs(price-sl),1)})\n` +
    `TP     : $${f(tp)}  (R:R ${f(rr,2)})\n` +
    `R      : $${f(R,2)}\nRegime : ${regime}\nBalance: $${f(balance)}`
  );
}

function waExit(side, symbol, pnl, reason, trailLockR, balance, wins, total) {
  const f   = (n, d=2) => Number(n).toLocaleString('en-US', { minimumFractionDigits:d, maximumFractionDigits:d });
  const wr  = total > 0 ? ((wins/total)*100).toFixed(1) : '0.0';
  const pStr = `${pnl>=0?'+':''}$${f(Math.abs(pnl))}`;
  sendWhatsApp(
    `${pnl>0?'✅':'❌'} *[Algo4] EXIT — ${side.toUpperCase()} ${symbol}*\n` +
    `Reason  : ${reason}\nPnL     : *${pStr}*\n` +
    `Trail   : ${trailLockR > 0 ? `${trailLockR.toFixed(2)}R locked` : 'No trail'}\n` +
    `Balance : $${f(balance)}\nWin Rate: ${wr}% (${wins}/${total})`
  );
}

// ── Google auth ───────────────────────────────────────────────────────
const googleClient = AUTH_REQUIRED ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ── SQLite ─────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'trades.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT, user_id TEXT DEFAULT 'guest',
    type TEXT, side TEXT, symbol TEXT, timeframe TEXT,
    price REAL, size REAL, pnl REAL,
    stop_loss REAL, take_profit REAL, reason TEXT,
    balance_after REAL, timestamp TEXT,
    rr REAL DEFAULT 0, lock_r REAL DEFAULT 0, mae REAL DEFAULT 0
  )
`);
['rr REAL DEFAULT 0','lock_r REAL DEFAULT 0','mae REAL DEFAULT 0'].forEach(col => {
  try { db.exec(`ALTER TABLE trades ADD COLUMN ${col}`); } catch {}
});

const stmtInsert = db.prepare(`
  INSERT INTO trades
    (session_id,user_id,type,side,symbol,timeframe,price,size,pnl,
     stop_loss,take_profit,reason,balance_after,timestamp,rr,lock_r,mae)
  VALUES
    (@session_id,@user_id,@type,@side,@symbol,@timeframe,@price,@size,@pnl,
     @stop_loss,@take_profit,@reason,@balance_after,@timestamp,@rr,@lock_r,@mae)
`);

// ── Session state ─────────────────────────────────────────────────────
const userSessions = new Map();
const CANDLE_MS = { '1m':60000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000 };

function defaultState() {
  return {
    running: false, symbol: 'BTCUSDT', timeframe: '1m', mode: 'paper',
    balance: 10000, initialBalance: 10000,
    sessionId: null, sessionStart: null,
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, lastConditions: null, error: null,
    peakBalance: 10000, maxDrawdownDollar: 0, maxDrawdownPct: 0,
    // Risk management
    dayStartBalance: 10000, dayKey: null,
    consecutiveLosses: 0, pauseUntil: null,
    dailyHalted: false,
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
      fastTicker:     null,
      tickBusy:       false,
      lastCandleTime: null,
      cache5m:        { candles: [], lastFetch: 0 },
    });
  }
  return userSessions.get(userId);
}

function broadcast(sess, obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sess.sseClients) { try { res.write(msg); } catch { sess.sseClients.delete(res); } }
}

function pushLog(sess, entry) {
  const row = { id: Date.now()+Math.random(), ...entry };
  sess.logs.unshift(row);
  if (sess.logs.length > 500) sess.logs.length = 500;
  broadcast(sess, { type:'log', entry: row });
}

function publicState(state) {
  const { running,symbol,timeframe,mode,balance,initialBalance,sessionId,sessionStart,
          pnl,totalTrades,wins,lastIndicators,lastSignal,lastConditions,error,
          peakBalance,maxDrawdownDollar,maxDrawdownPct,
          dailyHalted,pauseUntil,consecutiveLosses,dayStartBalance } = state;
  return {
    running,symbol,timeframe,mode,balance,initialBalance,sessionId,sessionStart,
    pnl,totalTrades,wins,error,lastIndicators,lastSignal,lastConditions,
    position: state.position ? { ...state.position } : null,
    winRate:  totalTrades > 0 ? ((wins/totalTrades)*100).toFixed(1) : '0.0',
    pnlPct:   ((pnl/(initialBalance||10000))*100).toFixed(2),
    peakBalance,
    maxDrawdownDollar: parseFloat(maxDrawdownDollar.toFixed(2)),
    maxDrawdownPct:    parseFloat(maxDrawdownPct.toFixed(2)),
    dailyHalted, pauseUntil, consecutiveLosses, dayStartBalance,
    dailyPnl: balance - dayStartBalance,
    dailyPnlPct: dayStartBalance > 0 ? ((balance-dayStartBalance)/dayStartBalance*100).toFixed(2) : '0.00',
  };
}

function updateDrawdown(state) {
  if (state.balance > state.peakBalance) state.peakBalance = state.balance;
  const dd    = state.peakBalance - state.balance;
  const ddPct = state.peakBalance > 0 ? (dd/state.peakBalance)*100 : 0;
  if (dd > state.maxDrawdownDollar) { state.maxDrawdownDollar = dd; state.maxDrawdownPct = ddPct; }
}

// Daily reset check
function checkDayReset(state) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.dayKey !== today) {
    state.dayKey          = today;
    state.dayStartBalance = state.balance;
    state.dailyHalted     = false;
    state.consecutiveLosses = 0;
    state.pauseUntil      = null;
  }
}

// ── 5-min data cache (refresh every 4 min) ───────────────────────────
async function get5mCandles(sess) {
  const now = Date.now();
  if (now - sess.cache5m.lastFetch > 4 * 60000) {
    try {
      sess.cache5m.candles   = await fetchCandles(sess.state.symbol, '5m', 120);
      sess.cache5m.lastFetch = now;
    } catch(e) { console.error('[Algo4] 5m fetch error:', e.message); }
  }
  return sess.cache5m.candles;
}

// ── Exit helper ───────────────────────────────────────────────────────
async function handleExit(sess, position, exitPrice, exitReason, indicators, ts) {
  const { state } = sess;
  const { side, entryPrice, size, stopLoss, takeProfit, mae, R, riskDist, trailing, trailLockR } = position;

  const rawPnl = side === 'long' ? (exitPrice-entryPrice)*size : (entryPrice-exitPrice)*size;
  const pnl    = parseFloat(rawPnl.toFixed(4));

  state.balance   += pnl;
  state.pnl       += pnl;
  if (pnl > 0) { state.wins++; state.consecutiveLosses = 0; }
  else         { state.consecutiveLosses++; }
  state.totalTrades++;
  updateDrawdown(state);
  state.position = null;

  // Consecutive loss rule: 2 losses → 15-min pause
  if (state.consecutiveLosses >= 2) {
    state.pauseUntil = new Date(Date.now() + 15*60000).toISOString();
    pushLog(sess, { ts, type:'RISK', message:`2 consecutive losses — 15-min pause until ${state.pauseUntil}` });
  }

  // Daily DD check: 3% halt
  checkDayReset(state);
  const dailyLoss = (state.dayStartBalance - state.balance) / state.dayStartBalance;
  if (dailyLoss >= 0.03) {
    state.dailyHalted = true;
    pushLog(sess, { ts, type:'RISK', message:`Daily DD ${(dailyLoss*100).toFixed(2)}% ≥ 3% — halting for the day` });
  }

  stmtInsert.run({
    session_id: state.sessionId, user_id: sess.userId,
    type:'exit', side, symbol:state.symbol, timeframe:state.timeframe,
    price:exitPrice, size, pnl,
    stop_loss:stopLoss, take_profit:takeProfit,
    reason:exitReason,
    balance_after:parseFloat(state.balance.toFixed(4)),
    timestamp:ts, rr:0, lock_r:trailLockR||0, mae:parseFloat((mae||0).toFixed(4)),
  });
  waExit(side, state.symbol, pnl, exitReason, trailLockR||0, state.balance, state.wins, state.totalTrades);
  pushLog(sess, { ts, type:'EXIT', side, price:exitPrice, pnl, mae:(mae||0).toFixed(2), reason:[exitReason], indicators });
  broadcast(sess, { type:'trade', state:publicState(state) });
}

// ── Fast ticker (10-second trailing poll) ─────────────────────────────
function stopFastTicker(sess) {
  if (sess.fastTicker) { clearInterval(sess.fastTicker); sess.fastTicker = null; }
}

function manageFastTicker(sess) {
  const pos      = sess.state.position;
  const needFast = sess.state.running && pos && (pos.trailing || (pos.unrealizedPnl||0) > pos.R*0.3);
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
    const price = await fetchCurrentPrice(state.symbol);
    const pos   = state.position;
    const { side, entryPrice, size, R } = pos;

    const unrealPnl = side === 'long' ? (price-entryPrice)*size : (entryPrice-price)*size;
    pos.unrealizedPnl = parseFloat(unrealPnl.toFixed(4));
    if (unrealPnl < (pos.mae||0)) pos.mae = unrealPnl;

    // Check SL hit
    const slHit = side === 'long' ? price <= pos.stopLoss : price >= pos.stopLoss;
    if (slHit) {
      const reason = pos.trailing
        ? `Trailing SL hit @ $${pos.stopLoss.toFixed(2)} (locked ${pos.trailLockR.toFixed(2)}R)`
        : `SL hit @ $${pos.stopLoss.toFixed(2)}`;
      await handleExit(sess, pos, pos.stopLoss, reason, state.lastIndicators||{}, ts);
      stopFastTicker(sess);
      return;
    }

    // Advance trailing SL
    const trail = computeTrailUpdate(pos, unrealPnl);
    if (trail) {
      const { oldSl, newSl, lockR, profitInR } = trail;
      pos.stopLoss    = newSl;
      pos.trailing    = true;
      pos.trailLockR  = lockR;
      const note = `TRAIL SL: $${oldSl.toFixed(2)} → $${newSl.toFixed(2)} (${profitInR.toFixed(2)}R reached, lock ${lockR.toFixed(2)}R)`;
      console.log('[Algo4]', note);
      pushLog(sess, { ts, type:'TICK', signal:'TRAIL-UPDATE', price,
        indicators:{ ...(state.lastIndicators||{}), price }, reason:[note] });
    } else if (pos.trailing) {
      pushLog(sess, { ts, type:'TICK', signal:'TRAIL-WATCH', price,
        indicators:{ ...(state.lastIndicators||{}), price },
        reason:[`Trailing: SL=$${pos.stopLoss.toFixed(2)} locked ${pos.trailLockR.toFixed(2)}R PnL=$${unrealPnl.toFixed(2)}`] });
    }

    broadcast(sess, { type:'tick', state:publicState(state) });
  } catch(e) { console.error('[Algo4 fastTick]', e.message); }
}

async function fastTick(sess) {
  if (sess.tickBusy) return;
  sess.tickBusy = true;
  try { await runFastTick(sess); } finally { sess.tickBusy = false; manageFastTicker(sess); }
}

// ── Main candle-aligned tick ──────────────────────────────────────────
async function runTick(sess) {
  const { state } = sess;
  const { symbol, timeframe, sessionId } = state;
  const userId = sess.userId;
  const ts     = new Date().toISOString();

  try {
    state.error = null;
    checkDayReset(state);

    // Daily halt
    if (state.dailyHalted) {
      pushLog(sess, { ts, type:'RISK', message:'Daily DD limit hit — no trading today' });
      broadcast(sess, { type:'tick', state:publicState(state) }); return;
    }

    // Mandatory pause after consecutive losses
    if (state.pauseUntil && new Date(state.pauseUntil) > new Date()) {
      const remaining = Math.ceil((new Date(state.pauseUntil)-Date.now())/1000);
      pushLog(sess, { ts, type:'RISK', message:`Pause active — ${remaining}s remaining` });
      broadcast(sess, { type:'tick', state:publicState(state) }); return;
    } else if (state.pauseUntil && new Date(state.pauseUntil) <= new Date()) {
      state.pauseUntil = null; state.consecutiveLosses = 0;
    }

    // Fetch 1-min candles (drop forming candle → evaluate on closed bar)
    const raw1m   = await fetchCandles(symbol, '1m', 301);
    const candles = raw1m.slice(0, -1);
    const latestCandleTime = candles[candles.length-1].time;
    const price            = candles[candles.length-1].close;

    // Fetch 5-min context
    const candles5m = await get5mCandles(sess);

    // Pre-compute VWAP for exit checks
    const vwapArr = vwapCalc(candles);

    // ── Open position: check exits first ──────────────────────────────
    if (state.position) {
      const pos = state.position;
      const { side, entryPrice, size, R } = pos;

      // SL check
      const slHit = side === 'long' ? price <= pos.stopLoss : price >= pos.stopLoss;
      if (slHit) {
        const reason = pos.trailing
          ? `Trailing SL hit @ $${pos.stopLoss.toFixed(2)} (locked ${pos.trailLockR?.toFixed(2)||0}R)`
          : `SL hit @ $${pos.stopLoss.toFixed(2)}`;
        stopFastTicker(sess);
        await handleExit(sess, pos, pos.stopLoss, reason, state.lastIndicators||{}, ts);
        return;
      }

      // Forced exit checks (ADX/order-flow)
      const forcedExit = checkForcedExit(pos, candles, vwapArr);
      if (forcedExit) {
        stopFastTicker(sess);
        await handleExit(sess, pos, price, forcedExit.reason, state.lastIndicators||{}, ts);
        return;
      }

      // Update unrealized PnL
      const unrealPnl = side === 'long' ? (price-entryPrice)*size : (entryPrice-price)*size;
      pos.unrealizedPnl = parseFloat(unrealPnl.toFixed(4));
      if (unrealPnl < (pos.mae||0)) pos.mae = unrealPnl;

      // Advance trailing SL on each closed candle too
      const trail = computeTrailUpdate(pos, unrealPnl);
      if (trail) {
        const { oldSl, newSl, lockR, profitInR } = trail;
        pos.stopLoss = newSl; pos.trailing = true; pos.trailLockR = lockR;
        pushLog(sess, { ts, type:'TICK', signal:'TRAIL-UPDATE', price,
          indicators:state.lastIndicators||{},
          reason:[`TRAIL SL: $${oldSl.toFixed(2)} → $${newSl.toFixed(2)} (${profitInR.toFixed(2)}R → lock ${lockR.toFixed(2)}R)`] });
      }

      manageFastTicker(sess);
    }

    const isNewCandle = latestCandleTime !== sess.lastCandleTime;
    if (!isNewCandle) {
      broadcast(sess, { type:'tick', state:publicState(state) }); return;
    }
    sess.lastCandleTime = latestCandleTime;

    // ── Signal on new closed candle ────────────────────────────────────
    const { signal, reason, indicators, buyScore, sellScore, sl, tp, riskDist, rr, size, R, ob, conditions } =
      generateSignal(candles, candles5m, state.balance);
    state.lastIndicators  = indicators;
    state.lastSignal      = { signal, buyScore, sellScore };
    state.lastConditions  = conditions || null;

    // Opposite-signal exit
    if (state.position) {
      const { side } = state.position;
      const isOpposite = (side==='long' && signal==='SELL') || (side==='short' && signal==='BUY');
      if (isOpposite) {
        stopFastTicker(sess);
        await handleExit(sess, state.position, price, `Opposite signal: ${signal}`, indicators, ts);
        // fall through to enter new position
      } else {
        pushLog(sess, { ts, type:'TICK', signal:`${signal} (B:${buyScore} S:${sellScore})`, price, indicators, reason });
        broadcast(sess, { type:'tick', state:publicState(state) }); return;
      }
    }

    // ── Entry ──────────────────────────────────────────────────────────
    if (!state.position && (signal==='BUY' || signal==='SELL')) {
      // Chase rule: skip if price moved > 5 pips from signal candle close
      const signalClose = candles[candles.length-1].close;
      if (Math.abs(price - signalClose) > 5) {
        pushLog(sess, { ts, type:'TICK', signal:'SKIP', price, indicators,
          reason:[`Chase rule: price moved $${Math.abs(price-signalClose).toFixed(1)} > $5 from signal close`] });
        broadcast(sess, { type:'tick', state:publicState(state) }); return;
      }

      // Mid-candle restart guard (skip if candle closed > 2 min ago)
      const candleIntervalMs = CANDLE_MS[timeframe] || 60000;
      const msSinceClose     = Date.now() - (latestCandleTime + candleIntervalMs);
      if (msSinceClose > 120000) {
        pushLog(sess, { ts, type:'TICK', signal:'SKIP', price, indicators,
          reason:[`Entry skipped: ${Math.round(msSinceClose/1000)}s since candle close (>2 min)`] });
        broadcast(sess, { type:'tick', state:publicState(state) }); return;
      }

      const entrySide = signal === 'BUY' ? 'long' : 'short';
      state.position = {
        side: entrySide, entryPrice: price, size, stopLoss: sl, takeProfit: tp,
        riskDist, rr, R, ob,
        entryTime: ts, unrealizedPnl: 0, mae: 0,
        trailing: false, trailLockR: 0,
      };

      stmtInsert.run({
        session_id:state.sessionId, user_id:userId,
        type:'entry', side:entrySide, symbol, timeframe,
        price, size, pnl:0,
        stop_loss:sl, take_profit:tp,
        reason:reason.join(' | '),
        balance_after:parseFloat(state.balance.toFixed(4)),
        timestamp:ts, rr:parseFloat(rr.toFixed(3)), lock_r:0, mae:0,
      });
      waEntry(entrySide, symbol, price, size, sl, tp, rr, R, indicators.regime, state.balance);
      pushLog(sess, { ts, type:'ENTRY', side:entrySide, signal, price, size, stopLoss:sl, takeProfit:tp,
        riskDist, rr, R, balance:state.balance.toFixed(4), reason, indicators });
      broadcast(sess, { type:'trade', state:publicState(state) });
    } else if (!state.position) {
      pushLog(sess, { ts, type:'TICK', signal:`${signal} (B:${buyScore} S:${sellScore})`, price, indicators, reason });
      broadcast(sess, { type:'tick', state:publicState(state) });
    }
  } catch(err) {
    state.error = err.message;
    pushLog(sess, { ts, type:'ERROR', message:err.message });
    broadcast(sess, { type:'error', message:err.message, state:publicState(state) });
  }
}

async function tick(sess) {
  if (sess.tickBusy) return;
  sess.tickBusy = true;
  try { await runTick(sess); } finally { sess.tickBusy = false; }
}

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
  if (sess.ticker)       { clearTimeout(sess.ticker);       sess.ticker       = null; }
  stopFastTicker(sess);
}

// ── Backtest ──────────────────────────────────────────────────────────
async function runBacktest(symbol, months) {
  console.log(`[Algo4] Backtest: ${symbol} ${months}mo 1m+5m`);
  const [all1m, all5m] = await Promise.all([
    fetchCandlesHistorical(symbol, '1m', months),
    fetchCandlesHistorical(symbol, '5m', months),
  ]);

  if (all1m.length < 250) throw new Error(`Need 250+ 1-min candles. Got ${all1m.length}`);

  const WINDOW = 250;
  let balance = 10000;
  const initialBalance = 10000;
  let pos = null, peakBal = balance, maxDD = 0;
  const trades = [];
  let wins = 0;
  let consecutiveLosses = 0, dayStartBal = balance, dayKey = null;
  let pauseUntilBar = -1;

  // Build 5m index pointer (sorted by time)
  let idx5m = 0;

  for (let i = WINDOW; i < all1m.length; i++) {
    const t1m = all1m[i].time;

    // Advance 5m pointer to last closed 5m bar (time + 300s <= t1m)
    while (idx5m+1 < all5m.length && all5m[idx5m+1].time + 300000 <= t1m) idx5m++;

    const seg1m = all1m.slice(Math.max(0, i-WINDOW+1), i+1);
    const seg5m = all5m.slice(Math.max(0, idx5m-100+1), idx5m+1);

    const price = all1m[i].close;
    const canH  = all1m[i].high;
    const canL  = all1m[i].low;

    // Daily reset
    const dayDate = new Date(t1m).toISOString().slice(0,10);
    if (dayDate !== dayKey) { dayKey = dayDate; dayStartBal = balance; }

    // Daily halt
    const dailyLoss = (dayStartBal - balance) / dayStartBal;
    if (dailyLoss >= 0.03) continue;

    // Pause gate
    if (i < pauseUntilBar) continue;

    if (pos) {
      // Trailing SL advance using candle peak
      const peakPx  = pos.side === 'long' ? canH : canL;
      const peakPnl = pos.side === 'long' ? (peakPx-pos.entryPrice)*pos.size : (pos.entryPrice-peakPx)*pos.size;
      const tu = computeTrailUpdate(pos, peakPnl);
      if (tu) { pos.stopLoss = tu.newSl; pos.trailing = true; pos.trailLockR = tu.lockR; }

      // SL hit
      const slHit = pos.side === 'long' ? canL <= pos.stopLoss : canH >= pos.stopLoss;

      // Forced exit check (on candle close)
      const vwapArr = vwapCalc(seg1m);
      const forced  = checkForcedExit(pos, seg1m, vwapArr);

      if (slHit || forced) {
        let exitPrice, reason;
        if (slHit) {
          exitPrice = pos.stopLoss;
          reason    = pos.trailing ? `Trailing SL hit: $${exitPrice.toFixed(2)} (locked ${pos.trailLockR?.toFixed(2)||0}R)` : `SL hit: $${exitPrice.toFixed(2)}`;
        } else {
          exitPrice = price;
          reason    = forced.reason;
        }
        const pnl = pos.side === 'long' ? (exitPrice-pos.entryPrice)*pos.size : (pos.entryPrice-exitPrice)*pos.size;
        balance += pnl;
        if (pnl > 0) { wins++; consecutiveLosses = 0; } else { consecutiveLosses++; }
        if (consecutiveLosses >= 2) { pauseUntilBar = i + Math.ceil(15*60/1); consecutiveLosses = 0; }
        if (balance > peakBal) peakBal = balance;
        const dd = peakBal - balance; if (dd > maxDD) maxDD = dd;
        trades.push({
          side:pos.side, entryPrice:+pos.entryPrice.toFixed(4), exitPrice:+exitPrice.toFixed(4),
          pnl:+pnl.toFixed(2), balance:+balance.toFixed(2),
          entryTime: new Date(pos.entryTime).toISOString(), exitTime: new Date(t1m).toISOString(),
          reason, rr:+(pos.rr||0).toFixed(3), trailed:pos.trailing||false, lockR:+(pos.trailLockR||0).toFixed(3),
        });
        pos = null;
      } else {
        // Opposite-signal exit
        const sig = generateSignal(seg1m, seg5m, balance);
        const isOpp = (pos.side==='long' && sig.signal==='SELL') || (pos.side==='short' && sig.signal==='BUY');
        if (isOpp) {
          const pnl = pos.side==='long' ? (price-pos.entryPrice)*pos.size : (pos.entryPrice-price)*pos.size;
          balance += pnl;
          if (pnl > 0) { wins++; consecutiveLosses = 0; } else { consecutiveLosses++; }
          if (consecutiveLosses >= 2) { pauseUntilBar = i + Math.ceil(15*60/1); consecutiveLosses = 0; }
          if (balance > peakBal) peakBal = balance;
          const dd = peakBal-balance; if (dd > maxDD) maxDD = dd;
          trades.push({
            side:pos.side, entryPrice:+pos.entryPrice.toFixed(4), exitPrice:+price.toFixed(4),
            pnl:+pnl.toFixed(2), balance:+balance.toFixed(2),
            entryTime: new Date(pos.entryTime).toISOString(), exitTime: new Date(t1m).toISOString(),
            reason:`Opposite signal: ${sig.signal}`, rr:+(pos.rr||0).toFixed(3),
            trailed:pos.trailing||false, lockR:+(pos.trailLockR||0).toFixed(3),
          });
          pos = null;
          // Fall through to enter new position below
          const { signal:s2, sl:sl2, tp:tp2, riskDist:rd2, rr:rr2, size:sz2, R:R2 } = sig;
          if (s2 === 'BUY' || s2 === 'SELL') {
            const newSide = s2 === 'BUY' ? 'long' : 'short';
            if (rd2 > 0) pos = { side:newSide, entryPrice:price, size:sz2, stopLoss:sl2, takeProfit:tp2,
              riskDist:rd2, rr:rr2, R:R2, entryTime:t1m, trailing:false, trailLockR:0 };
          }
          continue;
        }
      }
    }

    if (!pos) {
      const sig = generateSignal(seg1m, seg5m, balance);
      if (sig.signal === 'BUY' || sig.signal === 'SELL') {
        const { sl, tp, riskDist, rr, size, R } = sig;
        if (!sl || riskDist <= 0) continue;
        const newSide = sig.signal === 'BUY' ? 'long' : 'short';
        pos = { side:newSide, entryPrice:price, size, stopLoss:sl, takeProfit:tp,
          riskDist, rr, R, entryTime:t1m, trailing:false, trailLockR:0 };
      }
    }
  }

  // Close open position at end
  if (pos) {
    const lp  = all1m[all1m.length-1].close;
    const pnl = pos.side==='long' ? (lp-pos.entryPrice)*pos.size : (pos.entryPrice-lp)*pos.size;
    balance += pnl;
    trades.push({
      side:pos.side, entryPrice:+pos.entryPrice.toFixed(4), exitPrice:+lp.toFixed(4),
      pnl:+pnl.toFixed(2), balance:+balance.toFixed(2),
      entryTime:new Date(pos.entryTime).toISOString(), exitTime:new Date(all1m[all1m.length-1].time).toISOString(),
      reason:'End of backtest', rr:+(pos.rr||0).toFixed(3), trailed:pos.trailing||false, lockR:+(pos.trailLockR||0).toFixed(3),
    });
  }

  const total  = trades.length;
  const netPnl = balance - initialBalance;
  return {
    trades,
    summary: {
      totalTrades:total, wins, losses:total-wins,
      winRate: total > 0 ? ((wins/total)*100).toFixed(1) : '0.0',
      totalPnl:+netPnl.toFixed(2),
      pnlPct:((netPnl/initialBalance)*100).toFixed(2),
      maxDrawdown:+maxDD.toFixed(2),
      finalBalance:+balance.toFixed(2),
      candlesAnalyzed:all1m.length,
      period:`${months} month${months>1?'s':''}`,
      symbol,
    },
  };
}

// ── Express app ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(session({
  secret:SESSION_SECRET, resave:false, saveUninitialized:false,
  cookie:{ httpOnly:true, secure:false, maxAge:7*24*60*60*1000 },
}));
app.use(express.static(path.join(__dirname, 'web')));

function requireAuth(req, res, next) {
  if (!AUTH_REQUIRED) { req.userId = 'guest'; return next(); }
  if (req.session.userId) { req.userId = req.session.userId; return next(); }
  res.status(401).json({ error:'Not authenticated' });
}

app.get('/api/config', (req, res) => res.json({ authRequired:AUTH_REQUIRED, googleClientId:GOOGLE_CLIENT_ID, user:req.session.user||null }));
app.post('/auth/google', async (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ ok:false, error:'Auth not configured' });
  try {
    const { credential } = req.body;
    const ticket  = await googleClient.verifyIdToken({ idToken:credential, audience:GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    req.session.userId = payload.sub;
    req.session.user   = { id:payload.sub, email:payload.email, name:payload.name, picture:payload.picture };
    res.json({ ok:true, user:req.session.user });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});
app.post('/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok:true })); });

app.get('/health', (_, res) => res.json({ status:'ok', strategy:'btc-1m-scalp-v1' }));

app.get('/api/state',  requireAuth, (req, res) => res.json(publicState(getSession(req.userId).state)));
app.get('/api/logs',   requireAuth, (req, res) => res.json(getSession(req.userId).logs));
app.get('/api/trades', requireAuth, (req, res) => {
  const userId = req.userId, sess = getSession(userId);
  const rows   = sess.state.sessionId
    ? db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(sess.state.sessionId)
    : [];
  res.json(rows);
});

app.post('/api/start', requireAuth, (req, res) => {
  const sess = getSession(req.userId);
  if (sess.state.running) return res.json({ ok:false, msg:'Already running' });
  const { symbol='BTCUSDT', balance=10000, mode='paper' } = req.body || {};
  const bal = parseFloat(balance);
  Object.assign(sess.state, {
    running:true, symbol, timeframe:'1m', mode,
    balance:bal, initialBalance:bal,
    sessionId:`s_${Date.now()}_${req.userId}`,
    sessionStart:new Date().toISOString(),
    position:null, pnl:0, totalTrades:0, wins:0,
    lastIndicators:null, lastSignal:null, error:null,
    peakBalance:bal, maxDrawdownDollar:0, maxDrawdownPct:0,
    dayStartBalance:bal, dayKey:null, consecutiveLosses:0, pauseUntil:null, dailyHalted:false,
    userId:req.userId,
  });
  sess.logs = []; sess.lastCandleTime = null; sess.cache5m = { candles:[], lastFetch:0 };
  tick(sess);
  startAlignedTicks(sess, 60000); // 1-min aligned
  broadcast(sess, { type:'started', state:publicState(sess.state) });
  res.json({ ok:true, state:publicState(sess.state) });
});

app.post('/api/stop', requireAuth, (req, res) => {
  const sess = getSession(req.userId);
  if (!sess.state.running) return res.json({ ok:false, msg:'Not running' });
  stopTicker(sess);
  sess.state.running = false;
  broadcast(sess, { type:'stopped', state:publicState(sess.state) });
  res.json({ ok:true, state:publicState(sess.state) });
});

app.post('/api/backtest', requireAuth, async (req, res) => {
  const { symbol='BTCUSDT', months=1 } = req.body || {};
  const m = Math.max(1, Math.min(3, parseInt(months,10)||1));
  try {
    const result = await runBacktest(symbol, m);
    res.json({ ok:true, ...result });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.get('/events', (req, res) => {
  let userId = 'guest';
  if (AUTH_REQUIRED) { if (!req.session.userId) return res.status(401).end(); userId = req.session.userId; }
  const sess = getSession(userId);
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type:'connected', state:publicState(sess.state), logs:sess.logs })}\n\n`);
  sess.sseClients.add(res);
  req.on('close', () => sess.sseClients.delete(res));
});

app.listen(PORT, () => console.log(`CBT Algo4 (BTC 1m Scalp) listening on :${PORT}`));
