'use strict';

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    console.log('WS connected');
    clearTimeout(reconnectTimer);
  };

  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      renderState(data);
    } catch (e) {
      console.error('WS parse error', e);
    }
  };

  ws.onclose = () => {
    reconnectTimer = setTimeout(connectWS, 3000);
  };
  ws.onerror = () => ws.close();
}

connectWS();

// ── Timeframe badge in header ─────────────────────────────────────────────────
function updateTfBadge(interval) {
  const map = { 1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1h' };
  const el = document.getElementById('tfBadge');
  if (el) el.textContent = map[interval] || (interval + 'm');
}

// ── Clock (IST) ───────────────────────────────────────────────────────────────
function updateClock() {
  const el = document.getElementById('clockEl');
  if (!el) return;
  const ist = new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  el.textContent = `IST ${ist}`;
}
setInterval(updateClock, 1000);
updateClock();

// ── Render ────────────────────────────────────────────────────────────────────
function renderState(s) {
  const dot   = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  if (dot)   { dot.className   = `status-dot ${s.status}`; }
  if (label) { label.textContent = s.status || 'idle'; }

  setBadge('brokerBadge', s.broker || 'dhan', 'badge-blue');
  setBadge('modeBadge', s.mode || 'live', 'badge-red');

  // Account strip (INR)
  setText('acctEquity', s.equity != null ? 'Rs' + fmtINR(s.equity) : '—');
  const pnlEl = document.getElementById('acctPnl');
  if (pnlEl) {
    const pnl = s.session_pnl || 0;
    pnlEl.textContent = (pnl >= 0 ? '+Rs' : '-Rs') + fmtINR(Math.abs(pnl));
    pnlEl.className = 'acct-val pnl ' + (pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '');
  }
  const trades = s.total_trades || 0;
  const wins   = s.wins || 0;
  setText('acctWR',     trades > 0 ? (wins / trades * 100).toFixed(1) + '%' : '—');
  setText('acctTrades', trades);

  // Portfolio risk bar
  const riskPct = s.portfolio_risk_pct || 0;
  setText('acctRisk', riskPct.toFixed(1) + '%');
  const bar = document.getElementById('riskBar');
  if (bar) {
    const pct = Math.min(100, riskPct / 6 * 100);
    bar.style.width = pct + '%';
    bar.className = 'risk-bar' + (riskPct > 5 ? ' crit' : riskPct > 3.5 ? ' warn' : '');
  }

  // EOD phase
  const eodEl = document.getElementById('acctEOD');
  if (eodEl) {
    eodEl.textContent = s.eod_phase || '—';
    eodEl.style.color = s.eod_phase === 'closing' ? 'var(--amber)' :
                        s.eod_phase === 'fallback' ? 'var(--red)' : '';
  }

  renderPositions(s.positions || {});
  renderScreener(s.screener || []);
  renderLog(s.log || []);

  // Timeframe badge from running state
  if (s.candle_interval) updateTfBadge(s.candle_interval);

  const running = s.status === 'running' || s.status === 'screening' || s.status === 'loading';
  setDisabled('btnStart',    running);
  setDisabled('btnStop',     !running);
  setDisabled('btnCloseAll', s.status !== 'running');
  const tfSel = document.getElementById('tfSelect');
  if (tfSel) tfSel.disabled = running;
}

// ── Positions table ───────────────────────────────────────────────────────────
function renderPositions(positions) {
  const wrap  = document.getElementById('posTable');
  const count = document.getElementById('posCount');
  const sids  = Object.keys(positions);
  if (count) count.textContent = sids.length;

  if (!sids.length) {
    wrap.innerHTML = '<div class="empty-msg">No open positions</div>';
    return;
  }

  const rows = sids.map(sid => {
    const p = positions[sid];
    const pnl   = p.unrealized_pnl || 0;
    const phase = p.phase || 1;
    const phaseCls = phase >= 4 ? 'p4' : phase >= 3 ? 'p3' : phase >= 2 ? 'p2' : '';
    const pnlCls = pnl > 0.01 ? 'pnl-pos' : pnl < -0.01 ? 'pnl-neg' : 'pnl-zero';
    const pnlStr = (pnl >= 0 ? '+Rs' : '-Rs') + fmtINR(Math.abs(pnl));
    const risk   = p.open_risk_inr || 0;
    const sym    = p.symbol || sid;

    return `<tr>
      <td><strong>${esc(sym)}</strong></td>
      <td><span class="side-badge ${p.side}">${p.side.toUpperCase()}</span></td>
      <td>${p.qty || 0}</td>
      <td>Rs${fmtINR(p.entry_price || 0)}</td>
      <td>Rs${fmtINR(p.stop_loss || 0)}</td>
      <td class="${pnlCls}">${pnlStr}</td>
      <td>Rs${fmtINR(risk)}</td>
      <td><span class="phase-badge ${phaseCls}">P${phase}</span></td>
      <td>${p.candles_held || 0}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <table class="pos-table">
      <thead><tr>
        <th>Symbol</th><th>Side</th><th>Qty</th>
        <th>Entry</th><th>Stop</th>
        <th>P&amp;L</th><th>Risk Rs</th><th>Phase</th><th>Bars</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Screener list ─────────────────────────────────────────────────────────────
function renderScreener(items) {
  const el = document.getElementById('screenerList');
  if (!items.length) {
    el.innerHTML = '<div class="empty-msg">Run engine to populate screener</div>';
    return;
  }
  el.innerHTML = items.map((c, i) => {
    const gapCls = (c.gap_pct || 0) >= 0 ? 'pos' : 'neg';
    const gapStr = ((c.gap_pct || 0) >= 0 ? '+' : '') + (c.gap_pct || 0).toFixed(2) + '%';
    return `<div class="screener-row">
      <span class="screener-rank">${i + 1}</span>
      <span class="screener-sym">${esc(c.symbol || c.security_id)}</span>
      <span class="screener-rvol">${(c.rvol || 0).toFixed(1)}x</span>
      <span class="screener-gap ${gapCls}">${gapStr}</span>
      <span class="screener-atr">${(c.atr_pct || 0).toFixed(2)}%</span>
    </div>`;
  }).join('');
}

// ── Log feed ──────────────────────────────────────────────────────────────────
const _seenLogs = new Set();

function renderLog(entries) {
  const feed = document.getElementById('logFeed');
  const autoScroll = document.getElementById('autoScrollChk')?.checked;
  let added = false;

  for (const e of entries) {
    const key = e.ts + e.msg;
    if (_seenLogs.has(key)) continue;
    _seenLogs.add(key);
    if (_seenLogs.size > 1000) {
      const it = _seenLogs.values();
      _seenLogs.delete(it.next().value);
    }

    const level = e.level || 'INFO';
    const msgCls = e.msg && e.msg.includes('ENTERED') ? 'ENTRY'
                 : e.msg && e.msg.includes('CLOSED')  ? 'EXIT'
                 : level;

    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `<span class="log-ts">${esc(e.ts)}</span><span class="log-msg ${msgCls}">${esc(e.msg)}</span>`;
    feed.appendChild(div);
    added = true;
  }

  if (added && autoScroll) {
    feed.scrollTop = feed.scrollHeight;
  }
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function apiStart() {
  const tf = parseInt(document.getElementById('tfSelect')?.value || '5');
  updateTfBadge(tf);
  try {
    const r = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candle_interval: tf }),
    });
    const d = await r.json();
    if (d.error) alert('Start error: ' + d.error);
  } catch (e) { alert('Network error: ' + e.message); }
}

async function promptUpdateToken() {
  const token = prompt('Paste new Dhan access token (from dhanhq.co -> API Access):');
  if (!token || !token.trim()) return;
  try {
    const r = await fetch('/api/update_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.trim() }),
    });
    const d = await r.json();
    if (d.error) { alert('Token error: ' + d.error); return; }
    alert('Token updated. Stop and restart the engine to apply the new token.');
  } catch (e) { alert('Network error: ' + e.message); }
}

async function apiStop() {
  await fetch('/api/stop', { method: 'POST' });
}

async function apiCloseAll() {
  if (!confirm('Close all open positions now?')) return;
  await fetch('/api/close_all', { method: 'POST' });
}

async function reloadScreener() {
  const r = await fetch('/api/state');
  const d = await r.json();
  renderScreener(d.screener || []);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtINR(v) {
  return Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(s)   { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function setDisabled(id, dis) { const el = document.getElementById(id); if (el) el.disabled = dis; }
function setBadge(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'badge ' + cls;
}
