'use strict';

const https = require('https');

// ── Indicator math ────────────────────────────────────────────────

function ema(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const k = 2 / (period + 1);
  let val = 0;
  for (let i = 0; i < period; i++) val += values[i];
  val /= period;
  result[period - 1] = val;
  for (let i = period; i < values.length; i++) {
    val = values[i] * k + val * (1 - k);
    result[i] = val;
  }
  return result;
}

function rsiCalc(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  result[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    result[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return result;
}

function macdCalc(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );
  const firstValid = macdLine.findIndex(v => v !== null);
  if (firstValid === -1 || closes.length - firstValid < signalPeriod) {
    return closes.map(() => ({ macd: null, signal: null, hist: null }));
  }
  const validMacd = macdLine.slice(firstValid);
  const sigEma = ema(validMacd, signalPeriod);
  return closes.map((_, i) => {
    const m = macdLine[i];
    if (m === null) return { macd: null, signal: null, hist: null };
    const s = sigEma[i - firstValid];
    return { macd: m, signal: s, hist: s !== null ? m - s : null };
  });
}

function atrCalc(highs, lows, closes, period = 14) {
  const n = closes.length;
  const result = new Array(n).fill(null);
  if (n < period + 1) return result;
  const tr = [null];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  result[period] = sum / period;
  for (let i = period + 1; i < n; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }
  return result;
}

function volMACalc(volumes, period = 20) {
  return volumes.map((_, i) => {
    if (i < period - 1) return null;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += volumes[j];
    return s / period;
  });
}

// ADX(14) with Wilder's smoothing — returns array of {adx, diPlus, diMinus}
function adxCalc(highs, lows, closes, period = 14) {
  const n = closes.length;
  const empty = { adx: null, diPlus: null, diMinus: null };
  if (n < period * 2 + 1) return new Array(n).fill(null).map(() => ({ ...empty }));

  const tr   = new Array(n).fill(0);
  const dmP  = new Array(n).fill(0);
  const dmM  = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    const up = highs[i] - highs[i - 1];
    const dn = lows[i - 1] - lows[i];
    dmP[i] = (up > dn && up > 0) ? up : 0;
    dmM[i] = (dn > up && dn > 0) ? dn : 0;
  }

  // Wilder smoothed sums
  const sTR  = new Array(n).fill(0);
  const sDMP = new Array(n).fill(0);
  const sDMM = new Array(n).fill(0);
  for (let i = 1; i <= period; i++) { sTR[period] += tr[i]; sDMP[period] += dmP[i]; sDMM[period] += dmM[i]; }
  for (let i = period + 1; i < n; i++) {
    sTR[i]  = sTR[i-1]  - sTR[i-1]  / period + tr[i];
    sDMP[i] = sDMP[i-1] - sDMP[i-1] / period + dmP[i];
    sDMM[i] = sDMM[i-1] - sDMM[i-1] / period + dmM[i];
  }

  const diP = new Array(n).fill(null);
  const diM = new Array(n).fill(null);
  const dx  = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (sTR[i] === 0) continue;
    diP[i] = (sDMP[i] / sTR[i]) * 100;
    diM[i] = (sDMM[i] / sTR[i]) * 100;
    const s = diP[i] + diM[i];
    if (s > 0) dx[i] = Math.abs(diP[i] - diM[i]) / s * 100;
  }

  // ADX = Wilder smooth of DX, seeded at index 2*period-1
  const adxArr  = new Array(n).fill(null);
  const seedIdx = period * 2 - 1;
  if (seedIdx >= n) return new Array(n).fill(null).map((_, i) => ({ adx: adxArr[i], diPlus: diP[i], diMinus: diM[i] }));

  let seedSum = 0, seedCnt = 0;
  for (let i = period; i <= seedIdx; i++) {
    if (dx[i] != null) { seedSum += dx[i]; seedCnt++; }
  }
  if (seedCnt === period) {
    adxArr[seedIdx] = seedSum / period;
    for (let i = seedIdx + 1; i < n; i++) {
      if (dx[i] != null && adxArr[i - 1] != null)
        adxArr[i] = (adxArr[i - 1] * (period - 1) + dx[i]) / period;
    }
  }

  return new Array(n).fill(null).map((_, i) => ({ adx: adxArr[i], diPlus: diP[i], diMinus: diM[i] }));
}

// ── Core indicator snapshot ──────────────────────────────────────

function computeIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const n = candles.length - 1;

  const ema20   = ema(closes, 20);
  const ema50   = ema(closes, 50);
  const rsi14   = rsiCalc(closes, 14);
  const macdArr = macdCalc(closes);
  const atr14   = atrCalc(highs, lows, closes, 14);
  const volMA   = volMACalc(volumes, 20);
  const adxArr  = adxCalc(highs, lows, closes, 14);

  return {
    price:         closes[n],
    ema20:         ema20[n],
    ema50:         ema50[n],
    rsi:           rsi14[n],
    macdHist:      macdArr[n]?.hist       ?? null,
    macdPrevHist:  macdArr[n - 1]?.hist   ?? null,
    macdLine:      macdArr[n]?.macd       ?? null,
    macdSignal:    macdArr[n]?.signal     ?? null,
    atr:           atr14[n],
    volume:        volumes[n],
    volumeMA:      volMA[n],
    adx:           adxArr[n]?.adx         ?? null,
    diPlus:        adxArr[n]?.diPlus      ?? null,
    diMinus:       adxArr[n]?.diMinus     ?? null,
    candleTime:    candles[n].time,
  };
}

// ── Signal generation ────────────────────────────────────────────
//
// Strategy: ADX-Gated Multi-Confluence Trend Following v2
//
// Hard gate : ADX ≥ 20 (trending market — no ranging)
// Entry     : all 6 conditions must pass (6/6) — quality over quantity
//   1. ADX DI direction confirms trend side
//   2. EMA20 vs EMA50 trend alignment
//   3. Price vs EMA20 position
//   4. RSI [50–67] long / [33–50] short  (non-overlapping zones)
//   5. MACD Hist positive AND rising for 2 consecutive bars (long)
//      MACD Hist negative AND falling for 2 consecutive bars (short)
//   6. Volume > VolMA × 1.2
//
// Risk    : 1.5% per trade
// SL      : max(2×ATR, 0.15% of price) — floor prevents noise-stops
// TP      : SL × 2  (2:1 R:R)
// Exit    : Incremental phase-based stop ratchet + time stop 30 candles
//
function generateSignal(candles) {
  const ind = computeIndicators(candles);
  const { price, ema20, ema50, rsi, macdHist, macdPrevHist, atr, volume, volumeMA, adx, diPlus, diMinus } = ind;

  if ([ema20, ema50, rsi, macdHist, atr, volumeMA, adx].some(v => v == null)) {
    return { signal: 'HOLD', reason: ['Insufficient indicator data'], indicators: ind, buyScore: 0, sellScore: 0 };
  }

  const fmt = (v, d = 2) => v != null ? v.toFixed(d) : 'n/a';

  // Hard gate: market must be trending
  if (adx < 20) {
    return {
      signal: 'HOLD',
      reason: [`ADX(${fmt(adx, 1)}) < 20 — ranging market, skip`],
      indicators: ind, buyScore: 0, sellScore: 0,
    };
  }

  // MACD 2-bar confirmation: both bars same side AND histogram moving in direction
  const macdLongOk  = macdHist > 0 && macdPrevHist != null && macdPrevHist > 0 && macdHist > macdPrevHist;
  const macdShortOk = macdHist < 0 && macdPrevHist != null && macdPrevHist < 0 && macdHist < macdPrevHist;

  const buyC = [
    { ok: diPlus > diMinus,                        label: `DI+(${fmt(diPlus,1)}) > DI-(${fmt(diMinus,1)}) — ADX bullish` },
    { ok: ema20 > ema50,                           label: `EMA20(${fmt(ema20)}) > EMA50(${fmt(ema50)})` },
    { ok: price > ema20,                           label: `Price(${fmt(price)}) > EMA20(${fmt(ema20)})` },
    { ok: rsi >= 50 && rsi <= 67,                  label: `RSI(${fmt(rsi,1)}) ∈ [50–67]` },
    { ok: macdLongOk,                              label: `MACD 2×rising>0 (${fmt(macdPrevHist,5)}→${fmt(macdHist,5)})` },
    { ok: volumeMA > 0 && volume > volumeMA * 1.2, label: `Vol > VolMA×1.2 (${fmt(volume/volumeMA,2)}x)` },
  ];

  const sellC = [
    { ok: diMinus > diPlus,                        label: `DI-(${fmt(diMinus,1)}) > DI+(${fmt(diPlus,1)}) — ADX bearish` },
    { ok: ema20 < ema50,                           label: `EMA20(${fmt(ema20)}) < EMA50(${fmt(ema50)})` },
    { ok: price < ema20,                           label: `Price(${fmt(price)}) < EMA20(${fmt(ema20)})` },
    { ok: rsi >= 33 && rsi <= 50,                  label: `RSI(${fmt(rsi,1)}) ∈ [33–50]` },
    { ok: macdShortOk,                             label: `MACD 2×falling<0 (${fmt(macdPrevHist,5)}→${fmt(macdHist,5)})` },
    { ok: volumeMA > 0 && volume > volumeMA * 1.2, label: `Vol > VolMA×1.2 (${fmt(volume/volumeMA,2)}x)` },
  ];

  const buyScore  = buyC.filter(c => c.ok).length;
  const sellScore = sellC.filter(c => c.ok).length;
  let signal = 'HOLD';
  let reason = [];

  if (buyScore === 6) {
    signal = 'BUY';
    reason = buyC.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`);
  } else if (sellScore === 6) {
    signal = 'SELL';
    reason = sellC.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`);
  } else {
    reason = [
      `ADX(${fmt(adx,1)}) OK — BUY ${buyScore}/6 | SELL ${sellScore}/6`,
      ...buyC.map(c => `B${c.ok ? '✓' : '✗'} ${c.label}`),
      ...sellC.map(c => `S${c.ok ? '✓' : '✗'} ${c.label}`),
    ];
  }

  return { signal, reason, indicators: ind, buyScore, sellScore };
}

// ── Exit check — incremental phase-based stop ratchet ────────────
//
// Phase 1 (initial): hold, SL at entry ± stopDist
// Phase 2 (profit ≥ 1×ATR): SL → breakeven (entry price)
// Phase 3 (profit ≥ 2×ATR): SL → entry + 0.75×ATR (locked profit)
// Phase 4 (profit ≥ 3×ATR): SL → trailing at price ∓ 1.5×ATR
//
// Also tracks: candlesHeld (by candle time), MAE (worst unrealized $)
//
function checkExit(position, candles) {
  const ind = computeIndicators(candles);
  const { price, ema20, rsi, macdHist, atr } = ind;
  const reasons = [];

  // candlesHeld increments only when a new candle closes (avoids counting same candle multiple times)
  const curCandleTime = candles[candles.length - 1].time;
  if (!position.lastCandleTime || curCandleTime > position.lastCandleTime) {
    position.candlesHeld = (position.candlesHeld || 0) + 1;
    position.lastCandleTime = curCandleTime;
  }

  // Track MAE (max adverse excursion in $PnL — worst unrealized loss)
  const unrealNow = position.side === 'long'
    ? (price - position.entryPrice) * position.size
    : (position.entryPrice - price) * position.size;
  if (position.mae == null) position.mae = 0;
  if (unrealNow < position.mae) position.mae = unrealNow;

  const entry = position.entryPrice;

  if (position.side === 'long') {
    const profitDist = price - entry;

    // Incremental stop ratchet (never moves SL down)
    if (atr != null) {
      if (profitDist >= 3 * atr) {
        const trail = price - 1.5 * atr;
        if (trail > position.stopLoss) position.stopLoss = trail;
        position.phase = 4;
      } else if (profitDist >= 2 * atr) {
        const locked = entry + 0.75 * atr;
        if (locked > position.stopLoss) position.stopLoss = locked;
        if ((position.phase || 1) < 3) position.phase = 3;
      } else if (profitDist >= atr) {
        if (entry > position.stopLoss) position.stopLoss = entry;
        if ((position.phase || 1) < 2) position.phase = 2;
      }
    }

    if (rsi != null && rsi > 75)
      reasons.push(`RSI overbought (${rsi.toFixed(1)} > 75)`);
    if (ema20 != null && price < ema20 && macdHist != null && macdHist < 0)
      reasons.push(`Reversal: Price < EMA20 + MACD bearish`);
    if (price <= position.stopLoss)
      reasons.push(`SL hit (${price.toFixed(2)} ≤ ${position.stopLoss.toFixed(2)}) phase:${position.phase||1}`);
    if (price >= position.takeProfit)
      reasons.push(`TP hit (${price.toFixed(2)} ≥ ${position.takeProfit.toFixed(2)})`);
    if ((position.candlesHeld || 0) >= 30)
      reasons.push(`Time stop: held ${position.candlesHeld} candles`);

  } else if (position.side === 'short') {
    const profitDist = entry - price;

    if (atr != null) {
      if (profitDist >= 3 * atr) {
        const trail = price + 1.5 * atr;
        if (trail < position.stopLoss) position.stopLoss = trail;
        position.phase = 4;
      } else if (profitDist >= 2 * atr) {
        const locked = entry - 0.75 * atr;
        if (locked < position.stopLoss) position.stopLoss = locked;
        if ((position.phase || 1) < 3) position.phase = 3;
      } else if (profitDist >= atr) {
        if (entry < position.stopLoss) position.stopLoss = entry;
        if ((position.phase || 1) < 2) position.phase = 2;
      }
    }

    if (rsi != null && rsi < 25)
      reasons.push(`RSI oversold (${rsi.toFixed(1)} < 25)`);
    if (ema20 != null && price > ema20 && macdHist != null && macdHist > 0)
      reasons.push(`Reversal: Price > EMA20 + MACD bullish`);
    if (price >= position.stopLoss)
      reasons.push(`SL hit (${price.toFixed(2)} ≥ ${position.stopLoss.toFixed(2)}) phase:${position.phase||1}`);
    if (price <= position.takeProfit)
      reasons.push(`TP hit (${price.toFixed(2)} ≤ ${position.takeProfit.toFixed(2)})`);
    if ((position.candlesHeld || 0) >= 30)
      reasons.push(`Time stop: held ${position.candlesHeld} candles`);
  }

  return reasons.length > 0
    ? { exit: true, reasons, indicators: ind }
    : { exit: false, reasons: [], indicators: ind };
}

// ── Kraken public OHLCV ──────────────────────────────────────────
const KRAKEN_PAIR = {
  'BTCUSDT': 'XBTUSD', 'ETHUSDT': 'ETHUSD', 'SOLUSDT': 'SOLUSD',
  'XRPUSDT': 'XRPUSD', 'ADAUSDT': 'ADAUSD', 'DOGEUSDT': 'DOGEUSD',
  'LTCUSDT': 'LTCUSD', 'DOTUSDT': 'DOTUSD',
};
const KRAKEN_INTERVAL = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440,
};

// Low-level single-request fetch; since=null fetches latest 720 candles
function fetchCandlesRaw(pair, ivMin, since) {
  return new Promise((resolve, reject) => {
    let p = `/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${ivMin}`;
    if (since != null) p += `&since=${since}`;
    const req = https.get({ hostname: 'api.kraken.com', path: p, timeout: 20000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error && parsed.error.length > 0) throw new Error(parsed.error[0]);
          const key = Object.keys(parsed.result).find(k => k !== 'last');
          if (!key) throw new Error('No OHLCV data in Kraken response');
          const candles = parsed.result[key].map(c => ({
            time:   parseInt(c[0], 10) * 1000,
            open:   parseFloat(c[1]), high:   parseFloat(c[2]),
            low:    parseFloat(c[3]), close:  parseFloat(c[4]),
            volume: parseFloat(c[6]),
          }));
          resolve({ candles, last: parseInt(parsed.result.last, 10) });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Kraken request timed out')); });
  });
}

function fetchCandles(symbol, interval, limit = 100) {
  const pair  = KRAKEN_PAIR[symbol] || symbol;
  const ivMin = KRAKEN_INTERVAL[interval] || 5;
  return fetchCandlesRaw(pair, ivMin, null).then(({ candles }) => {
    const recent = candles.slice(-limit);
    if (recent.length < 60) throw new Error(`Only ${recent.length} candles returned`);
    return recent;
  });
}

// Historical fetch with pagination for backtesting
// Returns all candles from (months ago - 100 warmup bars) to now
async function fetchCandlesHistorical(symbol, interval, months) {
  const pair  = KRAKEN_PAIR[symbol] || symbol;
  const ivMin = KRAKEN_INTERVAL[interval] || 60;
  const ivSec = ivMin * 60;
  const now   = Math.floor(Date.now() / 1000);
  const startSec  = now - Math.ceil(months * 30.44 * 24 * 3600);
  const fetchFrom = startSec - 100 * ivSec; // include warmup candles

  // Safety cap: limit total API calls
  const candlesNeeded = Math.ceil((now - fetchFrom) / ivSec);
  const maxCalls = Math.min(50, Math.ceil(candlesNeeded / 700) + 2);

  const allCandles = [];
  let since = fetchFrom;

  for (let i = 0; i < maxCalls; i++) {
    const { candles, last } = await fetchCandlesRaw(pair, ivMin, since);
    if (!candles.length) break;

    // Deduplicate by timestamp
    const seen = new Set(allCandles.map(c => c.time));
    allCandles.push(...candles.filter(c => !seen.has(c.time)));

    const lastMs = allCandles[allCandles.length - 1].time;
    if (lastMs / 1000 >= now - ivSec * 3) break; // reached current time

    since = last || Math.floor(lastMs / 1000) + 1;
    if (i < maxCalls - 1) await new Promise(r => setTimeout(r, 350)); // rate-limit
  }

  return allCandles;
}

module.exports = { computeIndicators, generateSignal, checkExit, fetchCandles, fetchCandlesHistorical };
