/* ══════════════════════════════════════════════════════════════════
   BACKEND URL — bypass Cloudflare Pages proxy for all API + OAuth
   Cloudflare Pages _redirects with status 200 (rewrite) is GET-only.
   POST requests return 405. OAuth 200-rewrite follows Railway's 302
   server-side, returning raw HTML instead of redirecting the browser.
   Solution: call Railway directly from the browser for everything.
══════════════════════════════════════════════════════════════════ */
const BACKEND = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? ''   // localhost: use relative URLs (server.js serves public/)
  : 'https://social-media-uploader-production.up.railway.app';

/* ══════════════════════════════════════════════════════════════════
   STARS (identical to my-video)
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
   CREDENTIAL STORE (localStorage)
══════════════════════════════════════════════════════════════════ */
const STORE = 'sm_v3';
const load  = () => { try { return JSON.parse(localStorage.getItem(STORE)||'{}'); } catch { return {}; } };
const save  = o  => localStorage.setItem(STORE, JSON.stringify({ ...load(), ...o }));

/* ══════════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════════ */
let selectedFile = null;
let selectedNiche = 'General';
let generatedContent = null;  // stores { youtube, instagram, facebook, tiktok, twitter, linkedin }

/* ══════════════════════════════════════════════════════════════════
   RESTORE SAVED CREDS
══════════════════════════════════════════════════════════════════ */
(function restore() {
  const c = load();
  const f = (id, v) => { const el=document.getElementById(id); if(el&&v) el.value=v; };
  f('aiApiKey', c.aiApiKey); f('ollamaUrl', c.ollamaUrl);
  f('ytClientId',c.ytClientId); f('ytClientSecret',c.ytClientSecret); f('ytRefreshToken',c.ytRefreshToken);
  f('igToken',c.igToken); f('igUserId',c.igUserId);
  f('fbToken',c.fbToken); f('fbPageId',c.fbPageId);
  f('ttToken',c.ttToken); f('ttOpenId',c.ttOpenId); f('ttClientKey',c.ttClientKey); f('ttClientSecret',c.ttClientSecret);
  f('twApiKey',c.twApiKey); f('twApiSecret',c.twApiSecret); f('twToken',c.twToken); f('twTokenSecret',c.twTokenSecret);
  f('liToken',c.liToken); f('liUrn',c.liUrn); f('liClientId',c.liClientId); f('liClientSecret',c.liClientSecret);
  if (c.aiProvider) {
    const r = document.querySelector(`input[name="ai"][value="${c.aiProvider}"]`);
    if (r) { r.checked = true; updateAIUI(); }
  }
  if (c.niche) setNiche(c.niche);
})();

// Auto-save creds on change
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
   Shows the video in Step 01's file-info area, just like a local file
══════════════════════════════════════════════════════════════════ */
(function checkParams() {
  const p = new URLSearchParams(location.search);
  const videoUrl = p.get('video');
  const topic    = p.get('topic') || '';
  if (!videoUrl) return;

  window.__remoteVideoUrl   = decodeURIComponent(videoUrl);
  window.__remoteVideoTitle = decodeURIComponent(topic)
    || window.__remoteVideoUrl.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');

  // Show in Step 01 file-info area (hide drop zone, show file card)
  const fname = window.__remoteVideoUrl.split('/').pop().split('?')[0] || 'video.mp4';
  document.getElementById('fileName').textContent = fname;
  document.getElementById('fileSize').textContent = '(from Quiz Generator)';
  document.getElementById('fileInfo').style.display  = 'flex';
  document.getElementById('dropZone').style.display  = 'none';

  // Auto-generate content if API key is already saved
  const c = load();
  if (c.aiApiKey || getProvider() === 'ollama') setTimeout(triggerGenerate, 600);
})();

/* ══════════════════════════════════════════════════════════════════
   FILE DROP / SELECT
══════════════════════════════════════════════════════════════════ */
const dropZone  = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

['dragenter','dragover'].forEach(e => dropZone.addEventListener(e, ev => { ev.preventDefault(); dropZone.classList.add('drag-over'); }));
['dragleave','drop'].forEach(e => dropZone.addEventListener(e, ev => { ev.preventDefault(); dropZone.classList.remove('drag-over'); }));
dropZone.addEventListener('drop', ev => { const f=ev.dataTransfer.files[0]; if(f) setFile(f); });
dropZone.addEventListener('click', e => { if(e.target.tagName==='LABEL'||e.target.tagName==='INPUT') return; fileInput.click(); });
fileInput.addEventListener('change', () => { if(fileInput.files[0]) setFile(fileInput.files[0]); });
document.getElementById('removeFile').addEventListener('click', () => {
  selectedFile = null; fileInput.value = '';
  document.getElementById('fileInfo').style.display = 'none';
  document.getElementById('dropZone').style.display = '';
});

function setFile(file) {
  selectedFile = file;
  window.__remoteVideoUrl = null;
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = fmtBytes(file.size);
  document.getElementById('fileInfo').style.display = 'flex';
  document.getElementById('dropZone').style.display = 'none';
  triggerGenerate();
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
  groq:   { label:'GROQ API KEY',         link:'https://console.groq.com',                   lt:'Get free at console.groq.com' },
  gemini: { label:'GEMINI API KEY',        link:'https://aistudio.google.com/app/apikey',     lt:'Get free at Google AI Studio' },
  hf:     { label:'HUGGINGFACE TOKEN',     link:'https://huggingface.co/settings/tokens',     lt:'Get free at huggingface.co' },
  ollama: { label:'OLLAMA (no key needed)',link:'https://ollama.ai',                           lt:'Install Ollama locally' },
};
document.querySelectorAll('input[name="ai"]').forEach(r => {
  r.addEventListener('change', () => { updateAIUI(); save({ aiProvider: getProvider() }); });
});
document.getElementById('aiApiKey').addEventListener('input', () => {
  // Auto-trigger generation if we have a file and key
  const key = document.getElementById('aiApiKey').value.trim();
  if (key.length > 10 && (selectedFile || window.__remoteVideoUrl)) triggerGenerate();
});
updateAIUI();

function updateAIUI() {
  const p = getProvider(), m = providerMeta[p];
  document.getElementById('aiKeyLabel').innerHTML = `${m.label} — <a class="key-link" href="${m.link}" target="_blank">${m.lt} ↗</a>`;
  document.getElementById('aiKeyRow').style.display = p==='ollama' ? 'none' : '';
  document.getElementById('ollamaRow').style.display = p==='ollama' ? '' : 'none';
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
    const provider = getProvider();
    const apiKey   = document.getElementById('aiApiKey').value.trim();
    const ollamaUrl= document.getElementById('ollamaUrl').value.trim();
    if (provider !== 'ollama' && !apiKey) return;

    const title = window.__remoteVideoTitle
      || (selectedFile ? selectedFile.name.replace(/\.[^.]+$/,'').replace(/[-_]+/g,' ') : null);
    if (!title) return;

    const regenBtn = document.getElementById('regenBtn');
    regenBtn.disabled = true;
    regenBtn.textContent = '⏳ Generating…';

    document.getElementById('genLoading').style.display = 'flex';
    document.getElementById('genLoadingText').textContent = 'Generating platform-specific content…';
    document.getElementById('contentSection').style.display = 'none';

    try {
      const res  = await fetch(BACKEND + '/api/generate', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ videoTitle:title, niche:selectedNiche, provider, apiKey, ollamaUrl }),
      });
      let data;
      try { data = await res.json(); }
      catch { throw new Error(`Server returned an invalid response (HTTP ${res.status}). Check your API key and try again.`); }
      if (!res.ok) throw new Error(data.error || `AI provider error (HTTP ${res.status})`);
      generatedContent = data;
      fillContent(data);
    } catch(err) {
      document.getElementById('genLoadingText').textContent = '⚠ ' + err.message;
      // keep error visible until user acts — don't auto-hide
      regenBtn.disabled = false;
      regenBtn.textContent = generatedContent ? '↺ Regenerate' : '✨ Generate AI Content';
    }
  }, 400);
}

function fillContent(d) {
  document.getElementById('genLoading').style.display = 'none';
  document.getElementById('contentSection').style.display = '';
  const regenBtn = document.getElementById('regenBtn');
  regenBtn.disabled = false;
  regenBtn.textContent = '↺ Regenerate';

  // YouTube
  if (d.youtube) {
    document.getElementById('ytGenTitle').value = d.youtube.title || '';
    document.getElementById('ytGenDesc').value  = d.youtube.description || '';
    document.getElementById('ytGenTags').value  = Array.isArray(d.youtube.tags) ? d.youtube.tags.join(', ') : (d.youtube.tags||'');
    updateCount('ytGenTitle','yt-title-count',100);
  }
  // Instagram
  if (d.instagram) {
    document.getElementById('igGenCaption').value = d.instagram.caption || '';
    updateCount('igGenCaption','ig-cap-count',2200);
  }
  // Facebook
  if (d.facebook) {
    document.getElementById('fbGenTitle').value = d.facebook.title || '';
    document.getElementById('fbGenDesc').value  = d.facebook.description || '';
  }
  // TikTok
  if (d.tiktok) {
    document.getElementById('ttGenTitle').value = d.tiktok.title || '';
    updateCount('ttGenTitle','tt-title-count',150);
  }
  // Twitter
  if (d.twitter) {
    document.getElementById('twGenTweet').value = d.twitter.tweet || '';
    updateCount('twGenTweet','tw-tweet-count',280);
  }
  // LinkedIn
  if (d.linkedin) {
    document.getElementById('liGenPost').value = d.linkedin.post || '';
    updateCount('liGenPost','li-post-count',3000);
  }

  // Show the tab for the first enabled platform, default youtube
  switchTab('youtube');
  document.getElementById('contentSection').scrollIntoView({ behavior:'smooth', block:'nearest' });
}

document.getElementById('regenBtn').addEventListener('click', () => triggerGenerate());

/* ══════════════════════════════════════════════════════════════════
   PLATFORM TOGGLES
══════════════════════════════════════════════════════════════════ */
window.togglePlatform = function(pfx) {
  const cb = document.getElementById(pfx+'Enabled');
  cb.checked = !cb.checked; onToggle(pfx);
};
window.onToggle = function(pfx) {
  document.getElementById(pfx+'Fields').style.display =
    document.getElementById(pfx+'Enabled').checked ? '' : 'none';
};

/* ══════════════════════════════════════════════════════════════════
   OAUTH HELPERS
══════════════════════════════════════════════════════════════════ */
window.openAuth = function(platform) {
  let path;
  if (platform === 'youtube') {
    const ci = document.getElementById('ytClientId').value.trim();
    const cs = document.getElementById('ytClientSecret').value.trim();
    if (!ci || !cs) { alert('Please fill in Client ID and Client Secret first.'); return; }
    path = `/auth/youtube?client_id=${encodeURIComponent(ci)}&client_secret=${encodeURIComponent(cs)}`;
  } else if (platform === 'tiktok') {
    const ck = document.getElementById('ttClientKey').value.trim();
    const cs = document.getElementById('ttClientSecret').value.trim();
    if (!ck || !cs) { alert('Please fill in Client Key and Client Secret first.'); return; }
    path = `/auth/tiktok?client_key=${encodeURIComponent(ck)}&client_secret=${encodeURIComponent(cs)}`;
  } else if (platform === 'linkedin') {
    const ci = document.getElementById('liClientId').value.trim();
    const cs = document.getElementById('liClientSecret').value.trim();
    if (!ci || !cs) { alert('Please fill in Client ID and Client Secret first.'); return; }
    path = `/auth/linkedin?client_id=${encodeURIComponent(ci)}&client_secret=${encodeURIComponent(cs)}`;
  }
  // Use Railway URL directly — Cloudflare Pages 200-rewrite follows redirects server-side
  // which breaks OAuth flows. Auth must go to Railway directly so the 302 → Google/TikTok/LinkedIn
  // redirect is followed by the browser (not by Cloudflare).
  window.open(BACKEND + path, '_blank', 'width=620,height=720');
};

/* ══════════════════════════════════════════════════════════════════
   UPLOAD
══════════════════════════════════════════════════════════════════ */
document.getElementById('uploadAllBtn').addEventListener('click', async () => {
  if (!selectedFile && !window.__remoteVideoUrl) { alert('Please select a video first.'); return; }

  const enabled = [];
  if (document.getElementById('ytEnabled').checked) enabled.push('youtube');
  if (document.getElementById('igEnabled').checked) enabled.push('instagram');
  if (document.getElementById('fbEnabled').checked) enabled.push('facebook');
  if (document.getElementById('ttEnabled').checked) enabled.push('tiktok');
  if (document.getElementById('twEnabled').checked) enabled.push('twitter');
  if (document.getElementById('liEnabled').checked) enabled.push('linkedin');
  if (!enabled.length) { alert('Please enable at least one platform.'); return; }

  document.getElementById('resultsList').innerHTML = '';
  const btn = document.getElementById('uploadAllBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0"></div> Uploading…';

  await Promise.allSettled(enabled.map(p => uploadTo(p)));
  btn.disabled = false; btn.innerHTML = '🚀 Upload to All Enabled Platforms';
});

async function getVideoBlob() {
  if (selectedFile) return selectedFile;
  const r = await fetch(window.__remoteVideoUrl);
  return await r.blob();
}

async function uploadTo(platform) {
  const id = 'res-'+platform;
  document.getElementById('resultsList').appendChild(makeResultEl(id, platform, 'uploading', 'Uploading…'));

  // Pull platform-specific generated content
  const ytTitle  = document.getElementById('ytGenTitle')?.value || '';
  const ytDesc   = document.getElementById('ytGenDesc')?.value  || '';
  const ytTags   = document.getElementById('ytGenTags')?.value  || '';
  const igCap    = document.getElementById('igGenCaption')?.value || '';
  const fbTitle  = document.getElementById('fbGenTitle')?.value || '';
  const fbDesc   = document.getElementById('fbGenDesc')?.value  || '';
  const ttTitle  = document.getElementById('ttGenTitle')?.value || '';
  const twTweet  = document.getElementById('twGenTweet')?.value || '';
  const liPost   = document.getElementById('liGenPost')?.value  || '';

  const form = new FormData();
  try {
    const blob = await getVideoBlob();
    form.append('video', blob, selectedFile?.name || 'video.mp4');
  } catch(e) { updateResultEl(id,'error',label(platform)+' — Video fetch failed', e.message); return; }

  // ── Credential validation — skip platforms that aren't configured ──
  const missing = [];
  if (platform === 'youtube') {
    const ci = document.getElementById('ytClientId').value.trim();
    const cs = document.getElementById('ytClientSecret').value.trim();
    const rt = document.getElementById('ytRefreshToken').value.trim();
    if (!ci) missing.push('Client ID'); if (!cs) missing.push('Client Secret'); if (!rt) missing.push('Refresh Token');
  }
  if (platform === 'instagram') {
    if (!document.getElementById('igToken').value.trim())  missing.push('Page Access Token');
    if (!document.getElementById('igUserId').value.trim()) missing.push('IG User ID');
  }
  if (platform === 'facebook') {
    if (!document.getElementById('fbToken').value.trim())  missing.push('Page Access Token');
    if (!document.getElementById('fbPageId').value.trim()) missing.push('Page ID');
  }
  if (platform === 'tiktok') {
    if (!document.getElementById('ttToken').value.trim()) missing.push('Access Token');
  }
  if (platform === 'twitter') {
    if (!document.getElementById('twApiKey').value.trim())       missing.push('API Key');
    if (!document.getElementById('twApiSecret').value.trim())    missing.push('API Secret');
    if (!document.getElementById('twToken').value.trim())        missing.push('Access Token');
    if (!document.getElementById('twTokenSecret').value.trim())  missing.push('Access Token Secret');
  }
  if (platform === 'linkedin') {
    if (!document.getElementById('liToken').value.trim()) missing.push('Access Token');
    if (!document.getElementById('liUrn').value.trim())   missing.push('Person URN');
  }
  if (missing.length) {
    updateResultEl(id, 'error', label(platform)+' — Skipped',
      'Missing credentials: ' + missing.join(', ') + '. Fill in Step 03 above.');
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

    const res  = await fetch(BACKEND + endpoint, { method:'POST', body:form });
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
