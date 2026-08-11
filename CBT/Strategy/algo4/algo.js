'use strict';

const https = require('https');

// ── Strategy constants ────────────────────────────────────────────
const EMA_LEN            = 10;    // 10-period EMA on closes
const RF_SAMPLING_PERIOD = 100;   // Range Filter sampling period
const RF_MULT            = 3.0;   // Range Filter multiplier
const MAX_LOSS           = 150.0; // Fixed max risk per trade ($)
const MAX_QTY            = 5.0;   // Hard cap on position size
const SL_ATR_MULT        = 1.5;   // Initial SL distance = 1.5 × ATR14 → risk = $150 exactly
const MIN_BODY_RATIO     = 0.30;  // Signal candle body ≥ 30% of high-low range (not doji)
const CONSEC_BARS_MIN    = 4;     // Min consecutive bars below/above EMA before crossover
const SWING_LOOKBACK     = 5;     // Bars to look back for SL reference (recent swing)
const ATR_LEN            = 14;
const WARMUP_BARS        = 500;   // KAMA(100) needs ~500 bars to settle

// ── Pine-style EMA (seeded with first value) ─────────────────────
function pineEma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(0);
  if (n === 0) return out;
  const k = 2 / (period + 1);
  let val = values[0];
  out[0] = val;
  for (let i = 1; i < n; i++) {
    val = values[i] * k + val * (1 - k);
    out[i] = val;
  }
  return out;
}

// ── Range Filter (smoothrng + rngfilt) ───────────────────────────
function smoothRng(src, t, m) {
  const n = src.length;
  const absDiff = new Array(n).fill(0);
  for (let i = 1; i < n; i++) absDiff[i] = Math.abs(src[i] - src[i - 1]);
  const avrng = pineEma(absDiff, t);
  const wper  = t * 2 - 1;
  const smrng = pineEma(avrng, wper);
  return smrng.map(v => v * m);
}

function rngFilt(x, r) {
  const n = x.length;
  const out = new Array(n).fill(0);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const ri = r[i];
    let rf;
    if (x[i] > prev) {
      const cand = x[i] - ri;
      rf = cand < prev ? prev : cand;
    } else {
      const cand = x[i] + ri;
      rf = cand > prev ? prev : cand;
    }
    out[i] = rf;
    prev = rf;
  }
  return out;
}

// ── KAMA (Kaufman Adaptive Moving Average) ───────────────────────
function kama(s, len) {
  const n = s.length;
  const out = new Array(n).fill(0);
  const fastend = 0.666;
  const slowend = 0.0645;
  const xvnoise = new Array(n).fill(0);
  for (let i = 1; i < n; i++) xvnoise[i] = Math.abs(s[i] - s[i - 1]);
  let noiseSum = 0;
  let ama = s[0] || 0;
  for (let i = 0; i < n; i++) {
    if (i >= len) noiseSum -= xvnoise[i - len];
    noiseSum += xvnoise[i];
    let ratio = 0;
    if (i >= len && noiseSum > 0) ratio = Math.abs(s[i] - s[i - len]) / noiseSum;
    const smooth = Math.pow(ratio * (fastend - slowend) + slowend, 2);
    ama = ama + smooth * (s[i] - ama);
    out[i] = ama;
  }
  return out;
}

// ── 10-period EMA (seeded with SMA of first 10 bars) ─────────────
function compute10EMA(closes) {
  const n   = closes.length;
  const out = new Array(n).fill(null);
  if (n < EMA_LEN) return out;
  const k = 2 / (EMA_LEN + 1);
  let sum = 0;
  for (let i = 0; i < EMA_LEN; i++) sum += closes[i];
  let val = sum / EMA_LEN;
  out[EMA_LEN - 1] = val;
  for (let i = EMA_LEN; i < n; i++) {
    val = closes[i] * k + val * (1 - k);
    out[i] = val;
  }
  return out;
}

// ── ATR (Wilder) ──────────────────────────────────────────────────
function computeATR(candles, len) {
  const n   = candles.length;
  const atr = new Array(n).fill(0);
  if (n === 0) return atr;
  const tr = new Array(n).fill(0);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < n; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += tr[i];
    if (i < len)        atr[i] = sum / (i + 1);
    else if (i === len) atr[i] = sum / (len + 1);
    else                atr[i] = (atr[i-1] * (len - 1) + tr[i]) / len;
  }
  return atr;
}

// ── Full-series computation ───────────────────────────────────────
function computeSeries(candles) {
  const n     = candles.length;
  const src   = candles.map(c => c.close);
  const ohlc4 = candles.map(c => (c.open + c.high + c.low + c.close) / 4);
  const highs = candles.map(c => c.high);
  const lows  = candles.map(c => c.low);
  const opens = candles.map(c => c.open);

  const ema10    = compute10EMA(src);
  const atr      = computeATR(candles, ATR_LEN);
  const aboveEMA = new Array(n).fill(0);
  const belowEMA = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    if (ema10[i] == null) continue;
    if (src[i] > ema10[i]) {
      aboveEMA[i] = (aboveEMA[i-1] > 0 ? aboveEMA[i-1] : 0) + 1;
      belowEMA[i] = 0;
    } else if (src[i] < ema10[i]) {
      belowEMA[i] = (belowEMA[i-1] > 0 ? belowEMA[i-1] : 0) + 1;
      aboveEMA[i] = 0;
    }
  }

  // Range Filter
  const smrng = smoothRng(src, RF_SAMPLING_PERIOD, RF_MULT);
  const filt  = rngFilt(src, smrng);
  const hband = filt.map((f, i) => f + smrng[i]);
  const lband = filt.map((f, i) => f - smrng[i]);

  // KAMA cloud — 19 MAs spaced 5..100 on ohlc4, totalDistance measures spread
  const ma05  = kama(ohlc4,  5);  const ma10k = kama(ohlc4, 10);
  const ma15  = kama(ohlc4, 15);  const ma20  = kama(ohlc4, 20);
  const ma25  = kama(ohlc4, 25);  const ma30  = kama(ohlc4, 30);
  const ma35  = kama(ohlc4, 35);  const ma40  = kama(ohlc4, 40);
  const ma45  = kama(ohlc4, 45);  const ma50  = kama(ohlc4, 50);
  const ma55  = kama(ohlc4, 55);  const ma60  = kama(ohlc4, 60);
  const ma65  = kama(ohlc4, 65);  const ma70  = kama(ohlc4, 70);
  const ma75  = kama(ohlc4, 75);  const ma80  = kama(ohlc4, 80);
  const ma85  = kama(ohlc4, 85);  const ma90  = kama(ohlc4, 90);
  const ma100 = kama(ohlc4, 100);

  const totalDistance = new Array(n);
  for (let i = 0; i < n; i++) {
    totalDistance[i] = (
      (ma05[i]-ma10k[i])/ma10k[i]  + (ma10k[i]-ma15[i])/ma15[i]  +
      (ma15[i]-ma20[i])/ma20[i]    + (ma20[i]-ma25[i])/ma25[i]   +
      (ma25[i]-ma30[i])/ma30[i]    + (ma30[i]-ma35[i])/ma35[i]   +
      (ma35[i]-ma40[i])/ma40[i]    + (ma40[i]-ma45[i])/ma45[i]   +
      (ma45[i]-ma50[i])/ma50[i]    + (ma50[i]-ma55[i])/ma55[i]   +
      (ma55[i]-ma60[i])/ma60[i]    + (ma60[i]-ma65[i])/ma65[i]   +
      (ma65[i]-ma70[i])/ma70[i]    + (ma70[i]-ma75[i])/ma75[i]   +
      (ma75[i]-ma80[i])/ma80[i]    + (ma80[i]-ma85[i])/ma85[i]   +
      (ma85[i]-ma90[i])/ma90[i]    + (ma90[i]-ma100[i])/ma100[i]
    ) / 18;
  }

  const p1 = kama(src, 100);
  const p2 = new Array(n);
  for (let i = 0; i < n; i++) p2[i] = p1[i] * (1 + totalDistance[i] * 10);
  const p3 = kama(p2, 10);

  // Zone: greenZone = hband > p1 AND lband > p1 AND p2 > p1 AND p3 > p1 (BUY only)
  //        sellZone = hband < p1 AND lband < p1 AND p2 < p1 AND p3 < p1 (SELL only)
  const greenZone = new Array(n);
  const sellZone  = new Array(n);
  for (let i = 0; i < n; i++) {
    greenZone[i] = hband[i] > p1[i] && lband[i] > p1[i] && p2[i] > p1[i] && p3[i] > p1[i];
    sellZone[i]  = hband[i] < p1[i] && lband[i] < p1[i] && p2[i] < p1[i] && p3[i] < p1[i];
  }

  return { src, highs, lows, opens, ema10, atr, aboveEMA, belowEMA,
           smrng, filt, hband, lband, p1, p2, p3, greenZone, sellZone };
}

// ── Snapshot last bar's indicators ───────────────────────────────
function snapshotIndicators(series, candles, i) {
  const body      = Math.abs(series.src[i] - series.opens[i]);
  const range     = series.highs[i] - series.lows[i];
  const bodyRatio = range > 0 ? body / range : 0;
  return {
    price:      series.src[i],
    ema10:      series.ema10[i],
    atr:        series.atr[i],
    aboveEMA:   series.aboveEMA[i],
    belowEMA:   series.belowEMA[i],
    high:       series.highs[i],
    low:        series.lows[i],
    open:       series.opens[i],
    bodyRatio,
    filt:       series.filt[i],
    hband:      series.hband[i],
    lband:      series.lband[i],
    p1:         series.p1[i],
    p2:         series.p2[i],
    p3:         series.p3[i],
    greenZone:  series.greenZone[i],
    sellZone:   series.sellZone[i],
    candleTime: candles[i].time,
  };
}

// ── Signal generation ─────────────────────────────────────────────
// BUY:  ≥CONSEC_BARS_MIN closes below EMA, strong green candle closes above EMA,
//       AND in greenZone (hband > p1 AND lband > p1 AND p2 > p1 AND p3 > p1).
// SELL: ≥CONSEC_BARS_MIN closes above EMA, strong red candle closes below EMA,
//       AND in sellZone (hband < p1 AND lband < p1 AND p2 < p1 AND p3 < p1).
// No fixed TP — trailing SL is the only exit.
function generateSignal(candles, posSide = null) {
  const series = computeSeries(candles);
  const i      = candles.length - 1;

  if (i < 1) {
    return { signal: 'HOLD', reason: ['Not enough bars'], indicators: {}, entryHint: null, posSide };
  }

  const { src, highs, lows, opens, ema10, atr, aboveEMA, belowEMA, greenZone, sellZone } = series;
  const price     = src[i];
  const ema       = ema10[i];
  const high      = highs[i];
  const low       = lows[i];
  const open      = opens[i];
  const body      = Math.abs(price - open);
  const range     = high - low;
  const bodyRatio = range > 0 ? body / range : 0;

  const prevBelowEMA = belowEMA[i-1] || 0;
  const prevAboveEMA = aboveEMA[i-1] || 0;
  const inGreenZone  = greenZone[i];
  const inSellZone   = sellZone[i];

  const indicators = snapshotIndicators(series, candles, i);
  const reason     = [];
  let signal       = 'HOLD';
  let entryHint    = null;

  if (ema == null) {
    reason.push(`Warming up — need ${EMA_LEN} bars for EMA(${EMA_LEN})`);
    return { signal, reason, indicators, entryHint, posSide };
  }

  // BUY crossover
  if (prevBelowEMA >= CONSEC_BARS_MIN && price > ema && inGreenZone) {
    const isStrongGreen = price > open && bodyRatio >= MIN_BODY_RATIO;
    if (isStrongGreen) {
      const start = Math.max(0, i - SWING_LOOKBACK);
      let recentLow = Infinity;
      for (let j = start; j < i; j++) recentLow = Math.min(recentLow, lows[j]);
      const riskDist = price - recentLow;
      if (riskDist > 0) {
        signal = 'BUY';
        reason.push(`BUY: ${prevBelowEMA} bars below EMA(${EMA_LEN}) → close ${price.toFixed(2)} above EMA ${ema.toFixed(2)} [greenZone]`);
        reason.push(`Body ${(bodyRatio*100).toFixed(0)}% · SL ${recentLow.toFixed(2)} (${SWING_LOOKBACK}-bar low) · ATR ${atr[i].toFixed(2)}`);
        entryHint = { side: 'long', slPrice: recentLow, atr: atr[i], riskDist };
      } else {
        reason.push(`BUY setup (${prevBelowEMA} bars below, greenZone) but SL ref ${recentLow.toFixed(2)} ≥ close ${price.toFixed(2)} — skip`);
      }
    } else {
      const why = price <= open ? 'not a green candle' : `body ${(bodyRatio*100).toFixed(0)}% < ${(MIN_BODY_RATIO*100).toFixed(0)}% (doji)`;
      reason.push(`BUY setup (${prevBelowEMA} bars below EMA, greenZone) — signal bar weak: ${why}`);
    }
  }
  // SELL crossover
  else if (prevAboveEMA >= CONSEC_BARS_MIN && price < ema && inSellZone) {
    const isStrongRed = price < open && bodyRatio >= MIN_BODY_RATIO;
    if (isStrongRed) {
      const start = Math.max(0, i - SWING_LOOKBACK);
      let recentHigh = -Infinity;
      for (let j = start; j < i; j++) recentHigh = Math.max(recentHigh, highs[j]);
      const riskDist = recentHigh - price;
      if (riskDist > 0) {
        signal = 'SELL';
        reason.push(`SELL: ${prevAboveEMA} bars above EMA(${EMA_LEN}) → close ${price.toFixed(2)} below EMA ${ema.toFixed(2)} [sellZone]`);
        reason.push(`Body ${(bodyRatio*100).toFixed(0)}% · SL ${recentHigh.toFixed(2)} (${SWING_LOOKBACK}-bar high) · ATR ${atr[i].toFixed(2)}`);
        entryHint = { side: 'short', slPrice: recentHigh, atr: atr[i], riskDist };
      } else {
        reason.push(`SELL setup (${prevAboveEMA} bars above, sellZone) but SL ref ${recentHigh.toFixed(2)} ≤ close ${price.toFixed(2)} — skip`);
      }
    } else {
      const why = price >= open ? 'not a red candle' : `body ${(bodyRatio*100).toFixed(0)}% < ${(MIN_BODY_RATIO*100).toFixed(0)}% (doji)`;
      reason.push(`SELL setup (${prevAboveEMA} bars above EMA, sellZone) — signal bar weak: ${why}`);
    }
  } else {
    const zoneStr = inGreenZone ? 'greenZone' : inSellZone ? 'sellZone' : 'NO ZONE (sideways filtered)';
    const below = belowEMA[i] || 0;
    const above = aboveEMA[i] || 0;
    if (below >= 1) {
      reason.push(`Below EMA — ${below} bar${below>1?'s':''} (need ${CONSEC_BARS_MIN}) · zone: ${zoneStr}`);
    } else if (above >= 1) {
      reason.push(`Above EMA — ${above} bar${above>1?'s':''} (need ${CONSEC_BARS_MIN}) · zone: ${zoneStr}`);
    } else {
      reason.push(`EMA(10)=${ema.toFixed(2)} · close=${price.toFixed(2)} · zone: ${zoneStr}`);
    }
  }

  return { signal, reason, indicators, entryHint, posSide };
}

// ── Initialise a position after fill at entryPrice ───────────────
// No fixed TP — trailing SL is the only exit.
function initPosition(side, entryPrice, slPrice, qty, entryTime, atr) {
  const riskPerUnit = side === 'long' ? entryPrice - slPrice : slPrice - entryPrice;
  return {
    side, entryPrice, entryTime,
    size: qty, slPrice, riskPerUnit,
    atr:             atr || null,
    trailing:        false,
    trailStop:       null,
    trailLockProfit: 0,
    stopLoss:        slPrice,
    unrealizedPnl:   0,
    mae:             0,
  };
}

// ── Advance a position one bar/tick (milestone trailing SL) ──────
// Trailing milestones (dollar PnL from bestPx intra-bar):
//   < $200        → initial SL, no trail
//   $200–$249     → SL → break-even ($0 locked)
//   $250–$299     → SL locks $100 profit
//   $300+         → SL locks $200 + floor((bestPnl-300)/100)*100
//   Trail stop never retreats. Stop hit intra-bar → exit at stopNow.
function stepPosition(pos, candle) {
  const { side, entryPrice, size, slPrice } = pos;
  let   { trailing, trailStop, trailLockProfit = 0 } = pos;
  const { high, low, close } = candle;

  const bestPx  = side === 'long' ? high : low;
  const bestPnl = side === 'long'
    ? (bestPx - entryPrice) * size
    : (entryPrice - bestPx) * size;

  let proposedLock = null;
  if (bestPnl >= 200) {
    if (bestPnl >= 300) {
      proposedLock = 200 + Math.floor((bestPnl - 300) / 100) * 100;
    } else if (bestPnl >= 250) {
      proposedLock = 100;
    } else {
      proposedLock = 0; // break-even
    }
  }

  if (proposedLock !== null) {
    const proposedSl = side === 'long'
      ? entryPrice + proposedLock / size
      : entryPrice - proposedLock / size;
    const improved = !trailing
      || (side === 'long' ? proposedSl > trailStop : proposedSl < trailStop);
    if (improved) {
      trailing        = true;
      trailStop       = proposedSl;
      trailLockProfit = proposedLock;
    }
  }

  const stopNow = trailing ? trailStop : slPrice;
  const stopHit = side === 'long' ? low <= stopNow : high >= stopNow;

  const unrealPnl = side === 'long'
    ? (close - entryPrice) * size
    : (entryPrice - close) * size;
  const worstPx  = side === 'long' ? low : high;
  const worstPnl = side === 'long'
    ? (worstPx - entryPrice) * size
    : (entryPrice - worstPx) * size;

  if (stopHit) {
    const exitPnl = side === 'long'
      ? (stopNow - entryPrice) * size
      : (entryPrice - stopNow) * size;
    return {
      exit: true, exitPrice: stopNow, exitPnl,
      trailing, trailStop, trailLockProfit, stopNow, unrealPnl, worstPnl,
      reason: trailing
        ? `Trailing stop hit @ ${stopNow.toFixed(2)} (locked $${trailLockProfit.toFixed(0)} profit)`
        : `Initial SL hit @ ${stopNow.toFixed(2)} ($150 max loss)`,
    };
  }
  return { exit: false, trailing, trailStop, trailLockProfit, stopNow, unrealPnl, worstPnl };
}

// ── Kraken data fetchers ──────────────────────────────────────────
const KRAKEN_PAIR = {
  BTCUSDT: 'XBTUSD', ETHUSDT: 'ETHUSD',
  SOLUSDT: 'SOLUSD', XRPUSDT: 'XRPUSD',
  ADAUSDT: 'ADAUSD', LTCUSDT: 'LTCUSD',
  DOGEUSDT: 'XDGUSD',
};
const KRAKEN_INTERVAL = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440,
};

function fetchCandlesRaw(pair, ivMin, since) {
  return new Promise((resolve, reject) => {
    const qs   = `pair=${pair}&interval=${ivMin}${since ? `&since=${since}` : ''}`;
    const opts = { hostname: 'api.kraken.com', path: `/0/public/OHLC?${qs}`, method: 'GET' };
    const req  = https.request(opts, res => {
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

function dropUnfinished(candles, ivMs) {
  const now = Date.now();
  return candles.filter(c => (c.time + ivMs) <= now);
}

async function fetchCandles(symbol, interval, limit = 720) {
  const pair  = KRAKEN_PAIR[symbol] || symbol;
  const ivMin = KRAKEN_INTERVAL[interval] || 15;
  const ivMs  = ivMin * 60 * 1000;
  const { candles } = await fetchCandlesRaw(pair, ivMin, null);
  return dropUnfinished(candles, ivMs).slice(-limit);
}

async function fetchCandlesHistorical(symbol, interval, months) {
  const pair  = KRAKEN_PAIR[symbol] || symbol;
  const ivMin = KRAKEN_INTERVAL[interval] || 15;
  const ivSec = ivMin * 60;
  const ivMs  = ivSec * 1000;
  const now   = Math.floor(Date.now() / 1000);
  const fetchFrom     = now - Math.ceil(months * 30.44 * 24 * 3600) - WARMUP_BARS * ivSec;
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
  return dropUnfinished(allCandles, ivMs);
}

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
  EMA_LEN, RF_SAMPLING_PERIOD, RF_MULT, MAX_LOSS, MAX_QTY, SL_ATR_MULT,
  MIN_BODY_RATIO, CONSEC_BARS_MIN, SWING_LOOKBACK, ATR_LEN, WARMUP_BARS,
  pineEma, smoothRng, rngFilt, kama,
  compute10EMA, computeATR, computeSeries, snapshotIndicators,
  generateSignal, initPosition, stepPosition,
  fetchCandles, fetchCandlesHistorical, fetchCurrentPrice,
};
