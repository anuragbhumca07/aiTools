'use strict';

const https = require('https');

// ── Constants ─────────────────────────────────────────────────────────
const PIP         = 1;     // $1 per pip for BTC/USD
const TICK        = 1;     // $1 per tick
const SL_MIN_PIPS = 20; // $20 min SL — $10 is within 1m noise range for BTC/ETH
const SL_MAX_PIPS = 45;
const MIN_RR      = 2.5;
const MAX_LOTS    = 3;
const RISK_PCT    = 0.01;  // 1% per trade

// ── Trailing ladder ───────────────────────────────────────────────────
const TRAIL_LADDER = [
  { milestone: 0.5, lockR: 0.00 },
  { milestone: 1.0, lockR: 0.35 },
  { milestone: 1.5, lockR: 0.80 },
  { milestone: 2.0, lockR: 1.30 },
  { milestone: 2.5, lockR: 1.75 },
  { milestone: 3.0, lockR: 2.25 },
  { milestone: 3.5, lockR: 2.70 },
  { milestone: 4.0, lockR: 3.20 },
  // Beyond 4R: each +0.5R adds 0.45R to lock — computed dynamically
];

// ── Math helpers ──────────────────────────────────────────────────────

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

function rsiCalc(closes, period = 7) {
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

function atrCalc(highs, lows, closes, period = 14) {
  const n = closes.length;
  const result = new Array(n).fill(null);
  if (n < period + 1) return result;
  const tr = [null];
  for (let i = 1; i < n; i++)
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  result[period] = sum / period;
  for (let i = period + 1; i < n; i++)
    result[i] = (result[i-1] * (period - 1) + tr[i]) / period;
  return result;
}

function adxCalc(highs, lows, closes, period = 14) {
  const n = closes.length;
  const empty = { adx: null, diPlus: null, diMinus: null };
  if (n < period * 2 + 1) return new Array(n).fill(null).map(() => ({ ...empty }));
  const tr = new Array(n).fill(0), dmP = new Array(n).fill(0), dmM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    const up = highs[i]-highs[i-1], dn = lows[i-1]-lows[i];
    dmP[i] = (up > dn && up > 0) ? up : 0;
    dmM[i] = (dn > up && dn > 0) ? dn : 0;
  }
  const sTR = new Array(n).fill(0), sDMP = new Array(n).fill(0), sDMM = new Array(n).fill(0);
  for (let i = 1; i <= period; i++) { sTR[period] += tr[i]; sDMP[period] += dmP[i]; sDMM[period] += dmM[i]; }
  for (let i = period+1; i < n; i++) {
    sTR[i]  = sTR[i-1]  - sTR[i-1]/period  + tr[i];
    sDMP[i] = sDMP[i-1] - sDMP[i-1]/period + dmP[i];
    sDMM[i] = sDMM[i-1] - sDMM[i-1]/period + dmM[i];
  }
  const diP = new Array(n).fill(null), diM = new Array(n).fill(null), dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (sTR[i] === 0) continue;
    diP[i] = (sDMP[i]/sTR[i])*100; diM[i] = (sDMM[i]/sTR[i])*100;
    const s = diP[i]+diM[i];
    if (s > 0) dx[i] = Math.abs(diP[i]-diM[i])/s*100;
  }
  const adxArr = new Array(n).fill(null);
  const seed   = period*2-1;
  if (seed >= n) return new Array(n).fill(null).map((_,i) => ({ adx: adxArr[i], diPlus: diP[i], diMinus: diM[i] }));
  let seedSum = 0, seedCnt = 0;
  for (let i = period; i <= seed; i++) { if (dx[i] != null) { seedSum += dx[i]; seedCnt++; } }
  if (seedCnt === period) {
    adxArr[seed] = seedSum/period;
    for (let i = seed+1; i < n; i++)
      if (dx[i] != null && adxArr[i-1] != null)
        adxArr[i] = (adxArr[i-1]*(period-1) + dx[i])/period;
  }
  return new Array(n).fill(null).map((_,i) => ({ adx: adxArr[i], diPlus: diP[i], diMinus: diM[i] }));
}

function obvCalc(closes, volumes) {
  const r = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if      (closes[i] > closes[i-1]) r[i] = r[i-1] + volumes[i];
    else if (closes[i] < closes[i-1]) r[i] = r[i-1] - volumes[i];
    else                               r[i] = r[i-1];
  }
  return r;
}

function bollingerBands(closes, period = 20, mult = 2) {
  const result = new Array(closes.length).fill(null);
  for (let i = period-1; i < closes.length; i++) {
    const slice = closes.slice(i-period+1, i+1);
    const mid   = slice.reduce((a,b) => a+b, 0) / period;
    const sigma = Math.sqrt(slice.reduce((a,b) => a+(b-mid)**2, 0)/period);
    result[i] = { upper: mid+mult*sigma, mid, lower: mid-mult*sigma, width: sigma*mult*2/mid*100 };
  }
  return result;
}

// ── VWAP with σ-bands (resets each UTC day) ───────────────────────────
function vwapCalc(candles) {
  const r = candles.map(() => ({ vwap: null, sigma: 0, upper1: null, lower1: null, upper2: null, lower2: null }));
  let dayKey = null, cumTPV = 0, cumVol = 0, cumTPV2 = 0;
  for (let i = 0; i < candles.length; i++) {
    const d = new Date(candles[i].time);
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (k !== dayKey) { dayKey = k; cumTPV = 0; cumVol = 0; cumTPV2 = 0; }
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumTPV  += tp * candles[i].volume;
    cumVol  += candles[i].volume;
    cumTPV2 += tp * tp * candles[i].volume;
    if (cumVol > 0) {
      const vwap  = cumTPV / cumVol;
      const sigma = Math.sqrt(Math.max(0, cumTPV2/cumVol - vwap*vwap));
      r[i] = { vwap, sigma, upper1: vwap+sigma, lower1: vwap-sigma, upper2: vwap+2*sigma, lower2: vwap-2*sigma };
    }
  }
  return r;
}

// ── Volume profile ────────────────────────────────────────────────────
function volumeProfile(candles, bins = 50, lookback = 200) {
  const slice = candles.slice(Math.max(0, candles.length - lookback));
  const minP  = Math.min(...slice.map(c => c.low));
  const maxP  = Math.max(...slice.map(c => c.high));
  const range = maxP - minP;
  if (range <= 0) return [];
  const bs = range / bins;
  const profile = Array.from({ length: bins }, (_, i) => ({
    low: minP+i*bs, high: minP+(i+1)*bs, mid: minP+(i+0.5)*bs, volume: 0, hvn: false, lvn: false,
  }));
  for (const c of slice) {
    const tp  = (c.high + c.low + c.close) / 3;
    const idx = Math.min(bins-1, Math.max(0, Math.floor((tp-minP)/bs)));
    profile[idx].volume += c.volume;
  }
  const avgVol = profile.reduce((s,b) => s+b.volume, 0) / bins;
  for (const b of profile) { b.hvn = b.volume > avgVol*1.5; b.lvn = b.volume > 0 && b.volume < avgVol*0.5; }
  return profile;
}

function hasHVNBelow(profile, price, pct = 0.003) {
  return profile.some(b => b.hvn && b.mid < price && (price-b.mid)/price <= pct);
}
function hasLVNAbove(profile, price, pct = 0.003) {
  return profile.some(b => b.lvn && b.mid > price && (b.mid-price)/price <= pct);
}

// ── Candle delta (OHLCV approximation) ───────────────────────────────
function candleDelta(c) {
  const body  = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const ratio = range > 0 ? body/range : 0;
  return c.close > c.open ? c.volume*ratio : c.close < c.open ? -c.volume*ratio : 0;
}

function deltaConsistent(candles, n, direction, lookback = 3) {
  for (let i = n-lookback+1; i <= n; i++) {
    if (i < 0) return false;
    const d = candleDelta(candles[i]);
    if (direction === 'positive' && d <= 0) return false;
    if (direction === 'negative' && d >= 0) return false;
  }
  return true;
}

// ── Liquidity sweeps ──────────────────────────────────────────────────
function detectBuySweep(candles, n, lookback = 5) {
  if (n < lookback+5) return { found: false };
  const swingLow = Math.min(...candles.slice(n-lookback-5, n-lookback).map(c => c.low));
  for (let i = n-lookback; i <= n-1; i++) {
    if (candles[i].low < swingLow && candles[i].close > swingLow)
      return { found: true, sweepLow: candles[i].low };
  }
  return { found: false };
}

function detectSellSweep(candles, n, lookback = 5) {
  if (n < lookback+5) return { found: false };
  const swingHigh = Math.max(...candles.slice(n-lookback-5, n-lookback).map(c => c.high));
  for (let i = n-lookback; i <= n-1; i++) {
    if (candles[i].high > swingHigh && candles[i].close < swingHigh)
      return { found: true, sweepHigh: candles[i].high };
  }
  return { found: false };
}

// ── Order blocks ──────────────────────────────────────────────────────
function findBullishOB(candles, n, lookback = 40) {
  for (let i = n-3; i >= Math.max(1, n-lookback); i--) {
    if (candles[i].close >= candles[i].open) continue;
    let bullCnt = 0;
    for (let j = i+1; j <= Math.min(n-1, i+4); j++) {
      if (candles[j].close > candles[j].open) bullCnt++; else break;
    }
    if (bullCnt < 2) continue;
    let mitigated = false;
    for (let j = i+1; j <= n; j++) { if (candles[j].low <= candles[i].high) { mitigated = true; break; } }
    if (!mitigated) return { ...candles[i], idx: i };
  }
  return null;
}

function findBearishOB(candles, n, lookback = 40) {
  for (let i = n-3; i >= Math.max(1, n-lookback); i--) {
    if (candles[i].close <= candles[i].open) continue;
    let bearCnt = 0;
    for (let j = i+1; j <= Math.min(n-1, i+4); j++) {
      if (candles[j].close < candles[j].open) bearCnt++; else break;
    }
    if (bearCnt < 2) continue;
    let mitigated = false;
    for (let j = i+1; j <= n; j++) { if (candles[j].high >= candles[i].low) { mitigated = true; break; } }
    if (!mitigated) return { ...candles[i], idx: i };
  }
  return null;
}

function priceAtOB(price, ob) {
  if (!ob) return false;
  const tol = (ob.high - ob.low) * 0.1 + PIP;
  return price >= ob.low - tol && price <= ob.high + tol;
}

// ── VWAP reclaim / rejection ──────────────────────────────────────────
function checkVWAPReclaim(candles, vwapArr, n, lookback = 5) {
  const v = vwapArr[n];
  if (!v?.vwap) return false;
  if (candles[n].close <= v.vwap) return false;
  for (let i = Math.max(1, n-lookback); i < n; i++) {
    const vi = vwapArr[i];
    if (!vi?.vwap) continue;
    if (candles[i].close <= (vi.upper1 || vi.vwap*1.002) || candles[i].low <= vi.vwap*1.001)
      return true;
  }
  return false;
}

function checkVWAPRejection(candles, vwapArr, n, lookback = 5) {
  const v = vwapArr[n];
  if (!v?.vwap) return false;
  if (candles[n].close >= v.vwap) return false;
  for (let i = Math.max(1, n-lookback); i < n; i++) {
    const vi = vwapArr[i];
    if (!vi?.vwap) continue;
    if (candles[i].close >= (vi.lower1 || vi.vwap*0.998) || candles[i].high >= vi.vwap*0.999)
      return true;
  }
  return false;
}

// ── Candle patterns ───────────────────────────────────────────────────
function isBullishPattern(candles, n) {
  if (n < 1) return false;
  const c = candles[n], p = candles[n-1];
  const cRange = c.high - c.low; if (cRange === 0) return false;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const cBody = Math.abs(c.close - c.open), pBody = Math.abs(p.close - p.open);
  const engulf  = c.close > c.open && c.open <= Math.min(p.open,p.close) && c.close >= Math.max(p.open,p.close) && cBody > pBody;
  const hammer  = c.close > c.open && lowerWick >= 2*cBody && upperWick < cBody*0.5;
  const pinBar  = lowerWick >= cRange*0.60;
  return engulf || hammer || pinBar;
}

function isBearishPattern(candles, n) {
  if (n < 1) return false;
  const c = candles[n], p = candles[n-1];
  const cRange = c.high - c.low; if (cRange === 0) return false;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const cBody = Math.abs(c.close - c.open), pBody = Math.abs(p.close - p.open);
  const engulf      = c.close < c.open && c.open >= Math.max(p.open,p.close) && c.close <= Math.min(p.open,p.close) && cBody > pBody;
  const shootingStar = c.close < c.open && upperWick >= 2*cBody && lowerWick < cBody*0.5;
  const pinBar       = upperWick >= cRange*0.60;
  return engulf || shootingStar || pinBar;
}

// ── Regime classification ─────────────────────────────────────────────
function classifyRegime(candles) {
  const n = candles.length - 1;
  if (n < 50) return { regime: 'SIDEWAYS', reason: 'Need ≥50 candles' };

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const ema9     = ema(closes, 9)[n];
  const ema21    = ema(closes, 21)[n];
  const adxData  = adxCalc(highs, lows, closes, 14)[n];
  const adx      = adxData?.adx;
  const vwapArr  = vwapCalc(candles);
  const bbArr    = bollingerBands(closes, 20, 2);
  const obvArr   = obvCalc(closes, volumes);

  const price  = closes[n];
  const vwap   = vwapArr[n]?.vwap;
  const bbNow  = bbArr[n];

  const obvRising  = obvArr[n] > obvArr[Math.max(0, n-5)];
  const obvFalling = obvArr[n] < obvArr[Math.max(0, n-5)];

  const adxWeak   = adx !== null && adx < 12; // 1m charts have naturally lower ADX than daily
  const bbNarrow  = bbNow?.width < 0.25;
  const last10    = closes.slice(Math.max(0, n-9), n+1);
  const maxC = Math.max(...last10), minC = Math.min(...last10), midC = (maxC+minC)/2;
  const rangeChop = midC > 0 && (maxC-minC)/midC*100 < 0.30;
  const avgVol20  = volumes.slice(Math.max(0, n-19), n+1).reduce((a,b) => a+b, 0) / 20;
  const volLow    = volumes[n] < avgVol20 * 0.6;
  const vwapConv  = n >= 2 && vwapArr[n]?.sigma !== null && vwapArr[n].sigma < vwapArr[n-1]?.sigma && vwapArr[n-1].sigma < vwapArr[n-2]?.sigma;

  const chopFlags = [];
  if (adxWeak)   chopFlags.push(`ADX(${adx?.toFixed(1)}) < 20`);
  if (bbNarrow)  chopFlags.push(`BB-width < 0.25%`);
  if (rangeChop) chopFlags.push('10-bar range < ±0.15%');
  if (volLow)    chopFlags.push('Volume < 60% of 20-bar avg');
  if (vwapConv)  chopFlags.push('VWAP σ converging');

  // Require 3+ chop flags for SIDEWAYS — prevents over-gating from a single weak indicator
  if (chopFlags.length >= 3)
    return { regime: 'SIDEWAYS', reason: chopFlags[0], chopFlags, ema9, ema21, adx, vwap };

  if (ema9 === null || ema21 === null || adx === null || vwap === null)
    return { regime: 'SIDEWAYS', reason: 'Indicator data missing' };

  // OBV is confirmation; TRENDING needs ADX > 12 + price/EMA alignment (1m charts have naturally lower ADX)
  if (adx > 12 && price > vwap && ema9 > ema21)
    return { regime: 'TRENDING_BULL', reason: `ADX=${adx.toFixed(1)} P>VWAP EMA9>EMA21${obvRising?' OBV↑':''}`, ema9, ema21, adx, vwap, obvRising };

  if (adx > 12 && price < vwap && ema9 < ema21)
    return { regime: 'TRENDING_BEAR', reason: `ADX=${adx.toFixed(1)} P<VWAP EMA9<EMA21${obvFalling?' OBV↓':''}`, ema9, ema21, adx, vwap, obvRising };

  return { regime: 'SIDEWAYS', reason: `Unmet: ADX=${adx?.toFixed(1)} ${price>(vwap||0)?'P>VWAP':'P<VWAP'} EMA9${ema9>ema21?'>':'<'}EMA21`, ema9, ema21, adx, vwap };
}

// ── SL / TP ───────────────────────────────────────────────────────────
function computeLongSL(ob, sweepLow) {
  const candidates = [];
  if (ob)       candidates.push(ob.low    - 3*TICK);
  if (sweepLow) candidates.push(sweepLow  - 3*TICK);
  return candidates.length ? Math.min(...candidates) : null;
}

function computeShortSL(ob, sweepHigh) {
  const candidates = [];
  if (ob)        candidates.push(ob.high   + 3*TICK);
  if (sweepHigh) candidates.push(sweepHigh + 3*TICK);
  return candidates.length ? Math.max(...candidates) : null;
}

function computeTP(price, sl, profile, vwapData, side) {
  const riskDist = Math.abs(price - sl);
  if (side === 'long') {
    const hvns = profile.filter(b => b.hvn && b.mid > price+riskDist && (b.mid-price)/riskDist >= MIN_RR).map(b => b.mid);
    if (hvns.length) return Math.min(...hvns);
    if (vwapData?.upper2 && (vwapData.upper2-price)/riskDist >= MIN_RR) return vwapData.upper2;
    return price + 3*riskDist;
  } else {
    const hvns = profile.filter(b => b.hvn && b.mid < price-riskDist && (price-b.mid)/riskDist >= MIN_RR).map(b => b.mid);
    if (hvns.length) return Math.max(...hvns);
    if (vwapData?.lower2 && (price-vwapData.lower2)/riskDist >= MIN_RR) return vwapData.lower2;
    return price - 3*riskDist;
  }
}

// ── Trailing SL ladder ────────────────────────────────────────────────
function computeTrailUpdate(position, unrealPnl) {
  const { side, entryPrice, stopLoss, R, riskDist } = position;
  if (!R || R <= 0 || !riskDist) return null;

  const profitInR = unrealPnl / R;
  if (profitInR < 0.5) return null;

  let lockR;
  if (profitInR >= 4.0) {
    lockR = 3.20 + Math.floor((profitInR - 4.0) / 0.5) * 0.45;
  } else {
    for (let i = TRAIL_LADDER.length-1; i >= 0; i--) {
      if (profitInR >= TRAIL_LADDER[i].milestone) { lockR = TRAIL_LADDER[i].lockR; break; }
    }
  }
  if (lockR === undefined) return null;

  const newSl     = side === 'long' ? entryPrice + lockR*riskDist : entryPrice - lockR*riskDist;
  const improved  = side === 'long' ? newSl > stopLoss : newSl < stopLoss;
  return improved ? { oldSl: stopLoss, newSl, lockR, profitInR } : null;
}

// ── Forced exit checks (ADX death + order-flow flip) ──────────────────
function checkForcedExit(position, candles1m, vwapArr) {
  const n      = candles1m.length - 1;
  const closes = candles1m.map(c => c.close);
  const highs  = candles1m.map(c => c.high);
  const lows   = candles1m.map(c => c.low);
  const adx    = adxCalc(highs, lows, closes, 14)[n]?.adx;
  const vwap   = vwapArr[n]?.vwap;
  const price  = closes[n];

  if (adx !== null && adx < 10)
    return { exit: true, reason: `ADX(${adx.toFixed(1)}) < 10 — trend dying` };

  if (position.side === 'long') {
    if (deltaConsistent(candles1m, n, 'negative', 3) && vwap && price < vwap)
      return { exit: true, reason: 'Delta flipped bearish 3 bars + price < VWAP' };
  } else {
    if (deltaConsistent(candles1m, n, 'positive', 3) && vwap && price > vwap)
      return { exit: true, reason: 'Delta flipped bullish 3 bars + price > VWAP' };
  }
  return null;
}

// ── Main signal generator ─────────────────────────────────────────────
function generateSignal(candles1m, candles5m, equity = 10000) {
  const n = candles1m.length - 1;
  if (n < 60) return { signal: 'HOLD', reason: ['Need ≥60 1-min candles'], indicators: {}, buyScore: 0, sellScore: 0 };

  const closes  = candles1m.map(c => c.close);
  const highs   = candles1m.map(c => c.high);
  const lows    = candles1m.map(c => c.low);

  const rsi7Arr  = rsiCalc(closes, 7);
  const atrArr   = atrCalc(highs, lows, closes, 14);
  const vwapArr  = vwapCalc(candles1m);
  const profile  = volumeProfile(candles1m, 50, 200);

  const regime1m = classifyRegime(candles1m);
  const regime5m = (candles5m && candles5m.length >= 30)
    ? classifyRegime(candles5m)
    : { regime: 'SIDEWAYS', reason: 'No 5m data' };

  const price    = closes[n];
  const rsi      = rsi7Arr[n];
  const atr      = atrArr[n];
  const vwapNow  = vwapArr[n];

  const indicators = {
    price, rsi, atr,
    ema9:     regime1m.ema9,
    ema21:    regime1m.ema21,
    adx:      regime1m.adx,
    vwap:     vwapNow?.vwap,
    vwapSigma: vwapNow?.sigma,
    regime:   regime1m.regime,
    regime5m: regime5m.regime,
    candleTime: candles1m[n].time,
  };

  const cond1 = { id:1, label:'[1] Regime TRENDING (1m+5m)', ok: false };
  // ── Regime gate ───────────────────────────────────────────────────
  if (regime1m.regime === 'SIDEWAYS')
    return { signal: 'HOLD', reason: [`SIDEWAYS 1m: ${regime1m.reason}`], indicators, buyScore: 0, sellScore: 0, conditions: [cond1] };
  if (regime5m.regime === 'SIDEWAYS')
    return { signal: 'HOLD', reason: [`SIDEWAYS 5m: ${regime5m.reason}`], indicators, buyScore: 0, sellScore: 0, conditions: [cond1] };
  if (regime1m.regime !== regime5m.regime)
    return { signal: 'HOLD', reason: [`Trend conflict: 1m=${regime1m.regime} vs 5m=${regime5m.regime}`], indicators, buyScore: 0, sellScore: 0, conditions: [cond1] };

  // ── LONG: all 8 conditions ────────────────────────────────────────
  if (regime1m.regime === 'TRENDING_BULL') {
    const ob        = findBullishOB(candles1m, n);
    const vwapOk    = checkVWAPReclaim(candles1m, vwapArr, n);
    const obHit     = priceAtOB(price, ob);
    const hvnOk     = hasHVNBelow(profile, price);
    const deltaOk   = deltaConsistent(candles1m, n, 'positive', 3);
    const sweep     = detectBuySweep(candles1m, n);
    const rsiOk     = rsi !== null && rsi >= 35 && rsi <= 65;
    const patternOk = isBullishPattern(candles1m, n);

    const conds = [
      { id:1, label:'[1] Regime TRENDING_BULL (1m+5m)',                              ok: true },
      { id:2, label:`[2] VWAP reclaim @ $${vwapNow?.vwap?.toFixed(0) ?? 'n/a'}`,    ok: vwapOk },
      { id:3, label:`[3] At bullish OB ${ob ? `$${ob.low.toFixed(0)}-$${ob.high.toFixed(0)}` : '(none found)'}`, ok: obHit },
      { id:4, label:'[4] HVN support within 0.3% below',                            ok: hvnOk },
      { id:5, label:'[5] Cum-delta positive last 3 bars',                            ok: deltaOk },
      { id:6, label:'[6] Buy-side liquidity sweep',                                  ok: sweep.found },
      { id:7, label:`[7] RSI(7)=${rsi?.toFixed(1) ?? 'n/a'} ∈ [35–65]`,             ok: rsiOk },
      { id:8, label:'[8] Bullish candle pattern (engulf/hammer/pin)',                ok: patternOk },
    ];
    const buyScore = conds.filter(c => c.ok).length;
    const passed   = conds.filter(c => c.ok).map(c => c.label);
    const failed   = conds.filter(c => !c.ok).map(c => c.label);

    // Require stricter score when ADX is borderline — avoids false entries in weak trends
    const adxVal = indicators.adx || 0;
    const MIN_SCORE = adxVal >= 17 ? 6 : 7;
    if (buyScore >= MIN_SCORE) {
      // SL: use OB if available, else VWAP-1σ, else ATR-based
      const sl = computeLongSL(ob, sweep.found ? sweep.sweepLow : null)
        || (vwapNow?.lower1 ? vwapNow.lower1 - 3*PIP : null)
        || (atr ? price - 2*atr : null);
      if (!sl) return { signal:'HOLD', reason:['Long SL: no reference level'], indicators, buyScore, sellScore:0, conditions:conds };
      const riskDist = price - sl;
      if (riskDist < SL_MIN_PIPS*PIP) return { signal:'HOLD', reason:[`SL $${riskDist.toFixed(1)} < min ${SL_MIN_PIPS} pips`], indicators, buyScore, sellScore:0, conditions:conds };
      if (riskDist > SL_MAX_PIPS*PIP) return { signal:'HOLD', reason:[`SL $${riskDist.toFixed(1)} > max ${SL_MAX_PIPS} pips`], indicators, buyScore, sellScore:0, conditions:conds };
      const tp = computeTP(price, sl, profile, vwapNow, 'long');
      const rr = (tp - price) / riskDist;
      if (rr < MIN_RR) return { signal:'HOLD', reason:[`R:R ${rr.toFixed(2)} < ${MIN_RR}`], indicators, buyScore, sellScore:0, conditions:conds };
      const size = parseFloat(Math.min(equity*RISK_PCT/riskDist, MAX_LOTS).toFixed(4));
      const R    = riskDist * size;
      return { signal:'BUY', reason:passed, indicators, sl, tp, riskDist, rr, size, R, ob, buyScore, sellScore:0, conditions:conds };
    }
    return { signal:'HOLD', reason:[`BUY ${buyScore}/8 — need ${MIN_SCORE}. Missing: ${failed.slice(0,3).join(' | ')}`], indicators, buyScore, sellScore:0, conditions:conds };
  }

  // ── SHORT: all 8 conditions ───────────────────────────────────────
  if (regime1m.regime === 'TRENDING_BEAR') {
    const ob        = findBearishOB(candles1m, n);
    const vwapOk    = checkVWAPRejection(candles1m, vwapArr, n);
    const obHit     = priceAtOB(price, ob);
    const lvnOk     = hasLVNAbove(profile, price);
    const deltaOk   = deltaConsistent(candles1m, n, 'negative', 3);
    const sweep     = detectSellSweep(candles1m, n);
    const rsiOk     = rsi !== null && rsi >= 35 && rsi <= 65;
    const patternOk = isBearishPattern(candles1m, n);

    const conds = [
      { id:1, label:'[1] Regime TRENDING_BEAR (1m+5m)',                              ok: true },
      { id:2, label:`[2] VWAP rejection @ $${vwapNow?.vwap?.toFixed(0) ?? 'n/a'}`,  ok: vwapOk },
      { id:3, label:`[3] At bearish OB ${ob ? `$${ob.low.toFixed(0)}-$${ob.high.toFixed(0)}` : '(none found)'}`, ok: obHit },
      { id:4, label:'[4] LVN within 0.3% above (thin air)',                          ok: lvnOk },
      { id:5, label:'[5] Cum-delta negative last 3 bars',                            ok: deltaOk },
      { id:6, label:'[6] Sell-side liquidity sweep',                                 ok: sweep.found },
      { id:7, label:`[7] RSI(7)=${rsi?.toFixed(1) ?? 'n/a'} ∈ [35–65]`,             ok: rsiOk },
      { id:8, label:'[8] Bearish candle pattern (engulf/star/pin)',                  ok: patternOk },
    ];
    const sellScore = conds.filter(c => c.ok).length;
    const passed    = conds.filter(c => c.ok).map(c => c.label);
    const failed    = conds.filter(c => !c.ok).map(c => c.label);

    const adxVal2 = indicators.adx || 0;
    const MIN_SCORE = adxVal2 >= 17 ? 6 : 7;
    if (sellScore >= MIN_SCORE) {
      const sl = computeShortSL(ob, sweep.found ? sweep.sweepHigh : null)
        || (vwapNow?.upper1 ? vwapNow.upper1 + 3*PIP : null)
        || (atr ? price + 2*atr : null);
      if (!sl) return { signal:'HOLD', reason:['Short SL: no reference level'], indicators, buyScore:0, sellScore, conditions:conds };
      const riskDist = sl - price;
      if (riskDist < SL_MIN_PIPS*PIP) return { signal:'HOLD', reason:[`SL $${riskDist.toFixed(1)} < min ${SL_MIN_PIPS} pips`], indicators, buyScore:0, sellScore, conditions:conds };
      if (riskDist > SL_MAX_PIPS*PIP) return { signal:'HOLD', reason:[`SL $${riskDist.toFixed(1)} > max ${SL_MAX_PIPS} pips`], indicators, buyScore:0, sellScore, conditions:conds };
      const tp = computeTP(price, sl, profile, vwapNow, 'short');
      const rr = (price - tp) / riskDist;
      if (rr < MIN_RR) return { signal:'HOLD', reason:[`R:R ${rr.toFixed(2)} < ${MIN_RR}`], indicators, buyScore:0, sellScore, conditions:conds };
      const size = parseFloat(Math.min(equity*RISK_PCT/riskDist, MAX_LOTS).toFixed(4));
      const R    = riskDist * size;
      return { signal:'SELL', reason:passed, indicators, sl, tp, riskDist, rr, size, R, ob, buyScore:0, sellScore, conditions:conds };
    }
    return { signal:'HOLD', reason:[`SELL ${sellScore}/8 — need ${MIN_SCORE}. Missing: ${failed.slice(0,3).join(' | ')}`], indicators, buyScore:0, sellScore, conditions:conds };
  }

  return { signal:'HOLD', reason:['No valid regime'], indicators, buyScore:0, sellScore:0, conditions:[] };
}

// ── Kraken fetchers ───────────────────────────────────────────────────
const KRAKEN_PAIR     = { BTCUSDT:'XBTUSD', ETHUSDT:'ETHUSD', SOLUSDT:'SOLUSD', XRPUSDT:'XRPUSD', LTCUSDT:'LTCUSD' };
const KRAKEN_INTERVAL = { '1m':1,'5m':5,'15m':15,'30m':30,'1h':60,'4h':240 };

function fetchCandlesRaw(pair, ivMin, since) {
  return new Promise((resolve, reject) => {
    const qs  = `pair=${pair}&interval=${ivMin}${since ? `&since=${since}` : ''}`;
    const req = https.request({ hostname:'api.kraken.com', path:`/0/public/OHLC?${qs}`, method:'GET' }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.error?.length) return reject(new Error(json.error[0]));
          const key = Object.keys(json.result).find(k => k !== 'last');
          if (!key) return reject(new Error('No OHLC key'));
          const candles = json.result[key].map(c => ({ time:c[0]*1000, open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[6] }));
          resolve({ candles, last: json.result.last });
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject); req.end();
  });
}

async function fetchCandles(symbol, interval, limit = 300) {
  const pair  = KRAKEN_PAIR[symbol] || symbol;
  const ivMin = KRAKEN_INTERVAL[interval] || 1;
  const { candles } = await fetchCandlesRaw(pair, ivMin, null);
  return candles.slice(-limit);
}

async function fetchCandlesHistorical(symbol, interval, months) {
  // Use OKX for historical data — has full 1m history vs Kraken's ~12h limit
  return fetchCandlesHistoricalOKX(symbol, interval, months);
}

// ── OKX historical fetcher (full 1m+ history available) ──────────────────
const OKX_INSTID = { BTCUSDT:'BTC-USDT', ETHUSDT:'ETH-USDT', SOLUSDT:'SOL-USDT', XRPUSDT:'XRP-USDT', LTCUSDT:'LTC-USDT' };
const OKX_BAR    = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1H','4h':'4H' };

function fetchOKXRaw(instId, bar, after) {
  return new Promise((resolve, reject) => {
    const qs  = `instId=${instId}&bar=${bar}&limit=100${after ? `&after=${after}` : ''}`;
    const req = https.request({
      hostname: 'www.okx.com',
      path:     `/api/v5/market/history-candles?${qs}`,
      method:   'GET',
      headers:  { 'User-Agent': 'Mozilla/5.0' },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.code !== '0') return reject(new Error(`OKX error: ${json.msg}`));
          // OKX returns [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]
          const candles = (json.data || []).map(c => ({
            time:   +c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5],
          }));
          resolve(candles);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject); req.end();
  });
}

async function fetchCandlesHistoricalOKX(symbol, interval, months) {
  const instId = OKX_INSTID[symbol] || symbol;
  const bar    = OKX_BAR[interval]  || '1m';
  const ivMs   = (parseInt(interval) || 1) * 60000;
  const target = Math.ceil(months * 30.44 * 24 * 60); // target candle count
  const cutoff = Date.now() - months * 30.44 * 24 * 3600000;
  const all    = [];
  let after    = null; // start from most recent, page backwards

  // Gather in reverse-chronological order, deduplicate, stop at cutoff
  for (let i = 0; i < 500; i++) {
    const batch = await fetchOKXRaw(instId, bar, after);
    if (!batch.length) break;
    // OKX returns newest-first; batch is already newest→oldest
    const seen = new Set(all.map(c => c.time));
    let added = 0;
    for (const c of batch) {
      if (!seen.has(c.time)) { all.push(c); seen.add(c.time); added++; }
    }
    const oldest = batch[batch.length - 1];
    if (!oldest || oldest.time <= cutoff) break;
    after = oldest.time - 1; // page further back
    if (i < 499) await new Promise(r => setTimeout(r, 220));
  }

  // Sort chronologically (oldest→newest)
  all.sort((a, b) => a.time - b.time);
  return all;
}

async function fetchCurrentPrice(symbol) {
  const pair = KRAKEN_PAIR[symbol] || symbol;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:'api.kraken.com', path:`/0/public/Ticker?pair=${pair}`, method:'GET' }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.error?.length) return reject(new Error(json.error[0]));
          const key = Object.keys(json.result)[0];
          resolve(parseFloat(json.result[key].c[0]));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject); req.end();
  });
}

module.exports = {
  generateSignal, computeTrailUpdate, checkForcedExit,
  classifyRegime, vwapCalc, volumeProfile,
  fetchCandles, fetchCandlesHistorical, fetchCurrentPrice,
  TRAIL_LADDER, SL_MIN_PIPS, SL_MAX_PIPS, MIN_RR, MAX_LOTS, RISK_PCT, PIP,
};
