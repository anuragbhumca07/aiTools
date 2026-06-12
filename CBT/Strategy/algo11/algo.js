'use strict';

const https = require('https');

// ── Shared indicator math ─────────────────────────────────────────

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
  if (firstValid === -1 || closes.length - firstValid < signalPeriod)
    return closes.map(() => ({ macd: null, signal: null, hist: null }));
  const sigEma = ema(macdLine.slice(firstValid), signalPeriod);
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
  for (let i = period + 1; i < n; i++)
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
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

function adxCalc(highs, lows, closes, period = 14) {
  const n = closes.length;
  const empty = { adx: null, diPlus: null, diMinus: null };
  if (n < period * 2 + 1) return new Array(n).fill(null).map(() => ({ ...empty }));
  const tr  = new Array(n).fill(0);
  const dmP = new Array(n).fill(0);
  const dmM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    const up = highs[i] - highs[i-1], dn = lows[i-1] - lows[i];
    dmP[i] = (up > dn && up > 0) ? up : 0;
    dmM[i] = (dn > up && dn > 0) ? dn : 0;
  }
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
  const adxArr = new Array(n).fill(null);
  const seed   = period * 2 - 1;
  if (seed >= n) return new Array(n).fill(null).map((_, i) => ({ adx: adxArr[i], diPlus: diP[i], diMinus: diM[i] }));
  let seedSum = 0, seedCnt = 0;
  for (let i = period; i <= seed; i++) { if (dx[i] != null) { seedSum += dx[i]; seedCnt++; } }
  if (seedCnt === period) {
    adxArr[seed] = seedSum / period;
    for (let i = seed + 1; i < n; i++) {
      if (dx[i] != null && adxArr[i-1] != null)
        adxArr[i] = (adxArr[i-1] * (period - 1) + dx[i]) / period;
    }
  }
  return new Array(n).fill(null).map((_, i) => ({ adx: adxArr[i], diPlus: diP[i], diMinus: diM[i] }));
}

// ── Core indicator snapshot ───────────────────────────────────────

function computeIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const n = candles.length - 1;
  const p3 = Math.max(0, n - 3);

  const ema21  = ema(closes, 21);
  const ema55  = ema(closes, 55);
  const ema200 = ema(closes, 200);
  const rsi14  = rsiCalc(closes, 14);
  const macdArr = macdCalc(closes);
  const atr14  = atrCalc(highs, lows, closes, 14);
  const volMA  = volMACalc(volumes, 20);
  const adxArr = adxCalc(highs, lows, closes, 14);

  const atrWindow = [];
  for (let i = Math.max(0, n - 19); i <= n; i++) {
    if (atr14[i] !== null) atrWindow.push(atr14[i]);
  }
  const atrMA20 = atrWindow.length >= 5
    ? atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length
    : null;

  const adxNow  = adxArr[n]?.adx  ?? null;
  const adxPrev = adxArr[p3]?.adx ?? null;
  const adxSlope = adxNow !== null && adxPrev !== null ? adxNow - adxPrev : null;

  const ema21Slope = ema21[n] !== null && ema21[p3] !== null ? ema21[n] - ema21[p3] : null;

  const candleRange = highs[n] - lows[n];
  const candleBodyRatio = candleRange > 0 ? (closes[n] - lows[n]) / candleRange : 0.5;

  const lookback = Math.min(20, n);
  let swingHigh = -Infinity, swingLow = Infinity;
  for (let i = n - lookback; i <= n; i++) {
    if (candles[i].high > swingHigh) swingHigh = candles[i].high;
    if (candles[i].low  < swingLow)  swingLow  = candles[i].low;
  }

  return {
    price:          closes[n],
    ema21:          ema21[n],
    ema55:          ema55[n],
    ema200:         ema200[n],
    rsi:            rsi14[n],
    macdHist:       macdArr[n]?.hist     ?? null,
    macdPrevHist:   macdArr[n-1]?.hist   ?? null,
    macdLine:       macdArr[n]?.macd     ?? null,
    macdSignal:     macdArr[n]?.signal   ?? null,
    atr:            atr14[n],
    atrMA20,
    adxSlope,
    ema21Slope,
    candleBodyRatio,
    volume:         volumes[n-1],
    volumeMA:       volMA[n-1],
    adx:            adxArr[n]?.adx        ?? null,
    diPlus:         adxArr[n]?.diPlus     ?? null,
    diMinus:        adxArr[n]?.diMinus    ?? null,
    swingHigh,
    swingLow,
    candleTime:     candles[n].time,
  };
}

// ── Signal — identical to Algo3/Algo4/Algo5 (EMA Ribbon Swing v2) ──
function generateSignal(candles, state = {}) {
  const ind = computeIndicators(candles);
  const { price, ema21, ema55, ema200, rsi, macdHist,
          atr, atrMA20, adxSlope, ema21Slope,
          candleBodyRatio, adx, diPlus, diMinus } = ind;

  if ([ema21, ema55, ema200, rsi, macdHist, atr, adx].some(v => v == null)) {
    return { signal: 'HOLD', reason: ['Insufficient data — need 200+ candles for EMA200'], indicators: ind, buyScore: 0, sellScore: 0 };
  }

  const fmt = (v, d = 2) => v != null ? v.toFixed(d) : 'n/a';
  const diSpread = Math.abs(diPlus - diMinus);

  const ema21Rising  = ema21Slope !== null ? ema21Slope > 0 : false;
  const ema21Falling = ema21Slope !== null ? ema21Slope < 0 : false;

  const buyChecks = [
    { ok: diPlus  > diMinus,            label: `DI+(${fmt(diPlus,1)}) > DI-(${fmt(diMinus,1)})` },
    { ok: ema21   > ema55,              label: `EMA21(${fmt(ema21)}) > EMA55(${fmt(ema55)})` },
    { ok: ema55   > ema200,             label: `EMA55(${fmt(ema55)}) > EMA200(${fmt(ema200)})` },
    { ok: ema21Rising,                  label: `EMA21 slope rising (${fmt(ema21Slope,1)})` },
    { ok: rsi >= 42 && rsi <= 72,       label: `RSI(${fmt(rsi,1)}) ∈ [42–72]` },
    { ok: macdHist > 0,                 label: `MACD hist > 0 (${fmt(macdHist, 4)})` },
    { ok: candleBodyRatio >= 0.45,      label: `Candle close quality (${fmt(candleBodyRatio*100,0)}% upper)` },
  ];
  const buyScore  = buyChecks.filter(c => c.ok).length;
  const buyPassed = buyChecks.filter(c => c.ok).map(c => c.label);
  const buyFailed = buyChecks.filter(c => !c.ok).map(c => c.label);

  const sellChecks = [
    { ok: diMinus > diPlus,             label: `DI-(${fmt(diMinus,1)}) > DI+(${fmt(diPlus,1)})` },
    { ok: ema21   < ema55,              label: `EMA21 < EMA55` },
    { ok: ema55   < ema200,             label: `EMA55 < EMA200` },
    { ok: ema21Falling,                 label: `EMA21 slope falling (${fmt(ema21Slope,1)})` },
    { ok: rsi >= 28 && rsi <= 58,       label: `RSI(${fmt(rsi,1)}) ∈ [28–58]` },
    { ok: macdHist < 0,                 label: `MACD hist < 0 (${fmt(macdHist, 4)})` },
    { ok: candleBodyRatio <= 0.55,      label: `Candle close quality (${fmt((1-candleBodyRatio)*100,0)}% lower)` },
  ];
  const sellScore  = sellChecks.filter(c => c.ok).length;
  const sellPassed = sellChecks.filter(c => c.ok).map(c => c.label);
  const sellFailed = sellChecks.filter(c => !c.ok).map(c => c.label);

  if (adx < 25) {
    return { signal: 'HOLD', reason: [`ADX(${fmt(adx, 1)}) < 25 — weak trend`], indicators: ind, buyScore, sellScore };
  }
  if (diSpread < 15) {
    return { signal: 'HOLD', reason: [`DI spread(${fmt(diSpread, 1)}) < 15 — insufficient directional conviction`], indicators: ind, buyScore, sellScore };
  }
  if (adxSlope !== null && adxSlope <= 0) {
    return { signal: 'HOLD', reason: [`ADX slope (${fmt(adxSlope, 2)}) ≤ 0 — trend fading`], indicators: ind, buyScore, sellScore };
  }
  if (atrMA20 !== null && atr > atrMA20 * 1.3) {
    return { signal: 'HOLD', reason: [`ATR spike: ATR(${fmt(atr, 0)}) > 1.3×ATR_MA(${fmt(atrMA20, 0)})`], indicators: ind, buyScore, sellScore };
  }
  const ema21Dist = Math.abs(price - ema21);
  if (ema21Dist > atr * 1.5) {
    return { signal: 'HOLD', reason: [`Price overextended: |price−EMA21|(${fmt(ema21Dist, 0)}) > 1.5×ATR(${fmt(atr * 1.5, 0)})`], indicators: ind, buyScore, sellScore };
  }

  const THRESHOLD = 6;
  if (buyScore >= THRESHOLD && buyScore > sellScore) {
    return { signal: 'BUY', reason: buyPassed, indicators: ind, buyScore, sellScore };
  }
  if (sellScore >= THRESHOLD && sellScore > buyScore) {
    return { signal: 'SELL', reason: sellPassed, indicators: ind, buyScore, sellScore };
  }

  const holdReason = buyScore > sellScore
    ? [`BUY score ${buyScore}/7 — need 6 (missing: ${buyFailed.join(', ')})`]
    : [`SELL score ${sellScore}/7 — need 6 (missing: ${sellFailed.join(', ')})`];
  return { signal: 'HOLD', reason: holdReason, indicators: ind, buyScore, sellScore };
}

// ── Exit check — NO fixed TP (trailing takes over at $300 profit) ──
function checkExit(position, candles) {
  const ind = computeIndicators(candles);
  const { price } = ind;
  const { side, entryPrice, stopLoss } = position;

  const reasons = [];

  if (side === 'long') {
    if (price <= stopLoss)          reasons.push(`SL hit: ${price.toFixed(2)} ≤ ${stopLoss.toFixed(2)}`);
    if (price <= entryPrice - 1000) reasons.push(`$1000 adverse: ${price.toFixed(2)} ≤ ${(entryPrice - 1000).toFixed(2)}`);
  } else {
    if (price >= stopLoss)          reasons.push(`SL hit: ${price.toFixed(2)} ≥ ${stopLoss.toFixed(2)}`);
    if (price >= entryPrice + 1000) reasons.push(`$1000 adverse: ${price.toFixed(2)} ≥ ${(entryPrice + 1000).toFixed(2)}`);
  }

  return { exit: reasons.length > 0, reasons, indicators: ind };
}

// ── Trailing SL computation ───────────────────────────────────────
// Band-based $50/step starting at $300 profit (band 6):
//   band = floor(unrealPnl / 50); lock = (band - 1) * 50
//   $300 (band 6) → lock $250, $350 (band 7) → lock $300, ...
function computeTrailUpdate(position, unrealPnl) {
  const { side, entryPrice, size, stopLoss } = position;
  const band = Math.floor(unrealPnl / 50);
  if (band < 6) return null;

  const lockProfit = (band - 1) * 50;
  const newSl = side === 'long'
    ? entryPrice + lockProfit / size
    : entryPrice - lockProfit / size;

  const improved = side === 'long' ? newSl > stopLoss : newSl < stopLoss;
  return improved ? { oldSl: stopLoss, newSl, lockProfit } : null;
}

// ── Kraken data fetchers ──────────────────────────────────────────

const KRAKEN_PAIR = {
  BTCUSDT:  'XBTUSD', ETHUSDT:  'ETHUSD',
  SOLUSDT:  'SOLUSD', XRPUSDT:  'XRPUSD',
  ADAUSDT:  'ADAUSD', LTCUSDT:  'LTCUSD',
  DOGEUSDT: 'XDGUSD',
};
const KRAKEN_INTERVAL = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440,
};

function fetchCandlesRaw(pair, ivMin, since) {
  return new Promise((resolve, reject) => {
    const qs = `pair=${pair}&interval=${ivMin}${since ? `&since=${since}` : ''}`;
    const opts = { hostname: 'api.kraken.com', path: `/0/public/OHLC?${qs}`, method: 'GET' };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.error && json.error.length) return reject(new Error(json.error[0]));
          const key = Object.keys(json.result).find(k => k !== 'last');
          if (!key) return reject(new Error('No OHLC key in Kraken response'));
          const candles = json.result[key].map(c => ({
            time: c[0] * 1000, open: +c[1], high: +c[2], low: +c[3],
            close: +c[4], volume: +c[6],
          }));
          resolve({ candles, last: json.result.last });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchCandles(symbol, interval, limit = 200) {
  const pair  = KRAKEN_PAIR[symbol] || symbol;
  const ivMin = KRAKEN_INTERVAL[interval] || 60;
  const { candles } = await fetchCandlesRaw(pair, ivMin, null);
  return candles.slice(-limit);
}

async function fetchCandlesHistorical(symbol, interval, months) {
  const pair  = KRAKEN_PAIR[symbol] || symbol;
  const ivMin = KRAKEN_INTERVAL[interval] || 60;
  const ivSec = ivMin * 60;
  const now   = Math.floor(Date.now() / 1000);
  const fetchFrom    = now - Math.ceil(months * 30.44 * 24 * 3600) - 100 * ivSec;
  const candlesNeeded = Math.ceil((now - fetchFrom) / ivSec);
  const maxCalls      = Math.min(50, Math.ceil(candlesNeeded / 700) + 2);
  const allCandles    = [];
  let since = fetchFrom;
  for (let i = 0; i < maxCalls; i++) {
    const { candles, last } = await fetchCandlesRaw(pair, ivMin, since);
    if (!candles.length) break;
    const seen = new Set(allCandles.map(c => c.time));
    allCandles.push(...candles.filter(c => !seen.has(c.time)));
    const lastMs = allCandles[allCandles.length - 1].time;
    if (lastMs / 1000 >= now - ivSec * 3) break;
    since = last || Math.floor(lastMs / 1000) + 1;
    if (i < maxCalls - 1) await new Promise(r => setTimeout(r, 350));
  }
  return allCandles;
}

// Lightweight single-price fetch via Kraken Ticker endpoint.
// Used by the 10-second fast poll to avoid fetching 250 candles every 10s.
async function fetchCurrentPrice(symbol) {
  const pair = KRAKEN_PAIR[symbol] || symbol;
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.kraken.com',
      path: `/0/public/Ticker?pair=${pair}`,
      method: 'GET',
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.error && json.error.length) return reject(new Error(json.error[0]));
          const key = Object.keys(json.result)[0];
          resolve(parseFloat(json.result[key].c[0]));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = {
  computeIndicators, generateSignal, checkExit, computeTrailUpdate,
  fetchCandles, fetchCandlesHistorical, fetchCurrentPrice,
};
