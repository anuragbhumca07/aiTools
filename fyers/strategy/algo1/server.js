'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const session  = require('express-session');
const {
  computeIndicators, generateSignal, checkExit,
  fetchCandles, fetchCandlesHistorical,
  exchangeAuthCode, buildAuthUrl,
  placeFyersOrder, isMarketOpen, marketStatusMessage,
  FYERS_APP_ID,
} = require('./algo');

// ── Config ────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT || '3011', 10);
const ALGO_SLOT    = process.env.ALGO_SLOT    || '1';
const ALGO_NAME    = process.env.ALGO_NAME    || `Fyers Algo ${ALGO_SLOT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || `fyers-algo${ALGO_SLOT}-secret`;

const DATA_DIR    = path.join(__dirname, '..', 'shared_data');
const TOKEN_FILE  = path.join(DATA_DIR, 'fyers_token.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, `trades_algo${ALGO_SLOT}.db`);

// ── Token management ───────────────────────────────────────────────
function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    // Token expires daily at midnight IST — use 23h validity window
    if (!t.access_token || Date.now() > (t.expires_at || 0)) return null;
    return t.access_token;
  } catch { return null; }
}

function saveToken(data) {
  const expires_at = Date.now() + 23 * 60 * 60 * 1000; // 23h
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...data, expires_at }, null, 2));
}

// ── SQLite ─────────────────────────────────────────────────────────
const db = new Database(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT,
    algo_slot     TEXT,
    type          TEXT,
    side          TEXT,
    symbol        TEXT,
    timeframe     TEXT,
    price         REAL,
    qty           INTEGER,
    pnl           REAL,
    stop_loss     REAL,
    take_profit   REAL,
    reason        TEXT,
    balance_after REAL,
    timestamp     TEXT,
    mae           REAL DEFAULT 0,
    fyers_order_id TEXT
  )
`);
['mae REAL DEFAULT 0', 'fyers_order_id TEXT'].forEach(col => {
  try { db.exec(`ALTER TABLE trades ADD COLUMN ${col}`); } catch {}
});

const stmtInsert = db.prepare(`
  INSERT INTO trades
    (session_id,algo_slot,type,side,symbol,timeframe,price,qty,pnl,
     stop_loss,take_profit,reason,balance_after,timestamp,mae,fyers_order_id)
  VALUES
    (@session_id,@algo_slot,@type,@side,@symbol,@timeframe,@price,@qty,@pnl,
     @stop_loss,@take_profit,@reason,@balance_after,@timestamp,@mae,@fyers_order_id)
`);

// ── Strategy registry ──────────────────────────────────────────────
const STRATEGIES = {
  'swing-v2': {
    name: 'swing-v2: EMA Ribbon Swing v2 (Precision)',
    description: 'EMA21/55/200 + ADX(25) + DI-spread≥15 + ADX rising + ATR regime + EMA proximity + 6/7 scoring + 2.5×ATR SL + 3:1 R:R',
  },
};

// ── NSE Best Intraday Stocks ───────────────────────────────────────
const NSE_STOCKS = [
  // Nifty 50 — highest liquidity
  { label: 'RELIANCE',      value: 'NSE:RELIANCE-EQ' },
  { label: 'TCS',           value: 'NSE:TCS-EQ' },
  { label: 'INFY',          value: 'NSE:INFY-EQ' },
  { label: 'HDFC BANK',     value: 'NSE:HDFCBANK-EQ' },
  { label: 'ICICI BANK',    value: 'NSE:ICICIBANK-EQ' },
  { label: 'SBI',           value: 'NSE:SBIN-EQ' },
  { label: 'WIPRO',         value: 'NSE:WIPRO-EQ' },
  { label: 'HCL TECH',      value: 'NSE:HCLTECH-EQ' },
  { label: 'AXIS BANK',     value: 'NSE:AXISBANK-EQ' },
  { label: 'BAJ FINANCE',   value: 'NSE:BAJFINANCE-EQ' },
  // High-volatility intraday favorites
  { label: 'TATA MOTORS',   value: 'NSE:TATAMOTORS-EQ' },
  { label: 'ADANI ENT',     value: 'NSE:ADANIENT-EQ' },
  { label: 'ADANI PORTS',   value: 'NSE:ADANIPORTS-EQ' },
  { label: 'MARUTI',        value: 'NSE:MARUTI-EQ' },
  { label: 'SUN PHARMA',    value: 'NSE:SUNPHARMA-EQ' },
  { label: 'DR. REDDY',     value: 'NSE:DRREDDY-EQ' },
  { label: 'KOTAK BANK',    value: 'NSE:KOTAKBANK-EQ' },
  { label: 'TECH MAHINDRA', value: 'NSE:TECHM-EQ' },
  { label: 'BHARTI AIRTEL', value: 'NSE:BHARTIARTL-EQ' },
  { label: 'BAJAJ AUTO',    value: 'NSE:BAJAJ-AUTO-EQ' },
  { label: 'M&M',           value: 'NSE:M&M-EQ' },
  { label: 'TATA STEEL',    value: 'NSE:TATASTEEL-EQ' },
  { label: 'JSPL',          value: 'NSE:JSPL-EQ' },
  { label: 'ONGC',          value: 'NSE:ONGC-EQ' },
  { label: 'POWER GRID',    value: 'NSE:POWERGRID-EQ' },
];

// ── Session state ──────────────────────────────────────────────────
const CANDLE_MS = {
  '1m': 60000, '3m': 180000, '5m': 300000, '10m': 600000,
  '15m': 900000, '30m': 1800000, '1h': 3600000,
  '2h': 7200000, '4h': 14400000, '1d': 86400000,
};

function defaultState() {
  const defaultSymbol = process.env.DEFAULT_SYMBOL || 'NSE:RELIANCE-EQ';
  return {
    running: false, symbol: defaultSymbol, timeframe: '1m',
    strategyId: 'swing-v2', mode: 'paper',
    balance: 100000, initialBalance: 100000,
    sessionId: null, sessionStart: null,
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: 100000, maxDrawdownAmt: 0, maxDrawdownPct: 0,
    lastRsiExitSide: null, lastRsiExitCandleTime: null,
    algoSlot: ALGO_SLOT, algoName: ALGO_NAME,
    marketStatus: marketStatusMessage(),
  };
}

const sess = {
  state:         defaultState(),
  logs:          [],
  sseClients:    new Set(),
  ticker:        null,
  alignTimeout:  null,
  tickBusy:      false,
  lastCandleTime: null,
};

// ── Helpers ────────────────────────────────────────────────────────
function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sess.sseClients) {
    try { res.write(msg); } catch { sess.sseClients.delete(res); }
  }
}

function pushLog(entry) {
  const row = { id: Date.now() + Math.random(), ...entry };
  sess.logs.unshift(row);
  if (sess.logs.length > 500) sess.logs.length = 500;
  broadcast({ type: 'log', entry: row });
}

function publicState() {
  const s = sess.state;
  const totalTrades = s.totalTrades || 0;
  return {
    running: s.running, symbol: s.symbol, timeframe: s.timeframe,
    strategyId: s.strategyId, mode: s.mode,
    balance: s.balance, initialBalance: s.initialBalance,
    sessionId: s.sessionId, sessionStart: s.sessionStart,
    pnl: s.pnl, totalTrades, wins: s.wins,
    lastIndicators: s.lastIndicators, lastSignal: s.lastSignal,
    error: s.error,
    position:         s.position ? { ...s.position } : null,
    winRate:          totalTrades > 0 ? ((s.wins / totalTrades) * 100).toFixed(1) : '0.0',
    pnlPct:           ((s.pnl / (s.initialBalance || 100000)) * 100).toFixed(2),
    peakBalance:      s.peakBalance,
    maxDrawdownAmt:   parseFloat(s.maxDrawdownAmt.toFixed(2)),
    maxDrawdownPct:   parseFloat(s.maxDrawdownPct.toFixed(2)),
    algoSlot:         s.algoSlot,
    algoName:         s.algoName,
    marketStatus:     marketStatusMessage(),
    isMarketOpen:     isMarketOpen(),
    fyersConnected:   !!loadToken(),
    port:             PORT,
  };
}

function updateDrawdown() {
  const s = sess.state;
  if (s.balance > s.peakBalance) s.peakBalance = s.balance;
  const dd    = s.peakBalance - s.balance;
  const ddPct = s.peakBalance > 0 ? (dd / s.peakBalance) * 100 : 0;
  if (dd > s.maxDrawdownAmt) { s.maxDrawdownAmt = dd; s.maxDrawdownPct = ddPct; }
}

// ── Main tick ─────────────────────────────────────────────────────
async function runTick() {
  const s    = sess.state;
  const ts   = new Date().toISOString();
  const { symbol, timeframe, sessionId, mode } = s;

  try {
    s.error = null;
    s.marketStatus = marketStatusMessage();

    // Market hours guard for live mode — paper mode always runs
    if (mode === 'live' && !isMarketOpen()) {
      pushLog({ ts, type: 'TICK', signal: 'MARKET_CLOSED', price: null, indicators: null, reason: [marketStatusMessage()] });
      broadcast({ type: 'tick', state: publicState() });
      return;
    }

    const token = loadToken();
    if (!token) {
      s.error = 'Fyers not connected — open /auth/fyers to authenticate';
      broadcast({ type: 'error', message: s.error, state: publicState() });
      return;
    }

    const candles          = await fetchCandles(symbol, timeframe, 250, token);
    const latestCandleTime = candles[candles.length - 1].time;
    const price            = candles[candles.length - 1].close;

    // Update unrealized PnL on open position every tick
    if (s.position) {
      const exitResult = checkExit(s.position, candles);
      s.lastIndicators = exitResult.indicators;

      if (exitResult.exit) {
        const { side, entryPrice, qty, stopLoss, takeProfit, mae, fyersOrderId } = s.position;
        const rawPnl = side === 'long'
          ? (price - entryPrice) * qty
          : (entryPrice - price) * qty;
        const pnl = parseFloat(rawPnl.toFixed(2));

        // Close live order
        if (mode === 'live' && fyersOrderId && token) {
          await placeFyersOrder(symbol, side === 'long' ? 'short' : 'long', qty, 'INTRADAY', token).catch(() => {});
        }

        s.balance   += pnl;
        s.pnl       += pnl;
        if (pnl > 0) s.wins++;
        s.totalTrades++;
        updateDrawdown();

        // RSI extreme cooldown tracking
        const exitStr = exitResult.reasons.join(' ');
        if ((exitStr.includes('RSI overbought') && side === 'long') ||
            (exitStr.includes('RSI oversold')   && side === 'short')) {
          s.lastRsiExitSide       = side;
          s.lastRsiExitCandleTime = latestCandleTime;
        }

        stmtInsert.run({
          session_id: sessionId, algo_slot: ALGO_SLOT,
          type: 'exit', side, symbol, timeframe,
          price, qty, pnl,
          stop_loss: stopLoss, take_profit: takeProfit,
          reason: exitResult.reasons.join(' | '),
          balance_after: parseFloat(s.balance.toFixed(2)),
          timestamp: ts, mae: parseFloat((mae || 0).toFixed(2)),
          fyers_order_id: null,
        });
        pushLog({ ts, type: 'EXIT', side, price, pnl,
                  mae: (mae || 0).toFixed(2),
                  reason: exitResult.reasons, indicators: s.lastIndicators });
        s.position = null;
        broadcast({ type: 'trade', state: publicState() });
        return;
      }

      const { side, entryPrice, qty } = s.position;
      s.position.unrealizedPnl = parseFloat(
        (side === 'long' ? (price - entryPrice) * qty : (entryPrice - price) * qty).toFixed(2)
      );
    }

    const isNewCandle = latestCandleTime !== sess.lastCandleTime;
    if (!isNewCandle) {
      broadcast({ type: 'tick', state: publicState() });
      return;
    }
    sess.lastCandleTime = latestCandleTime;

    const { signal, reason, indicators, buyScore, sellScore } = generateSignal(candles);
    s.lastIndicators = indicators;
    s.lastSignal     = { signal, buyScore, sellScore };

    if (!s.position && (signal === 'BUY' || signal === 'SELL')) {
      const { atr } = indicators;
      const side = signal === 'BUY' ? 'long' : 'short';

      // RSI extreme cooldown check
      const candleIntervalMs = CANDLE_MS[timeframe] || 900000;
      const inRsiCooldown = s.lastRsiExitSide === side
        && s.lastRsiExitCandleTime
        && (latestCandleTime - s.lastRsiExitCandleTime) < 15 * candleIntervalMs;
      if (inRsiCooldown) {
        pushLog({ ts, type: 'TICK', signal: `RSI-cooldown (${side})`, price, indicators, reason });
        broadcast({ type: 'tick', state: publicState() });
        return;
      }

      // NSE position sizing: qty = floor(riskAmt / stopDist) — minimum 1 share
      const stopDist  = Math.max(2.5 * atr, price * 0.0025);
      const riskAmt   = Math.min(s.balance * 0.015, 15000); // 1.5% risk, cap ₹15000
      const qty       = Math.max(1, Math.floor(riskAmt / stopDist));
      const sl        = side === 'long' ? price - stopDist : price + stopDist;
      const tp        = side === 'long' ? price + stopDist * 3 : price - stopDist * 3;

      let fyersOrderId = null;
      if (mode === 'live' && token) {
        const orderResult = await placeFyersOrder(symbol, side, qty, 'INTRADAY', token);
        fyersOrderId = orderResult.orderId || null;
        if (orderResult.error) pushLog({ ts, type: 'WARN', message: `Order error: ${orderResult.error}` });
      }

      s.position = {
        side, entryPrice: price, qty, stopLoss: sl, takeProfit: tp,
        entryTime: ts, unrealizedPnl: 0,
        phase: 1, candlesHeld: 0, lastCandleTime: null, mae: 0,
        fyersOrderId,
      };

      stmtInsert.run({
        session_id: sessionId, algo_slot: ALGO_SLOT,
        type: 'entry', side, symbol, timeframe,
        price, qty, pnl: 0,
        stop_loss: sl, take_profit: tp,
        reason: reason.join(' | '),
        balance_after: parseFloat(s.balance.toFixed(2)),
        timestamp: ts, mae: 0,
        fyers_order_id: fyersOrderId,
      });
      pushLog({ ts, type: 'ENTRY', side, signal, price, qty,
                stopLoss: sl.toFixed(2), takeProfit: tp.toFixed(2),
                balance: s.balance.toFixed(2), reason, indicators });
      broadcast({ type: 'trade', state: publicState() });
    } else {
      pushLog({ ts, type: 'TICK',
                signal: `${signal} (B:${buyScore} S:${sellScore})`,
                price, indicators, reason });
      broadcast({ type: 'tick', state: publicState() });
    }
  } catch (err) {
    s.error = err.message;
    pushLog({ ts, type: 'ERROR', message: err.message });
    broadcast({ type: 'error', message: err.message, state: publicState() });
  }
}

async function tick() {
  if (sess.tickBusy) return;
  sess.tickBusy = true;
  try { await runTick(); } finally { sess.tickBusy = false; }
}

function startAlignedTicks(intervalMs) {
  stopTicker();
  const now   = Date.now();
  const delay = (Math.ceil(now / intervalMs) * intervalMs) - now + 2000;
  sess.alignTimeout = setTimeout(() => {
    tick();
    sess.ticker = setInterval(() => tick(), intervalMs);
  }, delay);
}

function stopTicker() {
  if (sess.alignTimeout) { clearTimeout(sess.alignTimeout);  sess.alignTimeout = null; }
  if (sess.ticker)       { clearInterval(sess.ticker);       sess.ticker       = null; }
}

// ── Backtest runner ───────────────────────────────────────────────
async function runBacktest(symbol, timeframe, months) {
  const token = loadToken();
  if (!token) throw new Error('Fyers not connected — authenticate first');

  const allCandles = await fetchCandlesHistorical(symbol, timeframe, months, token);
  if (allCandles.length < 210) {
    throw new Error(`Need 210+ candles for EMA200. Got ${allCandles.length} — try longer duration or shorter timeframe.`);
  }

  const WINDOW = 250;
  let balance = 100000;
  const initialBalance = 100000;
  let pos = null, peakBal = balance, maxDD = 0;
  const trades = [];
  let wins = 0;
  const COOLDOWN_BARS     = 6;
  const RSI_COOLDOWN_BARS = 15;
  let lastPhase1ExitBar   = -COOLDOWN_BARS;
  let lastPhase1ExitSide  = null;
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
          ? (exitPrice - pos.entryPrice) * pos.qty
          : (pos.entryPrice - exitPrice) * pos.qty;
        balance += pnl;
        if (pnl > 0) wins++;
        if (balance > peakBal) peakBal = balance;
        const dd = peakBal - balance;
        if (dd > maxDD) maxDD = dd;

        if (reason0.startsWith('SL hit (Phase 1)') || reason0.startsWith('SL hit (Phase 2)')) {
          lastPhase1ExitBar  = i; lastPhase1ExitSide = pos.side;
        }
        if ((reason0.includes('RSI overbought') && pos.side === 'long') ||
            (reason0.includes('RSI oversold')   && pos.side === 'short')) {
          lastRsiExitBar  = i; lastRsiExitSide = pos.side;
        }

        trades.push({
          side: pos.side,
          entryPrice: +pos.entryPrice.toFixed(2),
          exitPrice:  +exitPrice.toFixed(2),
          qty:        pos.qty,
          pnl:        +pnl.toFixed(2),
          balance:    +balance.toFixed(2),
          entryTime:  new Date(pos.entryTime).toISOString(),
          exitTime:   new Date(allCandles[i].time).toISOString(),
          reason:     reason0,
          mae:        +(pos.mae || 0).toFixed(2),
          phase:      pos.phase || 1,
        });
        pos = null;
      } else {
        const unreal = pos.side === 'long'
          ? (price - pos.entryPrice) * pos.qty
          : (pos.entryPrice - price) * pos.qty;
        if (unreal < (pos.mae || 0)) pos.mae = unreal;
      }
    }

    if (!pos) {
      const sig = generateSignal(seg);
      if (sig.signal === 'BUY' || sig.signal === 'SELL') {
        const newSide = sig.signal === 'BUY' ? 'long' : 'short';
        const inCooldown    = lastPhase1ExitSide === newSide && (i - lastPhase1ExitBar)  < COOLDOWN_BARS;
        const inRsiCooldown = lastRsiExitSide    === newSide && (i - lastRsiExitBar)    < RSI_COOLDOWN_BARS;
        if (inCooldown || inRsiCooldown) continue;

        const { atr } = sig.indicators;
        const stopDist = Math.max(2.5 * atr, price * 0.0025);
        const riskAmt  = Math.min(balance * 0.015, 15000);
        const qty      = Math.max(1, Math.floor(riskAmt / stopDist));
        pos = {
          side: newSide, entryPrice: price, qty,
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
      ? (lp - pos.entryPrice) * pos.qty
      : (pos.entryPrice - lp) * pos.qty;
    balance += pnl;
    trades.push({
      side: pos.side, entryPrice: +pos.entryPrice.toFixed(2), exitPrice: +lp.toFixed(2),
      qty: pos.qty, pnl: +pnl.toFixed(2), balance: +balance.toFixed(2),
      entryTime: new Date(pos.entryTime).toISOString(),
      exitTime: new Date(allCandles[allCandles.length - 1].time).toISOString(),
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

// ── Express app ────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'web')));

// ── Fyers auth endpoints ───────────────────────────────────────────
app.get('/auth/fyers', (req, res) => {
  const url = buildAuthUrl(`algo${ALGO_SLOT}`);
  res.redirect(url);
});

// Auth callback (also handled by dashboard on port 8080; this handles direct access)
app.get('/auth/callback', async (req, res) => {
  const { auth_code, code, s: status } = req.query;
  const authCode = auth_code || code;
  if (status === 'error' || !authCode) {
    return res.send('<h2>Fyers auth failed — check credentials and try again.</h2>');
  }
  try {
    const tokenData = await exchangeAuthCode(authCode);
    saveToken(tokenData);
    res.redirect('/');
  } catch (err) {
    res.send(`<h2>Token exchange failed: ${err.message}</h2>`);
  }
});

// ── REST API ───────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok', algoSlot: ALGO_SLOT, algoName: ALGO_NAME, port: PORT,
  fyersConnected: !!loadToken(), marketStatus: marketStatusMessage(),
}));

app.get('/api/config', (_, res) => res.json({
  algoSlot: ALGO_SLOT, algoName: ALGO_NAME, port: PORT,
  stocks: NSE_STOCKS,
  strategies: Object.entries(STRATEGIES).map(([id, s]) => ({ id, ...s })),
  fyersConnected: !!loadToken(),
  fyersAuthUrl: buildAuthUrl(`algo${ALGO_SLOT}`),
  marketStatus: marketStatusMessage(),
  isMarketOpen: isMarketOpen(),
}));

app.get('/api/state',  (_, res) => res.json(publicState()));
app.get('/api/logs',   (_, res) => res.json(sess.logs));

app.get('/api/trades', (req, res) => {
  const { session } = req.query;
  let rows;
  if (session) {
    rows = db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(session);
  } else {
    rows = sess.state.sessionId
      ? db.prepare('SELECT * FROM trades WHERE session_id=? ORDER BY id DESC').all(sess.state.sessionId)
      : [];
  }
  res.json(rows);
});

app.get('/api/trades/all', (_, res) => {
  const rows = db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 200').all();
  res.json(rows);
});

// CSV export
app.get('/api/trades/export', (_, res) => {
  const rows = db.prepare('SELECT * FROM trades ORDER BY id DESC').all();
  const header = 'id,session_id,type,side,symbol,timeframe,price,qty,pnl,stop_loss,take_profit,reason,balance_after,timestamp,mae,fyers_order_id\n';
  const csv = header + rows.map(r =>
    [r.id, r.session_id, r.type, r.side, r.symbol, r.timeframe,
     r.price, r.qty, r.pnl, r.stop_loss, r.take_profit,
     `"${(r.reason||'').replace(/"/g,'""')}"`,
     r.balance_after, r.timestamp, r.mae, r.fyers_order_id || ''].join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="algo${ALGO_SLOT}_trades.csv"`);
  res.send(csv);
});

app.post('/api/start', (req, res) => {
  if (sess.state.running) return res.json({ ok: false, msg: 'Already running' });
  const {
    symbol, timeframe = '15m', balance = 100000,
    interval, strategyId = 'swing-v2', mode = 'paper',
  } = req.body || {};

  const sym = symbol || sess.state.symbol;
  const ms  = interval ? Math.max(5000, parseInt(interval, 10) * 1000)
                       : (CANDLE_MS[timeframe] || 900000);
  const bal = parseFloat(balance);

  Object.assign(sess.state, {
    running: true, symbol: sym, timeframe, strategyId, mode,
    balance: bal, initialBalance: bal,
    sessionId:    `s${ALGO_SLOT}_${Date.now()}`,
    sessionStart: new Date().toISOString(),
    position: null, pnl: 0, totalTrades: 0, wins: 0,
    lastIndicators: null, lastSignal: null, error: null,
    peakBalance: bal, maxDrawdownAmt: 0, maxDrawdownPct: 0,
  });
  sess.logs           = [];
  sess.lastCandleTime = null;

  tick();
  startAlignedTicks(ms);

  broadcast({ type: 'started', state: publicState() });
  res.json({ ok: true, state: publicState() });
});

app.post('/api/stop', (_, res) => {
  if (!sess.state.running) return res.json({ ok: false, msg: 'Not running' });
  stopTicker();
  sess.state.running = false;
  broadcast({ type: 'stopped', state: publicState() });
  res.json({ ok: true, state: publicState() });
});

app.post('/api/backtest', async (req, res) => {
  const { symbol, timeframe = '15m', months = 3 } = req.body || {};
  const sym = symbol || sess.state.symbol;
  const m   = Math.max(1, Math.min(12, parseInt(months, 10) || 3));
  try {
    const result = await runBacktest(sym, timeframe, m);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/config/update', (req, res) => {
  const { symbol, timeframe, mode } = req.body || {};
  if (!sess.state.running) {
    if (symbol) sess.state.symbol    = symbol;
    if (timeframe) sess.state.timeframe = timeframe;
    if (mode)   sess.state.mode      = mode;
  }
  res.json({ ok: true, state: publicState() });
});

// ── SSE endpoint ───────────────────────────────────────────────────
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected', state: publicState(), logs: sess.logs })}\n\n`);
  sess.sseClients.add(res);
  req.on('close', () => sess.sseClients.delete(res));
});

app.listen(PORT, () =>
  console.log(`[Algo${ALGO_SLOT}] ${ALGO_NAME} listening on :${PORT} | Fyers: ${loadToken() ? 'connected' : 'not connected'}`)
);
