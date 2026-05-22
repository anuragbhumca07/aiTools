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

  return {
    price:       closes[n],
    ema20:       ema20[n],
    ema50:       ema50[n],
    rsi:         rsi14[n],
    macdHist:    macdArr[n]?.hist   ?? null,
    macdPrevHist:macdArr[n - 1]?.hist ?? null,
    macdLine:    macdArr[n]?.macd   ?? null,
    macdSignal:  macdArr[n]?.signal ?? null,
    atr:         atr14[n],
    volume:      volumes[n],
    volumeMA:    volMA[n],
    candleTime:  candles[n].time,
  };
}

// ── Signal generation ────────────────────────────────────────────
//
// Strategy: Multi-Confluence Trend Following
// Minimises loss by requiring 4/5 independent confirmations.
// Risk: 2% per trade | SL: 1.5×ATR | TP: 2.5×ATR | R:R ≈ 1.67
//
function generateSignal(candles) {
  const ind = computeIndicators(candles);
  const { price, ema20, ema50, rsi, macdHist, macdPrevHist, atr, volume, volumeMA } = ind;

  if ([ema20, ema50, rsi, macdHist, atr, volumeMA].some(v => v == null)) {
    return { signal: 'HOLD', reason: ['Insufficient indicator data'], indicators: ind, buyScore: 0, sellScore: 0 };
  }

  const fmt = (v, d = 2) => v != null ? v.toFixed(d) : 'n/a';

  const buyC = [
    { ok: ema20 > ema50,                               label: `EMA20(${fmt(ema20)}) > EMA50(${fmt(ema50)})` },
    { ok: price > ema20,                               label: `Price(${fmt(price)}) > EMA20(${fmt(ema20)})` },
    { ok: rsi > 45 && rsi < 68,                        label: `RSI(${fmt(rsi,1)}) ∈ [45–68]` },
    { ok: macdHist > 0 && macdPrevHist != null && macdHist > macdPrevHist,
                                                       label: `MACD Hist(${fmt(macdHist,6)}) rising +` },
    { ok: volumeMA > 0 && volume > volumeMA * 1.2,     label: `Vol(${fmt(volume,2)}) > VolMA×1.2(${fmt(volumeMA*1.2,2)})` },
  ];

  const sellC = [
    { ok: ema20 < ema50,                               label: `EMA20(${fmt(ema20)}) < EMA50(${fmt(ema50)})` },
    { ok: price < ema20,                               label: `Price(${fmt(price)}) < EMA20(${fmt(ema20)})` },
    { ok: rsi < 55 && rsi > 32,                        label: `RSI(${fmt(rsi,1)}) ∈ [32–55]` },
    { ok: macdHist < 0 && macdPrevHist != null && macdHist < macdPrevHist,
                                                       label: `MACD Hist(${fmt(macdHist,6)}) falling -` },
    { ok: volumeMA > 0 && volume > volumeMA * 1.2,     label: `Vol(${fmt(volume,2)}) > VolMA×1.2(${fmt(volumeMA*1.2,2)})` },
  ];

  const buyScore  = buyC.filter(c => c.ok).length;
  const sellScore = sellC.filter(c => c.ok).length;
  let signal = 'HOLD';
  let reason = [];

  if (buyScore >= 4) {
    signal = 'BUY';
    reason = buyC.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`);
  } else if (sellScore >= 4) {
    signal = 'SELL';
    reason = sellC.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`);
  } else {
    reason = [
      `BUY ${buyScore}/5 | SELL ${sellScore}/5`,
      ...buyC.map(c => `B${c.ok ? '✓' : '✗'} ${c.label}`),
      ...sellC.map(c => `S${c.ok ? '✓' : '✗'} ${c.label}`),
    ];
  }

  return { signal, reason, indicators: ind, buyScore, sellScore };
}

// ── Exit check (also updates trailing stop in-place) ─────────────
function checkExit(position, candles) {
  const ind = computeIndicators(candles);
  const { price, ema20, rsi, macdHist, atr } = ind;
  const reasons = [];

  if (position.side === 'long') {
    if (rsi != null && rsi > 73)
      reasons.push(`RSI overbought (${rsi.toFixed(1)} > 73)`);
    if (ema20 != null && price < ema20 && macdHist != null && macdHist < 0)
      reasons.push(`Reversal: Price < EMA20 + MACD bearish`);
    if (price <= position.stopLoss)
      reasons.push(`Stop loss hit (${price.toFixed(4)} ≤ SL:${position.stopLoss.toFixed(4)})`);
    if (price >= position.takeProfit)
      reasons.push(`Take profit hit (${price.toFixed(4)} ≥ TP:${position.takeProfit.toFixed(4)})`);
    if (atr != null) {
      const trail = price - 1.5 * atr;
      if (trail > position.stopLoss) position.stopLoss = trail;
    }
  } else if (position.side === 'short') {
    if (rsi != null && rsi < 27)
      reasons.push(`RSI oversold (${rsi.toFixed(1)} < 27)`);
    if (ema20 != null && price > ema20 && macdHist != null && macdHist > 0)
      reasons.push(`Reversal: Price > EMA20 + MACD bullish`);
    if (price >= position.stopLoss)
      reasons.push(`Stop loss hit (${price.toFixed(4)} ≥ SL:${position.stopLoss.toFixed(4)})`);
    if (price <= position.takeProfit)
      reasons.push(`Take profit hit (${price.toFixed(4)} ≤ TP:${position.takeProfit.toFixed(4)})`);
    if (atr != null) {
      const trail = price + 1.5 * atr;
      if (trail < position.stopLoss) position.stopLoss = trail;
    }
  }

  return reasons.length > 0
    ? { exit: true, reasons, indicators: ind }
    : { exit: false, reasons: [], indicators: ind };
}

// ── Kraken public OHLCV (globally accessible) ────────────────────
const KRAKEN_PAIR = {
  'BTCUSDT': 'XBTUSD', 'ETHUSDT': 'ETHUSD', 'SOLUSDT': 'SOLUSD',
  'XRPUSDT': 'XRPUSD', 'ADAUSDT': 'ADAUSD', 'DOGEUSDT': 'DOGEUSD',
  'LTCUSDT': 'LTCUSD', 'DOTUSDT': 'DOTUSD',
};
const KRAKEN_INTERVAL = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440,
};

function fetchCandles(symbol, interval, limit = 100) {
  const pair = KRAKEN_PAIR[symbol] || symbol;
  const ivMin = KRAKEN_INTERVAL[interval] || 5;
  return new Promise((resolve, reject) => {
    const p = `/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${ivMin}`;
    const req = https.get({ hostname: 'api.kraken.com', path: p, timeout: 15000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error && parsed.error.length > 0) throw new Error(parsed.error[0]);
          const key = Object.keys(parsed.result).find(k => k !== 'last');
          if (!key) throw new Error('No OHLCV data in Kraken response');
          // [time, open, high, low, close, vwap, volume, count]
          const candles = parsed.result[key]
            .slice(-limit)
            .map(c => ({
              time: parseInt(c[0], 10) * 1000,
              open: parseFloat(c[1]), high: parseFloat(c[2]),
              low: parseFloat(c[3]),  close: parseFloat(c[4]),
              volume: parseFloat(c[6]),
            }));
          if (candles.length < 60) throw new Error(`Only ${candles.length} candles returned`);
          resolve(candles);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Kraken request timed out')); });
  });
}

module.exports = { computeIndicators, generateSignal, checkExit, fetchCandles };
