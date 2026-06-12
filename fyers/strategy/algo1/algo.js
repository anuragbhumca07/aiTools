'use strict';

const https  = require('https');
const crypto = require('crypto');

// ── Fyers API config ──────────────────────────────────────────────
const FYERS_APP_ID    = process.env.FYERS_APP_ID    || 'KZZ4Y6S6F2-200';
const FYERS_SECRET_ID = process.env.FYERS_SECRET_ID || 'HaQvYYVPkQ0OAlYI';
const FYERS_APP_ID_HASH = crypto.createHash('sha256')
  .update(`${FYERS_APP_ID}:${FYERS_SECRET_ID}`)
  .digest('hex');

// Fyers resolution strings → minutes for candle interval
const FYERS_RESOLUTION = {
  '1m': '1', '3m': '3', '5m': '5', '10m': '10',
  '15m': '15', '30m': '30', '1h': '60', '2h': '120',
  '4h': '240', '1d': 'D',
};

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
    price:         closes[n],
    ema21:         ema21[n],
    ema55:         ema55[n],
    ema200:        ema200[n],
    rsi:           rsi14[n],
    macdHist:      macdArr[n]?.hist   ?? null,
    macdPrevHist:  macdArr[n-1]?.hist ?? null,
    macdLine:      macdArr[n]?.macd   ?? null,
    macdSignal:    macdArr[n]?.signal ?? null,
    atr:           atr14[n],
    atrMA20,
    adxSlope,
    ema21Slope,
    candleBodyRatio,
    volume:        volumes[n-1],
    volumeMA:      volMA[n-1],
    adx:           adxArr[n]?.adx    ?? null,
    diPlus:        adxArr[n]?.diPlus  ?? null,
    diMinus:       adxArr[n]?.diMinus ?? null,
    swingHigh,
    swingLow,
    candleTime:    candles[n].time,
  };
}

// ── EMA Ribbon Swing v2 — NSE Intraday Edition ────────────────────
//
// Same precision-filtered strategy as CBT algo3, adapted for NSE equities:
//   - Hard gates: ADX≥25, DI-spread≥15, ADX rising, ATR regime, EMA21 proximity
//   - Scoring: 6/7 conditions (DI, EMA21>55, EMA55>200, EMA21slope, RSI, MACD, candle quality)
//   - Risk: 1.5% per trade (in ₹), SL = max(2.5×ATR, 0.25%), TP = 3×SL
//   - Exit: Phase-based SL ratchet + RSI/EMA/time stops
//
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
    { ok: ema21Rising,                  label: `EMA21 slope rising (${fmt(ema21Slope,2)})` },
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
    { ok: ema21Falling,                 label: `EMA21 slope falling (${fmt(ema21Slope,2)})` },
    { ok: rsi >= 28 && rsi <= 58,       label: `RSI(${fmt(rsi,1)}) ∈ [28–58]` },
    { ok: macdHist < 0,                 label: `MACD hist < 0 (${fmt(macdHist, 4)})` },
    { ok: candleBodyRatio <= 0.55,      label: `Candle close quality (${fmt((1-candleBodyRatio)*100,0)}% lower)` },
  ];
  const sellScore  = sellChecks.filter(c => c.ok).length;
  const sellPassed = sellChecks.filter(c => c.ok).map(c => c.label);
  const sellFailed = sellChecks.filter(c => !c.ok).map(c => c.label);

  if (adx < 25) {
    return { signal: 'HOLD', reason: [`ADX(${fmt(adx,1)}) < 25 — weak trend`], indicators: ind, buyScore, sellScore };
  }
  if (diSpread < 15) {
    return { signal: 'HOLD', reason: [`DI spread(${fmt(diSpread,1)}) < 15 — no conviction`], indicators: ind, buyScore, sellScore };
  }
  if (adxSlope !== null && adxSlope <= 0) {
    return { signal: 'HOLD', reason: [`ADX slope(${fmt(adxSlope,2)}) ≤ 0 — trend fading`], indicators: ind, buyScore, sellScore };
  }
  if (atrMA20 !== null && atr > atrMA20 * 1.3) {
    return { signal: 'HOLD', reason: [`ATR spike: ${fmt(atr,2)} > 1.3×ATR_MA(${fmt(atrMA20,2)})`], indicators: ind, buyScore, sellScore };
  }
  const ema21Dist = Math.abs(price - ema21);
  if (ema21Dist > atr * 1.5) {
    return { signal: 'HOLD', reason: [`Price overextended: |p-EMA21|(${fmt(ema21Dist,2)}) > 1.5×ATR`], indicators: ind, buyScore, sellScore };
  }

  const THRESHOLD = 6;
  if (buyScore >= THRESHOLD && buyScore > sellScore) {
    return { signal: 'BUY', reason: buyPassed, indicators: ind, buyScore, sellScore };
  }
  if (sellScore >= THRESHOLD && sellScore > buyScore) {
    return { signal: 'SELL', reason: sellPassed, indicators: ind, buyScore, sellScore };
  }

  const holdReason = buyScore > sellScore
    ? [`BUY ${buyScore}/7 — missing: ${buyFailed.join(', ')}`]
    : [`SELL ${sellScore}/7 — missing: ${sellFailed.join(', ')}`];
  return { signal: 'HOLD', reason: holdReason, indicators: ind, buyScore, sellScore };
}

// ── Phase-based exit logic ────────────────────────────────────────
function checkExit(position, candles) {
  const ind = computeIndicators(candles);
  const { price, atr, rsi, ema21, ema55 } = ind;
  const { side, entryPrice, stopLoss, takeProfit, phase, mae } = position;

  const profit = side === 'long' ? price - entryPrice : entryPrice - price;
  const currentMAE = Math.min(mae || 0, profit);

  let newCandlesHeld = position.candlesHeld;
  const currentCandleTime = candles[candles.length - 1].time;
  if (currentCandleTime !== position.lastCandleTime) newCandlesHeld++;

  let newPhase = phase;
  let newSL    = stopLoss;
  const PHASE2_BUFFER = 0.15;

  if (side === 'long') {
    if (phase < 4 && profit >= atr * 4) { newPhase = 4; newSL = price - atr * 2; }
    else if (phase < 3 && profit >= atr * 2) { newPhase = 3; newSL = entryPrice + atr * 1.5; }
    else if (phase < 2 && profit >= atr)     { newPhase = 2; newSL = entryPrice + atr * PHASE2_BUFFER; }
    else if (phase === 4) newSL = Math.max(newSL, price - atr * 2);
  } else {
    if (phase < 4 && profit >= atr * 4) { newPhase = 4; newSL = price + atr * 2; }
    else if (phase < 3 && profit >= atr * 2) { newPhase = 3; newSL = entryPrice - atr * 1.5; }
    else if (phase < 2 && profit >= atr)     { newPhase = 2; newSL = entryPrice - atr * PHASE2_BUFFER; }
    else if (phase === 4) newSL = Math.min(newSL, price + atr * 2);
  }

  position.stopLoss       = newSL;
  position.phase          = newPhase;
  position.candlesHeld    = newCandlesHeld;
  position.lastCandleTime = currentCandleTime;
  position.mae            = currentMAE;

  const reasons = [];
  if (side === 'long') {
    if (price <= newSL)     reasons.push(`SL hit (Phase ${newPhase}): ${price.toFixed(2)} ≤ ${newSL.toFixed(2)}`);
    if (price >= takeProfit) reasons.push(`TP hit: ${price.toFixed(2)} ≥ ${takeProfit.toFixed(2)}`);
  } else {
    if (price >= newSL)     reasons.push(`SL hit (Phase ${newPhase}): ${price.toFixed(2)} ≥ ${newSL.toFixed(2)}`);
    if (price <= takeProfit) reasons.push(`TP hit: ${price.toFixed(2)} ≤ ${takeProfit.toFixed(2)}`);
  }
  if (side === 'long'  && rsi > 78) reasons.push(`RSI overbought (${rsi.toFixed(1)} > 78)`);
  if (side === 'short' && rsi < 22) reasons.push(`RSI oversold (${rsi.toFixed(1)} < 22)`);
  if (side === 'long'  && ema21 < ema55 && profit > 0) reasons.push('EMA trend reversed (bearish)');
  if (side === 'short' && ema21 > ema55 && profit > 0) reasons.push('EMA trend reversed (bullish)');
  if (newCandlesHeld >= 60) reasons.push(`Time stop: ${newCandlesHeld} candles held`);

  return { exit: reasons.length > 0, reasons, indicators: ind };
}

// ── Fyers data fetcher ────────────────────────────────────────────

function fyersGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api-t1.fyers.in',
      path,
      method: 'GET',
      headers: {
        Authorization: `${FYERS_APP_ID}:${accessToken}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.s === 'error' || json.s === 'no_data') return reject(new Error(json.message || json.errmsg || 'Fyers error'));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Exchange OAuth auth_code for access_token
async function exchangeAuthCode(authCode) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type:  'authorization_code',
      appIdHash:   FYERS_APP_ID_HASH,
      code:        authCode,
    });
    const opts = {
      hostname: 'api-t1.fyers.in',
      path:     '/api/v3/validate-authcode',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.s === 'error') return reject(new Error(json.message || 'Token exchange failed'));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Build Fyers OAuth URL
function buildAuthUrl(state = 'algo') {
  const params = new URLSearchParams({
    client_id:     FYERS_APP_ID,
    redirect_uri:  'http://127.0.0.1:8080/',
    response_type: 'code',
    state,
  });
  return `https://api-t1.fyers.in/api/v3/generate-authcode?${params}`;
}

// epoch seconds → YYYY-MM-DD (Fyers requires date strings when date_format=1)
function toDateStr(epochSec) {
  return new Date(epochSec * 1000).toISOString().split('T')[0];
}

// Fetch last N candles (live trading)
async function fetchCandles(symbol, interval, limit = 250, accessToken) {
  const resolution = FYERS_RESOLUTION[interval] || '15';
  const now  = Math.floor(Date.now() / 1000);
  // Fetch enough history to cover 250 candles accounting for market hours gaps
  const spanDays = Math.ceil((limit * (parseInt(resolution) || 1440)) / (375)) + 5; // 375 min/day on NSE
  const from = now - spanDays * 86400;

  const qs = `symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&date_format=1&range_from=${toDateStr(from)}&range_to=${toDateStr(now)}&cont_flag=1`;
  const data = await fyersGet(`/data/history?${qs}`, accessToken);

  if (!data.candles || !data.candles.length) throw new Error(`No candle data returned for ${symbol}`);

  const candles = data.candles.map(c => ({
    time:   c[0] * 1000,
    open:   c[1],
    high:   c[2],
    low:    c[3],
    close:  c[4],
    volume: c[5],
  }));
  return candles.slice(-limit);
}

// Fetch historical candles for backtesting (paginated)
async function fetchCandlesHistorical(symbol, interval, months, accessToken) {
  const resolution = FYERS_RESOLUTION[interval] || '15';
  const now  = Math.floor(Date.now() / 1000);
  const from = now - Math.ceil(months * 30.44 * 86400);

  // Fyers max range per request: 60 days for intraday, 366 for daily
  const maxRangeSec = resolution === 'D' ? 366 * 86400 : 60 * 86400;

  const allCandles = [];
  let cursor = from;

  while (cursor < now) {
    const rangeEnd = Math.min(cursor + maxRangeSec, now);
    const qs = `symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&date_format=1&range_from=${toDateStr(cursor)}&range_to=${toDateStr(rangeEnd)}&cont_flag=1`;

    try {
      const data = await fyersGet(`/data/history?${qs}`, accessToken);
      if (data.candles && data.candles.length) {
        const chunk = data.candles.map(c => ({
          time:   c[0] * 1000,
          open:   c[1],
          high:   c[2],
          low:    c[3],
          close:  c[4],
          volume: c[5],
        }));
        const seen = new Set(allCandles.map(c => c.time));
        allCandles.push(...chunk.filter(c => !seen.has(c.time)));
      }
    } catch (e) {
      console.error(`[Fyers] Fetch chunk error ${cursor}–${rangeEnd}:`, e.message);
    }

    cursor = rangeEnd + 1;
    if (cursor < now) await new Promise(r => setTimeout(r, 350)); // rate limit
  }

  return allCandles.sort((a, b) => a.time - b.time);
}

// Place a Fyers market order
async function placeFyersOrder(symbol, side, qty, productType, accessToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      symbol,
      qty,
      type:          2,   // Market order
      side:          side === 'long' ? 1 : -1,
      productType:   productType || 'INTRADAY',
      limitPrice:    0,
      stopPrice:     0,
      validity:      'DAY',
      disclosedQty:  0,
      offlineOrder:  false,
    });
    const opts = {
      hostname: 'api-t1.fyers.in',
      path:     '/api/v3/orders',
      method:   'POST',
      headers:  {
        Authorization:  `${FYERS_APP_ID}:${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.s === 'error') return resolve({ paper: false, error: json.message, orderId: null });
          resolve({ orderId: json.id || json.orderId, live: true });
        } catch (e) { resolve({ paper: false, error: e.message, orderId: null }); }
      });
    });
    req.on('error', e => resolve({ paper: false, error: e.message, orderId: null }));
    req.write(body);
    req.end();
  });
}

// Check if market is open — supports NSE (9:15-15:30) and MCX (9:00-23:30)
function isMarketOpen() {
  const exchange = process.env.EXCHANGE || 'NSE';
  const now = new Date();
  const istOffset = 5 * 60 + 30;
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist   = new Date(utcMs + istOffset * 60000);
  const day   = ist.getDay();
  if (day === 0 || day === 6) return false;
  const hhmm = ist.getHours() * 100 + ist.getMinutes();
  if (exchange === 'MCX') return hhmm >= 900 && hhmm < 2330;
  return hhmm >= 915 && hhmm < 1530;
}

function marketStatusMessage() {
  const exchange = process.env.EXCHANGE || 'NSE';
  const now = new Date();
  const istOffset = 5 * 60 + 30;
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist   = new Date(utcMs + istOffset * 60000);
  const day   = ist.getDay();
  if (day === 0 || day === 6) return 'Market closed — weekend';
  const hhmm = ist.getHours() * 100 + ist.getMinutes();
  if (exchange === 'MCX') {
    if (hhmm < 900)  return 'Pre-market — MCX opens 9:00 IST';
    if (hhmm >= 2330) return 'MCX closed — opens tomorrow 9:00 IST';
    return 'MCX Market OPEN';
  }
  if (hhmm < 915)  return 'Pre-market — opens 9:15 IST';
  if (hhmm >= 1530) return 'Market closed — opens tomorrow 9:15 IST';
  return 'Market OPEN';
}

module.exports = {
  computeIndicators, generateSignal, checkExit,
  fetchCandles, fetchCandlesHistorical,
  exchangeAuthCode, buildAuthUrl,
  placeFyersOrder, isMarketOpen, marketStatusMessage,
  FYERS_APP_ID, FYERS_APP_ID_HASH,
};
