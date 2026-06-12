'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const {
  generateSignal, checkExit,
  fetchCandles, fetchCandlesHistorical,
} = require('./algo');
const { RobinhoodClient, generateTOTP } = require('./robinhood-client');

const PORT           = parseInt(process.env.PORT || '4001', 10);
const DEFAULT_SYMBOL = (process.env.SYMBOL || 'BTCUSDT').toUpperCase();

const WA_INSTANCE = process.env.WA_INSTANCE || '';
const WA_TOKEN    = process.env.WA_TOKEN    || '';
const WA_GROUP    = process.env.WA_GROUP    || '';

const DATA_DIR = path.join(__dirname, '..', 'data', `port-${PORT}`);
[DATA_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── WhatsApp (Green API) ──────────────────────────────────────────
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
    `${dir} *ENTRY — ${label} ${sym} ${timeframe}*\n` +
    `Price : $${f(price)}\n` +
    `Size  : ${f(size, 5)} ${symbol.replace('USDT', '')}\n` +
    `SL    : $${f(sl)}  |  TP : $${f(tp)}\n` +
    `Risk  : $${f(riskAmt)}\n` +
    `Balance: $${f(balance)}`
  );
}

function waExit(side, symbol, timeframe, pnl, reason, balance, wins, totalTrades) {
  const icon   = pnl > 0 ? '✅' : '❌';
  const label  = side === 'long' ? 'LONG' : 'SHORT';
  const sym    = symbol.replace('USDT', '/USDT');
  const wr     = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
  const f      = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pnlStr = `${pnl >= 0 ? '+' : ''}$${f(Math.abs(pnl))}`;
  sendWhatsApp(
    `${icon} *EXIT — ${label} ${sym} ${timeframe}*\n` +
    `Reason  : ${reason}\n` +
    `PnL     : *${pnlStr}*\n` +
    `Balance : $${f(balance)}\n` +
    `Win Rate: ${wr}% (${wins}/${totalTrades})`
  );
}

// ── SQLite ────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'trades.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT,
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
    rh_order_id   TEXT
  )
`);
// Migration for existing databases
try { db.exec('ALTER TABLE trades ADD COLUMN rh_order_id TEXT'); } catch {}

const stmtInsert = db.prepare(`
  INSERT INTO trades
    (session_id,type,side,symbol,timeframe,price,size,pnl,
     stop_loss,take_profit,reason,balance_after,timestamp,mae,rh_order_id)
  VALUES
    (@session_id,@type,@side,@symbol,@timeframe,@price,@size,@pnl,
     @stop_loss,@take_profit,@reason,@balance_after,@timestamp,@mae,@rh_order_id)
`);

// ── Strategy registry ─────────────────────────────────────────────
const STRATEGIES = {
  'swing-v2': {
    name: 'swing-v2: EMA Ribbon Swing (precision)',
    description: 'EMA21/55/200 + ADX(25) + DI-spread≥15 + 5 hard gates + 6/7 conditions + 2.5×ATR SL + 3:1 R:R',
  },
};

// ── Per-process state ─────────────────────────────────────────────
const CANDLE_MS = {
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1d': 86400000,
};

function defaultState() {
  return {
    running: false, symbol: DEFAULT_SYMBOL, timeframe: '4h',
    mode: 'paper',
    balance: 10000, initialBalance: 10000,
    sessionId: null, sessionStart: null,
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: 10000, maxDrawdownDollar: 0, maxDrawdownPct: 0,
    lastRsiExitSide: null, lastRsiExitCandleTime: null,
  };
}

let state          = defaultState();
let logs           = [];
const sseClients   = new Set();
let ticker         = null;
let alignTimeout   = null;
let tickBusy       = false;
let lastCandleTime = null;

const rhClient = new RobinhoodClient();

// Auto-login via env vars if set (optional convenience)
(async () => {
  const user = process.env.RH_USERNAME;
  const pass = process.env.RH_PASSWORD;
  if (!user || !pass) return;
  console.log(`[RH:${PORT}] Auto-login for ${user}…`);
  const code = process.env.RH_MFA_SECRET ? generateTOTP(process.env.RH_MFA_SECRET) : undefined;
  try {
    const r = await rhClient.login(user, pass, code);
    if (r.mfaRequired) console.warn(`[RH:${PORT}] MFA required — set RH_MFA_SECRET or use /api/rh-auth`);
    else if (r.ok) { await rhClient.getAccountId(); console.log(`[RH:${PORT}] Auto-login OK, account: ${rhClient.accountId}`); }
  } catch (e) { console.error(`[RH:${PORT}] Auto-login failed:`, e.message); }
})();

function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

function pushLog(entry) {
  const row = { id: Date.now() + Math.random(), ...entry };
  logs.unshift(row);
  if (logs.length > 500) logs.length = 500;
  broadcast({ type: 'log', entry: row });
}

function publicState() {
  const {
    running, symbol, timeframe, mode, balance, initialBalance,
    sessionId, sessionStart, pnl, totalTrades, wins,
    lastIndicators, lastSignal, error,
    peakBalance, maxDrawdownDollar, maxDrawdownPct,
  } = state;
  return {
    running, symbol, timeframe, mode, balance, initialBalance,
    sessionId, sessionStart, pnl, totalTrades, wins, error,
    lastIndicators, lastSignal,
    position:          state.position ? { ...state.position } : null,
    winRate:           totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0',
    pnlPct:            ((pnl / (initialBalance || 10000)) * 100).toFixed(2),
    peakBalance,
    maxDrawdownDollar: parseFloat(maxDrawdownDollar.toFixed(2)),
    maxDrawdownPct:    parseFloat(maxDrawdownPct.toFixed(2)),
  };
}

function updateDrawdown() {
  if (state.balance > state.peakBalance) state.peakBalance = state.balance;
  const dd    = state.peakBalance - state.balance;
  const ddPct = state.peakBalance > 0 ? (dd / state.peakBalance) * 100 : 0;
  if (dd > state.maxDrawdownDollar) {
    state.maxDrawdownDollar = dd;
    state.maxDrawdownPct    = ddPct;
  }
}

// ── Main tick ─────────────────────────────────────────────────────
async function runTick() {
  const { symbol, timeframe, sessionId } = state;
  const ts = new Date().toISOString();
  try {
    state.error = null;
    const candles          = await fetchCandles(symbol, timeframe, 250);
    const latestCandleTime = candles[candles.length - 1].time;
    const price            = candles[candles.length - 1].close;

    if (state.position) {
      const exitResult = checkExit(state.position, candles);
      state.lastIndicators = exitResult.indicators;

      if (exitResult.exit) {
        const { side, entryPrice, size, stopLoss, takeProfit, mae } = state.position;

        // Live mode: place sell order on Robinhood to close the long position
        let rhExitOrderId = null;
        if (state.mode === 'live' && side === 'long') {
          try {
            const order = await rhClient.placeMarketOrder(symbol, 'sell', size);
            rhExitOrderId = order.id || order.ref_id || null;
            pushLog({ ts, type: 'RH_ORDER', message: `Sell order placed: ${rhExitOrderId}` });
          } catch (e) {
            pushLog({ ts, type: 'ERROR', message: `⚠ Robinhood SELL order failed: ${e.message} — close this position manually on Robinhood` });
          }
        }

        const rawPnl = side === 'long'
          ? (price - entryPrice) * size
          : (entryPrice - price) * size;
        const pnl = parseFloat(rawPnl.toFixed(4));

        state.balance   += pnl;
        state.pnl       += pnl;
        if (pnl > 0) state.wins++;
        state.totalTrades++;
        updateDrawdown();
        state.position = null;

        const trade = {
          session_id: sessionId, type: 'exit', side, symbol, timeframe,
          price, size, pnl,
          stop_loss: stopLoss, take_profit: takeProfit,
          reason: exitResult.reasons.join(' | '),
          balance_after: parseFloat(state.balance.toFixed(4)),
          timestamp: ts,
          mae: parseFloat((mae || 0).toFixed(4)),
          rh_order_id: rhExitOrderId,
        };

        const exitReasonStr = exitResult.reasons.join(' ');
        if ((exitReasonStr.includes('RSI overbought') && side === 'long') ||
            (exitReasonStr.includes('RSI oversold')   && side === 'short')) {
          state.lastRsiExitSide        = side;
          state.lastRsiExitCandleTime  = latestCandleTime;
        }

        stmtInsert.run(trade);
        waExit(side, symbol, timeframe, pnl, exitResult.reasons[0] || '', state.balance, state.wins, state.totalTrades);
        pushLog({ ts, type: 'EXIT', side, price, pnl,
                  mae: (mae || 0).toFixed(2),
                  reason: exitResult.reasons, indicators: state.lastIndicators });
        broadcast({ type: 'trade', trade, state: publicState() });
        return;
      }

      const { side, entryPrice, size } = state.position;
      state.position.unrealizedPnl = parseFloat(
        (side === 'long' ? (price - entryPrice) * size : (entryPrice - price) * size).toFixed(4)
      );
    }

    const isNewCandle = latestCandleTime !== lastCandleTime;
    if (!isNewCandle) {
      broadcast({ type: 'tick', state: publicState() });
      return;
    }
    lastCandleTime = latestCandleTime;

    const { signal, reason, indicators, buyScore, sellScore } = generateSignal(candles);
    state.lastIndicators = indicators;
    state.lastSignal     = { signal, buyScore, sellScore };

    if (!state.position && (signal === 'BUY' || signal === 'SELL')) {
      const { atr } = indicators;
      const side = signal === 'BUY' ? 'long' : 'short';

      // Live mode: Robinhood Crypto does not support short selling — skip SELL signals
      if (state.mode === 'live' && side === 'short') {
        pushLog({ ts, type: 'SKIP', signal: 'SELL skipped — Robinhood does not support short selling', price, indicators });
        broadcast({ type: 'tick', state: publicState() });
        return;
      }

      const candleIntervalMs = CANDLE_MS[state.timeframe] || 14400000;
      const inRsiCooldown = state.lastRsiExitSide === side
        && state.lastRsiExitCandleTime
        && (latestCandleTime - state.lastRsiExitCandleTime) < 15 * candleIntervalMs;
      if (inRsiCooldown) {
        pushLog({ ts, type: 'TICK', signal: `RSI-cooldown (${side})`, price, indicators, reason });
        broadcast({ type: 'tick', state: publicState() });
        return;
      }

      const stopDist = Math.max(2.5 * atr, price * 0.0025);
      const riskAmt  = Math.min(state.balance * 0.015, 150);
      const size     = parseFloat((riskAmt / stopDist).toFixed(8));
      const sl       = side === 'long' ? price - stopDist : price + stopDist;
      const tp       = side === 'long' ? price + stopDist * 3 : price - stopDist * 3;

      // Live mode: place buy order on Robinhood before entering position
      let rhOrderId = null;
      if (state.mode === 'live') {
        try {
          const order = await rhClient.placeMarketOrder(symbol, 'buy', size);
          rhOrderId = order.id || order.ref_id || null;
          pushLog({ ts, type: 'RH_ORDER', message: `Buy order placed: ${rhOrderId}` });
        } catch (e) {
          state.error = `Robinhood BUY order failed: ${e.message}`;
          pushLog({ ts, type: 'ERROR', message: state.error });
          broadcast({ type: 'error', message: state.error, state: publicState() });
          return; // Do not enter position if the real order failed
        }
      }

      state.position = {
        side, entryPrice: price, size, stopLoss: sl, takeProfit: tp,
        entryTime: ts, unrealizedPnl: 0,
        phase: 1, candlesHeld: 0, lastCandleTime: null, mae: 0,
        rhOrderId,
      };

      const trade = {
        session_id: sessionId, type: 'entry', side, symbol, timeframe,
        price, size, pnl: 0,
        stop_loss: sl, take_profit: tp,
        reason: reason.join(' | '),
        balance_after: parseFloat(state.balance.toFixed(4)),
        timestamp: ts, mae: 0, rh_order_id: rhOrderId,
      };
      stmtInsert.run(trade);
      waEntry(side, symbol, timeframe, price, size, sl, tp, riskAmt, state.balance);
      pushLog({ ts, type: 'ENTRY', side, signal, price, size,
                stopLoss: sl, takeProfit: tp,
                balance: state.balance.toFixed(4), reason, indicators });
      broadcast({ type: 'trade', trade, state: publicState() });
    } else {
      pushLog({ ts, type: 'TICK',
                signal: `${signal} (B:${buyScore} S:${sellScore})`,
                price, indicators, reason });
      broadcast({ type: 'tick', state: publicState() });
    }
  } catch (err) {
    state.error = err.message;
    pushLog({ ts, type: 'ERROR', message: err.message });
    broadcast({ type: 'error', message: err.message, state: publicState() });
  }
}

async function tick() {
  if (tickBusy) return;
  tickBusy = true;
  try { await runTick(); } finally { tickBusy = false; }
}

function startAlignedTicks(intervalMs) {
  stopTicker();
  const now   = Date.now();
  const delay = (Math.ceil(now / intervalMs) * intervalMs) - now + 2000;
  alignTimeout = setTimeout(() => {
    tick();
    ticker = setInterval(() => tick(), intervalMs);
  }, delay);
}

function stopTicker() {
  if (alignTimeout) { clearTimeout(alignTimeout);  alignTimeout = null; }
  if (ticker)       { clearInterval(ticker);       ticker       = null; }
}

// ── Backtest ──────────────────────────────────────────────────────
async function runBacktest(symbol, timeframe, months) {
  const allCandles = await fetchCandlesHistorical(symbol, timeframe, months);
  if (allCandles.length < 210) {
    throw new Error(`Need 210+ candles for EMA200. Got ${allCandles.length}`);
  }

  const WINDOW = 250;
  let balance = 10000;
  const initialBalance = 10000;
  let pos = null, peakBal = balance, maxDD = 0;
  const trades = [];
  let wins = 0;
  const COOLDOWN_BARS     = 6;
  let lastPhase1ExitBar   = -COOLDOWN_BARS;
  let lastPhase1ExitSide  = null;
  const RSI_COOLDOWN_BARS = 15;
  let lastRsiExitBar      = -RSI_COOLDOWN_BARS;
  let lastRsiExitSide     = null;

  for (let i = WINDOW; i < allCandles.length; i++) {
    const seg   = allCandles.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const price = allCandles[i].close;

    if (pos) {
      const ex = checkExit(pos, seg);
      if (ex.exit) {
        const reason0 = ex.reasons[0] || '';
        let exitPrice = price;
        if (reason0.startsWith('SL hit')) exitPrice = pos.stopLoss;
        else if (reason0.startsWith('TP hit')) exitPrice = pos.takeProfit;

        const pnl = pos.side === 'long'
          ? (exitPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - exitPrice) * pos.size;
        balance += pnl;
        if (pnl > 0) wins++;
        if (balance > peakBal) peakBal = balance;
        const dd = peakBal - balance;
        if (dd > maxDD) maxDD = dd;

        if (reason0.startsWith('SL hit (Phase 1)') || reason0.startsWith('SL hit (Phase 2)')) {
          lastPhase1ExitBar  = i;
          lastPhase1ExitSide = pos.side;
        }
        if ((reason0.includes('RSI overbought') && pos.side === 'long') ||
            (reason0.includes('RSI oversold')   && pos.side === 'short')) {
          lastRsiExitBar  = i;
          lastRsiExitSide = pos.side;
        }

        trades.push({
          side: pos.side, entryPrice: +pos.entryPrice.toFixed(4),
          exitPrice: +exitPrice.toFixed(4), pnl: +pnl.toFixed(2),
          balance: +balance.toFixed(2),
          entryTime: new Date(pos.entryTime).toISOString(),
          exitTime:  new Date(allCandles[i].time).toISOString(),
          reason: ex.reasons[0] || '', mae: +(pos.mae || 0).toFixed(2), phase: pos.phase || 1,
        });
        pos = null;
      } else {
        const unreal = pos.side === 'long'
          ? (price - pos.entryPrice) * pos.size
          : (pos.entryPrice - price) * pos.size;
        if (unreal < (pos.mae || 0)) pos.mae = unreal;
      }
    }

    if (!pos) {
      const sig = generateSignal(seg);
      if (sig.signal === 'BUY' || sig.signal === 'SELL') {
        const newSide = sig.signal === 'BUY' ? 'long' : 'short';
        const inCooldown    = lastPhase1ExitSide === newSide && (i - lastPhase1ExitBar) < COOLDOWN_BARS;
        const inRsiCooldown = lastRsiExitSide    === newSide && (i - lastRsiExitBar)    < RSI_COOLDOWN_BARS;
        if (inCooldown || inRsiCooldown) continue;

        const { atr } = sig.indicators;
        const stopDist = Math.max(2.5 * atr, price * 0.0025);
        const riskAmt  = Math.min(balance * 0.015, 150);
        const size     = riskAmt / stopDist;
        pos = {
          side: newSide, entryPrice: price, size,
          stopLoss:   newSide === 'long' ? price - stopDist : price + stopDist,
          takeProfit: newSide === 'long' ? price + stopDist * 3 : price - stopDist * 3,
          entryTime:  allCandles[i].time,
          phase: 1, candlesHeld: 0, lastCandleTime: null, mae: 0,
        };
      }
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
      reason: 'End of backtest', mae: +(pos.mae || 0).toFixed(2), phase: pos.phase || 1,
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

// ── Express app ───────────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS — allow hub dashboard to poll from different port
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'web')));

app.get('/health',       (_, res) => res.json({ status: 'ok', symbol: DEFAULT_SYMBOL, port: PORT }));
app.get('/api/symbol',   (_, res) => res.json({ symbol: DEFAULT_SYMBOL, port: PORT }));
app.get('/api/strategies', (_, res) =>
  res.json(Object.entries(STRATEGIES).map(([id, s]) => ({ id, ...s })))
);

app.get('/api/status', (_, res) => res.json({
  symbol:      state.symbol,
  running:     state.running,
  balance:     state.balance,
  pnl:         state.pnl,
  totalTrades: state.totalTrades,
  wins:        state.wins,
  winRate:     state.totalTrades > 0 ? ((state.wins / state.totalTrades) * 100).toFixed(1) : '0.0',
  lastPrice:   state.lastIndicators?.price ?? null,
  position:    state.position
    ? { side: state.position.side, entryPrice: state.position.entryPrice, unrealizedPnl: state.position.unrealizedPnl }
    : null,
}));

app.get('/api/state', (_, res) => res.json(publicState()));
app.get('/api/logs',  (_, res) => res.json(logs));
app.get('/api/trades', (req, res) => {
  const { session } = req.query;
  const rows = session
    ? db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(session)
    : (state.sessionId
        ? db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(state.sessionId)
        : []);
  res.json(rows);
});

app.post('/api/start', async (req, res) => {
  if (state.running) return res.json({ ok: false, msg: 'Already running' });
  const {
    symbol    = DEFAULT_SYMBOL,
    timeframe = '4h',
    balance   = 10000,
    interval  = 14400,
    mode      = 'paper',
  } = req.body || {};

  if (mode === 'live' && !rhClient.authenticated) {
    return res.json({ ok: false, msg: 'Robinhood authentication required for live mode — connect via /api/rh-auth first' });
  }

  const ms  = Math.max(5000, parseInt(interval, 10) * 1000);
  let bal = parseFloat(balance);

  // Sync starting balance from actual Robinhood portfolio
  if (mode === 'live' && rhClient.authenticated) {
    const rhBal = await rhClient.getPortfolioBalance();
    if (rhBal !== null && rhBal > 0) {
      bal = rhBal;
      console.log(`[RH:${PORT}] Using Robinhood portfolio balance: $${bal.toFixed(2)}`);
    }
  }

  Object.assign(state, {
    running: true, symbol, timeframe, mode,
    balance: bal, initialBalance: bal,
    sessionId:    `s_${Date.now()}`,
    sessionStart: new Date().toISOString(),
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: bal, maxDrawdownDollar: 0, maxDrawdownPct: 0,
  });
  logs = [];
  lastCandleTime = null;
  tick();
  startAlignedTicks(ms);
  broadcast({ type: 'started', state: publicState() });
  res.json({ ok: true, state: publicState() });
});

app.post('/api/stop', (req, res) => {
  if (!state.running) return res.json({ ok: false, msg: 'Not running' });
  stopTicker();
  state.running = false;
  broadcast({ type: 'stopped', state: publicState() });
  res.json({ ok: true, state: publicState() });
});

app.post('/api/backtest', async (req, res) => {
  const { symbol = DEFAULT_SYMBOL, timeframe = '4h', months = 3 } = req.body || {};
  const m = Math.max(1, Math.min(12, parseInt(months, 10) || 3));
  try {
    const result = await runBacktest(symbol, timeframe, m);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected', state: publicState(), logs })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Robinhood Auth endpoints ──────────────────────────────────────

app.get('/api/rh-status', (_, res) => res.json({
  connected: rhClient.authenticated,
  accountId: rhClient.accountId || null,
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
  console.log(`Robinhood Algo [${DEFAULT_SYMBOL}] listening on http://localhost:${PORT}`)
);
