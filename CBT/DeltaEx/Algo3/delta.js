'use strict';

// ── Delta Exchange India — REST adapter ──────────────────────────
// Docs: https://docs.delta.exchange
// Signature: HMAC-SHA256(secret, method + timestamp + path + query + body)
// Headers:   api-key, signature, timestamp, User-Agent
// Signature must reach Delta within 5s of `timestamp` (server-time skew is real).

const https  = require('https');
const crypto = require('crypto');

// Two Delta India environments. The active host is switchable at runtime so a
// single server can serve BOTH the demo (testnet) and live (production) account
// — the UI picks which one per session. Demo API keys ONLY work against the
// testnet host, real keys ONLY against production.
const PROD_HOST    = 'api.india.delta.exchange';
const TESTNET_HOST = 'cdn-ind.testnet.deltaex.org';
const UA           = 'cbt-algo3-delta/1.0';

// `let` so setHost() can switch environments live. Seeded from DELTA_HOST (else
// production) for backwards compatibility with the single-account start scripts.
let HOST = (process.env.DELTA_HOST || PROD_HOST).replace(/^https?:\/\//, '').replace(/\/+$/, '');
function isTestnet() { return /testnet/i.test(HOST); }
function getHost()   { return HOST; }
function setHost(h)  { if (h) HOST = String(h).replace(/^https?:\/\//, '').replace(/\/+$/, ''); return HOST; }
function hostFor(account) { return account === 'demo' ? TESTNET_HOST : PROD_HOST; }

// BTCUSD/ETHUSD perpetuals on Delta India. Product IDs differ between the two
// environments, so orders must use the id matching the ACTIVE host.
const PRODUCT_PROD = {
  BTCUSD: { product_id: 27,   contract_value: 0.001, tick: 0.5   },
  ETHUSD: { product_id: 3136, contract_value: 0.01,  tick: 0.05  },
};
const PRODUCT_TESTNET = {
  BTCUSD: { product_id: 84,   contract_value: 0.001, tick: 0.1   },
  ETHUSD: { product_id: 1699, contract_value: 0.01,  tick: 0.05  },
};
function getProduct(symbol) { return (isTestnet() ? PRODUCT_TESTNET : PRODUCT_PROD)[symbol]; }

// resolution string used by Delta candles endpoint
const RESOLUTION = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1d': '1d',
};
const CANDLE_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };

function sign(secret, method, ts, requestPath, query, body) {
  const payload = `${method}${ts}${requestPath}${query || ''}${body || ''}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Clock skew handling — Delta's HMAC window is 5s, and any drift between the
// local host and Delta's server will produce `expired_signature`. On every 4xx
// signature error Delta returns the server's own time in the error context, so
// we cache that offset and subtract it from local time on subsequent requests.
let _clockOffsetSec = 0;   // local_ts - delta_server_ts (positive = we're ahead)
function nowSec() { return Math.floor(Date.now() / 1000) - _clockOffsetSec; }
function setOffsetFromServerTs(serverTs) {
  if (!Number.isFinite(serverTs)) return;
  const localTs = Math.floor(Date.now() / 1000);
  _clockOffsetSec = localTs - serverTs;
}

// One HTTPS round-trip. Public endpoints skip auth if apiKey is null.
// Retries once on `expired_signature` after resyncing clock from the error body.
function httpsRequest({ method, path: reqPath, body }, apiKey, apiSecret, _retry = false) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const [rawPath, rawQuery] = reqPath.split('?');
    const query = rawQuery ? `?${rawQuery}` : '';
    const ts    = nowSec().toString();
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent':   UA,
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (apiKey && apiSecret) {
      const sig = sign(apiSecret, method, ts, rawPath, query, bodyStr);
      headers['api-key']   = apiKey;
      headers['signature'] = sig;
      headers['timestamp'] = ts;
    }
    const req = https.request({
      hostname: HOST, path: reqPath, method, headers,
      // Force IPv4 egress. Delta's API-key IP whitelist matches the source IP it
      // observes; a dual-stack host may otherwise leave over IPv6 and present a
      // different address than the (IPv4) one whitelisted → ip_not_whitelisted_for_api_key.
      family: 4,
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', async () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json ?? {});
        // Auto-resync clock and retry once when Delta reports its own server_time.
        const code = json?.error?.code;
        const srv  = json?.error?.context?.server_time;
        if (!_retry && (code === 'expired_signature' || code === 'invalid_timestamp') && Number.isFinite(srv)) {
          setOffsetFromServerTs(srv);
          try { return resolve(await httpsRequest({ method, path: reqPath, body }, apiKey, apiSecret, true)); }
          catch (e) { return reject(e); }
        }
        const err = new Error(`Delta ${method} ${reqPath} → ${res.statusCode}: ${code || json?.message || raw.slice(0,200)}`);
        err.status = res.statusCode;
        err.body   = json ?? raw;
        reject(err);
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// GET with retry on TRANSIENT upstream failures (5xx / network hiccups) — Delta's
// testnet especially returns occasional 503s. Never retries 4xx (real errors).
// GET-only, so it's always safe (no risk of double-placing an order).
async function getPublic(path, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await httpsRequest({ method: 'GET', path }); }
    catch (e) {
      lastErr = e;
      const transient = !e.status || (e.status >= 500 && e.status < 600);
      if (!transient || i === tries - 1) break;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));   // 0.4s, 0.8s backoff
    }
  }
  throw lastErr;
}

// ── Public: current tick (mark price) ─────────────────────────────
async function getTicker(symbol) {
  const r = await getPublic(`/v2/tickers/${symbol}`);
  return r?.result || null;
}

// ── Public: historical 1m/5m candles ──────────────────────────────
// Delta returns `time` in seconds; we normalize to ms for the algo.
// Delta's candles endpoint accepts start/end in SECONDS.
async function getCandles(symbol, timeframe, startSec, endSec) {
  const res = RESOLUTION[timeframe] || '1m';
  const path = `/v2/history/candles?symbol=${symbol}&resolution=${res}&start=${startSec}&end=${endSec}`;
  const r = await getPublic(path);
  const rows = (r?.result || []).map(c => ({
    time:   c.time * 1000,
    open:   +c.open,
    high:   +c.high,
    low:    +c.low,
    close:  +c.close,
    volume: +c.volume,
  }));
  rows.sort((a,b) => a.time - b.time);
  return rows;
}

// Recent N candles ending at (now - one interval) — filters the still-forming bar.
async function getRecentCandles(symbol, timeframe, count) {
  const ivMs  = CANDLE_MS[timeframe] || 60000;
  const ivSec = ivMs / 1000;
  const now   = Math.floor(Date.now() / 1000);
  // Delta caps at ~2000 candles/request; chunk if we need more.
  const chunkSize = 1000;
  const need = Math.min(count + 5, 5000);
  const all = new Map();
  let end = now;
  for (let attempts = 0; attempts < 6 && all.size < need; attempts++) {
    const start = end - chunkSize * ivSec;
    const rows = await getCandles(symbol, timeframe, start, end);
    if (!rows.length) break;
    for (const c of rows) all.set(c.time, c);
    end = Math.floor(rows[0].time / 1000) - ivSec;
    await new Promise(r => setTimeout(r, 200));
  }
  const sorted = [...all.values()].sort((a,b) => a.time - b.time);
  // Drop the still-forming candle (open + interval > now).
  const nowMs = Date.now();
  const closed = sorted.filter(c => c.time + ivMs <= nowMs);
  return closed.slice(-count);
}

// ── Auth: wallet balance / positions / orders ─────────────────────
async function getWallet(apiKey, apiSecret) {
  return httpsRequest({ method: 'GET', path: '/v2/wallet/balances' }, apiKey, apiSecret);
}
async function getPositions(apiKey, apiSecret) {
  return httpsRequest({ method: 'GET', path: '/v2/positions/margined' }, apiKey, apiSecret);
}
async function getPositionForProduct(apiKey, apiSecret, productId) {
  return httpsRequest({ method: 'GET', path: `/v2/positions?product_id=${productId}` }, apiKey, apiSecret);
}
async function placeMarketOrder(apiKey, apiSecret, { symbol, side, contracts, clientOrderId }) {
  const p = getProduct(symbol);
  if (!p) throw new Error(`Unknown symbol ${symbol}`);
  const body = {
    product_id:    p.product_id,
    product_symbol: symbol,
    size:          Math.max(1, Math.round(contracts)),
    side:          side === 'long' || side === 'buy' ? 'buy' : 'sell',
    order_type:    'market_order',
    time_in_force: 'ioc',
    ...(clientOrderId ? { client_order_id: String(clientOrderId).slice(0,32) } : {}),
  };
  return httpsRequest({ method: 'POST', path: '/v2/orders', body }, apiKey, apiSecret);
}
// Close position at market. Delta accepts `close_position: true` or a plain opposite-side market order.
async function closePosition(apiKey, apiSecret, { symbol, side, contracts }) {
  const p = getProduct(symbol);
  if (!p) throw new Error(`Unknown symbol ${symbol}`);
  const body = {
    product_id:    p.product_id,
    product_symbol: symbol,
    size:          Math.max(1, Math.round(contracts)),
    side:          side === 'long' || side === 'buy' ? 'sell' : 'buy',   // opposite side to close
    order_type:    'market_order',
    time_in_force: 'ioc',
    reduce_only:   true,
  };
  return httpsRequest({ method: 'POST', path: '/v2/orders', body }, apiKey, apiSecret);
}
async function cancelOrder(apiKey, apiSecret, { orderId, productId }) {
  const body = { id: Number(orderId), product_id: Number(productId) };
  return httpsRequest({ method: 'DELETE', path: '/v2/orders', body }, apiKey, apiSecret);
}
async function getOrder(apiKey, apiSecret, orderId) {
  return httpsRequest({ method: 'GET', path: `/v2/orders/${orderId}` }, apiKey, apiSecret);
}

module.exports = {
  PROD_HOST, TESTNET_HOST, CANDLE_MS,
  getHost, setHost, hostFor, isTestnet, getProduct,
  getTicker, getCandles, getRecentCandles,
  getWallet, getPositions, getPositionForProduct,
  placeMarketOrder, closePosition, cancelOrder, getOrder,
};
