'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const session  = require('express-session');

// ── Config ─────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT || '3018', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'cbt-algo66-dev-secret';
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// MetaAPI credentials — set via Railway env vars, never hardcode
const METAAPI_TOKEN  = process.env.METAAPI_TOKEN  || '';
const METAAPI_REGION = process.env.METAAPI_REGION || 'new-york';

// Multi-account support:
// Set METAAPI_ACCOUNTS as a JSON array, e.g.:
//   [{"id":"8486...","label":"Tickmill Demo 1 (#25329025)"},{"id":"xxxx","label":"Demo 2 (#99999)"}]
// Falls back to single METAAPI_ACCOUNT_ID for backward compat.
let MT5_ACCOUNTS = [];
try {
  const raw = process.env.METAAPI_ACCOUNTS || '';
  if (raw) MT5_ACCOUNTS = JSON.parse(raw);
} catch {}
if (!MT5_ACCOUNTS.length && process.env.METAAPI_ACCOUNT_ID) {
  MT5_ACCOUNTS = [{ id: process.env.METAAPI_ACCOUNT_ID, label: 'Default Account' }];
}
// Keep legacy single-ID constant for internal helpers that haven't been updated yet
const METAAPI_ACCOUNT_ID = MT5_ACCOUNTS[0]?.id || '';

// MT5 symbol names on Tickmill (no USDT suffix)
const MT5_SYMBOL_MAP = {
  'BTCUSDT': 'BTCUSD', 'ETHUSDT': 'ETHUSD',
  'SOLUSDT': 'SOLUSD', 'XRPUSDT': 'XRPUSD',
  'LTCUSDT': 'LTCUSD', 'ADAUSDT': 'ADAUSD',
};
const MAX_LOTS = 10.0;
const MIN_LOTS = 0.01;
const RISK_PCT = 0.02;

// ── MetaAPI REST client ─────────────────────────────────────────────
// accountId defaults to the first configured account
function metaapiRequest(method, apiPath, body, accountId) {
  const acctId = accountId || METAAPI_ACCOUNT_ID;
  return new Promise((resolve, reject) => {
    if (!METAAPI_TOKEN || !acctId) {
      return reject(new Error('MetaAPI credentials not configured (METAAPI_TOKEN / METAAPI_ACCOUNTS env vars missing)'));
    }
    const bodyStr = body ? JSON.stringify(body) : null;
    const hostname = `mt-client-api-v1.${METAAPI_REGION}.agiliumtrade.ai`;
    const fullPath = `/users/current/accounts/${acctId}${apiPath}`;
    const headers = { 'auth-token': METAAPI_TOKEN, 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({ hostname, path: fullPath, method, headers }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('MetaAPI timeout')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// 6 retries × 2s = up to 12s wait for the MT5 terminal to finish syncing
async function mt5GetAccountInfo(accountId) {
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const r = await metaapiRequest('GET', '/account-information', null, accountId);
    if (r.status === 200) return r.body;
    lastErr = `MetaAPI account-info error ${r.status}: ${JSON.stringify(r.body)}`;
    if (attempt < 6) await new Promise(res => setTimeout(res, 2000));
  }
  throw new Error(lastErr);
}

async function mt5PlaceBuy(mt5Symbol, lots, stopLoss, accountId) {
  const r = await metaapiRequest('POST', '/trade', {
    actionType: 'ORDER_TYPE_BUY',
    symbol: mt5Symbol,
    volume: parseFloat(lots.toFixed(2)),
    stopLoss: parseFloat(stopLoss.toFixed(2)),
  }, accountId);
  if (r.status !== 200) throw new Error(`MetaAPI buy error ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function mt5ModifySL(positionId, stopLoss, accountId) {
  const r = await metaapiRequest('POST', '/trade', {
    actionType: 'POSITION_MODIFY',
    positionId: String(positionId),
    stopLoss: parseFloat(stopLoss.toFixed(2)),
  }, accountId);
  return r.body;
}

async function mt5ClosePosition(positionId, accountId) {
  const r = await metaapiRequest('POST', '/trade', {
    actionType: 'POSITION_CLOSE_ID',
    positionId: String(positionId),
  }, accountId);
  return r.body;
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
        headers: { 'User-Agent': 'CBT-Algo66/1.0' } },
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
    mt5_position_id TEXT, mt5_mode TEXT
  )
`);
['level_high REAL','level_low REAL','flag_low REAL','mt5_position_id TEXT','mt5_mode TEXT'].forEach(col => {
  try { db.exec(`ALTER TABLE trades ADD COLUMN ${col}`); } catch {}
});
const stmtInsert = db.prepare(`
  INSERT INTO trades (session_id,user_id,type,side,symbol,timeframe,price,size,pnl,
    stop_loss,take_profit,reason,balance_after,timestamp,mae,level_high,level_low,flag_low,mt5_position_id,mt5_mode)
  VALUES (@session_id,@user_id,@type,@side,@symbol,@timeframe,@price,@size,@pnl,
    @stop_loss,@take_profit,@reason,@balance_after,@timestamp,@mae,@level_high,@level_low,@flag_low,@mt5_position_id,@mt5_mode)
`);

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
    // MT5 state
    mt5Balance: null, mt5Equity: null, mt5Leverage: null,
    mt5AccountState: null,
    selectedAccountId: MT5_ACCOUNTS[0]?.id || '',
    selectedAccountLabel: MT5_ACCOUNTS[0]?.label || '',
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
    mt5Balance: s.mt5Balance, mt5Equity: s.mt5Equity,
    mt5Leverage: s.mt5Leverage, mt5AccountState: s.mt5AccountState,
    selectedAccountId: s.selectedAccountId,
    selectedAccountLabel: s.selectedAccountLabel,
    mt5Accounts: MT5_ACCOUNTS,
  };
}

// ── Position sizing ─────────────────────────────────────────────────
// For live mode: use actual MT5 equity for risk calculation
// lots = (equity × RISK_PCT) / slDist, capped between MIN_LOTS and MAX_LOTS
async function calcLots(state, slDist) {
  let equity = state.balance;
  if (state.mode === 'live' && METAAPI_TOKEN) {
    try {
      const info = await mt5GetAccountInfo(state.selectedAccountId);
      equity = info.equity || info.balance || equity;
      state.mt5Balance  = info.balance;
      state.mt5Equity   = info.equity;
      state.mt5Leverage = info.leverage;
    } catch {
      // Fall back to local balance if MT5 unreachable
    }
  }
  const raw = (equity * RISK_PCT) / slDist;
  return parseFloat(Math.max(MIN_LOTS, Math.min(MAX_LOTS, raw)).toFixed(2));
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
  const tp   = parseFloat((entryPrice + 2.0 * slDist).toFixed(4));
  const lots = await calcLots(state, slDist);
  const size = lots; // lots = position size for BTC/USD on MT5

  let mt5PositionId = null;

  // Route to MT5 when in live mode
  if (state.mode === 'live') {
    const mt5Symbol = MT5_SYMBOL_MAP[symbol] || 'BTCUSD';
    try {
      pushLog(sess, { type: 'MT5', message: `Placing BUY on MT5: ${mt5Symbol} ${lots} lots SL=${sl.toFixed(2)}` });
      const result = await mt5PlaceBuy(mt5Symbol, lots, sl, state.selectedAccountId);
      mt5PositionId = result.positionId || result.orderId || null;
      const code = result.stringCode || result.numericCode || 'unknown';
      pushLog(sess, { type: 'MT5', message: `MT5 order placed: ${code} | positionId=${mt5PositionId}` });
    } catch (e) {
      pushLog(sess, { type: 'ERROR', message: `MT5 BUY failed: ${e.message} — trade NOT opened` });
      return; // abort if live trade fails
    }
  }

  state.position = {
    side: 'long', entryPrice, sl, tp, slDist, size, lots,
    entryTime: entryTimeIso,
    trailActive: false, trailHigh: entryPrice,
    unrealizedPnl: 0, originalSL: sl,
    mt5PositionId,
  };
  state.phase = 'IN_TRADE';

  stmtInsert.run({
    session_id: sessionId, user_id: userId,
    type: 'entry', side: 'long', symbol, timeframe: '5m',
    price: entryPrice, size, pnl: 0, stop_loss: sl, take_profit: tp,
    reason: `BUY: 5m close ${entryPrice.toFixed(4)} > LevelLow ${levelLow.toFixed(4)} | SL=${sl} (lowest low flag→entry) | lots=${lots}`,
    balance_after: parseFloat(state.balance.toFixed(4)),
    timestamp: entryTimeIso, mae: 0,
    level_high: state.levelHigh, level_low: state.levelLow, flag_low: sl,
    mt5_position_id: mt5PositionId ? String(mt5PositionId) : null,
    mt5_mode: state.mode,
  });
  const riskAmt = (state.mt5Equity || state.balance) * RISK_PCT;
  pushLog(sess, {
    type: 'ENTRY', side: 'long', price: entryPrice, size, sl, tp,
    message: `BUY ${entryPrice.toFixed(2)} | SL=${sl.toFixed(2)} | 2R-ref=${tp.toFixed(2)} | dist=${slDist.toFixed(2)} | lots=${lots} | risk=$${riskAmt.toFixed(2)}${mt5PositionId ? ' | MT5 ID=' + mt5PositionId : ''}`,
  });
  broadcast(sess, { type: 'trade', state: publicState(state) });
}

async function closeTrade(sess, exitPrice, reason) {
  const { state } = sess;
  const { position, symbol, sessionId, levelHigh, levelLow, flagCandle } = state;
  const userId = sess.userId;
  if (!position) return;

  // Close on MT5 if live
  if (state.mode === 'live' && position.mt5PositionId) {
    try {
      pushLog(sess, { type: 'MT5', message: `Closing MT5 position ${position.mt5PositionId}` });
      const result = await mt5ClosePosition(position.mt5PositionId, state.selectedAccountId);
      const code = result.stringCode || result.numericCode || 'unknown';
      pushLog(sess, { type: 'MT5', message: `MT5 position closed: ${code}` });
    } catch (e) {
      pushLog(sess, { type: 'ERROR', message: `MT5 close failed: ${e.message}` });
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
    mt5_position_id: position.mt5PositionId ? String(position.mt5PositionId) : null,
    mt5_mode: state.mode,
  });
  pushLog(sess, {
    type: 'EXIT', price: exitPrice, pnl, reason,
    message: `EXIT ${exitPrice.toFixed(2)} | PnL=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | Balance=$${state.balance.toFixed(2)}`,
  });
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

// Update MT5 position SL when trailing (best-effort, non-fatal)
async function updateMt5SL(sess, positionId, newSL) {
  try {
    await mt5ModifySL(positionId, newSL, sess.state.selectedAccountId);
  } catch (e) {
    pushLog(sess, { type: 'WARN', message: `MT5 SL modify failed: ${e.message}` });
  }
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
      // Sync SL to MT5 when live
      if (state.mode === 'live' && pos.mt5PositionId) {
        updateMt5SL(sess, pos.mt5PositionId, pos.sl);
      }
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
      const nyOpenStr  = new Date(state.nyOpen).toISOString().substring(11, 16);
      const nyCloseStr = new Date(state.nyClose).toISOString().substring(11, 16);
      pushLog(sess, { type: 'INFO', message: `New day ${today}. NY 4h candle: ${nyOpenStr}–${nyCloseStr} UTC` });
    }

    const nyOpen  = dayNYOpen(now);
    const nyClose = dayNYClose(now);
    state.nyOpen  = nyOpen;
    state.nyClose = nyClose;

    try { state.currentPrice = await fetchTicker(pair); } catch {}

    // Refresh MT5 account info periodically in live mode (silent on transient errors)
    if (state.mode === 'live' && METAAPI_TOKEN && !state.position) {
      try {
        const info = await mt5GetAccountInfo(state.selectedAccountId);
        state.mt5Balance      = info.balance;
        state.mt5Equity       = info.equity;
        state.mt5Leverage     = info.leverage;
        state.mt5AccountState = 'CONNECTED';
      } catch {
        // Keep last known values — transient 500s don't affect trade operations
        if (!state.mt5AccountState || state.mt5AccountState === 'CONNECTING…') {
          state.mt5AccountState = state.mt5Balance != null ? 'CONNECTED (cached)' : 'CONNECTING…';
        }
      }
    }

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

    // ── 4H_FORMING ─────────────────────────────────────────────────
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

    // ── WAIT_FLAG / WAIT_BUY ───────────────────────────────────────
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

    // ── IN_TRADE ───────────────────────────────────────────────────
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
        // Sync SL to MT5 when live
        if (state.mode === 'live' && pos.mt5PositionId) {
          updateMt5SL(sess, pos.mt5PositionId, pos.sl);
        }
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
          const lots   = parseFloat(Math.max(MIN_LOTS, Math.min(MAX_LOTS, (balance * RISK_PCT) / slDist)).toFixed(2));
          position = {
            entryPrice, sl, slDist, tp, size: lots, entryTime: c.time,
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
      note: 'Backtest uses 1h candles for FLAG/BUY signals (Kraken public API limit). Live trading uses 5m candles.',
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

function requireAuth(req, res, next) { req.userId = 'guest'; next(); }

app.get('/health', (_, res) => res.json({ status: 'ok', strategy: 'NY Session 4H+5M + MetaAPI MT5' }));
app.get('/api/state', requireAuth, (req, res) => res.json(publicState(getSession(req.userId).state)));
app.get('/api/logs',  requireAuth, (req, res) => res.json(getSession(req.userId).logs));
app.get('/api/trades', requireAuth, (req, res) => {
  const { session: sid } = req.query;
  const sess = getSession(req.userId);
  const rows = sid
    ? db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(sid)
    : (sess.state.sessionId ? db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(sess.state.sessionId) : []);
  res.json(rows);
});

// List all configured MT5 accounts
app.get('/api/mt5/accounts', requireAuth, (req, res) => {
  res.json({ ok: true, accounts: MT5_ACCOUNTS, region: METAAPI_REGION });
});

// MT5 account status — accepts ?id=accountId, defaults to first account
app.get('/api/mt5/status', requireAuth, async (req, res) => {
  if (!METAAPI_TOKEN || !MT5_ACCOUNTS.length) {
    return res.json({ ok: false, error: 'METAAPI_TOKEN / METAAPI_ACCOUNTS env vars not set' });
  }
  const accountId = req.query.id || MT5_ACCOUNTS[0].id;
  const acct = MT5_ACCOUNTS.find(a => a.id === accountId) || MT5_ACCOUNTS[0];
  try {
    const info = await mt5GetAccountInfo(acct.id);
    res.json({
      ok: true,
      accountId: acct.id,
      label: acct.label,
      region: METAAPI_REGION,
      accountInfo: info,
      provisioning: { state: 'DEPLOYED', server: info.broker || 'Tickmill-Demo', login: info.login },
    });
  } catch (e) {
    res.json({
      ok: false,
      softError: true,
      accountId: acct.id,
      label: acct.label,
      region: METAAPI_REGION,
      error: e.message,
    });
  }
});

// Deploy is managed via MetaAPI dashboard
app.post('/api/mt5/deploy', requireAuth, (req, res) => {
  res.json({ ok: true, dashboardUrl: 'https://app.metaapi.cloud/accounts' });
});

app.post('/api/start', requireAuth, (req, res) => {
  const sess = getSession(req.userId);
  if (sess.state.running) return res.json({ ok: false, msg: 'Already running' });
  const { symbol = 'BTCUSDT', balance = 10000, mode = 'paper', accountId } = req.body || {};
  // Resolve selected account
  const acct = (accountId && MT5_ACCOUNTS.find(a => a.id === accountId))
    || MT5_ACCOUNTS[0]
    || { id: '', label: 'None' };
  Object.assign(sess.state, {
    running: true, symbol, mode,
    balance: parseFloat(balance), initialBalance: parseFloat(balance),
    sessionId: `s_${Date.now()}_${req.userId}`, sessionStart: new Date().toISOString(),
    pnl: 0, totalTrades: 0, wins: 0, error: null,
    peakBalance: parseFloat(balance), maxDrawdownDollar: 0, maxDrawdownPct: 0,
    phase: 'WAIT_4H', levelHigh: null, levelLow: null, flagCandle: null,
    position: null, todayDate: null, lastProcessed5mTime: null,
    interim4hHigh: null, interim4hLow: null,
    mt5Balance: null, mt5Equity: null, mt5Leverage: null, mt5AccountState: null,
    selectedAccountId: acct.id,
    selectedAccountLabel: acct.label,
  });
  sess.logs = [];
  if (mode === 'live' && (!METAAPI_TOKEN || !acct.id)) {
    pushLog(sess, { type: 'WARN', message: 'LIVE mode selected but MetaAPI credentials are not set — trades will NOT be routed to MT5!' });
  } else if (mode === 'live') {
    pushLog(sess, { type: 'INFO', message: `Live trading on: ${acct.label} (${acct.id})` });
  }
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

app.listen(PORT, () =>
  console.log(`CBT Algo66 — NY Session 4H+5M + MetaAPI MT5 on :${PORT}`)
);
