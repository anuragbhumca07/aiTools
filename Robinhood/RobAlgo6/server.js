'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const session  = require('express-session');
const { RobinhoodClient, generateTOTP } = require('./robinhood-client');

// ── Config ─────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT || '4010', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'rob-algo6-dev-secret';
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── WhatsApp (Green API) — optional notifications ──────────────────
const WA_INSTANCE = process.env.WA_INSTANCE || '';
const WA_TOKEN    = process.env.WA_TOKEN    || '';
const WA_GROUP    = process.env.WA_GROUP    || '';

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
    res.on('end', () => { if (res.statusCode !== 200) console.error('[WA] send failed:', res.statusCode); });
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// ── Kraken API ─────────────────────────────────────────────────────
const KRAKEN_PAIRS = {
  'BTCUSDT': 'XBTUSD', 'ETHUSDT': 'ETHUSD',
  'SOLUSDT': 'SOLUSD', 'XRPUSDT': 'XRPUSD',
  'LTCUSDT': 'LTCUSD', 'ADAUSDT': 'ADAUSD',
};

function krakenGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.kraken.com', path: apiPath, method: 'GET',
        headers: { 'User-Agent': 'RobAlgo6/1.0' } },
      res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Kraken timeout')));
    req.end();
  });
}

function parseOHLC(result) {
  const key = Object.keys(result).find(k => k !== 'last');
  if (!key) return [];
  return result[key].map(c => ({
    time:   c[0] * 1000,
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[6]),
  }));
}

async function fetchOHLC(pair, intervalMin, sinceUnixSec) {
  const url = `/0/public/OHLC?pair=${pair}&interval=${intervalMin}${sinceUnixSec ? '&since=' + sinceUnixSec : ''}`;
  const d = await krakenGet(url);
  if (d.error && d.error.length) throw new Error(d.error[0]);
  return { candles: parseOHLC(d.result), last: d.result.last };
}

async function fetchAllOHLC(pair, intervalMin, fromMs) {
  const all = [];
  let since = Math.floor(fromMs / 1000);
  for (let i = 0; i < 60; i++) {
    const { candles, last } = await fetchOHLC(pair, intervalMin, since);
    if (!candles.length) break;
    all.push(...candles);
    if (candles.length < 720 || !last) break;
    if (last <= since) break;
    since = last;
    await new Promise(r => setTimeout(r, 450));
  }
  const seen = new Set();
  return all
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => a.time - b.time)
    .filter(c => c.time >= fromMs);
}

async function fetchTicker(pair) {
  const d = await krakenGet(`/0/public/Ticker?pair=${pair}`);
  if (d.error && d.error.length) throw new Error(d.error[0]);
  const key = Object.keys(d.result)[0];
  return parseFloat(d.result[key].c[0]);
}

// ── NY Session timing ───────────────────────────────────────────────
function dayNYOpen(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0);
}
function dayNYClose(nowMs) { return dayNYOpen(nowMs) + 4 * 3600 * 1000; }
function todayUTC() { return new Date().toISOString().split('T')[0]; }

// ── SQLite ─────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'trades.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT, user_id TEXT DEFAULT 'guest',
    type TEXT, side TEXT, symbol TEXT, timeframe TEXT,
    price REAL, size REAL, pnl REAL,
    stop_loss REAL, take_profit REAL, reason TEXT,
    balance_after REAL, timestamp TEXT, mae REAL DEFAULT 0,
    level_high REAL, level_low REAL, flag_low REAL,
    rh_order_id TEXT
  )
`);
['level_high REAL','level_low REAL','flag_low REAL','rh_order_id TEXT'].forEach(col => {
  try { db.exec(`ALTER TABLE trades ADD COLUMN ${col}`); } catch {}
});
const stmtInsert = db.prepare(`
  INSERT INTO trades (session_id,user_id,type,side,symbol,timeframe,price,size,pnl,
    stop_loss,take_profit,reason,balance_after,timestamp,mae,level_high,level_low,flag_low,rh_order_id)
  VALUES (@session_id,@user_id,@type,@side,@symbol,@timeframe,@price,@size,@pnl,
    @stop_loss,@take_profit,@reason,@balance_after,@timestamp,@mae,@level_high,@level_low,@flag_low,@rh_order_id)
`);

// ── Robinhood client ────────────────────────────────────────────────
const rhClient = new RobinhoodClient();

// Auto-login via env vars if set
(async () => {
  const user = process.env.RH_USERNAME;
  const pass = process.env.RH_PASSWORD;
  if (!user || !pass) return;
  console.log(`[RH] Auto-login for ${user}…`);
  const code = process.env.RH_MFA_SECRET ? generateTOTP(process.env.RH_MFA_SECRET) : undefined;
  try {
    const r = await rhClient.login(user, pass, code);
    if (r.mfaRequired) console.warn('[RH] MFA required — set RH_MFA_SECRET or use /api/rh-auth');
    else if (r.ok) { await rhClient.getAccountId(); console.log(`[RH] Auto-login OK, account: ${rhClient.accountId}`); }
  } catch (e) { console.error('[RH] Auto-login failed:', e.message); }
})();

// ── Session management ─────────────────────────────────────────────
const userSessions = new Map();

function defaultState() {
  return {
    running: false, symbol: 'BTCUSDT', mode: 'paper',
    balance: 10000, initialBalance: 10000,
    sessionId: null, sessionStart: null,
    pnl: 0, totalTrades: 0, wins: 0, error: null,
    peakBalance: 10000, maxDrawdownDollar: 0, maxDrawdownPct: 0,
    phase: 'WAIT_4H',
    levelHigh: null, levelLow: null,
    flagCandle: null,
    position: null,
    todayDate: null,
    nyOpen: null, nyClose: null,
    lastProcessed5mTime: null,
    lowestLowSinceFlag: null,
    currentPrice: null,
    interim4hHigh: null, interim4hLow: null,
  };
}

function getSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      userId, state: defaultState(), logs: [],
      sseClients: new Set(),
      ticker: null, trailInterval: null,
      tickBusy: false,
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
  const row = { id: Date.now() + Math.random(), ts: new Date().toISOString(), ...entry };
  sess.logs.unshift(row);
  if (sess.logs.length > 500) sess.logs.length = 500;
  broadcast(sess, { type: 'log', entry: row });
}
function updateDrawdown(state) {
  if (state.balance > state.peakBalance) state.peakBalance = state.balance;
  const dd    = state.peakBalance - state.balance;
  const ddPct = state.peakBalance > 0 ? (dd / state.peakBalance) * 100 : 0;
  if (dd > state.maxDrawdownDollar) { state.maxDrawdownDollar = dd; state.maxDrawdownPct = ddPct; }
}
function publicState(s) {
  return {
    running: s.running, symbol: s.symbol, mode: s.mode,
    balance: s.balance, initialBalance: s.initialBalance,
    sessionId: s.sessionId, sessionStart: s.sessionStart,
    pnl: s.pnl, totalTrades: s.totalTrades, wins: s.wins, error: s.error,
    pnlPct:    ((s.pnl / (s.initialBalance || 10000)) * 100).toFixed(2),
    winRate:   s.totalTrades > 0 ? ((s.wins / s.totalTrades) * 100).toFixed(1) : '0.0',
    peakBalance: s.peakBalance,
    maxDrawdownDollar: parseFloat(s.maxDrawdownDollar.toFixed(2)),
    maxDrawdownPct:    parseFloat(s.maxDrawdownPct.toFixed(2)),
    phase: s.phase,
    levelHigh: s.levelHigh, levelLow: s.levelLow,
    flagCandle: s.flagCandle,
    position: s.position ? { ...s.position } : null,
    todayDate: s.todayDate,
    nyOpen: s.nyOpen, nyClose: s.nyClose,
    currentPrice: s.currentPrice,
    interim4hHigh: s.interim4hHigh, interim4hLow: s.interim4hLow,
    lowestLowSinceFlag: s.lowestLowSinceFlag,
  };
}

// ── Trade helpers ───────────────────────────────────────────────────
async function openTrade(sess, entryPrice, entryTimeIso, lowestLow) {
  const { state } = sess;
  const userId = sess.userId;
  const { symbol, sessionId, levelLow } = state;

  const sl     = parseFloat(lowestLow.toFixed(4));
  const slDist = parseFloat((entryPrice - sl).toFixed(4));
  if (slDist <= 0) {
    pushLog(sess, { type: 'WARN', message: `Skipping BUY — invalid SL dist: entry=${entryPrice} lowestLow=${sl}` });
    return;
  }
  const tp      = parseFloat((entryPrice + 2.0 * slDist).toFixed(4));
  const riskAmt = state.balance * 0.02;
  const size    = parseFloat((riskAmt / slDist).toFixed(6));

  // ── Live mode: place buy order on Robinhood ───────────────────────
  let rhOrderId = null;
  if (state.mode === 'live') {
    try {
      const order = await rhClient.placeMarketOrder(symbol, 'buy', size);
      rhOrderId = order.id || order.ref_id || order.client_order_id || null;
      pushLog(sess, { type: 'RH_ORDER', message: `Robinhood BUY order placed: ${rhOrderId}` });
    } catch (e) {
      state.error = `Robinhood BUY order failed: ${e.message}`;
      pushLog(sess, { type: 'ERROR', message: state.error });
      broadcast(sess, { type: 'error', message: state.error, state: publicState(state) });
      return; // Do not enter position if the real order failed
    }
  }

  state.position = {
    side: 'long', entryPrice, sl, tp, slDist, size,
    entryTime: entryTimeIso,
    trailActive: false, trailHigh: entryPrice,
    unrealizedPnl: 0, originalSL: sl,
    rhOrderId,
  };
  state.phase = 'IN_TRADE';

  stmtInsert.run({
    session_id: sessionId, user_id: userId,
    type: 'entry', side: 'long', symbol, timeframe: '5m',
    price: entryPrice, size, pnl: 0, stop_loss: sl, take_profit: tp,
    reason: `BUY: 5m close ${entryPrice.toFixed(4)} > LevelLow ${levelLow.toFixed(4)} | SL=${sl} (lowest low flag→entry)`,
    balance_after: parseFloat(state.balance.toFixed(4)),
    timestamp: entryTimeIso, mae: 0,
    level_high: state.levelHigh, level_low: state.levelLow, flag_low: sl,
    rh_order_id: rhOrderId,
  });
  pushLog(sess, {
    type: 'ENTRY', side: 'long', price: entryPrice, size, sl, tp,
    message: `BUY ${entryPrice.toFixed(2)} | SL=${sl.toFixed(2)} | 2R-ref=${tp.toFixed(2)} | dist=${slDist.toFixed(2)} | risk=$${riskAmt.toFixed(2)}${rhOrderId ? ` | RH: ${rhOrderId}` : ''}`,
  });
  sendWhatsApp(
    `🟢 *ENTRY — LONG ${symbol} 5m*\n` +
    `Price : $${entryPrice.toFixed(2)}\nSize  : ${size} ${symbol.replace('USDT','')}\n` +
    `SL    : $${sl.toFixed(2)}  |  2R ref : $${tp.toFixed(2)}\n` +
    `Risk  : $${riskAmt.toFixed(2)}\nBalance: $${state.balance.toFixed(2)}`
  );
  broadcast(sess, { type: 'trade', state: publicState(state) });
}

async function closeTrade(sess, exitPrice, reason) {
  const { state } = sess;
  const { position, symbol, sessionId, levelHigh, levelLow, flagCandle } = state;
  const userId = sess.userId;
  if (!position) return;

  // ── Live mode: place sell order on Robinhood ──────────────────────
  let rhExitOrderId = null;
  if (state.mode === 'live') {
    try {
      const order = await rhClient.placeMarketOrder(symbol, 'sell', position.size);
      rhExitOrderId = order.id || order.ref_id || order.client_order_id || null;
      pushLog(sess, { type: 'RH_ORDER', message: `Robinhood SELL order placed: ${rhExitOrderId}` });
    } catch (e) {
      pushLog(sess, { type: 'ERROR', message: `⚠ Robinhood SELL order failed: ${e.message} — close manually on Robinhood` });
    }
  }

  const pnl = parseFloat(((exitPrice - position.entryPrice) * position.size).toFixed(4));
  state.balance += pnl;
  state.pnl     += pnl;
  if (pnl > 0) state.wins++;
  state.totalTrades++;
  updateDrawdown(state);

  const ts = new Date().toISOString();
  stmtInsert.run({
    session_id: sessionId, user_id: userId,
    type: 'exit', side: 'long', symbol, timeframe: '5m',
    price: exitPrice, size: position.size, pnl,
    stop_loss: position.sl, take_profit: position.tp,
    reason, balance_after: parseFloat(state.balance.toFixed(4)),
    timestamp: ts, mae: 0,
    level_high: levelHigh, level_low: levelLow,
    flag_low: flagCandle ? flagCandle.low : null,
    rh_order_id: rhExitOrderId,
  });
  pushLog(sess, {
    type: 'EXIT', price: exitPrice, pnl, reason,
    message: `EXIT ${exitPrice.toFixed(2)} | PnL=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | Balance=$${state.balance.toFixed(2)}${rhExitOrderId ? ` | RH: ${rhExitOrderId}` : ''}`,
  });
  sendWhatsApp(
    `${pnl > 0 ? '✅' : '❌'} *EXIT — LONG ${symbol}*\nReason: ${reason}\n` +
    `PnL    : *${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}*\n` +
    `Balance: $${state.balance.toFixed(2)}\n` +
    `Win Rate: ${state.totalTrades > 0 ? ((state.wins / state.totalTrades) * 100).toFixed(1) : '0.0'}% (${state.wins}/${state.totalTrades})`
  );
  state.position = null;
  state.flagCandle = null;
  state.lowestLowSinceFlag = null;
  state.phase = 'WAIT_FLAG';

  if (sess.trailInterval) { clearInterval(sess.trailInterval); sess.trailInterval = null; }
  if (state.running) scheduleNextTick(sess);
  broadcast(sess, { type: 'trade', state: publicState(state) });
}

// ── Decremental SL milestones ───────────────────────────────────────
//   ≥1R   → SL = entry (breakeven)
//   ≥1.5R → SL = entry + 1×slDist (1R locked)
//   ≥2R   → SL = entry + 1.75×slDist; then trail min(25, 0.25×slDist) from trailHigh
function decrementalSL(pos, currentPrice) {
  const { entryPrice, slDist, trailHigh: oldHigh, sl: currentSL } = pos;
  const newHigh = Math.max(oldHigh, currentPrice);
  const profitR = (newHigh - entryPrice) / slDist;

  let idealSL;
  if (profitR >= 2.0) {
    const trailAmt = Math.min(25, 0.25 * slDist);
    idealSL = Math.max(newHigh - trailAmt, entryPrice + 1.75 * slDist);
  } else if (profitR >= 1.5) {
    idealSL = entryPrice + slDist;
  } else if (profitR >= 1.0) {
    idealSL = entryPrice;
  } else {
    idealSL = currentSL;
  }

  return {
    sl: parseFloat(Math.max(currentSL, idealSL).toFixed(4)),
    trailHigh: newHigh,
  };
}

// ── Trailing 5-second check ─────────────────────────────────────────
async function trailCheck(sess) {
  const { state } = sess;
  if (!state.running || !state.position) {
    if (sess.trailInterval) { clearInterval(sess.trailInterval); sess.trailInterval = null; }
    return;
  }
  const pair = KRAKEN_PAIRS[state.symbol] || 'XBTUSD';
  try {
    const price = await fetchTicker(pair);
    state.currentPrice = price;
    const pos = state.position;

    const prevSL = pos.sl;
    const updated = decrementalSL(pos, price);
    pos.sl = updated.sl;
    pos.trailHigh = updated.trailHigh;

    if (!pos.trailActive && pos.trailHigh >= pos.entryPrice + 2.0 * pos.slDist) {
      pos.trailActive = true;
      pushLog(sess, { type: 'TRAIL',
        message: `2R reached — Phase 4 active trail. min(25, 0.25×dist)=${Math.min(25, 0.25 * pos.slDist).toFixed(2)} from max. SL=${pos.sl.toFixed(2)}` });
    } else if (pos.sl > prevSL) {
      const rStr = ((pos.trailHigh - pos.entryPrice) / pos.slDist).toFixed(2);
      pushLog(sess, { type: 'TRAIL',
        message: `SL raised → ${pos.sl.toFixed(2)} (${rStr}R milestone) | TrailHigh=${pos.trailHigh.toFixed(2)}` });
    }

    pos.unrealizedPnl = parseFloat(((price - pos.entryPrice) * pos.size).toFixed(4));
    if (price <= pos.sl) {
      await closeTrade(sess, pos.sl, `SL hit at ${pos.sl.toFixed(4)}`);
    } else {
      broadcast(sess, { type: 'tick', state: publicState(state) });
    }
  } catch {}
}

// ── Main tick (every 30 seconds) ────────────────────────────────────
async function runTick(sess) {
  const { state } = sess;
  const { symbol } = state;
  const pair = KRAKEN_PAIRS[symbol] || 'XBTUSD';
  const now  = Date.now();

  try {
    state.error = null;

    // Day reset at UTC midnight
    const today = todayUTC();
    if (state.todayDate !== today) {
      if (state.position) {
        try {
          const lp = await fetchTicker(pair);
          await closeTrade(sess, lp, 'End-of-day auto-close');
        } catch {}
      }
      if (sess.trailInterval) { clearInterval(sess.trailInterval); sess.trailInterval = null; }
      state.todayDate = today;
      state.phase     = 'WAIT_4H';
      state.levelHigh = null; state.levelLow = null;
      state.flagCandle = null; state.lowestLowSinceFlag = null; state.lastProcessed5mTime = null;
      state.interim4hHigh = null; state.interim4hLow = null;
      state.nyOpen  = dayNYOpen(now);
      state.nyClose = dayNYClose(now);
      pushLog(sess, { type: 'INFO', message: `New day ${today}. NY 4h candle: 12:00–16:00 UTC` });
    }

    const nyOpen  = dayNYOpen(now);
    const nyClose = dayNYClose(now);
    state.nyOpen  = nyOpen;
    state.nyClose = nyClose;

    try { state.currentPrice = await fetchTicker(pair); } catch {}

    // ── WAIT_4H ────────────────────────────────────────────────────
    if (state.phase === 'WAIT_4H') {
      if (now < nyOpen) {
        const minsLeft = Math.round((nyOpen - now) / 60000);
        pushLog(sess, { type: 'WAIT',
          message: `Waiting for NY session 4h candle. Opens in ${minsLeft}m at 12:00 UTC` });
        broadcast(sess, { type: 'tick', state: publicState(state) });
        return;
      }
      state.phase = '4H_FORMING';
    }

    // ── 4H_FORMING ────────────────────────────────────────────────
    if (state.phase === '4H_FORMING') {
      const since4h = Math.floor(nyOpen / 1000) - 1;
      const { candles } = await fetchOHLC(pair, 240, since4h);
      const nyCandle = candles.find(c => c.time === nyOpen);
      if (nyCandle) {
        state.interim4hHigh = nyCandle.high;
        state.interim4hLow  = nyCandle.low;
        if (now >= nyClose) {
          state.levelHigh = nyCandle.high;
          state.levelLow  = nyCandle.low;
        }
      }
      if (now < nyClose) {
        const minsLeft = Math.round((nyClose - now) / 60000);
        pushLog(sess, { type: '4H',
          message: `4h candle forming. HIGH=${(state.interim4hHigh||0).toFixed(2)} LOW=${(state.interim4hLow||0).toFixed(2)}. Closes in ${minsLeft}m`,
        });
        broadcast(sess, { type: 'tick', state: publicState(state) });
        return;
      }
      if (!state.levelHigh) {
        pushLog(sess, { type: 'ERROR', message: 'Could not find 12:00 UTC 4h candle — will retry.' });
        state.phase = 'WAIT_4H';
        broadcast(sess, { type: 'tick', state: publicState(state) });
        return;
      }
      state.lastProcessed5mTime = now;
      state.phase = 'WAIT_FLAG';
      pushLog(sess, { type: 'LEVEL',
        message: `NY 4h candle CLOSED. LevelHigh=${state.levelHigh.toFixed(4)} LevelLow=${state.levelLow.toFixed(4)}. Watching 5m chart from NOW.`,
      });
    }

    // ── WAIT_FLAG / WAIT_BUY ──────────────────────────────────────
    if (state.phase === 'WAIT_FLAG' || state.phase === 'WAIT_BUY') {
      const since5m = state.lastProcessed5mTime
        ? Math.floor(state.lastProcessed5mTime / 1000)
        : Math.floor(nyClose / 1000);
      const { candles: c5m } = await fetchOHLC(pair, 5, since5m);

      const newCandles = c5m
        .filter(c => c.time + 300000 < now)
        .filter(c => !state.lastProcessed5mTime || c.time > state.lastProcessed5mTime)
        .sort((a, b) => a.time - b.time);

      for (const c of newCandles) {
        state.lastProcessed5mTime = c.time;

        if (state.phase === 'WAIT_FLAG') {
          if (c.close < state.levelLow) {
            state.flagCandle = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
            state.lowestLowSinceFlag = c.low;
            state.phase = 'WAIT_BUY';
            const ct = new Date(c.time).toISOString().substring(11, 19);
            pushLog(sess, { type: 'FLAG',
              message: `FLAG at ${ct} UTC | Close=${c.close.toFixed(4)} < LevelLow=${state.levelLow.toFixed(4)} | FLAG low=${c.low.toFixed(4)}`,
            });
            broadcast(sess, { type: 'flag', state: publicState(state) });
          }
        } else if (state.phase === 'WAIT_BUY') {
          state.lowestLowSinceFlag = Math.min(state.lowestLowSinceFlag, c.low);
          if (c.close > state.levelLow) {
            const ct = new Date(c.time).toISOString().substring(11, 19);
            pushLog(sess, { type: 'BUY_SIGNAL',
              message: `BUY SIGNAL at ${ct} UTC | Close=${c.close.toFixed(4)} > LevelLow=${state.levelLow.toFixed(4)} | SL (lowest low)=${state.lowestLowSinceFlag.toFixed(4)}`,
            });
            await openTrade(sess, c.close, new Date(c.time).toISOString(), state.lowestLowSinceFlag);
            break;
          }
        }

        if (state.phase === 'IN_TRADE') break;
      }

      if (state.phase !== 'IN_TRADE') {
        const phaseLabel = state.phase === 'WAIT_FLAG'
          ? `Watching for 5m close BELOW LevelLow=${state.levelLow.toFixed(4)}`
          : `FLAG set at ${state.flagCandle ? state.flagCandle.low.toFixed(4) : '?'} — watching for 5m close ABOVE LevelLow=${state.levelLow.toFixed(4)}`;
        pushLog(sess, { type: 'SCAN', message: phaseLabel });
        broadcast(sess, { type: 'tick', state: publicState(state) });
        return;
      }
    }

    // ── IN_TRADE: 30s backup SL check ─────────────────────────────
    if (state.phase === 'IN_TRADE' && state.position) {
      const price = state.currentPrice || state.position.entryPrice;
      const pos   = state.position;

      const prevSL = pos.sl;
      const updated = decrementalSL(pos, price);
      pos.sl = updated.sl;
      pos.trailHigh = updated.trailHigh;
      if (!pos.trailActive && pos.trailHigh >= pos.entryPrice + 2.0 * pos.slDist) {
        pos.trailActive = true;
        if (!sess.trailInterval) {
          sess.trailInterval = setInterval(() => trailCheck(sess), 5000);
        }
        pushLog(sess, { type: 'TRAIL',
          message: `2R hit — Phase 4 trail active (5s interval). TrailAmt=min($25, 0.25×dist)` });
      }
      if (pos.sl > prevSL) {
        const rStr = ((pos.trailHigh - pos.entryPrice) / pos.slDist).toFixed(2);
        pushLog(sess, { type: 'TRAIL', message: `SL raised → ${pos.sl.toFixed(2)} (${rStr}R)` });
      }

      pos.unrealizedPnl = parseFloat(((price - pos.entryPrice) * pos.size).toFixed(4));
      if (price <= pos.sl) {
        await closeTrade(sess, pos.sl, `SL hit at ${pos.sl.toFixed(4)}`);
        return;
      }
      broadcast(sess, { type: 'tick', state: publicState(state) });
    }

  } catch (err) {
    state.error = err.message;
    pushLog(sess, { type: 'ERROR', message: err.message });
    broadcast(sess, { type: 'error', message: err.message, state: publicState(state) });
  }
}

async function tick(sess) {
  if (sess.tickBusy) return;
  sess.tickBusy = true;
  try { await runTick(sess); } finally { sess.tickBusy = false; }
}

// ── Dynamic tick scheduler ───────────────────────────────────────────
function scheduleNextTick(sess) {
  if (!sess.state.running) return;
  if (sess.ticker) { clearTimeout(sess.ticker); sess.ticker = null; }

  const now   = Date.now();
  const phase = sess.state.phase;
  let delayMs;

  if (phase === 'WAIT_FLAG' || phase === 'WAIT_BUY') {
    const FIVE_MIN = 5 * 60 * 1000;
    const nextCandleClose = (Math.floor(now / FIVE_MIN) + 1) * FIVE_MIN;
    delayMs = nextCandleClose + 1000 - now;
    if (delayMs < 500) delayMs += FIVE_MIN;
  } else {
    delayMs = 60 * 1000;
  }

  sess.ticker = setTimeout(async () => {
    sess.ticker = null;
    await tick(sess);
    scheduleNextTick(sess);
  }, delayMs);
}

// ── Backtest ────────────────────────────────────────────────────────
async function runBacktest(symbol, months, onProgress) {
  const pair    = KRAKEN_PAIRS[symbol] || 'XBTUSD';
  const fromMs  = Date.now() - Math.ceil(months * 30.44 * 24 * 3600 * 1000);

  onProgress('Fetching 4h candles from Kraken (NY session levels)…');
  const candles4h = await fetchAllOHLC(pair, 240, fromMs);
  if (!candles4h.length) throw new Error('No 4h candles returned from Kraken');

  onProgress('Fetching 1h candles from Kraken (FLAG/BUY simulation)…');
  const candles1h = await fetchAllOHLC(pair, 60, fromMs);
  if (!candles1h.length) throw new Error('No 1h candles returned from Kraken');

  const dataFromMs = Math.min(candles4h[0].time, candles1h[0].time);
  const dataToMs   = Math.max(candles4h[candles4h.length-1].time, candles1h[candles1h.length-1].time);
  const actualDays = Math.round((dataToMs - dataFromMs) / (24 * 3600 * 1000));

  onProgress(`Simulating on ${candles4h.length} × 4h + ${candles1h.length} × 1h candles (${actualDays} days of data)…`);

  const c1hByDay = new Map();
  for (const c of candles1h) {
    const d = new Date(c.time);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    if (!c1hByDay.has(key)) c1hByDay.set(key, []);
    c1hByDay.get(key).push(c);
  }

  const nyCandles = candles4h.filter(c => new Date(c.time).getUTCHours() === 12);

  let balance = 10000;
  const initialBalance = 10000;
  let peakBal = balance, maxDD = 0;
  const trades = [];
  let wins = 0;
  let daysScanned = 0, daysWithSetup = 0;

  for (const nyCandle of nyCandles) {
    daysScanned++;
    const nyOpenMs  = nyCandle.time;
    const nyCloseMs = nyCandle.time + 4 * 3600 * 1000;
    const d = new Date(nyOpenMs);
    const dayKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;

    const levelHigh = nyCandle.high;
    const levelLow  = nyCandle.low;

    const all1hDay = c1hByDay.get(dayKey) || [];
    const window1h = all1hDay.filter(c => c.time >= nyCloseMs).sort((a, b) => a.time - b.time);
    if (!window1h.length) continue;

    let flagCandle = null;
    let lowestLowSinceFlag = Infinity;
    let position   = null;
    let phase = 'WAIT_FLAG';

    for (const c of window1h) {
      if (phase === 'WAIT_FLAG') {
        if (c.close < levelLow) {
          flagCandle = c;
          lowestLowSinceFlag = c.low;
          phase = 'WAIT_BUY';
        }
        continue;
      }

      if (phase === 'WAIT_BUY') {
        lowestLowSinceFlag = Math.min(lowestLowSinceFlag, c.low);
        if (c.close > levelLow) {
          const entryPrice = c.close;
          const sl    = lowestLowSinceFlag;
          const slDist = entryPrice - sl;
          if (slDist <= 0) continue;
          const tp     = entryPrice + 2.0 * slDist;
          const size   = (balance * 0.02) / slDist;
          position = {
            entryPrice, sl, slDist, tp, size, entryTime: c.time,
            trailHigh: entryPrice, trailActive: false,
            originalSL: sl, flagLow: flagCandle.low,
          };
          phase = 'IN_TRADE';
          daysWithSetup++;
        }
        continue;
      }

      if (phase === 'IN_TRADE') {
        const pos = position;
        const updH = decrementalSL(pos, c.high);
        pos.sl = updH.sl; pos.trailHigh = updH.trailHigh;
        if (!pos.trailActive && pos.trailHigh >= pos.entryPrice + 2.0 * pos.slDist) pos.trailActive = true;

        if (c.low <= pos.sl) {
          const exitPrice = pos.sl;
          const pnl = (exitPrice - pos.entryPrice) * pos.size;
          balance += pnl; if (pnl > 0) wins++;
          if (balance > peakBal) peakBal = balance;
          const dd = peakBal - balance; if (dd > maxDD) maxDD = dd;
          trades.push({
            date: dayKey, entryPrice: +pos.entryPrice.toFixed(2), exitPrice: +exitPrice.toFixed(2),
            pnl: +pnl.toFixed(2), balance: +balance.toFixed(2),
            entryTime: new Date(pos.entryTime).toISOString(), exitTime: new Date(c.time).toISOString(),
            levelHigh: +levelHigh.toFixed(2), levelLow: +levelLow.toFixed(2),
            flagLow: +pos.flagLow.toFixed(2), lowestLow: +pos.originalSL.toFixed(2),
            reason: pos.trailActive ? 'Trail SL hit' : 'SL hit', trailActive: pos.trailActive,
          });
          phase = 'WAIT_FLAG';
          flagCandle = null; lowestLowSinceFlag = Infinity; position = null;
          continue;
        }
      }
    }

    if (phase === 'IN_TRADE' && position) {
      const last = window1h[window1h.length - 1];
      const pnl = (last.close - position.entryPrice) * position.size;
      balance += pnl; if (pnl > 0) wins++;
      if (balance > peakBal) peakBal = balance;
      const dd = peakBal - balance; if (dd > maxDD) maxDD = dd;
      trades.push({
        date: dayKey, entryPrice: +position.entryPrice.toFixed(2), exitPrice: +last.close.toFixed(2),
        pnl: +pnl.toFixed(2), balance: +balance.toFixed(2),
        entryTime: new Date(position.entryTime).toISOString(), exitTime: new Date(last.time).toISOString(),
        levelHigh: +levelHigh.toFixed(2), levelLow: +levelLow.toFixed(2),
        flagLow: +position.flagLow.toFixed(2), lowestLow: +position.originalSL.toFixed(2),
        reason: 'EOD close', trailActive: position.trailActive,
      });
    }
  }

  const total  = trades.length;
  const netPnl = balance - initialBalance;
  return {
    trades,
    summary: {
      totalTrades: total, wins, losses: total - wins,
      winRate:       total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0',
      totalPnl:      +netPnl.toFixed(2),
      pnlPct:        ((netPnl / initialBalance) * 100).toFixed(2),
      maxDrawdown:   +maxDD.toFixed(2),
      finalBalance:  +balance.toFixed(2),
      daysScanned, daysWithSetup,
      fourHCandles: nyCandles.length,
      oneHCandles: candles1h.length,
      actualDays,
      note: 'Backtest uses 1h candles for FLAG/BUY signals. Live trading uses 5m candles.',
      period: `${months}m requested / ${actualDays}d data available`,
      symbol,
    },
  };
}

// ── Express app ────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: false, maxAge: 7 * 24 * 3600 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'web')));

// CORS — allow hub dashboard to poll
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function requireAuth(req, res, next) { req.userId = 'guest'; next(); }

app.get('/health', (_, res) => res.json({ status: 'ok', strategy: 'RobAlgo6 — NY Session 4H+5M', port: PORT }));
app.get('/api/state',  requireAuth, (req, res) => res.json(publicState(getSession(req.userId).state)));
app.get('/api/logs',   requireAuth, (req, res) => res.json(getSession(req.userId).logs));
app.get('/api/trades', requireAuth, (req, res) => {
  const { session: sid } = req.query;
  const sess = getSession(req.userId);
  const rows = sid
    ? db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(sid)
    : (sess.state.sessionId ? db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(sess.state.sessionId) : []);
  res.json(rows);
});

app.post('/api/start', requireAuth, async (req, res) => {
  const sess = getSession(req.userId);
  if (sess.state.running) return res.json({ ok: false, msg: 'Already running' });
  const { symbol = 'BTCUSDT', balance = 10000, mode = 'paper' } = req.body || {};

  if (mode === 'live' && !rhClient.authenticated) {
    return res.json({ ok: false, msg: 'Robinhood not connected — use /api/rh-auth first or set RH_API_KEY_ID + RH_API_PRIVATE_KEY env vars' });
  }

  let bal = parseFloat(balance);

  // Sync starting balance from Robinhood in live mode
  if (mode === 'live' && rhClient.authenticated) {
    const rhBal = await rhClient.getPortfolioBalance();
    if (rhBal !== null && rhBal > 0) {
      bal = rhBal;
      console.log(`[RH] Using Robinhood portfolio balance: $${bal.toFixed(2)}`);
    }
  }

  Object.assign(sess.state, {
    running: true, symbol, mode,
    balance: bal, initialBalance: bal,
    sessionId: `s_${Date.now()}_${req.userId}`, sessionStart: new Date().toISOString(),
    pnl: 0, totalTrades: 0, wins: 0, error: null,
    peakBalance: bal, maxDrawdownDollar: 0, maxDrawdownPct: 0,
    phase: 'WAIT_4H', levelHigh: null, levelLow: null, flagCandle: null,
    position: null, todayDate: null, lastProcessed5mTime: null,
    interim4hHigh: null, interim4hLow: null,
  });
  sess.logs = [];
  (async () => { await tick(sess); scheduleNextTick(sess); })();
  broadcast(sess, { type: 'started', state: publicState(sess.state) });
  res.json({ ok: true, state: publicState(sess.state) });
});

app.post('/api/stop', requireAuth, (req, res) => {
  const sess = getSession(req.userId);
  if (!sess.state.running) return res.json({ ok: false, msg: 'Not running' });
  if (sess.ticker)        { clearTimeout(sess.ticker);         sess.ticker        = null; }
  if (sess.trailInterval) { clearInterval(sess.trailInterval); sess.trailInterval = null; }
  sess.state.running = false;
  broadcast(sess, { type: 'stopped', state: publicState(sess.state) });
  res.json({ ok: true, state: publicState(sess.state) });
});

app.post('/api/backtest', requireAuth, async (req, res) => {
  const { symbol = 'BTCUSDT', months = 3 } = req.body || {};
  const m = Math.max(1, Math.min(12, parseInt(months, 10) || 3));
  try {
    const result = await runBacktest(symbol, m, msg => console.log('[BT]', msg));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

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

// ── Robinhood Auth endpoints ──────────────────────────────────────
app.get('/api/rh-status', (_, res) => res.json({
  connected: rhClient.authenticated,
  accountId: rhClient.accountId || null,
  mode:      rhClient.mode,
}));

app.post('/api/rh-auth', async (req, res) => {
  const { username, password, mfaCode, mfaSecret } = req.body || {};
  if (!username || !password) {
    return res.json({ ok: false, error: 'username and password are required' });
  }
  const code = mfaCode || (mfaSecret ? generateTOTP(mfaSecret) : undefined);
  try {
    const result = await rhClient.login(username, password, code);
    if (result.mfaRequired) return res.json({ ok: false, mfaRequired: true });
    try { await rhClient.getAccountId(); } catch {}
    return res.json({ ok: true, accountId: rhClient.accountId });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

app.post('/api/rh-logout', (_, res) => {
  rhClient.logout();
  res.json({ ok: true });
});

app.listen(PORT, () =>
  console.log(`RobAlgo6 — NY Session 4H+5M + Robinhood Live on :${PORT}`)
);
