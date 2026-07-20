'use strict';

const https = require('https');

// ── Pine Script defaults (Range Filter + KAMA Cloud Strategy V2) ──
const RF_SAMPLING_PERIOD = 100;   // Range Filter sampling period
const RF_MULT            = 3.0;   // Range Filter multiplier
const MAX_LOSS           = 150.0; // Fixed intended max loss per trade at sizeFactor=1
const SL_ATR_MULT        = 1.5;   // Sizing distance = SL_ATR_MULT × ATR (algo1 uses 1.5)
const TRAIL_START_PNL    = 300.0; // Unrealised PnL @ sizeFactor=1 that first activates trailing
const TRAIL_STEP_PNL     = 100.0; // PnL bucket @ sizeFactor=1; scaled per-position at fill time
const MIN_ATR            = 15.0;  // Below this, SL breathing room is too tight — skip the entry
const ATR_LEN            = 14;    // ATR period (drives sizing + reported in indicators)
const USE_BAR_COLOR      = true;  // Bar color gates zones (green=buy, red=sell)

const WARMUP_BARS = 500;          // KAMA(100) + Range Filter need long warmup

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
// Pine-canonical seed: nAMA[0] = src[0] (matches `na(nAMA[1]) ? src : ...`).
// Seeding at 0 leaves an ~$27 residual on BTCUSD after 720 warmup bars;
// seeding at src[0] converges to Pine's plot within pennies.
function kama(s, len) {
  const n = s.length;
  const out = new Array(n).fill(0);
  const fastend = 0.666;
  const slowend = 0.0645;
  const xvnoise = new Array(n).fill(0);
  for (let i = 1; i < n; i++) xvnoise[i] = Math.abs(s[i] - s[i - 1]);

  let noiseSum = 0;
  let ama      = s[0] || 0;
  for (let i = 0; i < n; i++) {
    if (i >= len) noiseSum -= xvnoise[i - len];
    noiseSum += xvnoise[i];
    let ratio = 0;
    if (i >= len && noiseSum > 0) {
      ratio = Math.abs(s[i] - s[i - len]) / noiseSum;
    }
    const smooth = Math.pow(ratio * (fastend - slowend) + slowend, 2);
    ama = ama + smooth * (s[i] - ama);
    out[i] = ama;
  }
  return out;
}

// ── ATR (Wilder) ─────────────────────────────────────────────────
function computeATR(candles, len) {
  const n = candles.length;
  const atr = new Array(n).fill(0);
  if (n === 0) return atr;
  const tr = new Array(n).fill(0);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < n; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  // Running SMA until we reach `len`, then Wilder smoothing.
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += tr[i];
    if (i < len) {
      atr[i] = sum / (i + 1);
    } else if (i === len) {
      atr[i] = sum / (len + 1);       // seed with SMA(len+1)
    } else {
      atr[i] = (atr[i - 1] * (len - 1) + tr[i]) / len;
    }
  }
  return atr;
}

// ── Full-series indicator computation ────────────────────────────
function computeSeries(candles) {
  const n     = candles.length;
  const src   = candles.map(c => c.close);
  const ohlc4 = candles.map(c => (c.open + c.high + c.low + c.close) / 4);
  const highs = candles.map(c => c.high);
  const lows  = candles.map(c => c.low);

  // Range Filter
  const smrng = smoothRng(src, RF_SAMPLING_PERIOD, RF_MULT);
  const filt  = rngFilt(src, smrng);
  const hband = filt.map((f, i) => f + smrng[i]);
  const lband = filt.map((f, i) => f - smrng[i]);

  const upward   = new Array(n).fill(0);
  const downward = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if      (filt[i] > filt[i-1]) upward[i]   = upward[i-1] + 1;
    else if (filt[i] < filt[i-1]) upward[i]   = 0;
    else                          upward[i]   = upward[i-1];
    if      (filt[i] < filt[i-1]) downward[i] = downward[i-1] + 1;
    else if (filt[i] > filt[i-1]) downward[i] = 0;
    else                          downward[i] = downward[i-1];
  }

  const isGreenBar = new Array(n);
  const isBlueBar  = new Array(n);
  for (let i = 0; i < n; i++) {
    isGreenBar[i] = src[i] > filt[i] && upward[i]   > 0;
    isBlueBar[i]  = src[i] < filt[i] && downward[i] > 0;
  }

  // KAMA cloud
  const ma05  = kama(ohlc4,  5);
  const ma10  = kama(ohlc4, 10);
  const ma15  = kama(ohlc4, 15);
  const ma20  = kama(ohlc4, 20);
  const ma25  = kama(ohlc4, 25);
  const ma30  = kama(ohlc4, 30);
  const ma35  = kama(ohlc4, 35);
  const ma40  = kama(ohlc4, 40);
  const ma45  = kama(ohlc4, 45);
  const ma50  = kama(ohlc4, 50);
  const ma55  = kama(ohlc4, 55);
  const ma60  = kama(ohlc4, 60);
  const ma65  = kama(ohlc4, 65);
  const ma70  = kama(ohlc4, 70);
  const ma75  = kama(ohlc4, 75);
  const ma80  = kama(ohlc4, 80);
  const ma85  = kama(ohlc4, 85);
  const ma90  = kama(ohlc4, 90);
  const ma100 = kama(ohlc4, 100);

  const totalDistance = new Array(n);
  for (let i = 0; i < n; i++) {
    totalDistance[i] = (
      (ma05[i] - ma10[i])  / ma10[i]  +
      (ma10[i] - ma15[i])  / ma15[i]  +
      (ma15[i] - ma20[i])  / ma20[i]  +
      (ma20[i] - ma25[i])  / ma25[i]  +
      (ma25[i] - ma30[i])  / ma30[i]  +
      (ma30[i] - ma35[i])  / ma35[i]  +
      (ma35[i] - ma40[i])  / ma40[i]  +
      (ma40[i] - ma45[i])  / ma45[i]  +
      (ma45[i] - ma50[i])  / ma50[i]  +
      (ma50[i] - ma55[i])  / ma55[i]  +
      (ma55[i] - ma60[i])  / ma60[i]  +
      (ma60[i] - ma65[i])  / ma65[i]  +
      (ma65[i] - ma70[i])  / ma70[i]  +
      (ma70[i] - ma75[i])  / ma75[i]  +
      (ma75[i] - ma80[i])  / ma80[i]  +
      (ma80[i] - ma85[i])  / ma85[i]  +
      (ma85[i] - ma90[i])  / ma90[i]  +
      (ma90[i] - ma100[i]) / ma100[i]
    ) / 18;
  }

  const p1 = kama(src, 100);
  const p2 = new Array(n);
  for (let i = 0; i < n; i++) p2[i] = p1[i] * (1 + totalDistance[i] * 10);
  const p3 = kama(p2, 10);

  const cloudTop = new Array(n);
  const cloudBot = new Array(n);
  for (let i = 0; i < n; i++) {
    cloudTop[i] = Math.max(p2[i], p3[i]);
    cloudBot[i] = Math.min(p2[i], p3[i]);
  }

  // Zones — bar color (matches UI: red when downward>0, green otherwise)
  // AND hband/lband AND p2/p3 all on the same side of p1.
  const buyZone  = new Array(n);
  const sellZone = new Array(n);
  for (let i = 0; i < n; i++) {
    const barRed   = downward[i] > 0;
    const barGreen = !barRed;
    buyZone[i]  = barGreen &&
      p2[i]    > p1[i] && p3[i]    > p1[i] &&
      hband[i] > p1[i] && lband[i] > p1[i];
    sellZone[i] = barRed &&
      p2[i]    < p1[i] && p3[i]    < p1[i] &&
      hband[i] < p1[i] && lband[i] < p1[i];
  }

  const atr = computeATR(candles, ATR_LEN);

  return {
    src, highs, lows,
    smrng, filt, hband, lband, upward, downward,
    isGreenBar, isBlueBar,
    p1, p2, p3, cloudTop, cloudBot, totalDistance,
    buyZone, sellZone, atr,
  };
}

// ── Snapshot last bar's indicators (for UI/logging) ──────────────
function snapshotIndicators(series, i) {
  return {
    price:         series.src[i],
    filt:          series.filt[i],
    hband:         series.hband[i],
    lband:         series.lband[i],
    smrng:         series.smrng[i],
    upward:        series.upward[i],
    downward:      series.downward[i],
    isGreenBar:    series.isGreenBar[i],
    isBlueBar:     series.isBlueBar[i],
    p1:            series.p1[i],
    p2:            series.p2[i],
    p3:            series.p3[i],
    cloudTop:      series.cloudTop[i],
    cloudBot:      series.cloudBot[i],
    totalDistance: series.totalDistance[i],
    buyZone:       series.buyZone[i],
    sellZone:      series.sellZone[i],
    atr:           series.atr[i],
    high:          series.highs[i],
    low:           series.lows[i],
  };
}

// ── Stateful signal generation ────────────────────────────────────
// Flag rules:
//   • LONG flag forms on the first bar whose LOW touches the KAMA cloud
//     (low ≤ cloudTop) *while buyZone is active*.  Its running SL is the
//     minimum low of the flag bar and every subsequent bar until trigger.
//   • Flag is cleared the moment buyZone drops (strict zone gate) so a
//     stale flag cannot fire a BUY on a non-green bar.
//   • LONG trigger: buyZone still true AND close > p2 AND close > p3.
//   • Short is the mirror image.
//
// Triggers fire regardless of current position; callers decide whether to
// (a) open, (b) ignore (same-side), or (c) exit-then-open (opposite-side).
// Quantity is sized in the server at fill time:
//   qty = ($150 / (1.5 × ATR)) × sizeFactor   → SL hit loss ≈ $150 × sizeFactor
function generateSignal(candles, flagState = {}, posSide = null) {
  const series = computeSeries(candles);
  const i = candles.length - 1;

  let { longFlag = false, longFlagLow = null,
        shortFlag = false, shortFlagHigh = null } = flagState;

  const buyZone  = series.buyZone[i];
  const sellZone = series.sellZone[i];
  const low   = series.lows[i];
  const high  = series.highs[i];
  const close = series.src[i];
  const cloudTop = series.cloudTop[i];
  const cloudBot = series.cloudBot[i];
  const p2 = series.p2[i];
  const p3 = series.p3[i];
  const atr = series.atr[i];

  // ── LONG flag ────────────────────────────────────────────────────
  if (buyZone) {
    if (!longFlag && low <= cloudTop) {
      longFlag = true;
      longFlagLow = low;                          // flag candle low = seed SL
    } else if (longFlag) {
      longFlagLow = Math.min(longFlagLow, low);   // track lowest low up to trigger
    }
  } else {
    longFlag = false; longFlagLow = null;         // zone dropped → invalidate
  }

  // ── SHORT flag ───────────────────────────────────────────────────
  if (sellZone) {
    if (!shortFlag && high >= cloudBot) {
      shortFlag = true;
      shortFlagHigh = high;
    } else if (shortFlag) {
      shortFlagHigh = Math.max(shortFlagHigh, high);
    }
  } else {
    shortFlag = false; shortFlagHigh = null;
  }

  // Strict: zone must STILL be true at trigger bar.
  const longTrigger  = longFlag  && buyZone  && close > p2 && close > p3;
  const shortTrigger = shortFlag && sellZone && close < p2 && close < p3;

  let signal = 'HOLD';
  const reason = [];
  let entryHint = null;

  if (longTrigger) {
    const riskEst = close - longFlagLow;
    if (atr < MIN_ATR) {
      reason.push(`Long trigger SKIPPED — ATR ${atr.toFixed(2)} < MIN_ATR ${MIN_ATR} (SL breathing room too tight)`);
      longFlag = false; longFlagLow = null;
    } else if (riskEst > 0) {
      signal = 'BUY';
      reason.push(`Long trigger — close ${close.toFixed(2)} > p2 ${p2.toFixed(2)} & p3 ${p3.toFixed(2)}`);
      reason.push(`Flag low ${longFlagLow.toFixed(2)} · risk/unit ${riskEst.toFixed(2)} · ATR ${atr.toFixed(2)} · max risk $${MAX_LOSS.toFixed(0)}`);
      entryHint = { side: 'long', slPrice: longFlagLow, atr, riskEstimate: riskEst };
      longFlag = false; longFlagLow = null;
    }
  } else if (shortTrigger) {
    const riskEst = shortFlagHigh - close;
    if (atr < MIN_ATR) {
      reason.push(`Short trigger SKIPPED — ATR ${atr.toFixed(2)} < MIN_ATR ${MIN_ATR} (SL breathing room too tight)`);
      shortFlag = false; shortFlagHigh = null;
    } else if (riskEst > 0) {
      signal = 'SELL';
      reason.push(`Short trigger — close ${close.toFixed(2)} < p2 ${p2.toFixed(2)} & p3 ${p3.toFixed(2)}`);
      reason.push(`Flag high ${shortFlagHigh.toFixed(2)} · risk/unit ${riskEst.toFixed(2)} · ATR ${atr.toFixed(2)} · max risk $${MAX_LOSS.toFixed(0)}`);
      entryHint = { side: 'short', slPrice: shortFlagHigh, atr, riskEstimate: riskEst };
      shortFlag = false; shortFlagHigh = null;
    }
  } else if (longFlag) {
    reason.push(`Long FLAG active — waiting for close > p2(${p2.toFixed(2)}) & p3(${p3.toFixed(2)}). Running SL: ${longFlagLow.toFixed(2)}`);
  } else if (shortFlag) {
    reason.push(`Short FLAG active — waiting for close < p2(${p2.toFixed(2)}) & p3(${p3.toFixed(2)}). Running SL: ${shortFlagHigh.toFixed(2)}`);
  } else if (buyZone) {
    reason.push(`BUY zone — waiting for low ≤ cloud top ${cloudTop.toFixed(2)} to form flag`);
  } else if (sellZone) {
    reason.push(`SELL zone — waiting for high ≥ cloud bottom ${cloudBot.toFixed(2)} to form flag`);
  } else {
    reason.push('No zone active — Range Filter or KAMA cloud not aligned');
  }

  const indicators = snapshotIndicators(series, i);
  indicators.candleTime = candles[i].time;

  return {
    signal,
    reason,
    indicators,
    flagState: { longFlag, longFlagLow, shortFlag, shortFlagHigh },
    entryHint,
    posSide,   // echoed back for symmetry; callers already know it
  };
}

// ── Initialise a position after a fill at entryPrice ─────────────
// sizeFactor scales the trailing thresholds so a 0.01× position doesn't need
// to reach +$300 unrealised PnL to activate trailing (which it never would).
function initPosition(side, entryPrice, slPrice, qty, entryTime, atr, sizeFactor = 1) {
  const riskPerUnit = side === 'long' ? entryPrice - slPrice : slPrice - entryPrice;
  return {
    side,
    entryPrice,
    entryTime,
    size:            qty,
    slPrice,
    riskPerUnit,
    atr:             atr || null,
    trailing:        false,
    trailStop:       null,
    trailLockProfit: 0,
    // Per-position trail thresholds, scaled by sizeFactor.
    sizeFactor,
    trailStart:      TRAIL_START_PNL * sizeFactor,
    trailStep:       TRAIL_STEP_PNL  * sizeFactor,
    // UI-compat aliases
    stopLoss:        slPrice,
    unrealizedPnl:   0,
    mae:             0,
  };
}

// ── Advance a position one bar (used by backtest AND 1s live tick) ──
// PnL-based trailing (algo1-style):
//   • Activates at +$300 unrealised PnL → locks $200 profit.
//   • Every additional +$100 PnL → locks $100 more:
//       lockProfit = floor((bestPnl − $100) / $100) × $100
//     e.g. +$400 → $300, +$500 → $400. Trail stop never retreats.
//   • Stop hit intra-bar (initial SL if not trailing, trailStop if trailing)
//     → exit at stopNow.
function stepPosition(pos, candle) {
  const { side, entryPrice, size, slPrice } = pos;
  let   { trailing, trailStop, trailLockProfit = 0 } = pos;
  const { high, low, close } = candle;
  // Per-position thresholds; fall back to module defaults for backward compat.
  const trailStart = pos.trailStart != null ? pos.trailStart : TRAIL_START_PNL;
  const trailStep  = pos.trailStep  != null ? pos.trailStep  : TRAIL_STEP_PNL;

  // Best-case intra-bar PnL — drives trail activation / advance.
  const bestPx  = side === 'long' ? high : low;
  const bestPnl = side === 'long'
    ? (bestPx - entryPrice) * size
    : (entryPrice - bestPx) * size;

  if (bestPnl >= trailStart) {
    const lockProfit = Math.floor((bestPnl - trailStep) / trailStep) * trailStep;
    const proposedSl = side === 'long'
      ? entryPrice + lockProfit / size
      : entryPrice - lockProfit / size;
    const improved = !trailing
      || (side === 'long' ? proposedSl > trailStop : proposedSl < trailStop);
    if (improved) {
      trailing        = true;
      trailStop       = proposedSl;
      trailLockProfit = lockProfit;
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
    const exitPrice = stopNow;
    const exitPnl   = side === 'long'
      ? (exitPrice - entryPrice) * size
      : (entryPrice - exitPrice) * size;
    return {
      exit: true,
      exitPrice,
      exitPnl,
      trailing,
      trailStop,
      trailLockProfit,
      stopNow,
      unrealPnl,
      worstPnl,
      reason: trailing
        ? `Trailing stop hit @ ${stopNow.toFixed(2)} (locked $${trailLockProfit.toFixed(0)} PnL)`
        : `Initial SL hit @ ${stopNow.toFixed(2)}`,
    };
  }

  return {
    exit: false,
    trailing,
    trailStop,
    trailLockProfit,
    stopNow,
    unrealPnl,
    worstPnl,
  };
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

// Kraken OHLC returns the still-forming candle as the last row. TradingView
// draws indicators on CLOSED bars only, so drop any candle whose close time
// (open + intervalMs) hasn't passed wall-clock yet.
function dropUnfinished(candles, ivMs) {
  const now = Date.now();
  return candles.filter(c => (c.time + ivMs) <= now);
}

async function fetchCandles(symbol, interval, limit = 720) {
  const pair  = KRAKEN_PAIR[symbol] || symbol;
  const ivMin = KRAKEN_INTERVAL[interval] || 60;
  const ivMs  = ivMin * 60 * 1000;
  const { candles } = await fetchCandlesRaw(pair, ivMin, null);
  return dropUnfinished(candles, ivMs).slice(-limit);
}

async function fetchCandlesHistorical(symbol, interval, months) {
  const pair  = KRAKEN_PAIR[symbol] || symbol;
  const ivMin = KRAKEN_INTERVAL[interval] || 60;
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
  RF_SAMPLING_PERIOD, RF_MULT, MAX_LOSS, SL_ATR_MULT,
  TRAIL_START_PNL, TRAIL_STEP_PNL, MIN_ATR, ATR_LEN, USE_BAR_COLOR,
  WARMUP_BARS,
  computeSeries, computeATR, snapshotIndicators, generateSignal,
  initPosition, stepPosition,
  fetchCandles, fetchCandlesHistorical, fetchCurrentPrice,
};
