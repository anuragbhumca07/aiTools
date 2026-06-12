'use strict';
const https  = require('https');
const crypto = require('crypto');

// ── Symbol mapping ────────────────────────────────────────────────
const SYMBOL_MAP = {
  BTCUSDT:  'BTC-USD',  ETHUSDT:  'ETH-USD',
  SOLUSDT:  'SOL-USD',  DOGEUSDT: 'DOGE-USD',
  XRPUSDT:  'XRP-USD',  ADAUSDT:  'ADA-USD',
  LTCUSDT:  'LTC-USD',
};

// ── TOTP (RFC 6238) — for authenticator-app MFA on OAuth2 ────────
const RH_OAUTH_CLIENT_ID = 'c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS';

function base32Decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0;
  const out = [];
  for (const c of s) {
    val = (val << 5) | alpha.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateTOTP(secret, step = 30) {
  const key = base32Decode(secret);
  const T   = Math.floor(Date.now() / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(T / 2 ** 32), 0);
  buf.writeUInt32BE(T >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000;
  return n.toString().padStart(6, '0');
}

// ── Ed25519 private key loader ────────────────────────────────────
// Accepts: 32-byte seed (base64), 64-byte seed+pubkey (base64), or PEM string
function loadEd25519PrivateKey(keyStr) {
  if (!keyStr) return null;
  keyStr = keyStr.trim();
  // PEM format
  if (keyStr.includes('PRIVATE KEY')) {
    return crypto.createPrivateKey({ key: keyStr, format: 'pem', type: 'pkcs8' });
  }
  // Base64-encoded bytes
  const raw = Buffer.from(keyStr, 'base64');
  let seed;
  if (raw.length === 32) {
    seed = raw;
  } else if (raw.length === 64) {
    seed = raw.slice(0, 32);   // nacl format: seed‖pubkey
  } else if (raw.length >= 48) {
    // Already PKCS8 DER
    return crypto.createPrivateKey({ key: raw, format: 'der', type: 'pkcs8' });
  } else {
    throw new Error(`Unexpected private key length: ${raw.length}`);
  }
  // Build PKCS8 DER for Ed25519 from 32-byte seed
  const hdr = Buffer.from('302e020100300506032b657004220420', 'hex');
  return crypto.createPrivateKey({ key: Buffer.concat([hdr, seed]), format: 'der', type: 'pkcs8' });
}

// ── Generic HTTPS helper ──────────────────────────────────────────
function request({ hostname, path, method = 'GET', headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const hdrs = { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers };
    if (payload) hdrs['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request({ hostname, path, method, headers: hdrs }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(raw); } catch { j = null; }
        if (res.statusCode >= 400) {
          const e = Object.assign(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 400)}`),
            { status: res.statusCode, body: j });
          reject(e);
        } else { resolve(j); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Official API (Ed25519 key-pair) ───────────────────────────────
const OFFICIAL_HOST = 'trading.robinhood.com';

class OfficialApiClient {
  constructor(apiKeyId, privateKey) {
    this.apiKeyId   = apiKeyId;
    this.privateKey = privateKey;
    this._accountId = null;
  }

  get authenticated() { return true; }   // stateless — key always valid

  _sign(timestamp, path, body = '') {
    const msg = Buffer.from(`${this.apiKeyId}${timestamp}${path}${body}`, 'utf8');
    return crypto.sign(null, msg, this.privateKey).toString('base64');
  }

  async _req(path, method = 'GET', body = null) {
    const ts      = Math.floor(Date.now() / 1000).toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    return request({
      hostname: OFFICIAL_HOST,
      path,
      method,
      body:    body ? bodyStr : null,
      headers: {
        'x-api-key':   this.apiKeyId,
        'x-timestamp': ts,
        'x-signature': this._sign(ts, path, bodyStr),
      },
    });
  }

  async getAccount() {
    const res = await this._req('/api/v1/crypto/trading/accounts/');
    return res;
  }

  async getPortfolioBalance() {
    try {
      const res = await this.getAccount();
      const acct = (res.results || (Array.isArray(res) ? res : []))[0];
      return acct ? parseFloat(acct.buying_power || acct.portfolio_cash || 0) : null;
    } catch { return null; }
  }

  async placeMarketOrder(symbol, side, quantity) {
    const rhSymbol = SYMBOL_MAP[symbol];
    if (!rhSymbol) throw new Error(`Unknown symbol: ${symbol}`);
    return this._req('/api/v1/crypto/trading/orders/', 'POST', {
      client_order_id:    crypto.randomUUID(),
      side,                          // 'buy' | 'sell'
      type:               'market',
      symbol:             rhSymbol,
      market_order_config: { asset_quantity: quantity.toFixed(8) },
    });
  }

  logout() {}  // key-pair auth has no session to clear
}

// ── OAuth2 client (username + password) ──────────────────────────
const OAUTH_HOST = 'api.robinhood.com';

class OAuthClient {
  constructor() {
    this.accessToken  = null;
    this.refreshToken = null;
    this.expiresAt    = 0;
    this._accountId   = null;
    this.deviceToken  = process.env.RH_DEVICE_TOKEN || crypto.randomUUID();
    this._pairs       = {};
  }

  get authenticated() { return !!this.accessToken && Date.now() < this.expiresAt; }

  async login(username, password, mfaCode) {
    const body = {
      username, password,
      grant_type: 'password', scope: 'internal',
      client_id: RH_OAUTH_CLIENT_ID,
      expires_in: 86400, device_token: this.deviceToken,
    };
    if (mfaCode) body.mfa_code = mfaCode;

    let res;
    try {
      res = await request({
        hostname: OAUTH_HOST, path: '/oauth2/token/', method: 'POST',
        headers: {
          'User-Agent':              'python-requests/2.32.3',
          'X-Robinhood-API-Version': '1.431.4',
        },
        body,
      });
    } catch (err) {
      if (err.status === 400 && err.body?.mfa_required) return { mfaRequired: true };
      throw err;
    }
    if (res?.mfa_required) return { mfaRequired: true };
    this.accessToken  = res.access_token;
    this.refreshToken = res.refresh_token;
    this.expiresAt    = Date.now() + (res.expires_in - 60) * 1000;
    return { ok: true };
  }

  async ensureToken() {
    if (!this.accessToken) throw new Error('Not authenticated with Robinhood');
    if (Date.now() < this.expiresAt) return;
    const res = await request({
      hostname: OAUTH_HOST, path: '/oauth2/token/', method: 'POST',
      headers: { 'User-Agent': 'python-requests/2.32.3' },
      body: {
        grant_type: 'refresh_token', refresh_token: this.refreshToken,
        client_id: RH_OAUTH_CLIENT_ID, device_token: this.deviceToken,
        expires_in: 86400, scope: 'internal',
      },
    });
    this.accessToken  = res.access_token;
    this.refreshToken = res.refresh_token;
    this.expiresAt    = Date.now() + (res.expires_in - 60) * 1000;
  }

  async getAccountId() {
    if (this._accountId) return this._accountId;
    await this.ensureToken();
    const res      = await request({ hostname: 'nummus.robinhood.com', path: '/accounts/',
      headers: { Authorization: `Bearer ${this.accessToken}` } });
    const accounts = res.results || (Array.isArray(res) ? res : []);
    if (!accounts.length) throw new Error('No crypto account found');
    this._accountId = accounts[0].id;
    return this._accountId;
  }

  async getCryptoPair(symbol) {
    if (this._pairs[symbol]) return this._pairs[symbol];
    const rhSym = SYMBOL_MAP[symbol];
    if (!rhSym) throw new Error(`Unknown symbol: ${symbol}`);
    await this.ensureToken();
    const res  = await request({ hostname: OAUTH_HOST, path: '/crypto/currency_pairs/',
      headers: { Authorization: `Bearer ${this.accessToken}` } });
    const pair = (res.results || []).find(p =>
      (p.asset_currency?.code || '') + '-' + (p.quote_currency?.code || '') === rhSym);
    if (!pair) throw new Error(`Pair not found: ${rhSym}`);
    this._pairs[symbol] = pair;
    return pair;
  }

  async getPortfolioBalance() {
    try {
      await this.ensureToken();
      const res  = await request({ hostname: 'nummus.robinhood.com', path: '/portfolios/',
        headers: { Authorization: `Bearer ${this.accessToken}` } });
      const port = (res.results || (Array.isArray(res) ? res : []))[0];
      return port ? parseFloat(port.equity) : null;
    } catch { return null; }
  }

  async placeMarketOrder(symbol, side, quantity) {
    await this.ensureToken();
    const [accountId, pair] = await Promise.all([this.getAccountId(), this.getCryptoPair(symbol)]);
    return request({
      hostname: 'nummus.robinhood.com', path: '/orders/', method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: {
        account_id: accountId, currency_pair_id: pair.id,
        quantity: quantity.toFixed(8), side, type: 'market',
        time_in_force: 'gtc', ref_id: crypto.randomUUID(),
      },
    });
  }

  logout() {
    this.accessToken = null; this.refreshToken = null;
    this.expiresAt = 0; this._accountId = null; this._pairs = {};
  }
}

// ── Unified RobinhoodClient ───────────────────────────────────────
// Auto-selects Official API if RH_API_KEY_ID + RH_API_PRIVATE_KEY are set,
// otherwise falls back to OAuth2 (username + password).
class RobinhoodClient {
  constructor() {
    const apiKeyId    = process.env.RH_API_KEY_ID;
    const privateKeyB = process.env.RH_API_PRIVATE_KEY;

    if (apiKeyId && privateKeyB) {
      let privateKey;
      try { privateKey = loadEd25519PrivateKey(privateKeyB); } catch (e) {
        console.error('[RH] Failed to load private key:', e.message);
      }
      if (privateKey) {
        this._impl = new OfficialApiClient(apiKeyId, privateKey);
        this._mode = 'official';
        console.log('[RH] Using Official API (Ed25519 key-pair)');
        return;
      }
    }

    this._impl = new OAuthClient();
    this._mode = 'oauth2';
    console.log('[RH] Using OAuth2 (username + password)');
  }

  get mode()          { return this._mode; }
  get authenticated() { return this._impl.authenticated; }
  get accountId()     { return this._impl._accountId || null; }

  // Official API is always authenticated; OAuth2 needs explicit login
  async login(username, password, mfaCode) {
    if (this._mode === 'official') return { ok: true };
    return this._impl.login(username, password, mfaCode);
  }

  async getPortfolioBalance()          { return this._impl.getPortfolioBalance(); }
  async placeMarketOrder(sym, side, q) { return this._impl.placeMarketOrder(sym, side, q); }
  logout()                             { return this._impl.logout(); }

  // Only used by OAuth2 mode (official API derives account from key)
  async getAccountId() {
    if (this._mode === 'official') {
      try {
        const res  = await this._impl.getAccount();
        const acct = (res.results || (Array.isArray(res) ? res : []))[0];
        if (acct?.account_number) this._impl._accountId = acct.account_number;
      } catch {}
      return this._impl._accountId;
    }
    return this._impl.getAccountId();
  }
}

module.exports = { RobinhoodClient, generateTOTP, SYMBOL_MAP };
