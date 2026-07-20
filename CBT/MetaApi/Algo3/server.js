'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const dns      = require('dns');
const Database = require('better-sqlite3');
const session  = require('express-session');
const { OAuth2Client } = require('google-auth-library');

// Railway's default resolver has failed to look up mt-provisioning-api-v1.agiliumtrade.ai
// intermittently — force public resolvers so MetaApi calls can succeed.
try {
  dns.setDefaultResultOrder('ipv4first');
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch (e) { console.warn('[dns] override failed:', e.message); }
const {
  RF_SAMPLING_PERIOD, RF_MULT, MAX_LOSS, SL_ATR_MULT,
  TRAIL_START_PNL, TRAIL_STEP_PNL, MIN_ATR, ATR_LEN,
  WARMUP_BARS,
  generateSignal, initPosition, stepPosition,
  // NOTE: Kraken fetchers from algo.js are intentionally NOT imported here —
  // this service must always source market data from the connected MetaApi/Tickmill account.
} = require('./algo');

// ── Config ────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '3010', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AUTH_REQUIRED    = !!GOOGLE_CLIENT_ID;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'cbt-metaapi-algo3-dev-secret';

const METAAPI_TOKEN      = process.env.METAAPI_TOKEN      || '';
const METAAPI_REGION     = process.env.METAAPI_REGION     || 'new-york';
const DEFAULT_ACCOUNT_ID = '135bd50b-39a1-4b6f-b291-82cb52c7c988';   // Tickmill demo default
const METAAPI_ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;

// Official MetaApi SDK — knows the current API URLs and handles retries.
const MetaApiSDK = (() => {
  if (!METAAPI_TOKEN) return null;
  try {
    const mod = require('metaapi.cloud-sdk');
    const MetaApi = mod.default || mod;
    return new MetaApi(METAAPI_TOKEN, {
      domain:            process.env.METAAPI_DOMAIN || 'agiliumtrade.agiliumtrade.ai',
      requestTimeout:    30,
      connectTimeout:    30,
      retryOpts:         { retries: 2, minDelayInSeconds: 1, maxDelayInSeconds: 5 },
    });
  } catch (e) {
    console.error('[MetaApi SDK] failed to init:', e.message);
    return null;
  }
})();

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
    `${dir} *[Algo3 RF+KAMA] ENTRY — ${label} ${sym} ${timeframe}*\n` +
    `Price      : $${f(price)}\n` +
    `Size       : ${f(size, 5)} ${symbol.replace('USDT', '')}\n` +
    `Initial SL : $${f(sl)}  (flag ${side === 'long' ? 'low' : 'high'}, risk/unit $${f(riskPerUnit)})\n` +
    `Risk       : $${f(riskAmt)}  (fixed $${f(MAX_LOSS)} × sizeFactor)\n` +
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
    `${icon} *[Algo3 RF+KAMA] EXIT — ${label} ${sym} ${timeframe}*\n` +
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
    name: 'rf-kama-v2: Range Filter + KAMA Cloud Strategy V2',
    description: `Range Filter (period ${RF_SAMPLING_PERIOD}, mult ${RF_MULT}) + KAMA cloud gate + flag-candle triggers. Fixed-$${MAX_LOSS} sizing: SL = entry ± ${SL_ATR_MULT}×ATR; qty = ($${MAX_LOSS} / (${SL_ATR_MULT}×ATR)) × sizeFactor → SL hit = $${MAX_LOSS} × sizeFactor loss. Trailing starts @ +$${TRAIL_START_PNL} × sizeFactor PnL (locks $${TRAIL_START_PNL - TRAIL_STEP_PNL} × sizeFactor), +$${TRAIL_STEP_PNL} × sizeFactor per step. Entries skipped when ATR < ${MIN_ATR}. SL & trailing scanned every 1s from entry.`,
  },
};

// ── Tickmill / MetaApi Adapter (uses official metaapi.cloud-sdk) ────
const tickmill = {
  mode: MetaApiSDK ? 'metaapi' : 'paper-kraken',
  _accountStatus: new Map(),   // accountId -> deployed bool
  _accountMeta:   new Map(),   // accountId -> { region, state, ...}
  _rpcCache:      new Map(),   // accountId -> synchronized RPC connection

  async _getAccount(accountId) {
    if (!MetaApiSDK) throw new Error('MetaApi SDK not initialized (missing METAAPI_TOKEN)');
    return MetaApiSDK.metatraderAccountApi.getAccount(accountId);
  },

  async checkAccount(accountId) {
    if (!MetaApiSDK || !accountId) return false;
    try {
      const acct = await this._getAccount(accountId);
      const meta = {
        deployed:  acct.state === 'DEPLOYED',
        region:    acct.region || null,
        name:      acct.name || null,
        broker:    acct.brokerName || null,
        server:    acct.server || null,
        platform:  acct.type || acct.platform || null,
        state:     acct.state || null,
        connectionStatus: acct.connectionStatus || null,
        login:     acct.login || null,
        updatedAt: Date.now(),
      };
      this._accountMeta.set(accountId, meta);
      this._accountStatus.set(accountId, meta.deployed);
      console.log(`[MetaApi Algo3] account ${accountId.slice(0,8)}… state=${meta.state} region=${meta.region}`);
      return meta.deployed;
    } catch (err) {
      console.error(`[MetaApi Algo3] getAccount(${accountId.slice(0,8)}…) failed:`, err.message);
      this._accountStatus.set(accountId, false);
      this._accountMeta.set(accountId, { deployed: false, error: err.message, updatedAt: Date.now() });
      return false;
    }
  },
  isConnected(accountId) { return !!this._accountStatus.get(accountId); },
  getMeta(accountId)     { return this._accountMeta.get(accountId) || null; },

  async updateAccount(accountId, patch) {
    const acct = await this._getAccount(accountId);
    await acct.update(patch);
    return { updated: Object.keys(patch) };
  },
  async deployAccount(accountId) {
    const acct = await this._getAccount(accountId);
    await acct.deploy();
    return { ok: true };
  },
  async undeployAccount(accountId) {
    const acct = await this._getAccount(accountId);
    await acct.undeploy();
    this._rpcCache.delete(accountId);
    return { ok: true };
  },

  async _getRpc(accountId) {
    let rpc = this._rpcCache.get(accountId);
    if (rpc) return rpc;
    const acct = await this._getAccount(accountId);
    // Deploy if idle, then wait until MetaApi says it's connected.
    if (acct.state !== 'DEPLOYED') await acct.deploy();
    await acct.waitConnected(90, 5000);          // 90s max
    rpc = acct.getRPCConnection();
    await rpc.connect();
    await rpc.waitSynchronized({ timeoutInSeconds: 60 });
    this._rpcCache.set(accountId, rpc);
    return rpc;
  },

  async accountInformation(accountId) {
    const rpc = await this._getRpc(accountId);
    return rpc.getAccountInformation();
  },

  async placeOrder(accountId, side, symbol, lots, stopLoss, takeProfit, comment) {
    if (!MetaApiSDK) return { paper: true, orderId: `paper_${Date.now()}` };
    try {
      const rpc = await this._getRpc(accountId);
      const tkSymbol = symbol.replace('USDT', 'USD');
      const opts = { comment: comment || 'CBT MetaApi Algo3' };
      if (stopLoss   != null) opts.stopLoss   = stopLoss;
      if (takeProfit != null) opts.takeProfit = takeProfit;
      const result = side === 'long'
        ? await rpc.createMarketBuyOrder(tkSymbol, lots, null, null, opts)
        : await rpc.createMarketSellOrder(tkSymbol, lots, null, null, opts);
      return { orderId: result.orderId || result.positionId, live: true, accountId, raw: result };
    } catch (err) {
      console.error('[MetaApi Algo3] placeOrder error:', err.message);
      return { paper: true, orderId: `paper_${Date.now()}`, error: err.message };
    }
  },

  async closeOrder(accountId, orderId) {
    if (!orderId || String(orderId).startsWith('paper_')) return { paper: true };
    try {
      const rpc = await this._getRpc(accountId);
      const r = await rpc.closePosition(orderId);
      return { closed: true, raw: r };
    } catch (err) {
      console.error('[MetaApi Algo3] closeOrder error:', err.message);
      return { error: err.message };
    }
  },
};

// Warm up the default account so /api/tickmill can report status before /api/start is hit.
if (METAAPI_TOKEN) tickmill.checkAccount(METAAPI_ACCOUNT_ID).catch(() => {});

// ── MetaApi market-data fetchers ─────────────────────────────────
// Endpoints: https://metaapi.cloud/docs/client/restApi/api/readHistoricalMarketData/
//   GET /users/current/accounts/{accountId}/historical-market-data/symbols/{symbol}/timeframes/{tf}/candles
//   GET /users/current/accounts/{accountId}/symbols/{symbol}/current-price?keepSubscription=true
// Symbols on Tickmill use the "USD" suffix (BTCUSD, ETHUSD, …); source symbol is BTCUSDT-style.
function tkSymbolOf(symbol) { return symbol.replace('USDT', 'USD'); }

// Market-data via SDK. Historical candles live on the account object
// (metatraderAccount.getHistoricalCandles); live prices go through RPC.
async function fetchCandlesMeta(accountId, symbol, timeframe, limit = 720) {
  if (!MetaApiSDK) throw new Error('MetaApi SDK not initialized');
  const tkSymbol = tkSymbolOf(symbol);
  const acct    = await tickmill._getAccount(accountId);
  const ivMs    = CANDLE_MS[timeframe] || 60000;
  const nowMs   = Date.now();
  const wantN   = Math.min(1000, limit);
  // IMPORTANT: MetaApi treats `startTime` as an END timestamp — it returns `limit`
  // candles ending at/before that time, NOT going forward from it. To get the most
  // recent bars we pass `startTime = now` (plus a small +ivMs lookahead to be sure
  // the current forming bar is included; we filter it out below).
  const startTime = new Date(nowMs + ivMs);
  const rows = await acct.getHistoricalCandles(tkSymbol, timeframe, startTime, wantN);
  if (!Array.isArray(rows)) throw new Error('MetaApi candles: non-array response');
  // Drop the still-forming candle so the algo at :01s always sees the
  // just-closed bar (open + intervalMs ≤ now).
  return rows
    .map(c => ({
      time:   new Date(c.time).getTime(),
      open:   +c.open,
      high:   +c.high,
      low:    +c.low,
      close:  +c.close,
      volume: +(c.tickVolume ?? c.volume ?? 0),
    }))
    .filter(c => (c.time + ivMs) <= nowMs);
}
async function fetchCandlesHistoricalMeta(accountId, symbol, timeframe, months) {
  if (!MetaApiSDK) throw new Error('MetaApi SDK not initialized');
  const tkSymbol = tkSymbolOf(symbol);
  const acct    = await tickmill._getAccount(accountId);
  const ivMs    = CANDLE_MS[timeframe] || 60000;
  const nowMs   = Date.now();
  const startMs = nowMs - Math.ceil(months * 30.44 * 24 * 3600 * 1000) - WARMUP_BARS * ivMs;
  const all = new Map();
  let cursor = new Date(nowMs);
  const maxLoops = 50;
  for (let i = 0; i < maxLoops; i++) {
    const rows = await acct.getHistoricalCandles(tkSymbol, timeframe, cursor, 1000);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const c of rows) {
      const t = new Date(c.time).getTime();
      if (!all.has(t)) all.set(t, { time: t, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +(c.tickVolume ?? c.volume ?? 0) });
    }
    const earliest = Math.min(...rows.map(r => new Date(r.time).getTime()));
    if (earliest <= startMs) break;
    cursor = new Date(earliest - ivMs);
    await new Promise(r => setTimeout(r, 250));
  }
  return [...all.values()].sort((a, b) => a.time - b.time).filter(c => (c.time + ivMs) <= nowMs);
}
async function fetchCurrentPriceMeta(accountId, symbol) {
  const tkSymbol = tkSymbolOf(symbol);
  const rpc = await tickmill._getRpc(accountId);
  const price = await rpc.getSymbolPrice(tkSymbol, true);
  const bid = parseFloat(price?.bid || 0);
  const ask = parseFloat(price?.ask || 0);
  const mid = (bid && ask) ? (bid + ask) / 2 : (bid || ask);
  if (!mid || !isFinite(mid)) throw new Error('MetaApi current-price: empty bid/ask');
  return mid;
}

// ── Fetch dispatchers: MetaApi when connected, Kraken as fallback ────
// MetaApi is the only market-data source in this service. If MetaApi is not
// initialized or the account isn't deployed/connected, we surface the error
// rather than silently falling back to a different exchange — the caller
// (algo runTick / trailTick / backtest) is expected to handle the failure.
async function fetchCandles(accountId, symbol, timeframe, limit) {
  if (!MetaApiSDK) throw new Error('MetaApi SDK not initialized (missing METAAPI_TOKEN)');
  if (!tickmill.isConnected(accountId)) throw new Error(`MetaApi account ${accountId?.slice(0,8) || '?'}… not deployed`);
  return fetchCandlesMeta(accountId, symbol, timeframe, limit);
}
async function fetchCandlesHistorical(accountId, symbol, timeframe, months) {
  if (!MetaApiSDK) throw new Error('MetaApi SDK not initialized (missing METAAPI_TOKEN)');
  if (!tickmill.isConnected(accountId)) throw new Error(`MetaApi account ${accountId?.slice(0,8) || '?'}… not deployed`);
  return fetchCandlesHistoricalMeta(accountId, symbol, timeframe, months);
}
async function fetchCurrentPrice(accountId, symbol) {
  if (!MetaApiSDK) throw new Error('MetaApi SDK not initialized (missing METAAPI_TOKEN)');
  if (!tickmill.isConnected(accountId)) throw new Error(`MetaApi account ${accountId?.slice(0,8) || '?'}… not deployed`);
  return fetchCurrentPriceMeta(accountId, symbol);
}

// ── Per-user session management ────────────────────────────────────
const userSessions = new Map();

const CANDLE_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };

function defaultFlagState() {
  return { longFlag: false, longFlagLow: null, shortFlag: false, shortFlagHigh: null };
}

function defaultState() {
  return {
    running: false, symbol: 'BTCUSDT', timeframe: '1m',
    strategyId: 'rf-kama-v2', mode: 'paper',
    balance: 10000, initialBalance: 10000,
    sessionId: null, sessionStart: null,
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: 10000, maxDrawdownDollar: 0, maxDrawdownPct: 0,
    flagState:      defaultFlagState(),
    pendingEntry:   null,
    metaapiAccountId: METAAPI_ACCOUNT_ID,   // account used for broker order routing
    sizeFactor:     1,                      // multiplier on qty/lots at fill
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
    flagState, pendingEntry, metaapiAccountId, sizeFactor,
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
    tickmillConnected: tickmill.isConnected(metaapiAccountId),
    tickmillMode:      tickmill.mode,
    metaapiAccountId,
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
    closeResult = await tickmill.closeOrder(state.metaapiAccountId, tickmillOrderId);
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
    const candles          = await fetchCandles(state.metaapiAccountId, symbol, timeframe, WARMUP_BARS + 220);
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
        // Fixed intended max loss = $150 at sizeFactor=1, regardless of account balance.
        // sizeFactor scales the final size and the effective PnL (both loss & trail thresholds).
        // For BTCUSD on Tickmill 1 lot = 1 BTC, so qty is used both as internal size AND broker volume.
        const slPrice    = pe.side === 'long' ? entryPx - stopDist : entryPx + stopDist;
        const riskAmt    = MAX_LOSS;                              // always $150 baseline
        const sizeFactor = state.sizeFactor || 1;
        const rawQty     = (riskAmt / stopDist) * sizeFactor;     // baseline units × factor
        const qty        = parseFloat(rawQty.toFixed(8));         // internal size
        const lots       = parseFloat(rawQty.toFixed(2));         // broker step = 0.01
        const pos        = initPosition(pe.side, entryPx, slPrice, qty, lastBar.time, pe.atr, sizeFactor);
        const orderResult = await tickmill.placeOrder(state.metaapiAccountId, pe.side, symbol, lots, pos.slPrice, null, 'CBT Algo3 RF+KAMA');
        pos.tickmillOrderId = orderResult.orderId;
        state.position      = pos;

        const trade = {
          session_id: sessionId, user_id: userId,
          type: 'entry', side: pe.side, symbol, timeframe,
          price: entryPx, size: pos.size, pnl: 0,
          stop_loss: pos.slPrice, take_profit: null,
          reason: pe.reason || `RF+KAMA trigger — flag ref ${pe.side === 'long' ? 'low' : 'high'} ${pe.slPrice.toFixed(2)} · risk $${riskAmt.toFixed(2)}`,
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
            `Size ${qty} = ($${riskAmt.toFixed(2)} / ${SL_ATR_MULT}×ATR ${stopDist.toFixed(2)}) × sizeFactor ${sizeFactor}  · broker lots=${lots}`,
            `Initial SL $${pos.slPrice.toFixed(2)} = entry ± $${stopDist.toFixed(2)} · max loss on SL hit ≈ $${(riskAmt * sizeFactor).toFixed(2)}`,
            `Flag ${pe.side === 'long' ? 'low' : 'high'} ref: $${pe.slPrice.toFixed(2)} (trigger only, not SL)`,
            `Trail starts @ +$${pos.trailStart.toFixed(2)} PnL → locks $${(pos.trailStart - pos.trailStep).toFixed(2)}, then +$${pos.trailStep.toFixed(2)}/step (1s scan from entry)`,
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
    const price = await fetchCurrentPrice(state.metaapiAccountId, state.symbol);
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
async function runBacktest(accountId, symbol, timeframe, months, sizeFactor = 1) {
  const allCandles = await fetchCandlesHistorical(accountId, symbol, timeframe, months);
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
        // Fixed $150 max loss at sizeFactor=1; qty and trail thresholds scale together.
        const slPrice = pendingEntry.side === 'long' ? entryPx - stopDist : entryPx + stopDist;
        const qty     = (MAX_LOSS / stopDist) * sizeFactor;
        pos = initPosition(pendingEntry.side, entryPx, slPrice, qty, bar.time, pendingEntry.atr, sizeFactor);
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

app.get('/health', (_, res) => res.json({ status: 'ok', strategy: 'rf-kama-v2' }));
app.get('/api/strategies', (_, res) =>
  res.json(Object.entries(STRATEGIES).map(([id, s]) => ({ id, ...s })))
);
app.get('/api/tickmill', async (req, res) => {
  // Optional ?accountId=... to check a specific account; defaults to the env-configured one.
  const accountId = (req.query.accountId || METAAPI_ACCOUNT_ID || '').trim();
  if (accountId && !tickmill._accountStatus.has(accountId)) {
    await tickmill.checkAccount(accountId);
  }
  res.json({
    connected:         tickmill.isConnected(accountId),
    mode:              tickmill.mode,
    accountNumber:     TICKMILL_DEMO.accountNumber,
    accountType:       TICKMILL_DEMO.accountType,
    currency:          TICKMILL_DEMO.currency,
    metaapiConfigured: !!METAAPI_TOKEN,
    accountId,
    defaultAccountId:  DEFAULT_ACCOUNT_ID,
  });
});

// ── MetaApi diagnostics + one-shot test-trade endpoints ───────────
//   GET  /api/metaapi/check?accountId=…  — connection status + broker balance
//   POST /api/metaapi/test-buy   { accountId, symbol?, lots? }  — real 0.01-lot BUY
//   POST /api/metaapi/test-close { accountId, orderId }         — close given order
// Probe: sanity-check that the SDK can talk to MetaApi.
app.get('/api/metaapi/probe', async (req, res) => {
  if (!MetaApiSDK) return res.json({ ok: false, error: 'MetaApi SDK not initialized' });
  const accountId = (req.query.accountId || METAAPI_ACCOUNT_ID || '').trim();
  try {
    const acct = await MetaApiSDK.metatraderAccountApi.getAccount(accountId);
    // Force reload from provisioning so we get the freshest connectionStatus.
    if (typeof acct.reload === 'function') { try { await acct.reload(); } catch {} }
    res.json({
      ok: true,
      sdkVersion: 'live',
      accountId,
      state:            acct?.state || null,
      region:           acct?.region || null,
      connectionStatus: acct?.connectionStatus || null,
      name:             acct?.name || null,
      broker:           acct?.brokerName || null,
      server:           acct?.server || null,
      type:             acct?.type || null,
      login:            acct?.login || null,
      // Diagnostic fields — some SDK versions expose reasons for connection failures.
      accessToken:      acct?.accessToken || null,
      symbol:           acct?.symbol || null,
      stateChangedAt:   acct?.stateChangedAt || null,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, name: e.name, details: e.details || null });
  }
});

app.get('/api/metaapi/check', async (req, res) => {
  const accountId = (req.query.accountId || METAAPI_ACCOUNT_ID || '').trim();
  if (!METAAPI_TOKEN) {
    return res.json({ ok: false, connected: false, error: 'METAAPI_TOKEN not set on server', accountId });
  }
  if (!accountId) {
    return res.json({ ok: false, connected: false, error: 'accountId required', accountId });
  }
  try {
    // 1. Provisioning-API — canonical account state + region (region-less host).
    const deployed = await tickmill.checkAccount(accountId);
    const meta = tickmill.getMeta(accountId) || {};
    // 2. Client-API in the account's own region — real-time balance/equity.
    let info = null, infoErr = null;
    if (deployed) {
      try { info = await tickmill.accountInformation(accountId); }
      catch (e) { infoErr = `[${e.statusCode || 'n/a'}] ${e.message}`; }
    } else {
      infoErr = `Account is ${meta.state || 'not deployed'} — deploy it in MetaApi to fetch balance.`;
    }
    res.json({
      ok:        true,
      connected: !!deployed,
      accountId,
      state:     meta.state || null,
      region:    meta.region || null,
      name:      meta.name || null,
      broker:    info?.broker || meta.broker || null,
      server:    info?.server || meta.server || null,
      platform:  info?.platform || meta.platform || null,
      balance:   info?.balance,
      equity:    info?.equity,
      currency:  info?.currency,
      leverage:  info?.leverage,
      marginLevel: info?.marginLevel,
      infoError: infoErr,
    });
  } catch (err) {
    res.json({
      ok: false, connected: false, accountId,
      error: err.message,
      statusCode: err.statusCode,
      body: err.body,
    });
  }
});

// Update password (or name/server) on an EXISTING MetaApi account.
// MetaApi does NOT allow changing `login` on non-draft accounts — to switch to a
// different Tickmill demo #, use POST /api/metaapi/create-account instead.
app.post('/api/metaapi/update', async (req, res) => {
  const { accountId, login, password, server, name } = req.body || {};
  const aid = (accountId || METAAPI_ACCOUNT_ID || '').trim();
  if (!MetaApiSDK) return res.json({ ok: false, error: 'MetaApi SDK not initialized' });
  if (!aid) return res.json({ ok: false, error: 'accountId required' });
  // Warn the client if the login they typed differs from the stored one — we intentionally
  // ignore it because MetaApi will reject the patch.
  let loginWarning = null;
  try {
    const acct = await MetaApiSDK.metatraderAccountApi.getAccount(aid);
    if (login && String(login) !== String(acct.login || '')) {
      loginWarning = `Ignored login=${login}; account is locked at login=${acct.login}. Use CREATE NEW to provision an account for a different login.`;
    }
  } catch {}
  const patch = {};
  if (password != null && password !== '') patch.password = String(password);
  if (server   != null && server   !== '') patch.server   = String(server);
  if (name     != null && name     !== '') patch.name     = String(name);
  if (!Object.keys(patch).length) return res.json({ ok: false, error: 'nothing to update (only password/server/name are mutable on a live account)' });
  try {
    await tickmill.updateAccount(aid, patch);
    await tickmill.checkAccount(aid);
    res.json({ ok: true, updated: Object.keys(patch), loginWarning });
  } catch (err) {
    res.json({ ok: false, error: err.message, statusCode: err.statusCode });
  }
});

// List all MetaApi accounts on this token (so the user can pick the one with the correct login).
app.get('/api/metaapi/accounts', async (_req, res) => {
  if (!MetaApiSDK) return res.json({ ok: false, error: 'MetaApi SDK not initialized' });
  try {
    const accts = await MetaApiSDK.metatraderAccountApi.getAccountsWithInfiniteScrollPagination({ limit: 100 });
    res.json({
      ok: true,
      accounts: (accts || []).map(a => ({
        id:               a.id,
        name:             a.name,
        login:            a.login,
        server:           a.server,
        region:           a.region,
        state:            a.state,
        connectionStatus: a.connectionStatus,
        type:             a.type,
      })),
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Provision a brand-new MetaApi account for a given Tickmill login/password/server.
app.post('/api/metaapi/create-account', async (req, res) => {
  if (!MetaApiSDK) return res.json({ ok: false, error: 'MetaApi SDK not initialized' });
  const { login, password, server, name, region = 'london', platform = 'mt4' } = req.body || {};
  if (!login || !password || !server) return res.json({ ok: false, error: 'login, password, server required' });
  try {
    const created = await MetaApiSDK.metatraderAccountApi.createAccount({
      name:     String(name || `Tickmill-${login}`),
      login:    String(login),
      password: String(password),
      server:   String(server),
      region,
      platform,
      magic:    123456,
      type:     'cloud-g2',
      application: 'MetaApi',
    });
    // createAccount returns the account object (already scheduled for deployment)
    res.json({ ok: true, accountId: created?.id, state: created?.state, region: created?.region });
  } catch (err) {
    res.json({ ok: false, error: err.message, statusCode: err.statusCode });
  }
});

app.post('/api/metaapi/deploy', async (req, res) => {
  const { accountId } = req.body || {};
  const aid = (accountId || METAAPI_ACCOUNT_ID || '').trim();
  if (!METAAPI_TOKEN) return res.json({ ok: false, error: 'METAAPI_TOKEN not set' });
  if (!aid) return res.json({ ok: false, error: 'accountId required' });
  try {
    await tickmill.deployAccount(aid);
    await tickmill.checkAccount(aid);
    res.json({ ok: true, meta: tickmill.getMeta(aid) });
  } catch (err) {
    res.json({ ok: false, error: err.message, statusCode: err.statusCode, body: err.body });
  }
});

app.post('/api/metaapi/undeploy', async (req, res) => {
  const { accountId } = req.body || {};
  const aid = (accountId || METAAPI_ACCOUNT_ID || '').trim();
  if (!METAAPI_TOKEN) return res.json({ ok: false, error: 'METAAPI_TOKEN not set' });
  if (!aid) return res.json({ ok: false, error: 'accountId required' });
  try {
    await tickmill.undeployAccount(aid);
    await tickmill.checkAccount(aid);
    res.json({ ok: true, meta: tickmill.getMeta(aid) });
  } catch (err) {
    res.json({ ok: false, error: err.message, statusCode: err.statusCode, body: err.body });
  }
});

// Diagnostic: sanity-check that MetaApi historical candles work without starting the algo.
// Compare what MetaApi is serving vs what Tickmill's chart shows.
//   ?symbol=BTCUSDT (default). Returns the last N closed candles with UTC + broker
//   timestamps, the current bid/ask, and the exact tkSymbol we're sending to MetaApi.
app.get('/api/metaapi/diag-symbol', async (req, res) => {
  const accountId = (req.query.accountId || METAAPI_ACCOUNT_ID || '').trim();
  const uiSymbol  = req.query.symbol || 'BTCUSDT';
  const timeframe = req.query.timeframe || '1m';
  const n         = Math.min(20, parseInt(req.query.n || '5', 10));
  if (!MetaApiSDK) return res.json({ ok: false, error: 'MetaApi SDK not initialized' });
  try {
    const tkSymbol = tkSymbolOf(uiSymbol);
    const acct = await tickmill._getAccount(accountId);
    const ivMs = CANDLE_MS[timeframe] || 60000;
    // Fetch a chunk and take the tail N (skipping the still-forming bar).
    const rows = await acct.getHistoricalCandles(tkSymbol, timeframe, new Date(Date.now() - n * ivMs * 3), 200);
    const nowMs = Date.now();
    const closed = (rows || [])
      .map(c => ({ ...c, timeMs: new Date(c.time).getTime() }))
      .filter(c => c.timeMs + ivMs <= nowMs)
      .slice(-n)
      .map(c => ({
        openTimeUTC:  new Date(c.timeMs).toISOString(),
        closeTimeUTC: new Date(c.timeMs + ivMs).toISOString(),
        open: +c.open, high: +c.high, low: +c.low, close: +c.close,
        volume: +(c.tickVolume ?? c.volume ?? 0),
      }));
    // Current tick side-by-side (bid / ask / mid)
    let tick = null, tickErr = null;
    try {
      const rpc = await tickmill._getRpc(accountId);
      const p = await rpc.getSymbolPrice(tkSymbol, true);
      tick = { bid: p?.bid, ask: p?.ask, mid: (p?.bid && p?.ask) ? (p.bid + p.ask) / 2 : null, time: p?.time || null, brokerTime: p?.brokerTime || null };
    } catch (e) { tickErr = e.message; }
    res.json({
      ok: true,
      accountId,
      uiSymbol,
      tkSymbolSentToMetaApi: tkSymbol,
      timeframe,
      count: closed.length,
      candles: closed,
      currentTick: tick,
      currentTickError: tickErr,
      serverNowUTC: new Date(nowMs).toISOString(),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/metaapi/test-candles', async (req, res) => {
  const accountId = (req.query.accountId || METAAPI_ACCOUNT_ID || '').trim();
  const symbol    = req.query.symbol    || 'BTCUSDT';
  const timeframe = req.query.timeframe || '1m';
  const limit     = Math.min(1000, parseInt(req.query.limit || '5', 10));
  const hoursBack = parseInt(req.query.hoursBack || '0', 10);
  try {
    let candles;
    if (hoursBack > 0) {
      const tkSymbol = tkSymbolOf(symbol);
      const acct = await tickmill._getAccount(accountId);
      const startTime = new Date(Date.now() - hoursBack * 3600 * 1000);
      const rows = await acct.getHistoricalCandles(tkSymbol, timeframe, startTime, limit);
      candles = (rows || []).map(c => ({
        time: new Date(c.time).getTime(),
        open: +c.open, high: +c.high, low: +c.low, close: +c.close,
        volume: +(c.tickVolume ?? c.volume ?? 0),
      }));
    } else {
      candles = await fetchCandlesMeta(accountId, symbol, timeframe, limit);
    }
    const full = req.query.debug === '1' || req.query.full === '1';
    res.json({
      ok: true, source: 'metaapi', accountId, symbol, timeframe,
      hoursBack,
      count: candles.length,
      first: candles[0],
      last: candles[candles.length - 1],
      ...(full ? { candles } : {}),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, name: e.name, source: 'metaapi' });
  }
});

app.post('/api/metaapi/test-buy', async (req, res) => {
  const { accountId, symbol = 'BTCUSDT', lots = 0.01 } = req.body || {};
  const aid = (accountId || METAAPI_ACCOUNT_ID || '').trim();
  if (!METAAPI_TOKEN) return res.json({ ok: false, error: 'METAAPI_TOKEN not set' });
  if (!aid) return res.json({ ok: false, error: 'accountId required' });
  if (!tickmill.isConnected(aid)) await tickmill.checkAccount(aid);
  if (!tickmill.isConnected(aid)) return res.json({ ok: false, error: 'account not deployed on MetaApi' });
  const result = await tickmill.placeOrder(aid, 'long', symbol, parseFloat(lots), null, null, 'CBT MetaApi Algo3 test-buy');
  res.json({ ok: !result.paper, ...result });
});

app.post('/api/metaapi/test-close', async (req, res) => {
  const { accountId, orderId } = req.body || {};
  const aid = (accountId || METAAPI_ACCOUNT_ID || '').trim();
  if (!METAAPI_TOKEN) return res.json({ ok: false, error: 'METAAPI_TOKEN not set' });
  if (!aid || !orderId) return res.json({ ok: false, error: 'accountId and orderId required' });
  const result = await tickmill.closeOrder(aid, orderId);
  res.json({ ok: !!result.closed, ...result });
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

app.post('/api/start', requireAuth, async (req, res) => {
  const sess = getSession(req.userId);
  if (sess.state.running) return res.json({ ok: false, msg: 'Already running' });
  const {
    symbol = 'BTCUSDT', timeframe = '1m',
    balance = 10000,
    strategyId = 'rf-kama-v2', mode = 'paper',
    metaapiAccountId,
    sizeFactor,
  } = req.body || {};
  // Main tick must fire ONCE per closed candle (at :01s past the candle boundary),
  // regardless of any user-supplied interval. Otherwise signals fire mid-bar.
  const ms  = CANDLE_MS[timeframe] || 60000;
  const bal = parseFloat(balance);
  const accountId = (metaapiAccountId || METAAPI_ACCOUNT_ID || DEFAULT_ACCOUNT_ID).trim();
  const sf        = Math.max(0.01, Math.min(10, parseFloat(sizeFactor) || 1));

  // Warm up connection status for the chosen account so tickmill.isConnected(...)
  // reports correctly before the first entry attempt.
  if (METAAPI_TOKEN && accountId) await tickmill.checkAccount(accountId);

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
    metaapiAccountId: accountId,
    sizeFactor:       sf,
    userId:           req.userId,
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
  const {
    symbol = 'BTCUSDT', timeframe = '1m', months = 3,
    metaapiAccountId,
    sizeFactor,
  } = req.body || {};
  const m         = Math.max(1, Math.min(12, parseInt(months, 10) || 3));
  const accountId = (metaapiAccountId || METAAPI_ACCOUNT_ID || DEFAULT_ACCOUNT_ID).trim();
  const sf        = Math.max(0.01, Math.min(10, parseFloat(sizeFactor) || 1));
  if (METAAPI_TOKEN && accountId) await tickmill.checkAccount(accountId);
  try {
    const result = await runBacktest(accountId, symbol, timeframe, m, sf);
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
  console.log(`CBT MetaApi Algo3 (RF+KAMA v2) listening on :${PORT} | MetaApi: ${tickmill.mode} | default account ${METAAPI_ACCOUNT_ID.slice(0,8)}…`)
);
