'use strict';

// ── Delta Exchange India REST adapter + Yahoo Finance commodity data ─
// Docs: https://docs.delta.exchange
// Signature: HMAC-SHA256(secret, method + timestamp + path + query + body)

const https  = require('https');
const crypto = require('crypto');

// Demo API keys only work against the testnet host; live keys only against
// production. Set DELTA_HOST=cdn-ind.testnet.deltaex.org to run against demo.
const PROD_HOST    = 'api.india.delta.exchange';
const TESTNET_HOST = 'cdn-ind.testnet.deltaex.org';
const HOST = (process.env.DELTA_HOST || PROD_HOST).replace(/^https?:\/\//, '').replace(/\/+$/, '');
const IS_TESTNET = /testnet/i.test(HOST);
const UA   = 'cbt-deltaex-algo1/1.0';

// Live-tradeable perpetuals on Delta India. Product IDs differ between prod
// and testnet, so the map must match the active HOST.
const PRODUCT_PROD = {
  BTCUSD:  { product_id: 27,     contract_value: 0.001, tick: 0.5  },
  ETHUSD:  { product_id: 3136,   contract_value: 0.01,  tick: 0.05 },
  XAUTUSD: { product_id: 131253, contract_value: 0.001, tick: 0.01 },
};
const PRODUCT_TESTNET = {
  BTCUSD:  { product_id: 84,     contract_value: 0.001, tick: 0.1  },
  ETHUSD:  { product_id: 1699,   contract_value: 0.01,  tick: 0.05 },
  XAUTUSD: { product_id: 181689, contract_value: 0.001, tick: 0.01 },
};
const PRODUCT = IS_TESTNET ? PRODUCT_TESTNET : PRODUCT_PROD;

// Only these symbols can be traded live on Delta; all others are paper-only.
// Delta has no plain XAUUSD spot/futures contract — XAUTUSD (Tether Gold
// perpetual, 1 token ≈ 1 troy oz) is the live gold-tracking proxy.
const DELTA_LIVE_SYMBOLS = new Set(['BTCUSD', 'ETHUSD', 'XAUTUSD']);

// Yahoo Finance tickers for commodity paper-trading
const YAHOO_TICKER = {
  XAUUSD:  'GC=F',  // Gold futures (CME)
  XAGUSD:  'SI=F',  // Silver futures (CME)
  WTIUSD:  'CL=F',  // Crude Oil WTI futures
  NGASUSD: 'NG=F',  // Natural Gas futures
  COPPER:  'HG=F',  // Copper futures
};

// Human-readable labels (used in UI dropdown)
const SYMBOL_LABEL = {
  BTCUSD:  'BTCUSD perp (live)',
  ETHUSD:  'ETHUSD perp (live)',
  XAUTUSD: 'Tether Gold (XAUTUSD) perp — live',
  XAUUSD:  'Gold (XAUUSD) — paper',
  XAGUSD:  'Silver (XAGUSD) — paper',
  WTIUSD:  'Crude Oil WTI — paper',
  NGASUSD: 'Natural Gas — paper',
  COPPER:  'Copper — paper',
};

const RESOLUTION = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1d': '1d',
};
const CANDLE_MS = {
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1d': 86400000,
};

// ── HMAC-SHA256 signature ─────────────────────────────────────────
function sign(secret, method, ts, requestPath, query, body) {
  const payload = `${method}${ts}${requestPath}${query || ''}${body || ''}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

let _clockOffsetSec = 0;
function nowSec() { return Math.floor(Date.now() / 1000) - _clockOffsetSec; }
function setOffsetFromServerTs(serverTs) {
  if (!Number.isFinite(serverTs)) return;
  _clockOffsetSec = Math.floor(Date.now() / 1000) - serverTs;
}

function httpsRequest({ method, path: reqPath, body }, apiKey, apiSecret, _retry = false) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const [rawPath, rawQuery] = reqPath.split('?');
    const query = rawQuery ? `?${rawQuery}` : '';
    const ts    = nowSec().toString();
    const headers = {
      'Content-Type':   'application/json',
      'User-Agent':     UA,
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (apiKey && apiSecret) {
      const sig = sign(apiSecret, method, ts, rawPath, query, bodyStr);
      headers['api-key']   = apiKey;
      headers['signature'] = sig;
      headers['timestamp'] = ts;
    }
    const req = https.request({ hostname: HOST, path: reqPath, method, headers }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', async () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json ?? {});
        const code = json?.error?.code;
        const srv  = json?.error?.context?.server_time;
        if (!_retry && (code === 'expired_signature' || code === 'invalid_timestamp') && Number.isFinite(srv)) {
          setOffsetFromServerTs(srv);
          try { return resolve(await httpsRequest({ method, path: reqPath, body }, apiKey, apiSecret, true)); }
          catch (e) { return reject(e); }
        }
        const err = new Error(`Delta ${method} ${reqPath} → ${res.statusCode}: ${code || json?.message || raw.slice(0, 200)}`);
        err.status = res.statusCode;
        err.body   = json ?? raw;
        reject(err);
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error(`Delta ${method} ${reqPath} timed out`)); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Delta public endpoints ─────────────────────────────────────────
async function getTicker(symbol) {
  const r = await httpsRequest({ method: 'GET', path: `/v2/tickers/${symbol}` });
  return r?.result || null;
}

async function getCandles(symbol, timeframe, startSec, endSec) {
  const res  = RESOLUTION[timeframe] || '1m';
  const path = `/v2/history/candles?symbol=${symbol}&resolution=${res}&start=${startSec}&end=${endSec}`;
  const r    = await httpsRequest({ method: 'GET', path });
  const rows = (r?.result || []).map(c => ({
    time: c.time * 1000, open: +c.open, high: +c.high,
    low:  +c.low, close: +c.close, volume: +c.volume,
  }));
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

async function getRecentCandles(symbol, timeframe, count) {
  const ivMs      = CANDLE_MS[timeframe] || 60000;
  const ivSec     = ivMs / 1000;
  const now       = Math.floor(Date.now() / 1000);
  const chunkSize = 1000;
  const need      = Math.min(count + 10, 10000);
  const all       = new Map();
  let end = now;
  for (let attempts = 0; attempts < 12 && all.size < need; attempts++) {
    const start = end - chunkSize * ivSec;
    const rows  = await getCandles(symbol, timeframe, start, end);
    if (!rows.length) break;
    for (const c of rows) all.set(c.time, c);
    end = Math.floor(rows[0].time / 1000) - ivSec;
    await new Promise(r => setTimeout(r, 200));
  }
  const sorted = [...all.values()].sort((a, b) => a.time - b.time);
  const nowMs  = Date.now();
  const closed = sorted.filter(c => c.time + ivMs <= nowMs);
  return closed.slice(-count);
}

// ── Delta auth endpoints ───────────────────────────────────────────
async function getWallet(apiKey, apiSecret) {
  return httpsRequest({ method: 'GET', path: '/v2/wallet/balances' }, apiKey, apiSecret);
}
async function getPositions(apiKey, apiSecret) {
  return httpsRequest({ method: 'GET', path: '/v2/positions/margined' }, apiKey, apiSecret);
}
async function placeMarketOrder(apiKey, apiSecret, { symbol, side, contracts, clientOrderId }) {
  const p = PRODUCT[symbol];
  if (!p) throw new Error(`Symbol ${symbol} is not live-tradeable on Delta Exchange`);
  const body = {
    product_id:      p.product_id,
    product_symbol:  symbol,
    size:            Math.max(1, Math.round(contracts)),
    side:            side === 'long' || side === 'buy' ? 'buy' : 'sell',
    order_type:      'market_order',
    time_in_force:   'ioc',
    ...(clientOrderId ? { client_order_id: String(clientOrderId).slice(0, 32) } : {}),
  };
  return httpsRequest({ method: 'POST', path: '/v2/orders', body }, apiKey, apiSecret);
}
async function closePosition(apiKey, apiSecret, { symbol, side, contracts }) {
  const p = PRODUCT[symbol];
  if (!p) throw new Error(`Symbol ${symbol} is not live-tradeable on Delta Exchange`);
  const body = {
    product_id:     p.product_id,
    product_symbol: symbol,
    size:           Math.max(1, Math.round(contracts)),
    side:           side === 'long' || side === 'buy' ? 'sell' : 'buy',
    order_type:     'market_order',
    time_in_force:  'ioc',
    reduce_only:    true,
  };
  return httpsRequest({ method: 'POST', path: '/v2/orders', body }, apiKey, apiSecret);
}
async function getOrder(apiKey, apiSecret, orderId) {
  return httpsRequest({ method: 'GET', path: `/v2/orders/${orderId}` }, apiKey, apiSecret);
}

// ── Yahoo Finance candle fetcher (for commodity paper trading) ────
const YAHOO_INTERVAL_MAP = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '60m', '4h': '60m', '1d': '1d',
};
const YAHOO_RANGE_MAP = {
  '1m': '7d', '5m': '60d', '15m': '60d', '30m': '60d',
  '1h': '730d', '4h': '730d', '1d': 'max',
};

function fetchYahooRaw(ticker, timeframe) {
  return new Promise((resolve, reject) => {
    const iv   = YAHOO_INTERVAL_MAP[timeframe] || '1m';
    const rng  = YAHOO_RANGE_MAP[timeframe]    || '7d';
    const path = `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${iv}&range=${rng}&includePrePost=false`;
    const opts = {
      hostname: 'query1.finance.yahoo.com', path, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': 'application/json' },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json   = JSON.parse(raw);
          const result = json?.chart?.result?.[0];
          if (!result) return reject(new Error(`Yahoo Finance: no data returned for ${ticker}`));
          const timestamps = result.timestamp || [];
          const quote      = result.indicators?.quote?.[0] || {};
          const candles    = [];
          for (let i = 0; i < timestamps.length; i++) {
            const o = quote.open?.[i], h = quote.high?.[i];
            const l = quote.low?.[i],  c = quote.close?.[i];
            const v = quote.volume?.[i];
            if (o == null || h == null || l == null || c == null) continue;
            candles.push({
              time: timestamps[i] * 1000,
              open: +o, high: +h, low: +l, close: +c, volume: +(v || 0),
            });
          }
          candles.sort((a, b) => a.time - b.time);
          resolve(candles);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Yahoo Finance real-time quote (for fast trailing tick)
function fetchYahooPrice(ticker) {
  return new Promise((resolve, reject) => {
    const path = `/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&fields=regularMarketPrice`;
    const opts = {
      hostname: 'query1.finance.yahoo.com', path, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': 'application/json' },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json  = JSON.parse(raw);
          const price = json?.quoteResponse?.result?.[0]?.regularMarketPrice;
          if (price == null) return reject(new Error(`Yahoo Finance: no price for ${ticker}`));
          resolve(parseFloat(price));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getRecentCandlesYahoo(symbol, timeframe, count) {
  const ticker  = YAHOO_TICKER[symbol];
  if (!ticker)  throw new Error(`No Yahoo Finance ticker for symbol: ${symbol}`);
  const ivMs    = CANDLE_MS[timeframe] || 60000;
  const candles = await fetchYahooRaw(ticker, timeframe);
  const nowMs   = Date.now();
  const closed  = candles.filter(c => c.time + ivMs <= nowMs);
  return closed.slice(-count);
}

async function getHistoricalCandlesYahoo(symbol, timeframe, months) {
  const ticker  = YAHOO_TICKER[symbol];
  if (!ticker)  throw new Error(`No Yahoo Finance ticker for symbol: ${symbol}`);
  const ivMs    = CANDLE_MS[timeframe] || 60000;
  const candles = await fetchYahooRaw(ticker, timeframe);
  const cutoff  = Date.now() - months * 30.44 * 24 * 3600 * 1000;
  const nowMs   = Date.now();
  return candles.filter(c => c.time >= cutoff && c.time + ivMs <= nowMs);
}

// ── Unified symbol router ─────────────────────────────────────────
async function getRecentCandlesForSymbol(symbol, timeframe, count) {
  if (DELTA_LIVE_SYMBOLS.has(symbol)) return getRecentCandles(symbol, timeframe, count);
  return getRecentCandlesYahoo(symbol, timeframe, count);
}

async function getHistoricalCandlesForSymbol(symbol, timeframe, months) {
  if (DELTA_LIVE_SYMBOLS.has(symbol)) {
    const ivMs      = CANDLE_MS[timeframe] || 60000;
    const totalBars = Math.ceil(months * 30.44 * 24 * (3600 * 1000 / ivMs)) + 260;
    return getRecentCandles(symbol, timeframe, totalBars);
  }
  return getHistoricalCandlesYahoo(symbol, timeframe, months);
}

async function getCurrentPriceForSymbol(symbol) {
  if (DELTA_LIVE_SYMBOLS.has(symbol)) {
    const t = await getTicker(symbol);
    const p = parseFloat(t?.mark_price || t?.close || 0);
    if (!p || !isFinite(p)) throw new Error(`No ticker price for ${symbol}`);
    return p;
  }
  const ticker = YAHOO_TICKER[symbol];
  if (!ticker) throw new Error(`No data source for symbol: ${symbol}`);
  return fetchYahooPrice(ticker);
}

module.exports = {
  HOST, PRODUCT, CANDLE_MS,
  DELTA_LIVE_SYMBOLS, YAHOO_TICKER, SYMBOL_LABEL,
  getTicker, getCandles, getRecentCandles,
  getWallet, getPositions,
  placeMarketOrder, closePosition, getOrder,
  getRecentCandlesForSymbol, getHistoricalCandlesForSymbol, getCurrentPriceForSymbol,
};
