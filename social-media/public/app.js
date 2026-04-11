/* ══════════════════════════════════════════════════════════════════
   BACKEND URL
══════════════════════════════════════════════════════════════════ */
const BACKEND = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? ''
  : 'https://social-media-uploader-production.up.railway.app';

/* ══════════════════════════════════════════════════════════════════
   STARS
══════════════════════════════════════════════════════════════════ */
(function createStars() {
  const container = document.getElementById('stars');
  for (let i = 0; i < 120; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    const size = Math.random() * 2.5 + 0.5;
    s.style.cssText = `width:${size}px;height:${size}px;top:${Math.random()*100}%;left:${Math.random()*100}%;
      --d:${2+Math.random()*4}s;--delay:${Math.random()*4}s`;
    container.appendChild(s);
  }
})();

/* ══════════════════════════════════════════════════════════════════
   CREDENTIAL STORE (localStorage — persists across sessions)
══════════════════════════════════════════════════════════════════ */
const STORE = 'sm_v6';
const load  = () => { try { return JSON.parse(localStorage.getItem(STORE)||'{}'); } catch { return {}; } };
const save  = o  => localStorage.setItem(STORE, JSON.stringify({ ...load(), ...o }));

/* ══════════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════════ */
let selectedFile     = null;
let selectedNiche    = 'General';
let generatedContent = null;

/* ══════════════════════════════════════════════════════════════════
   RESTORE SAVED CREDS ON PAGE LOAD
══════════════════════════════════════════════════════════════════ */
(function restore() {
  const c = load();
  const f = (id, v) => { const el=document.getElementById(id); if(el&&v) el.value=v; };
  f('aiApiKey',      c.aiApiKey);
  f('ollamaUrl',     c.ollamaUrl);
  f('ytClientId',    c.ytClientId);
  f('ytClientSecret',c.ytClientSecret);
  f('ytRefreshToken',c.ytRefreshToken);
  f('igToken',       c.igToken);
  f('igUserId',      c.igUserId);
  f('fbToken',       c.fbToken);
  f('fbPageId',      c.fbPageId);
  f('ttToken',       c.ttToken);
  f('ttOpenId',      c.ttOpenId);
  f('ttClientKey',   c.ttClientKey);
  f('ttClientSecret',c.ttClientSecret);
  f('twApiKey',      c.twApiKey);
  f('twApiSecret',   c.twApiSecret);
  f('twToken',       c.twToken);
  f('twTokenSecret', c.twTokenSecret);
  f('liToken',       c.liToken);
  f('liUrn',         c.liUrn);
  f('liClientId',    c.liClientId);
  f('liClientSecret',c.liClientSecret);
  if (c.aiProvider) {
    const r = document.querySelector(`input[name="ai"][value="${c.aiProvider}"]`);
    if (r) { r.checked = true; updateAIUI(); }
  }
  if (c.niche) setNiche(c.niche);
})();

/* Auto-save credentials whenever they change */
[['aiApiKey','aiApiKey'],['ytClientId','ytClientId'],['ytClientSecret','ytClientSecret'],
 ['ytRefreshToken','ytRefreshToken'],['igToken','igToken'],['igUserId','igUserId'],
 ['fbToken','fbToken'],['fbPageId','fbPageId'],['ttToken','ttToken'],['ttOpenId','ttOpenId'],
 ['ttClientKey','ttClientKey'],['ttClientSecret','ttClientSecret'],['twApiKey','twApiKey'],
 ['twApiSecret','twApiSecret'],['twToken','twToken'],['twTokenSecret','twTokenSecret'],
 ['liToken','liToken'],['liUrn','liUrn'],['liClientId','liClientId'],['liClientSecret','liClientSecret']
].forEach(([key,id]) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', e => save({ [key]: e.target.value }));
});

/* ══════════════════════════════════════════════════════════════════
   ?video= PARAM (from my-video integration)
══════════════════════════════════════════════════════════════════ */
(function checkParams() {
  const p = new URLSearchParams(location.search);
  const videoUrl = p.get('video');
  const topic    = p.get('topic') || '';
  if (!videoUrl) return;

  window.__remoteVideoUrl   = decodeURIComponent(videoUrl);
  window.__remoteVideoTitle = decodeURIComponent(topic)
    || window.__remoteVideoUrl.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');

  const fname = window.__remoteVideoUrl.split('/').pop().split('?')[0] || 'video.mp4';
  document.getElementById('fileName').textContent = fname;
  document.getElementById('fileSize').textContent = '(from Quiz Generator)';
  document.getElementById('fileInfo').style.display  = 'flex';
  document.getElementById('dropZone').style.display  = 'none';
  if (window.__remoteVideoTitle)
    document.getElementById('manualTitle').value = window.__remoteVideoTitle;

  const c = load();
  if (c.aiApiKey || getProvider() === 'ollama') setTimeout(triggerGenerate, 600);
  else showKeyWarning();
})();

/* ══════════════════════════════════════════════════════════════════
   FILE DROP / SELECT
══════════════════════════════════════════════════════════════════ */
const dropZone  = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

['dragenter','dragover'].forEach(e => dropZone.addEventListener(e, ev => { ev.preventDefault(); dropZone.classList.add('drag-over'); }));
['dragleave','drop'].forEach(e     => dropZone.addEventListener(e, ev => { ev.preventDefault(); dropZone.classList.remove('drag-over'); }));
dropZone.addEventListener('drop', ev => { const f=ev.dataTransfer.files[0]; if(f) setFile(f); });
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if(fileInput.files[0]) setFile(fileInput.files[0]); });
document.getElementById('removeFile').addEventListener('click', () => {
  selectedFile = null; fileInput.value = ''; window.__remoteVideoUrl = null;
  document.getElementById('fileInfo').style.display = 'none';
  document.getElementById('dropZone').style.display = '';
  document.getElementById('keyWarning').classList.remove('show');
});

function setFile(file) {
  selectedFile = file;
  window.__remoteVideoUrl = null;
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = fmtBytes(file.size);
  document.getElementById('fileInfo').style.display = 'flex';
  document.getElementById('dropZone').style.display = 'none';
  const titleEl = document.getElementById('manualTitle');
  if (!titleEl.value.trim())
    titleEl.value = file.name.replace(/\.[^.]+$/,'').replace(/[-_]+/g,' ');
  const key = document.getElementById('aiApiKey').value.trim();
  if (key || getProvider() === 'ollama') triggerGenerate();
  else showKeyWarning();
}

function showKeyWarning() {
  document.getElementById('keyWarning').classList.add('show');
  document.getElementById('aiApiKey').focus();
}

function fmtBytes(b) {
  if (b < 1024) return b+' B';
  if (b < 1024**2) return (b/1024).toFixed(1)+' KB';
  if (b < 1024**3) return (b/1024**2).toFixed(1)+' MB';
  return (b/1024**3).toFixed(2)+' GB';
}

/* ══════════════════════════════════════════════════════════════════
   NICHE CHIPS
══════════════════════════════════════════════════════════════════ */
document.getElementById('nicheChips').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn'); if (!btn) return;
  document.querySelectorAll('#nicheChips .tab-btn').forEach(b=>b.classList.remove('selected'));
  btn.classList.add('selected');
  selectedNiche = btn.dataset.niche;
  save({ niche: selectedNiche });
});
function setNiche(n) {
  selectedNiche = n;
  document.querySelectorAll('#nicheChips .tab-btn').forEach(b=>b.classList.toggle('selected', b.dataset.niche===n));
}

/* ══════════════════════════════════════════════════════════════════
   AI PROVIDER UI
══════════════════════════════════════════════════════════════════ */
const providerMeta = {
  groq:   { label:'GROQ API KEY',         link:'https://console.groq.com',               lt:'Get free at console.groq.com' },
  gemini: { label:'GEMINI API KEY',        link:'https://aistudio.google.com/app/apikey', lt:'Get free at Google AI Studio' },
  hf:     { label:'HUGGINGFACE TOKEN',     link:'https://huggingface.co/settings/tokens', lt:'Get free at huggingface.co' },
  ollama: { label:'OLLAMA (no key needed)',link:'https://ollama.ai',                       lt:'Install Ollama locally' },
};
document.querySelectorAll('input[name="ai"]').forEach(r => {
  r.addEventListener('change', () => { updateAIUI(); save({ aiProvider: getProvider() }); });
});
document.getElementById('aiApiKey').addEventListener('input', () => {
  const key = document.getElementById('aiApiKey').value.trim();
  if (key.length > 10) {
    document.getElementById('keyWarning').classList.remove('show');
    if (selectedFile || window.__remoteVideoUrl) triggerGenerate();
  }
});
updateAIUI();

function updateAIUI() {
  const p = getProvider(), m = providerMeta[p];
  document.getElementById('aiKeyLabel').innerHTML = `${m.label} — <a class="key-link" href="${m.link}" target="_blank">${m.lt} ↗</a>`;
  document.getElementById('aiKeyRow').style.display   = p==='ollama' ? 'none' : '';
  document.getElementById('ollamaRow').style.display  = p==='ollama' ? '' : 'none';
  document.querySelectorAll('.provider-card').forEach(c=>c.classList.toggle('selected', c.dataset.p===p));
}
function getProvider() { return document.querySelector('input[name="ai"]:checked')?.value || 'groq'; }

/* ══════════════════════════════════════════════════════════════════
   CHARACTER COUNT
══════════════════════════════════════════════════════════════════ */
window.updateCount = function(inputId, countId, max) {
  const len = document.getElementById(inputId)?.value.length || 0;
  const el = document.getElementById(countId); if (!el) return;
  el.textContent = `${len}/${max}`;
  el.style.color = len > max * 0.9 ? '#f59e0b' : '';
};

/* ══════════════════════════════════════════════════════════════════
   CONTENT TABS
══════════════════════════════════════════════════════════════════ */
window.switchTab = function(tab) {
  document.querySelectorAll('#contentTabs .tab-btn').forEach(b=>b.classList.toggle('selected', b.dataset.tab===tab));
  document.querySelectorAll('.tab-content').forEach(t=>t.style.display='none');
  document.getElementById('tab-'+tab).style.display = '';
};

/* ══════════════════════════════════════════════════════════════════
   AI GENERATION
══════════════════════════════════════════════════════════════════ */
let genDebounce = null;
function triggerGenerate() {
  clearTimeout(genDebounce);
  genDebounce = setTimeout(async () => {
    const provider  = getProvider();
    const apiKey    = document.getElementById('aiApiKey').value.trim();
    const ollamaUrl = document.getElementById('ollamaUrl').value.trim();
    if (provider !== 'ollama' && !apiKey) { showKeyWarning(); return; }

    const title = document.getElementById('manualTitle').value.trim()
      || window.__remoteVideoTitle
      || (selectedFile ? selectedFile.name.replace(/\.[^.]+$/,'').replace(/[-_]+/g,' ') : null);
    if (!title) { alert('Enter a video title in Step 02 first.'); return; }

    const regenBtn = document.getElementById('regenBtn');
    regenBtn.disabled = true; regenBtn.textContent = '⏳ Generating…';
    document.getElementById('keyWarning').classList.remove('show');
    document.getElementById('genLoading').style.display = 'flex';
    document.getElementById('genLoadingText').textContent = 'Generating platform-specific content…';
    document.getElementById('contentSection').style.display = 'none';

    try {
      const res = await fetch(BACKEND + '/api/generate', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ videoTitle:title, niche:selectedNiche, provider, apiKey, ollamaUrl }),
      });
      let data;
      try { data = await res.json(); }
      catch { throw new Error(`Server error (HTTP ${res.status}). Check your API key.`); }
      if (!res.ok) throw new Error(data.error || `AI error (HTTP ${res.status})`);
      generatedContent = data;
      fillContent(data);
    } catch(err) {
      document.getElementById('genLoadingText').textContent = '⚠ ' + err.message;
      regenBtn.disabled = false;
      regenBtn.textContent = generatedContent ? '↺ Regenerate' : '✨ Generate AI Content';
    }
  }, 400);
}

function fillContent(d) {
  document.getElementById('genLoading').style.display = 'none';
  document.getElementById('contentSection').style.display = '';
  const regenBtn = document.getElementById('regenBtn');
  regenBtn.disabled = false; regenBtn.textContent = '↺ Regenerate';

  if (d.youtube)   { document.getElementById('ytGenTitle').value = d.youtube.title||''; document.getElementById('ytGenDesc').value = d.youtube.description||''; document.getElementById('ytGenTags').value = Array.isArray(d.youtube.tags)?d.youtube.tags.join(', '):(d.youtube.tags||''); updateCount('ytGenTitle','yt-title-count',100); }
  if (d.instagram) { document.getElementById('igGenCaption').value = d.instagram.caption||''; updateCount('igGenCaption','ig-cap-count',2200); }
  if (d.facebook)  { document.getElementById('fbGenTitle').value = d.facebook.title||''; document.getElementById('fbGenDesc').value = d.facebook.description||''; }
  if (d.tiktok)    { document.getElementById('ttGenTitle').value = d.tiktok.title||''; updateCount('ttGenTitle','tt-title-count',150); }
  if (d.twitter)   { document.getElementById('twGenTweet').value = d.twitter.tweet||''; updateCount('twGenTweet','tw-tweet-count',280); }
  if (d.linkedin)  { document.getElementById('liGenPost').value = d.linkedin.post||''; updateCount('liGenPost','li-post-count',3000); }

  switchTab('youtube');
  document.getElementById('contentSection').scrollIntoView({ behavior:'smooth', block:'nearest' });
}

document.getElementById('regenBtn').addEventListener('click', () => {
  const provider = getProvider();
  const apiKey   = document.getElementById('aiApiKey').value.trim();
  if (provider !== 'ollama' && !apiKey) { showKeyWarning(); return; }
  triggerGenerate();
});

/* ══════════════════════════════════════════════════════════════════
   PLATFORM TOGGLES — credentials always visible, badge shows ON/OFF
══════════════════════════════════════════════════════════════════ */
window.togglePlatform = function(pfx) {
  const cb = document.getElementById(pfx+'Enabled');
  cb.checked = !cb.checked; onToggle(pfx);
};
window.onToggle = function(pfx) {
  const on     = document.getElementById(pfx+'Enabled').checked;
  const badge  = document.getElementById(pfx+'Badge');
  const card   = document.getElementById('pf-' + pfxToName(pfx));
  const fields = document.getElementById(pfx+'Fields');
  if (fields) fields.style.display = on ? '' : 'none';
  if (badge)  { badge.textContent = on ? 'ON' : 'OFF'; badge.classList.toggle('off', !on); }
  if (card)   { card.classList.toggle('disabled-card', !on); }
};

function pfxToName(pfx) {
  return { yt:'youtube', ig:'instagram', fb:'facebook', tt:'tiktok', tw:'twitter', li:'linkedin' }[pfx] || pfx;
}

/* ══════════════════════════════════════════════════════════════════
   OAUTH HELPERS
══════════════════════════════════════════════════════════════════ */
window.openAuth = function(platform) {
  let path;
  if (platform === 'youtube') {
    const ci = document.getElementById('ytClientId').value.trim();
    const cs = document.getElementById('ytClientSecret').value.trim();
    if (!ci || !cs) { alert('Fill in Client ID and Client Secret first.'); return; }
    path = `/auth/youtube?client_id=${encodeURIComponent(ci)}&client_secret=${encodeURIComponent(cs)}`;
  } else if (platform === 'tiktok') {
    const ck = document.getElementById('ttClientKey').value.trim();
    const cs = document.getElementById('ttClientSecret').value.trim();
    if (!ck || !cs) { alert('Fill in Client Key and Client Secret first.'); return; }
    path = `/auth/tiktok?client_key=${encodeURIComponent(ck)}&client_secret=${encodeURIComponent(cs)}`;
  } else if (platform === 'linkedin') {
    const ci = document.getElementById('liClientId').value.trim();
    const cs = document.getElementById('liClientSecret').value.trim();
    if (!ci || !cs) { alert('Fill in Client ID and Client Secret first.'); return; }
    path = `/auth/linkedin?client_id=${encodeURIComponent(ci)}&client_secret=${encodeURIComponent(cs)}`;
  }
  window.open(BACKEND + path, '_blank', 'width=620,height=720');
};

/* ══════════════════════════════════════════════════════════════════
   UPLOAD
══════════════════════════════════════════════════════════════════ */
document.getElementById('uploadAllBtn').addEventListener('click', async () => {
  if (!_hubUser) { openHubAuth(); return; }
  if (!selectedFile && !window.__remoteVideoUrl) { alert('Select a video in Step 01 first.'); return; }

  const enabled = [];
  if (document.getElementById('ytEnabled').checked) enabled.push('youtube');
  if (document.getElementById('igEnabled').checked) enabled.push('instagram');
  if (document.getElementById('fbEnabled').checked) enabled.push('facebook');
  if (document.getElementById('ttEnabled').checked) enabled.push('tiktok');
  if (document.getElementById('twEnabled').checked) enabled.push('twitter');
  if (document.getElementById('liEnabled').checked) enabled.push('linkedin');
  if (!enabled.length) {
    alert('Toggle at least one platform ON in Step 03 above.');
    document.querySelector('.platform-grid').scrollIntoView({ behavior:'smooth' });
    return;
  }

  document.getElementById('resultsList').innerHTML = '';
  const btn = document.getElementById('uploadAllBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0"></div> Uploading…';

  await Promise.allSettled(enabled.map(p => uploadTo(p)));
  btn.disabled = false; btn.innerHTML = '🚀 Upload to All Enabled Platforms';
});

async function getVideoBlob() {
  if (selectedFile) return selectedFile;
  const r = await fetch(window.__remoteVideoUrl);
  if (!r.ok) throw new Error(`Could not fetch video (HTTP ${r.status})`);
  return await r.blob();
}

async function uploadTo(platform) {
  const id = 'res-'+platform;
  document.getElementById('resultsList').appendChild(makeResultEl(id, platform, 'uploading', 'Uploading…'));

  const ytTitle = document.getElementById('ytGenTitle')?.value || '';
  const ytDesc  = document.getElementById('ytGenDesc')?.value  || '';
  const ytTags  = document.getElementById('ytGenTags')?.value  || '';
  const igCap   = document.getElementById('igGenCaption')?.value || '';
  const fbTitle = document.getElementById('fbGenTitle')?.value || '';
  const fbDesc  = document.getElementById('fbGenDesc')?.value  || '';
  const ttTitle = document.getElementById('ttGenTitle')?.value || '';
  const twTweet = document.getElementById('twGenTweet')?.value || '';
  const liPost  = document.getElementById('liGenPost')?.value  || '';

  const form = new FormData();
  try {
    const blob = await getVideoBlob();
    form.append('video', blob, selectedFile?.name || 'video.mp4');
  } catch(e) { updateResultEl(id,'error',label(platform)+' — Video fetch failed', e.message); return; }

  const missing = [];
  if (platform === 'youtube') {
    if (!document.getElementById('ytClientId').value.trim())    missing.push('Client ID');
    if (!document.getElementById('ytClientSecret').value.trim())missing.push('Client Secret');
    if (!document.getElementById('ytRefreshToken').value.trim())missing.push('Refresh Token');
  }
  if (platform === 'instagram') {
    if (!document.getElementById('igToken').value.trim())  missing.push('Page Access Token');
    if (!document.getElementById('igUserId').value.trim()) missing.push('IG Business Account ID');
  }
  if (platform === 'facebook') {
    if (!document.getElementById('fbToken').value.trim())  missing.push('Page Access Token');
    if (!document.getElementById('fbPageId').value.trim()) missing.push('Page ID');
  }
  if (platform === 'tiktok') {
    if (!document.getElementById('ttToken').value.trim()) missing.push('Access Token');
  }
  if (platform === 'twitter') {
    if (!document.getElementById('twApiKey').value.trim())      missing.push('API Key');
    if (!document.getElementById('twApiSecret').value.trim())   missing.push('API Secret');
    if (!document.getElementById('twToken').value.trim())       missing.push('Access Token');
    if (!document.getElementById('twTokenSecret').value.trim()) missing.push('Token Secret');
  }
  if (platform === 'linkedin') {
    if (!document.getElementById('liToken').value.trim()) missing.push('Access Token');
    if (!document.getElementById('liUrn').value.trim())   missing.push('Person URN');
  }
  if (missing.length) {
    updateResultEl(id, 'error', label(platform)+' — Missing Credentials',
      'Please fill in: ' + missing.join(', ') + ' in Step 03.');
    const card = document.getElementById('pf-'+platform);
    if (card) {
      card.style.boxShadow = '0 0 0 2px rgba(233,69,96,.6)';
      setTimeout(() => card.style.boxShadow='', 4000);
      card.scrollIntoView({ behavior:'smooth', block:'nearest' });
    }
    return;
  }

  let endpoint;
  try {
    if (platform === 'youtube') {
      form.append('clientId',     document.getElementById('ytClientId').value.trim());
      form.append('clientSecret', document.getElementById('ytClientSecret').value.trim());
      form.append('refreshToken', document.getElementById('ytRefreshToken').value.trim());
      form.append('title',        ytTitle);
      form.append('description',  ytDesc);
      form.append('tags',         ytTags);
      form.append('privacyStatus',document.getElementById('ytPrivacy').value);
      endpoint = '/api/upload/youtube';
    }
    if (platform === 'instagram') {
      form.append('pageAccessToken', document.getElementById('igToken').value.trim());
      form.append('igUserId',        document.getElementById('igUserId').value.trim());
      form.append('description',     igCap);
      endpoint = '/api/upload/instagram';
    }
    if (platform === 'facebook') {
      form.append('pageAccessToken', document.getElementById('fbToken').value.trim());
      form.append('pageId',          document.getElementById('fbPageId').value.trim());
      form.append('title',           fbTitle);
      form.append('description',     fbDesc);
      endpoint = '/api/upload/facebook';
    }
    if (platform === 'tiktok') {
      form.append('accessToken',  document.getElementById('ttToken').value.trim());
      form.append('openId',       document.getElementById('ttOpenId').value.trim());
      form.append('title',        ttTitle);
      form.append('privacyLevel', document.getElementById('ttPrivacy').value);
      endpoint = '/api/upload/tiktok';
    }
    if (platform === 'twitter') {
      form.append('apiKey',            document.getElementById('twApiKey').value.trim());
      form.append('apiSecret',         document.getElementById('twApiSecret').value.trim());
      form.append('accessToken',       document.getElementById('twToken').value.trim());
      form.append('accessTokenSecret', document.getElementById('twTokenSecret').value.trim());
      form.append('tweetText',         twTweet);
      endpoint = '/api/upload/twitter';
    }
    if (platform === 'linkedin') {
      form.append('accessToken', document.getElementById('liToken').value.trim());
      form.append('personUrn',   document.getElementById('liUrn').value.trim());
      form.append('title',       ytTitle || ttTitle || 'Video');
      form.append('description', liPost);
      endpoint = '/api/upload/linkedin';
    }

    const res = await fetch(BACKEND + endpoint, { method:'POST', body:form });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
    updateResultEl(id, 'success', label(platform)+' — Uploaded! ✓',
      data.url ? `<a class="rlink" href="${data.url}" target="_blank">${data.url}</a>`
               : (data.publishId || data.postId || 'Published successfully'));
  } catch(err) {
    updateResultEl(id, 'error', label(platform)+' — Failed', err.message);
  }
}

function makeResultEl(id, platform, state, msg) {
  const d = document.createElement('div');
  d.id = id; d.className = 'result-item '+state;
  d.innerHTML = `<div class="rdot"></div><div class="rbody"><div class="rtitle">${label(platform)}</div><div class="rdetail">${msg}</div><div class="pbar"><div class="pfill"></div></div></div>`;
  return d;
}
function updateResultEl(id, state, title, detail) {
  const el = document.getElementById(id); if(!el) return;
  el.className = 'result-item '+state;
  el.querySelector('.rtitle').textContent = title;
  el.querySelector('.rdetail').innerHTML  = detail;
  const pb = el.querySelector('.pbar'); if(pb) pb.remove();
}
const LABELS = { youtube:'YouTube', instagram:'Instagram', facebook:'Facebook', tiktok:'TikTok', twitter:'X / Twitter', linkedin:'LinkedIn' };
function label(p) { return LABELS[p]||p; }

/* ══════════════════════════════════════════════════════════════════
   AI HUB AUTH + CREDITS
══════════════════════════════════════════════════════════════════ */
try { (function() {
  const _SB_URL = 'https://dhdzftmlrkuwcsgmgihe.supabase.co';
  const _SB_KEY = 'sb_publishable_9Ns_telLHzlI-qwxJ_-XbQ_u_9Sab3J';
  const _sb = supabase.createClient(_SB_URL, _SB_KEY);
  window._hubUser = null;

  async function _hubInit() {
    const _hash = new URLSearchParams(window.location.hash.slice(1));
    const _at = _hash.get('access_token'), _rt = _hash.get('refresh_token');
    if (_at && _rt) {
      await _sb.auth.setSession({ access_token: _at, refresh_token: _rt });
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    const { data: { session } } = await _sb.auth.getSession();
    if (session) { window._hubUser = session.user; _showHubUser(); }
    else _showHubGuest();
    _sb.auth.onAuthStateChange((_e, sess) => {
      if (sess) { window._hubUser = sess.user; _showHubUser(); }
      else { window._hubUser = null; _showHubGuest(); }
    });
  }

  function _showHubUser() {
    const meta = window._hubUser.user_metadata || {};
    const name = meta.first_name || meta.full_name?.split(' ')[0] || window._hubUser.email?.split('@')[0] || 'User';
    document.getElementById('hub-firstname').textContent = name;
    document.getElementById('hub-guest-bar').style.display = 'none';
    document.getElementById('hub-user-bar').style.display = 'flex';
    _loadCredits();
  }

  function _showHubGuest() {
    document.getElementById('hub-guest-bar').style.display = '';
    document.getElementById('hub-user-bar').style.display = 'none';
  }

  async function _loadCredits() {
    try {
      const { data } = await _sb.from('user_credits').select('balance').single();
      const el = document.getElementById('hub-credits-badge');
      if (el) el.textContent = '⚡ ' + (data?.balance ?? '?');
    } catch {}
  }

  window.openHubAuth  = function() { document.getElementById('hub-modal-ov').classList.add('show'); };
  window.closeHubAuth = function() { document.getElementById('hub-modal-ov').classList.remove('show'); document.getElementById('hub-auth-err').classList.remove('show'); };
  window.hubSignIn = async function() {
    const email = document.getElementById('hub-email').value.trim();
    const pass  = document.getElementById('hub-password').value;
    const btn   = document.getElementById('hub-signin-btn');
    const err   = document.getElementById('hub-auth-err');
    err.classList.remove('show');
    if (!email || !pass) { err.textContent = 'Enter email and password.'; err.classList.add('show'); return; }
    btn.disabled = true; btn.textContent = '…';
    const { error } = await _sb.auth.signInWithPassword({ email, password: pass });
    btn.disabled = false; btn.textContent = 'Sign In';
    if (error) { err.textContent = error.message; err.classList.add('show'); return; }
    closeHubAuth();
  };
  window.hubSignOut = async function() { await _sb.auth.signOut(); };

  document.getElementById('hub-modal-ov').addEventListener('click', e => { if (e.target === document.getElementById('hub-modal-ov')) closeHubAuth(); });

  _hubInit();
})(); } catch(e) { console.warn('Hub auth init failed:', e); }
