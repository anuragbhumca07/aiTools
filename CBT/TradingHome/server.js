'use strict';

const express = require('express');
const path    = require('path');
const https   = require('https');

const PORT = parseInt(process.env.PORT || '3015', 10);

// ── Registry of every algo: name, group, description, Railway URL (null = local-only) ──
const ALGOS = [
  // ─────────────── Strategy ───────────────
  { group: 'Strategy', name: 'Algo1',  title: 'Swing v3 — Closed Candle',           desc: 'EMA21/55/200 ribbon · ADX · MACD · closed-candle eval (1h–1d)', url: 'https://cbt-algo1-production.up.railway.app' },
  { group: 'Strategy', name: 'Algo2',  title: 'Kronos Trader',                       desc: 'AI signal generator (Kronos LLM forecast → BUY/SELL signals)', url: 'https://cbt-algo2-production.up.railway.app' },
  { group: 'Strategy', name: 'Algo3',  title: 'Swing v3 — Multi-Timeframe',          desc: 'MTF EMA confluence · 4h trend + 1h entry trigger',             url: 'https://cbt-algo3-production.up.railway.app' },
  { group: 'Strategy', name: 'Algo4',  title: 'BTC/USD 1-min Scalp',                 desc: 'Regime gate · OB + Liquidity Sweep · 8 conditions · R-Ladder trailing', url: 'https://algo4-production.up.railway.app' },
  { group: 'Strategy', name: 'Algo5',  title: 'Swing v2 — Trailing SL',              desc: 'EMA ribbon + ADX(25) + DI-spread + macro gate · $50/step trailing after $300', url: 'https://algo5-production.up.railway.app' },
  { group: 'Strategy', name: 'Algo6',  title: 'NY Session — 4H + 5M',                desc: '4-hour bias + 5-min entry · NY-session-only swing strategy',   url: 'https://cbt-algo6-production.up.railway.app' },
  { group: 'Strategy', name: 'Algo11', title: 'Swing v3 — Closed Candle (v2)',       desc: 'Refined closed-candle MTF entry — alt build of Algo1',          url: 'https://algo11-production.up.railway.app' },
  { group: 'Strategy', name: 'Algo44', title: 'BTC 1m Scalp (Algo5-style UI)',       desc: 'Algo4 logic with the dark Algo5 UI shell · regime gate · R-Ladder', url: 'https://algo44-production.up.railway.app' },
  { group: 'Strategy', name: 'Algo55', title: 'Swing v2 — Dynamic Sizing',           desc: 'Algo5 + dynamic position sizing tuned per regime',              url: 'https://algo55-production.up.railway.app' },
  { group: 'Strategy', name: 'Algo66', title: 'NY Session 4H+5M — MetaAPI MT5',      desc: 'Algo6 strategy wired to MetaAPI for MT5 live execution',         url: 'https://algo66-production.up.railway.app' },

  // ─────────────── Robinhood ───────────────
  { group: 'Robinhood', name: 'RobAlgo6', title: 'NY Session 4H + 5M (Robinhood)', desc: 'Algo6 strategy executing through Robinhood crypto API — live execution', url: 'https://rob-algo6-production.up.railway.app' },

  // ─────────────── Tickmill (local only — no Railway deploy yet) ───────────────
  { group: 'Tickmill', name: 'TickAlgo1', title: 'Tickmill Swing Bot', desc: 'Algo1 strategy wired through Tickmill API · runs locally, not yet on Railway', url: null },

  // ─────────────── MT5 (local only — no Railway deploy yet) ───────────────
  { group: 'MT5', name: 'MT5Algo1', title: 'MT5 Python Bridge', desc: 'Node ↔ Python MT5 bridge running Algo1 strategy · local-only via Python', url: null },

  // ─────────────── Fyers (local only) ───────────────
  { group: 'Fyers', name: 'FyersAlgo1', title: 'Fyers Strategy v1', desc: 'NSE/MCX intraday strategy via Fyers API · local-only', url: null },
];

const GROUP_ORDER = ['Tickmill', 'Strategy', 'MT5', 'Fyers', 'Robinhood'];
const GROUP_META  = {
  Tickmill:  { icon: '📈', color: '#f0883e', tagline: 'CFD forex broker — UK MiFID II regulated' },
  Strategy:  { icon: '🧠', color: '#58a6ff', tagline: 'Generic strategy services (crypto · paper/Kraken)' },
  MT5:       { icon: '📊', color: '#bc8cff', tagline: 'MetaTrader 5 — MetaAPI / Python bridge' },
  Fyers:     { icon: '🇮🇳', color: '#39d353', tagline: 'Fyers — Indian NSE/MCX broker' },
  Robinhood: { icon: '🦅', color: '#3fb950', tagline: 'Robinhood Crypto — US retail broker' },
};

// ── Express ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

app.get('/health', (_, res) => res.json({
  status: 'ok',
  service: 'cbt-trading-home',
  algos: ALGOS.length,
  deployed: ALGOS.filter(a => a.url).length,
}));

app.get('/api/algos', (_, res) => res.json({
  groups: GROUP_ORDER,
  groupMeta: GROUP_META,
  algos: ALGOS,
}));

// Server-side health probe for any URL (so the UI can show live/down dots without CORS pain).
function probe(url) {
  return new Promise(resolve => {
    if (!url) return resolve({ ok: false, status: 0, note: 'local-only' });
    let done = false;
    const finish = obj => { if (!done) { done = true; resolve(obj); } };
    const start = Date.now();
    try {
      const u = new URL('/health', url);
      const req = https.request({
        hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'GET',
        headers: { 'User-Agent': 'cbt-trading-home/health-probe' },
        timeout: 8000,
      }, r => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => finish({
          ok:  r.statusCode === 200,
          status: r.statusCode,
          ms:   Date.now() - start,
          body: body.slice(0, 200),
        }));
      });
      req.on('timeout', () => { req.destroy(); finish({ ok: false, status: 0, note: 'timeout' }); });
      req.on('error',   e => finish({ ok: false, status: 0, note: e.message }));
      req.end();
    } catch (e) { finish({ ok: false, status: 0, note: e.message }); }
  });
}

app.get('/api/check', async (_, res) => {
  const results = await Promise.all(
    ALGOS.map(async a => ({ name: a.name, group: a.group, url: a.url, probe: await probe(a.url) }))
  );
  res.json({ results, ts: new Date().toISOString() });
});

app.listen(PORT, () =>
  console.log(`CBT TradingHome listening on :${PORT} | ${ALGOS.length} algos registered, ${ALGOS.filter(a => a.url).length} on Railway`)
);
