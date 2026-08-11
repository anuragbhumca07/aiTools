'use strict';

const https = require('https');

// ── Algo33 — RF bar color + RSI(2) mean-reversion + $100-step trail ──
//   Zone (BUY) : RF bar GREEN  (src > filt AND upward   > 0)
//   Zone (SELL): RF bar BLUE   (src < filt AND downward > 0)
//   Entry trigger: RSI(2) crosses ABOVE 10 (BUY) / BELOW 90 (SELL)
//   Initial SL: entry ± 2 × ATR14
//   Trail: breakeven at +$100 PnL, then +$100 locked per +$100 PnL
//   (KAMA cloud / p1 / p2 / p3 removed — zone gate is RF bar color only)
const RF_SAMPLING_PERIOD = 100;   // Range Filter sampling period
const RF_MULT            = 3.0;   // Range Filter multiplier
const MAX_LOSS           = 150.0; // Fixed max risk per trade ($)
const MAX_QTY            = 5.0;   // Hard cap on position size (contracts/units)
const RISK_FRAC          = 0.015; // unused — kept for API compat
const SL_ATR_MULT        = 1.5;   // Initial SL distance = 1.5 × ATR14 → risk = $150 exactly
const TRAIL_STEP_PNL     = 100.0; // reference — actual milestones: $200 BE / $250→$100 / $300→$200 …
const ATR_LEN            = 14;    // ATR period (drives sizing + reported in indicators)
const RSI_LEN            = 2;     // RSI period for entry trigger
const RSI_BUY_LEVEL      = 10;    // BUY when RSI(2) crosses ABOVE this while in buyZone
const RSI_SELL_LEVEL     = 90;    // SELL when RSI(2) crosses BELOW this while in sellZone
const SWING_BARS         = 3;     // SL reference = min low / max high of last N bars

// RF needs ~220 bars to settle. No KAMA → warmup is much shorter than algo34.
const WARMUP_BARS = 220;

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

// ── RSI (Wilder smoothing, Pine-style) ───────────────────────────
function computeRSI(closes, len) {
  const n = closes.length;
  const out = new Array(n).fill(50);   // neutral 50 while warming
  if (n < 2) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < n; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change :  0;
    const loss = change < 0 ? -change : 0;
    if (i <= len) {
      avgGain = (avgGain * (i - 1) + gain) / i;
      avgLoss = (avgLoss * (i - 1) + loss) / i;
    } else {
      avgGain = (avgGain * (len - 1) + gain) / len;
      avgLoss = (avgLoss * (len - 1) + loss) / len;
    }
    if (avgLoss === 0) { out[i] = 100; continue; }
    const rs = avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

// ── Full-series indicator computation ────────────────────────────
function computeSeries(candles) {
  const n     = candles.length;
  const src   = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows  = candles.map(c => c.low);

  // Range Filter
  const smrng = smoothRng(src, RF_SAMPLING_PERIOD, RF_MULT);
  const filt  = rngFilt(src, smrng);
  const hband = filt.map((f, i) => f + smrng[i]);
  const lband = filt.map((f, i) => f - smrng[i]);

  // Direction counters — count consecutive up/down bars of the filter.
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

  // Pine-accurate bar color (three states, not two):
  //   GREEN : src > filt AND upward   > 0
  //   BLUE  : src < filt AND downward > 0  ← "sell" color in Pine = RED in our UI
  //   MID   : everything else (neutral, neither zone)
  const isGreenBar = new Array(n);
  const isBlueBar  = new Array(n);
  for (let i = 0; i < n; i++) {
    isGreenBar[i] = src[i] > filt[i] && upward[i]   > 0;
    isBlueBar[i]  = src[i] < filt[i] && downward[i] > 0;
  }

  const atr = computeATR(candles, ATR_LEN);
  const rsi = computeRSI(src, RSI_LEN);

  return {
    src, highs, lows,
    smrng, filt, hband, lband, upward, downward,
    isGreenBar, isBlueBar,
    atr, rsi,
  };
}

// ── Snapshot last bar's indicators (for UI/logging) ──────────────
function snapshotIndicators(series, i) {
  return {
    price:      series.src[i],
    filt:       series.filt[i],
    hband:      series.hband[i],
    lband:      series.lband[i],
    smrng:      series.smrng[i],
    upward:      series.upward[i],
    downward:    series.downward[i],
    isGreenBar:  series.isGreenBar[i],
    isBlueBar:   series.isBlueBar[i],
    atr:        series.atr[i],
    rsi:        series.rsi[i],
    rsiPrev:    i > 0 ? series.rsi[i - 1] : series.rsi[i],
    high:       series.highs[i],
    low:        series.lows[i],
  };
}

// ── Stateful signal generation ────────────────────────────────────
// Entry rules — no zone concept, direct bar-color + RSI cross:
//   • LONG  : BAR = GREEN (isGreenBar) AND RSI(2) crossed above 10
//             on the current bar OR the bar immediately before it
//             (1-bar lookback handles the common case where the RSI cross
//             and bar colour flip happen on adjacent candles)
//   • SHORT : BAR = BLUE  (isBlueBar)  AND RSI(2) crossed below 90 (same lookback)
// flagState is unused but echoed for API compatibility with algo3's server.
function generateSignal(candles, flagState = {}, posSide = null) {
  const series = computeSeries(candles);
  const i = candles.length - 1;

  const close   = series.src[i];
  const atr     = series.atr[i];
  const rsi     = series.rsi[i];
  const rsiPrev = i > 0 ? series.rsi[i - 1] : rsi;
  const rsi2ago = i > 1 ? series.rsi[i - 2] : rsiPrev;

  // Swing-based SL window: last SWING_BARS closed bars (inclusive of current)
  const w0 = Math.max(0, i - (SWING_BARS - 1));
  let swingLow  = series.lows[w0];
  let swingHigh = series.highs[w0];
  for (let k = w0 + 1; k <= i; k++) {
    if (series.lows[k]  < swingLow)  swingLow  = series.lows[k];
    if (series.highs[k] > swingHigh) swingHigh = series.highs[k];
  }

  // RSI cross on current bar (i) OR the previous bar (i-1).
  // Using two checks so a cross that happened one candle before the bar colour
  // flips to GREEN/BLUE still triggers entry on the colour-flip candle.
  const rsiCrossUpNow    = rsiPrev  <= RSI_BUY_LEVEL  && rsi     > RSI_BUY_LEVEL;
  const rsiCrossUpPrev   = rsi2ago  <= RSI_BUY_LEVEL  && rsiPrev > RSI_BUY_LEVEL;
  const rsiCrossDownNow  = rsiPrev  >= RSI_SELL_LEVEL && rsi     < RSI_SELL_LEVEL;
  const rsiCrossDownPrev = rsi2ago  >= RSI_SELL_LEVEL && rsiPrev < RSI_SELL_LEVEL;

  const rsiCrossUp   = rsiCrossUpNow   || rsiCrossUpPrev;
  const rsiCrossDown = rsiCrossDownNow || rsiCrossDownPrev;

  // Direct BAR-color + RSI-cross entry — no persistent zone needed.
  const longTrigger  = series.isGreenBar[i] && rsiCrossUp;
  const shortTrigger = series.isBlueBar[i]  && rsiCrossDown;

  // Which cross fired (for logging)
  const crossUpBar  = rsiCrossUpNow   ? 'current' : 'prev';
  const crossDnBar  = rsiCrossDownNow ? 'current' : 'prev';

  let signal = 'HOLD';
  const reason = [];
  let entryHint = null;

  const hband = series.hband[i], lband = series.lband[i];

  if (longTrigger) {
    const riskEst = close - swingLow;
    if (riskEst > 0) {
      signal = 'BUY';
      reason.push(`Long trigger — BAR GREEN + RSI(${RSI_LEN}) cross above ${RSI_BUY_LEVEL} [${crossUpBar} bar]`);
      reason.push(`RSI ${rsi2ago.toFixed(1)}→${rsiPrev.toFixed(1)}→${rsi.toFixed(1)} · filt ${series.filt[i].toFixed(2)}`);
      reason.push(`SwingLow(${SWING_BARS}) ${swingLow.toFixed(2)} · risk/unit ${riskEst.toFixed(2)} · ATR ${atr.toFixed(2)} · max risk $${MAX_LOSS.toFixed(0)}`);
      entryHint = { side: 'long', slPrice: swingLow, atr, riskEstimate: riskEst };
    }
  } else if (shortTrigger) {
    const riskEst = swingHigh - close;
    if (riskEst > 0) {
      signal = 'SELL';
      reason.push(`Short trigger — BAR BLUE + RSI(${RSI_LEN}) cross below ${RSI_SELL_LEVEL} [${crossDnBar} bar]`);
      reason.push(`RSI ${rsi2ago.toFixed(1)}→${rsiPrev.toFixed(1)}→${rsi.toFixed(1)} · filt ${series.filt[i].toFixed(2)}`);
      reason.push(`SwingHigh(${SWING_BARS}) ${swingHigh.toFixed(2)} · risk/unit ${riskEst.toFixed(2)} · ATR ${atr.toFixed(2)} · max risk $${MAX_LOSS.toFixed(0)}`);
      entryHint = { side: 'short', slPrice: swingHigh, atr, riskEstimate: riskEst };
    }
  } else if (series.isGreenBar[i]) {
    reason.push(`BAR GREEN — RSI(${RSI_LEN}) ${rsi2ago.toFixed(1)}→${rsiPrev.toFixed(1)}→${rsi.toFixed(1)} · waiting for cross above ${RSI_BUY_LEVEL}`);
  } else if (series.isBlueBar[i]) {
    reason.push(`BAR BLUE — RSI(${RSI_LEN}) ${rsi2ago.toFixed(1)}→${rsiPrev.toFixed(1)}→${rsi.toFixed(1)} · waiting for cross below ${RSI_SELL_LEVEL}`);
  } else {
    reason.push(`BAR MID (neutral) · filt ${series.filt[i].toFixed(2)} · RSI(${RSI_LEN}) ${rsi.toFixed(1)}`);
  }

  const indicators = snapshotIndicators(series, i);
  indicators.candleTime = candles[i].time;
  indicators.swingLow   = swingLow;
  indicators.swingHigh  = swingHigh;

  return {
    signal,
    reason,
    indicators,
    flagState: {},                // stub for API parity with algo3
    entryHint,
    posSide,
  };
}

// ── Initialise a position after a fill at entryPrice ─────────────
// Initial SL = entry ± 2×ATR14. Trail activates at +$100 PnL (breakeven),
// then advances the stop by $100 for every additional $100 of PnL.
function initPosition(side, entryPrice, slPrice, qty, entryTime, atr) {
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
    // UI-compat aliases
    stopLoss:        slPrice,
    unrealizedPnl:   0,
    mae:             0,
  };
}

// ── Advance a position one bar (used by backtest AND 1s live tick) ──
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
  RF_SAMPLING_PERIOD, RF_MULT, MAX_LOSS, MAX_QTY, RISK_FRAC, SL_ATR_MULT,
  TRAIL_STEP_PNL, ATR_LEN, RSI_LEN, RSI_BUY_LEVEL, RSI_SELL_LEVEL, SWING_BARS,
  WARMUP_BARS,
  computeSeries, computeATR, computeRSI, snapshotIndicators, generateSignal,
  initPosition, stepPosition,
  fetchCandles, fetchCandlesHistorical, fetchCurrentPrice,
};
