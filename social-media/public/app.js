/* ── Persistent credential store (localStorage) ──────────────────────────── */
const STORE_KEY = 'sm_uploader_v2';
function loadCreds() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; } }
function saveCreds(obj) { localStorage.setItem(STORE_KEY, JSON.stringify({ ...loadCreds(), ...obj })); }

/* ── State ────────────────────────────────────────────────────────────────── */
let selectedFile = null;
let selectedNiche = 'General';
let autoGenDone  = false;

/* ── DOM ──────────────────────────────────────────────────────────────────── */
const dropZone    = document.getElementById('dropZone');
const fileInput   = document.getElementById('fileInput');
const fileInfo    = document.getElementById('fileInfo');
const fileNameEl  = document.getElementById('fileName');
const fileSizeEl  = document.getElementById('fileSize');
const removeFile  = document.getElementById('removeFile');
const genStatus   = document.getElementById('genStatus');
const genStatusTx = document.getElementById('genStatusText');
const generatedBox= document.getElementById('generatedBox');
const uploadAllBtn= document.getElementById('uploadAllBtn');
const resultsList = document.getElementById('resultsList');
const regenBtn    = document.getElementById('regenBtn');

/* ── Init: restore saved credentials ─────────────────────────────────────── */
(function restoreCreds() {
  const c = loadCreds();
  const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
  set('aiApiKey',   c.aiApiKey);   set('ollamaUrl', c.ollamaUrl);
  set('ytClientId', c.ytClientId); set('ytClientSecret', c.ytClientSecret); set('ytRefreshToken', c.ytRefreshToken);
  set('igToken', c.igToken);       set('igUserId', c.igUserId);
  set('fbToken', c.fbToken);       set('fbPageId', c.fbPageId);
  set('ttToken', c.ttToken);       set('ttOpenId', c.ttOpenId);
  set('ttClientKey', c.ttClientKey); set('ttClientSecret', c.ttClientSecret);
  set('twApiKey', c.twApiKey);     set('twApiSecret', c.twApiSecret);
  set('twToken', c.twToken);       set('twTokenSecret', c.twTokenSecret);
  set('liToken', c.liToken);       set('liUrn', c.liUrn);
  set('liClientId', c.liClientId); set('liClientSecret', c.liClientSecret);
  if (c.aiProvider) {
    const radio = document.querySelector(`input[name="ai"][value="${c.aiProvider}"]`);
    if (radio) { radio.checked = true; updateAIProviderUI(); }
  }
  if (c.niche) setNiche(c.niche);
})();

/* ── Check for ?video= param (my-video integration) ─────────────────────── */
(function checkVideoParam() {
  const params   = new URLSearchParams(window.location.search);
  const videoUrl = params.get('video');
  const topic    = params.get('topic') || '';
  if (videoUrl) {
    // Show a banner so user knows we received a video URL
    const banner = document.createElement('div');
    banner.style = 'background:rgba(108,99,255,.12);border:1px solid rgba(108,99,255,.3);border-radius:8px;padding:10px 14px;margin-bottom:1rem;font-size:13px;color:#a78bfa';
    banner.innerHTML = `🎬 Video from Quiz Generator detected. Fill in your AI key below and content will auto-generate.<br><span style="font-size:11px;opacity:.7">${decodeURIComponent(videoUrl)}</span>`;
    document.querySelector('.main').prepend(banner);
    // Store video URL as a remote file reference
    window.__remoteVideoUrl = decodeURIComponent(videoUrl);
    if (topic) document.getElementById('genTitle') && (document.getElementById('genTitle').value = topic);
    // Use filename from URL as title hint
    const seg = window.__remoteVideoUrl.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g,' ');
    window.__remoteVideoTitle = decodeURIComponent(seg) || topic || 'My Video';
    // Trigger AI gen if key already stored
    const c = loadCreds();
    if (c.aiApiKey || getProvider() === 'ollama') setTimeout(triggerAutoGen, 500);
  }
})();

/* ═══════════════════════════════════════════════════════════════════════════
   FILE DROP / SELECT
══════════════════════════════════════════════════════════════════════════════ */
['dragenter','dragover'].forEach(e => dropZone.addEventListener(e, ev => { ev.preventDefault(); dropZone.classList.add('drag-over'); }));
['dragleave','drop'].forEach(e => dropZone.addEventListener(e, ev => { ev.preventDefault(); dropZone.classList.remove('drag-over'); }));
dropZone.addEventListener('drop', ev => { const f = ev.dataTransfer.files[0]; if (f) setFile(f); });
dropZone.addEventListener('click', e => { if (e.target.tagName==='LABEL'||e.target.tagName==='INPUT') return; fileInput.click(); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });
removeFile.addEventListener('click', () => { selectedFile = null; fileInput.value = ''; fileInfo.style.display='none'; dropZone.style.display=''; autoGenDone=false; });

function setFile(file) {
  selectedFile = file;
  window.__remoteVideoUrl = null;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatBytes(file.size);
  fileInfo.style.display = 'flex';
  dropZone.style.display = 'none';
  autoGenDone = false;
  triggerAutoGen();
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024**2) return (b/1024).toFixed(1) + ' KB';
  if (b < 1024**3) return (b/1024**2).toFixed(1) + ' MB';
  return (b/1024**3).toFixed(2) + ' GB';
}

/* ═══════════════════════════════════════════════════════════════════════════
   NICHE CHIPS
══════════════════════════════════════════════════════════════════════════════ */
document.getElementById('nicheChips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  selectedNiche = chip.dataset.niche;
  saveCreds({ niche: selectedNiche });
});

function setNiche(niche) {
  selectedNiche = niche;
  document.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('active', c.dataset.niche === niche);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   AI PROVIDER UI
══════════════════════════════════════════════════════════════════════════════ */
const providerMeta = {
  groq:   { label:'Groq API Key', link:'https://console.groq.com',                linkText:'Get free at console.groq.com' },
  gemini: { label:'Gemini API Key', link:'https://aistudio.google.com/app/apikey', linkText:'Get free at Google AI Studio' },
  hf:     { label:'HuggingFace Token', link:'https://huggingface.co/settings/tokens', linkText:'Get free at huggingface.co' },
  ollama: { label:'Ollama (no key needed)', link:'https://ollama.ai',             linkText:'Install Ollama locally' },
};

document.querySelectorAll('input[name="ai"]').forEach(r => r.addEventListener('change', () => { updateAIProviderUI(); saveCreds({ aiProvider: getProvider() }); }));
document.getElementById('aiApiKey').addEventListener('change', e => saveCreds({ aiApiKey: e.target.value }));
updateAIProviderUI();

function updateAIProviderUI() {
  const p = getProvider();
  const m = providerMeta[p];
  document.getElementById('aiKeyLabel').innerHTML = `${m.label} — <a class="key-link" href="${m.link}" target="_blank">${m.linkText} ↗</a>`;
  document.getElementById('aiKeyRow').style.display = p === 'ollama' ? 'none' : '';
  document.getElementById('ollamaRow').style.display = p === 'ollama' ? '' : 'none';
  document.querySelectorAll('.provider-card').forEach(c => c.classList.toggle('active-provider', c.dataset.p === p));
}
function getProvider() { return document.querySelector('input[name="ai"]:checked')?.value || 'groq'; }

/* ═══════════════════════════════════════════════════════════════════════════
   AUTO GENERATE (fires on file select)
══════════════════════════════════════════════════════════════════════════════ */
async function triggerAutoGen() {
  const provider = getProvider();
  const apiKey   = document.getElementById('aiApiKey').value.trim();
  const ollamaUrl= document.getElementById('ollamaUrl').value.trim();
  if (provider !== 'ollama' && !apiKey) return; // no key yet, wait
  const videoTitle = window.__remoteVideoTitle
    || (selectedFile ? selectedFile.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g,' ') : null);
  if (!videoTitle) return;

  genStatus.style.display = 'flex';
  genStatusTx.textContent = 'Generating title, description & hashtags…';
  generatedBox.style.display = 'none';

  try {
    const res  = await fetch('/api/generate', {
      method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ videoTitle, niche: selectedNiche, provider, apiKey, ollamaUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    fillGenerated(data);
    autoGenDone = true;
  } catch(err) {
    genStatusTx.textContent = '⚠ Generation failed: ' + err.message;
  } finally {
    if (autoGenDone) genStatus.style.display = 'none';
  }
}

function fillGenerated(data) {
  const v = (id, val) => { document.getElementById(id).value = val || ''; };
  v('genTitle', data.title);
  v('genDescription', data.description);
  v('genHashtags', Array.isArray(data.hashtags) ? data.hashtags.join(' ') : data.hashtags);
  v('genTags', Array.isArray(data.tags) ? data.tags.join(', ') : data.tags);
  v('genTweet', data.tweet);
  v('genLinkedin', data.linkedin);
  generatedBox.style.display = '';
  generatedBox.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

regenBtn.addEventListener('click', () => { autoGenDone = false; triggerAutoGen(); });

/* ═══════════════════════════════════════════════════════════════════════════
   PLATFORM TOGGLES & CREDENTIAL PERSISTENCE
══════════════════════════════════════════════════════════════════════════════ */
function togglePlatform(prefix) {
  const cb = document.getElementById(`${prefix}Enabled`);
  cb.checked = !cb.checked;
  onPlatformToggle(prefix);
}
window.onPlatformToggle = function(prefix) {
  const fields = document.getElementById(`${prefix}Fields`);
  fields.style.display = document.getElementById(`${prefix}Enabled`).checked ? '' : 'none';
};

// Save creds on input change
const credFields = {
  ytClientId:'ytClientId', ytClientSecret:'ytClientSecret', ytRefreshToken:'ytRefreshToken',
  igToken:'igToken', igUserId:'igUserId',
  fbToken:'fbToken', fbPageId:'fbPageId',
  ttToken:'ttToken', ttOpenId:'ttOpenId', ttClientKey:'ttClientKey', ttClientSecret:'ttClientSecret',
  twApiKey:'twApiKey', twApiSecret:'twApiSecret', twToken:'twToken', twTokenSecret:'twTokenSecret',
  liToken:'liToken', liUrn:'liUrn', liClientId:'liClientId', liClientSecret:'liClientSecret',
};
Object.entries(credFields).forEach(([key, id]) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', e => saveCreds({ [key]: e.target.value }));
});

/* ═══════════════════════════════════════════════════════════════════════════
   OAUTH HELPERS
══════════════════════════════════════════════════════════════════════════════ */
window.openAuth = function(platform) {
  const c = loadCreds();
  let url;
  if (platform === 'youtube') {
    const ci = document.getElementById('ytClientId').value.trim() || c.ytClientId || '';
    const cs = document.getElementById('ytClientSecret').value.trim() || c.ytClientSecret || '';
    url = ci && cs ? `/auth/youtube?client_id=${encodeURIComponent(ci)}&client_secret=${encodeURIComponent(cs)}` : '/auth/youtube';
  } else if (platform === 'tiktok') {
    const ck = document.getElementById('ttClientKey').value.trim() || c.ttClientKey || '';
    const cs = document.getElementById('ttClientSecret').value.trim() || c.ttClientSecret || '';
    url = ck && cs ? `/auth/tiktok?client_key=${encodeURIComponent(ck)}&client_secret=${encodeURIComponent(cs)}` : '/auth/tiktok';
  } else if (platform === 'linkedin') {
    const ci = document.getElementById('liClientId').value.trim() || c.liClientId || '';
    const cs = document.getElementById('liClientSecret').value.trim() || c.liClientSecret || '';
    url = ci && cs ? `/auth/linkedin?client_id=${encodeURIComponent(ci)}&client_secret=${encodeURIComponent(cs)}` : '/auth/linkedin';
  }
  window.open(url, '_blank', 'width=600,height=720');
};

/* ═══════════════════════════════════════════════════════════════════════════
   UPLOAD
══════════════════════════════════════════════════════════════════════════════ */
uploadAllBtn.addEventListener('click', async () => {
  if (!selectedFile && !window.__remoteVideoUrl) { alert('Please select a video file first.'); return; }

  const platforms = [];
  if (document.getElementById('ytEnabled').checked) platforms.push('youtube');
  if (document.getElementById('igEnabled').checked) platforms.push('instagram');
  if (document.getElementById('fbEnabled').checked) platforms.push('facebook');
  if (document.getElementById('ttEnabled').checked) platforms.push('tiktok');
  if (document.getElementById('twEnabled').checked) platforms.push('twitter');
  if (document.getElementById('liEnabled').checked) platforms.push('linkedin');
  if (!platforms.length) { alert('Please enable at least one platform.'); return; }

  resultsList.innerHTML = '';
  uploadAllBtn.disabled = true;
  uploadAllBtn.innerHTML = '⟳ Uploading…';

  await Promise.allSettled(platforms.map(p => uploadTo(p)));

  uploadAllBtn.disabled = false;
  uploadAllBtn.innerHTML = '🚀 Upload to All Enabled Platforms';
});

async function getVideoBlob() {
  if (selectedFile) return selectedFile;
  if (window.__remoteVideoUrl) {
    const r = await fetch(window.__remoteVideoUrl);
    return await r.blob();
  }
  throw new Error('No video source');
}

async function uploadTo(platform) {
  const id   = `res-${platform}`;
  resultsList.appendChild(makeResult(id, platform, 'uploading', 'Uploading…'));

  const title       = document.getElementById('genTitle')?.value       || (selectedFile?.name.replace(/\.[^.]+$/,'') || 'My Video');
  const description = document.getElementById('genDescription')?.value || '';
  const hashtags    = document.getElementById('genHashtags')?.value    || '';
  const tags        = document.getElementById('genTags')?.value        || '';
  const tweet       = document.getElementById('genTweet')?.value       || title;
  const linkedin    = document.getElementById('genLinkedin')?.value    || description;
  const fullDesc    = description + (hashtags ? '\n\n' + hashtags : '');

  const form = new FormData();
  try {
    const blob = await getVideoBlob();
    form.append('video', blob, (selectedFile?.name) || 'video.mp4');
  } catch(e) { updateResult(id, 'error', pLabel(platform)+' — Video fetch failed', e.message); return; }

  form.append('title', title);
  form.append('description', fullDesc);
  let endpoint;

  try {
    if (platform === 'youtube') {
      form.append('clientId',     document.getElementById('ytClientId').value.trim());
      form.append('clientSecret', document.getElementById('ytClientSecret').value.trim());
      form.append('refreshToken', document.getElementById('ytRefreshToken').value.trim());
      form.append('tags', tags);
      form.append('privacyStatus', document.getElementById('ytPrivacy').value);
      endpoint = '/api/upload/youtube';
    }
    if (platform === 'instagram') {
      form.append('pageAccessToken', document.getElementById('igToken').value.trim());
      form.append('igUserId',        document.getElementById('igUserId').value.trim());
      endpoint = '/api/upload/instagram';
    }
    if (platform === 'facebook') {
      form.append('pageAccessToken', document.getElementById('fbToken').value.trim());
      form.append('pageId',          document.getElementById('fbPageId').value.trim());
      endpoint = '/api/upload/facebook';
    }
    if (platform === 'tiktok') {
      form.append('accessToken',  document.getElementById('ttToken').value.trim());
      form.append('openId',       document.getElementById('ttOpenId').value.trim());
      form.append('privacyLevel', document.getElementById('ttPrivacy').value);
      endpoint = '/api/upload/tiktok';
    }
    if (platform === 'twitter') {
      form.append('apiKey',            document.getElementById('twApiKey').value.trim());
      form.append('apiSecret',         document.getElementById('twApiSecret').value.trim());
      form.append('accessToken',       document.getElementById('twToken').value.trim());
      form.append('accessTokenSecret', document.getElementById('twTokenSecret').value.trim());
      form.append('tweetText', tweet);
      endpoint = '/api/upload/twitter';
    }
    if (platform === 'linkedin') {
      form.append('accessToken', document.getElementById('liToken').value.trim());
      form.append('personUrn',   document.getElementById('liUrn').value.trim());
      form.append('description', linkedin + (hashtags ? '\n\n' + hashtags : ''));
      endpoint = '/api/upload/linkedin';
    }

    const res  = await fetch(endpoint, { method:'POST', body:form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    updateResult(id, 'success', pLabel(platform)+' — Uploaded!',
      data.url ? `<a class="rlink" href="${data.url}" target="_blank">${data.url}</a>` : (data.publishId || data.postId || 'Success'));
  } catch(err) {
    updateResult(id, 'error', pLabel(platform)+' — Failed', err.message);
  }
}

/* ── Result card helpers ──────────────────────────────────────────────────── */
function makeResult(id, platform, state, msg) {
  const d = document.createElement('div');
  d.id = id; d.className = `result-item ${state}`;
  d.innerHTML = `<div class="rdot"></div><div class="rbody"><div class="rtitle">${pLabel(platform)}</div><div class="rdetail">${msg}</div><div class="pbar"><div class="pfill"></div></div></div>`;
  return d;
}
function updateResult(id, state, title, detail) {
  const el = document.getElementById(id); if (!el) return;
  el.className = `result-item ${state}`;
  el.querySelector('.rtitle').textContent = title;
  el.querySelector('.rdetail').innerHTML = detail;
  const pb = el.querySelector('.pbar'); if (pb) pb.remove();
}
const LABELS = { youtube:'YouTube', instagram:'Instagram', facebook:'Facebook', tiktok:'TikTok', twitter:'X / Twitter', linkedin:'LinkedIn' };
function pLabel(p) { return LABELS[p] || p; }
