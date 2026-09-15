/* NSE ORB Scanner — dashboard JS */
'use strict';

const API = '';   // same origin
let activeSlot = '09:30';
let pollTimer  = null;
let isScanning = false;

// ── IST Clock ────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const ist = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(now);
  document.getElementById('istClock').textContent = ist;
}
setInterval(updateClock, 1000);
updateClock();

// ── Trigger scan ─────────────────────────────────────────────────────────────
async function triggerScan() {
  if (isScanning) return;
  isScanning = true;

  const params = {
    MIN_PRICE:        parseFloat(document.getElementById('minPrice').value)        || 50,
    MIN_ADTV_CR:      parseFloat(document.getElementById('minAdtv').value)         || 10,
    TOP_N:            parseInt(document.getElementById('topN').value)               || 5,
    MAX_INSTRUMENTS:  parseInt(document.getElementById('maxInstruments').value)     || 50,
    scan_time:        document.getElementById('scanTime').value                     || '09:30',
    force_refresh:    document.getElementById('forceRefresh').checked,
  };

  // Select the tab matching the chosen scan time
  document.querySelectorAll('.tab').forEach(t => {
    if (t.dataset.slot === params.scan_time) t.click();
  });

  setStatus('loading');
  showProgress(5, 'Starting…');
  clearLog();
  clearResults();

  try {
    const res = await fetch(`${API}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    startPolling();
  } catch (e) {
    setStatus('error');
    appendLog(`ERROR: ${e.message}`, true);
    hideProgress();
    isScanning = false;
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 800);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function poll() {
  try {
    const [statusRes, resultsRes] = await Promise.all([
      fetch(`${API}/api/status`),
      fetch(`${API}/api/results`),
    ]);
    const status  = await statusRes.json();
    const results = await resultsRes.json();

    updateStatus(status);
    updateResults(results);

    if (status.status === 'done' || status.status === 'error') {
      stopPolling();
      isScanning = false;
      hideProgress();
      enableBtn();
    }
  } catch (e) {
    console.error('Poll error', e);
  }
}

// ── Clear cache ───────────────────────────────────────────────────────────────
async function clearCache() {
  if (isScanning) return;
  const btn = document.getElementById('clearBtn');
  btn.disabled = true;
  btn.textContent = 'Clearing...';
  try {
    const res = await fetch(`${API}/api/clear-cache`, { method: 'POST' });
    const body = await res.json();
    appendLog(body.message || body.error || 'Cache cleared');
    document.getElementById('cacheCount').textContent = '0';
    // Immediately trigger a fresh scan
    await triggerScan();
  } catch (e) {
    appendLog(`Clear cache error: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '↺ Clear Cache & Rescan';
  }
}

// ── Status & log ──────────────────────────────────────────────────────────────
function updateStatus(data) {
  setStatus(data.status);
  showProgress(data.progress || 0, statusLabel(data.status));

  if (data.last_scan_at) document.getElementById('lastScanAt').textContent = data.last_scan_at;
  if (data.universe_size) document.getElementById('universeSize').textContent = data.universe_size.toLocaleString();

  const dsEl = document.getElementById('dataSource');
  if (dsEl && data.data_source) {
    dsEl.textContent = data.data_source;
    dsEl.style.color = data.data_source === 'Dhan' ? 'var(--green)' : 'var(--amber)';
  }

  if (data.log && data.log.length) {
    const logBox = document.getElementById('logBox');
    const entries = data.log.slice(-30);
    logBox.innerHTML = entries.map(e =>
      `<div class="log-entry${e.msg.startsWith('ERROR') ? ' err' : ''}">` +
      `<span class="ts">${e.ts}</span>${escHtml(e.msg)}</div>`
    ).join('');
    logBox.scrollTop = logBox.scrollHeight;
  }
}

function setStatus(s) {
  const chip = document.getElementById('statusChip');
  chip.textContent = s.toUpperCase();
  chip.className   = `status-chip ${s}`;
  const btn = document.getElementById('scanBtn');
  btn.disabled = ['loading','caching','computing','scanning'].includes(s);
}

function statusLabel(s) {
  return { loading:'Loading master…', caching:'Caching OHLCV…',
           computing:'Computing features…', scanning:'Running scan…',
           done:'Complete', error:'Error', idle:'—' }[s] || s;
}

function clearLog() { document.getElementById('logBox').innerHTML = ''; }
function enableBtn() { document.getElementById('scanBtn').disabled = false; }

function appendLog(msg, isErr = false) {
  const logBox = document.getElementById('logBox');
  const ts = new Intl.DateTimeFormat('en-IN', {
    timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  }).format(new Date());
  logBox.insertAdjacentHTML('beforeend',
    `<div class="log-entry${isErr?' err':''}"><span class="ts">${ts}</span>${escHtml(msg)}</div>`);
  logBox.scrollTop = logBox.scrollHeight;
}

// ── Progress ──────────────────────────────────────────────────────────────────
function showProgress(pct, label) {
  document.getElementById('progressWrap').style.display = 'block';
  document.getElementById('progressBar').style.width    = `${Math.min(pct, 100)}%`;
  document.getElementById('progressLabel').textContent  = label || '';
}

function hideProgress() {
  document.getElementById('progressWrap').style.display = 'none';
}

// ── Results rendering ─────────────────────────────────────────────────────────
function updateResults(allResults) {
  const data = allResults[activeSlot];
  if (!data) return;

  const regime = data.regime || 'NEUTRAL';
  document.getElementById('regimeBadge').textContent = regime;
  styleRegime(regime);

  const note = data.note;
  const infoBar = document.getElementById('infoBar');
  if (note) {
    infoBar.style.display = 'block';
    document.getElementById('infoNote').textContent = note;
  } else {
    infoBar.style.display = 'none';
  }

  renderSide('longCol',  'longEmpty',  data.LONG  || [], 'long',  data.confirmed, data.failed);
  renderSide('shortCol', 'shortEmpty', data.SHORT || [], 'short', data.confirmed, data.failed);
}

function renderSide(colId, emptyId, stocks, dir, confirmed = [], failed = []) {
  const col   = document.getElementById(colId);
  const empty = document.getElementById(emptyId);

  if (!stocks.length) {
    empty.style.display = '';
    // Remove old cards
    col.querySelectorAll('.card').forEach(c => c.remove());
    return;
  }
  empty.style.display = 'none';

  const existing = {};
  col.querySelectorAll('.card').forEach(c => { existing[c.dataset.sid] = c; });
  const seen = new Set();

  stocks.forEach((s, rank) => {
    seen.add(s.security_id);
    const isConfirmed = confirmed.includes(s.symbol);
    const isFailed    = failed.includes(s.symbol);
    const card = existing[s.security_id] || createCard(s, dir, rank, isConfirmed, isFailed);

    if (existing[s.security_id]) {
      updateCard(card, s, dir, rank, isConfirmed, isFailed);
    } else {
      col.appendChild(card);
    }
  });

  // Remove cards no longer in results
  Object.keys(existing).forEach(sid => {
    if (!seen.has(sid)) existing[sid].remove();
  });
}

function createCard(s, dir, rank, confirmed, failed) {
  const card = document.createElement('div');
  card.className = `card ${dir}${confirmed?' confirmed':''}${failed?' failed':''}`;
  card.dataset.sid = s.security_id;
  card.innerHTML = cardHTML(s, dir, rank, confirmed, failed);
  return card;
}

function updateCard(card, s, dir, rank, confirmed, failed) {
  card.className = `card ${dir}${confirmed?' confirmed':''}${failed?' failed':''}`;
  card.innerHTML = cardHTML(s, dir, rank, confirmed, failed);
}

function cardHTML(s, dir, rank, confirmed, failed) {
  const score    = typeof s.score === 'number' ? s.score.toFixed(1) : '—';
  const fbRisk   = typeof s.fb_risk === 'number' ? s.fb_risk : 50;
  const fbColor  = fbRisk < 35 ? '#1eca7a' : fbRisk < 65 ? '#f5a623' : '#e8404a';
  const ltp      = fmt(s.ltp);
  const entry    = fmt(s.entry);
  const sl       = fmt(s.stop_loss);
  const t1r      = fmt(s.target_1r);
  const t2r      = fmt(s.target_2r);
  const relVol   = s.rel_volume != null ? `${s.rel_volume.toFixed(2)}×` : '—';
  const dayMove  = s.day_move_pct != null ? pctStr(s.day_move_pct) : '—';
  const rs       = s.rs_nifty    != null ? pctStr(s.rs_nifty)      : '—';
  const vwap     = s.vwap        != null ? fmt(s.vwap)              : '—';

  const badge = confirmed ? '<span class="signal-badge confirmed">▲ CONFIRMED</span>'
              : failed    ? '<span class="signal-badge failed">▼ FAILED</span>'
              : '';

  const reasons = (s.reasons || []).map(r => {
    const isWarn = r.startsWith('⚠') || r.toLowerCase().includes('unvalidated');
    return `<div class="reason-item${isWarn?' warn':''}">${escHtml(r)}</div>`;
  }).join('');

  return `
    <div class="card-header">
      <div>
        <div class="card-sym">#${rank+1} ${escHtml(s.symbol || s.security_id)}${badge}</div>
        <div class="card-company">${escHtml(s.company || s.security_id)}</div>
      </div>
      <div class="card-scores">
        <div class="score-main">${score}</div>
        <div class="score-fb">
          <span class="fb-dot" style="background:${fbColor}"></span>
          Risk ${fbRisk.toFixed(0)}
        </div>
      </div>
    </div>
    <div class="score-bar-wrap"><div class="score-bar" style="width:${Math.min(s.score||0,100)}%"></div></div>
    <div class="price-grid">
      <div class="price-cell entry"><div class="plabel">Entry</div><div class="pval">${entry}</div></div>
      <div class="price-cell sl">   <div class="plabel">Stop</div> <div class="pval">${sl}</div></div>
      <div class="price-cell t1r">  <div class="plabel">1R</div>   <div class="pval">${t1r}</div></div>
      <div class="price-cell t2r">  <div class="plabel">2R</div>   <div class="pval">${t2r}</div></div>
    </div>
    <div class="card-stats">
      <span class="stat-chip">LTP <span class="chip-val">${ltp}</span></span>
      <span class="stat-chip ${signClass(s.day_move_pct)}">Day <span class="chip-val">${dayMove}</span></span>
      <span class="stat-chip ${signClass(s.rs_nifty)}">RS <span class="chip-val">${rs}</span></span>
      <span class="stat-chip">RVOL <span class="chip-val">${relVol}</span></span>
      <span class="stat-chip">VWAP <span class="chip-val">${vwap}</span></span>
    </div>
    ${reasons ? `
    <div class="card-reasons">
      <button class="reasons-toggle" onclick="toggleReasons(this)">▸ Reasons</button>
      <div class="reasons-list" style="display:none">${reasons}</div>
    </div>` : ''}
  `;
}

function toggleReasons(btn) {
  const list = btn.nextElementSibling;
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'flex';
  btn.textContent = open ? '▸ Reasons' : '▾ Reasons';
}

function clearResults() {
  ['longCol','shortCol'].forEach(id => {
    const col = document.getElementById(id);
    col.querySelectorAll('.card').forEach(c => c.remove());
  });
  document.getElementById('longEmpty').style.display  = '';
  document.getElementById('shortEmpty').style.display = '';
  document.getElementById('infoBar').style.display    = 'none';
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function selectTab(btn, slot) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  activeSlot = slot;

  // Re-render with cached results
  fetch(`${API}/api/results`).then(r => r.json()).then(updateResults).catch(() => {});
}

// ── Regime styling ────────────────────────────────────────────────────────────
function styleRegime(regime) {
  const badge = document.getElementById('regimeBadge');
  const map = {
    STRONG_BULL: '#1eca7a', BULL: '#1eca7a',
    NEUTRAL: '#5a6480',
    BEAR: '#e8404a', STRONG_BEAR: '#e8404a',
  };
  badge.textContent = regime.replace('_', ' ');
  badge.style.color       = map[regime] || '#5a6480';
  badge.style.borderColor = map[regime] || '#252a3a';
}

// ── Weights panel ─────────────────────────────────────────────────────────────
async function loadWeights() {
  try {
    const res = await fetch(`${API}/api/config`);
    const cfg = await res.json();
    const w = cfg.weights || {};
    const total = cfg.total_weight || 100;
    const el = document.getElementById('weightsTable');
    el.innerHTML = Object.entries(w).map(([name, val]) => `
      <div class="weight-row">
        <span class="weight-name">${escHtml(name)}</span>
        <div class="weight-bar-wrap"><div class="weight-bar" style="width:${val/total*100}%"></div></div>
        <span class="weight-num">${val}</span>
      </div>
    `).join('');
  } catch(e) { console.warn('Could not load weights', e); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(v) {
  if (v == null) return '—';
  return parseFloat(v).toFixed(2);
}

function pctStr(v) {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${parseFloat(v).toFixed(2)}%`;
}

function signClass(v) {
  if (v == null) return '';
  return v >= 0 ? 'positive' : 'negative';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  await loadWeights();

  // Load current status
  try {
    const res = await fetch(`${API}/api/status`);
    const s   = await res.json();
    updateStatus(s);
    document.getElementById('universeSize').textContent =
      s.universe_size ? s.universe_size.toLocaleString() : '—';
    if (['loading','caching','computing','scanning'].includes(s.status)) {
      isScanning = true;
      startPolling();
    }
  } catch(e) {}

  // Load any existing results
  try {
    const res = await fetch(`${API}/api/results`);
    const r   = await res.json();
    if (Object.keys(r).length) updateResults(r);
  } catch(e) {}
})();
