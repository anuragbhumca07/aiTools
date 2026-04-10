'use strict';

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const cron       = require('node-cron');
const axios      = require('axios');
const Database   = require('better-sqlite3');
const cronParser = require('cron-parser');
const { google } = require('googleapis');
const { TwitterApi } = require('twitter-api-v2');
const FormData   = require('form-data');

const app  = express();
const PORT = process.env.PORT || 3003;

const QUIZ_API            = process.env.QUIZ_API_URL       || 'https://quiz-video-generator-production.up.railway.app';
const BASE_URL            = process.env.BASE_URL            || 'https://quiz-scheduler-production.up.railway.app';
const SUPABASE_URL        = process.env.SUPABASE_URL        || 'https://dhdzftmlrkuwcsgmgihe.supabase.co';
const SUPABASE_ANON       = process.env.SUPABASE_ANON_KEY   || 'sb_publishable_9Ns_telLHzlI-qwxJ_-XbQ_u_9Sab3J';
// Get from: Supabase Dashboard → Project Settings → API → service_role (secret key)
// Add as Railway env var: SUPABASE_SERVICE_KEY
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TZ                  = process.env.TZ_NAME              || 'Asia/Kolkata';

const DATA_DIR = '/data';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* volume not mounted, use local */ }
const DB_PATH = fs.existsSync('/data') ? '/data/scheduler.db' : path.join(__dirname, 'data', 'scheduler.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS schedules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    category      TEXT    NOT NULL,
    subcategory   TEXT    NOT NULL,
    format        TEXT    NOT NULL DEFAULT '16:9',
    freq_type     TEXT    NOT NULL,
    freq_value    TEXT,
    run_time      TEXT    NOT NULL DEFAULT '09:00',
    run_day       INTEGER NOT NULL DEFAULT 1,
    cron_expr     TEXT    NOT NULL,
    platforms     TEXT    NOT NULL DEFAULT '[]',
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    last_run      TEXT,
    next_run      TEXT,
    total_runs    INTEGER NOT NULL DEFAULT 0,
    total_errors  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS credentials (
    user_id     TEXT NOT NULL,
    platform    TEXT NOT NULL,
    config_json TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, platform)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id  INTEGER NOT NULL,
    user_id      TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'running',
    video_url    TEXT,
    question     TEXT,
    options      TEXT,
    correct_idx  INTEGER,
    error        TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS postings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      INTEGER NOT NULL,
    platform    TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',
    post_url    TEXT,
    error       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );
`);

// ── Auth ──────────────────────────────────────────────────────────────────────
async function verifyJWT(token) {
  const r = await axios.get(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    timeout: 10000,
  });
  return r.data; // { id, email, ... }
}

async function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ success: false, error: 'Login required' });
  try {
    req.user = await verifyJWT(token);
    if (!req.user?.id) throw new Error('Invalid user');
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired session. Please log in again.' });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const FREQ_LABELS = {
  hourly:'Every Hour', every2h:'Every 2 Hours', every4h:'Every 4 Hours',
  every6h:'Every 6 Hours', every12h:'Every 12 Hours',
  daily:'Daily', weekly:'Weekly', custom:'Custom',
};

function buildCronExpr(freqType, freqValue, runTime, runDay) {
  const [h = 9, m = 0] = (runTime || '09:00').split(':').map(Number);
  switch (freqType) {
    case 'hourly':   return `${m} * * * *`;
    case 'every2h':  return `${m} */2 * * *`;
    case 'every4h':  return `${m} */4 * * *`;
    case 'every6h':  return `${m} */6 * * *`;
    case 'every12h': return `${m} */12 * * *`;
    case 'daily':    return `${m} ${h} * * *`;
    case 'weekly':   return `${m} ${h} * * ${runDay || 1}`;
    case 'custom':   return freqValue || '0 9 * * *';
    default:         return '0 9 * * *';
  }
}

function nextRun(expr) {
  try { return cronParser.parseExpression(expr, { tz: TZ }).next().toDate().toISOString(); } catch { return null; }
}

function getUserCreds(userId, platform) {
  const row = db.prepare('SELECT config_json FROM credentials WHERE user_id=? AND platform=?').get(userId, platform);
  return row ? JSON.parse(row.config_json) : null;
}

// Load ALL users' credentials from Supabase into SQLite (requires service role key to bypass RLS)
async function syncCredsFromSupabase() {
  if (!SUPABASE_SERVICE_KEY) return 0;
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/scheduler_credentials?select=user_id,platform,config_json`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }, timeout: 15000 }
    );
    if (!data?.length) return 0;
    const stmt = db.prepare(`INSERT OR REPLACE INTO credentials (user_id,platform,config_json,updated_at) VALUES (?,?,?,datetime('now'))`);
    for (const row of data) {
      const cfg = typeof row.config_json === 'string' ? row.config_json : JSON.stringify(row.config_json);
      stmt.run(row.user_id, row.platform, cfg);
    }
    console.log(`[SYNC] Loaded ${data.length} credential(s) from Supabase`);
    return data.length;
  } catch (e) {
    console.warn('[SYNC] Supabase credential sync failed:', e.message);
    return 0;
  }
}

async function downloadToTemp(url) {
  const tmp = path.join(os.tmpdir(), `sched_${Date.now()}.mp4`);
  const res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 180000 });
  const w = fs.createWriteStream(tmp);
  res.data.pipe(w);
  await new Promise((ok, fail) => { w.on('finish', ok); w.on('error', fail); });
  return tmp;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Download video to Scheduler's own serving directory so platform APIs can fetch it reliably
const SERVE_DIR = path.join(__dirname, 'serve');
fs.mkdirSync(SERVE_DIR, { recursive: true });

async function stageVideo(videoUrl) {
  const fname  = `v_${Date.now()}.mp4`;
  const fpath  = path.join(SERVE_DIR, fname);
  const pubUrl = `${BASE_URL}/serve/${fname}`;
  const tmp = await downloadToTemp(videoUrl);
  fs.renameSync(tmp, fpath);
  // Auto-delete after 3 hours
  setTimeout(() => { try { fs.unlinkSync(fpath); } catch {} }, 3 * 60 * 60 * 1000);
  return { fpath, pubUrl };
}

// ── Platform Posters (all receive { fpath, pubUrl } staged video) ─────────────
async function postYouTube(fpath, pubUrl, title, desc, c) {
  if (!c.refresh_token) throw new Error('YouTube not authorized — click "Authorize with Google" in Credentials first');
  const oauth2 = new google.auth.OAuth2(c.client_id, c.client_secret, `${BASE_URL}/auth/youtube/callback`);
  oauth2.setCredentials({ refresh_token: c.refresh_token });
  const yt = google.youtube({ version: 'v3', auth: oauth2 });
  const r  = await yt.videos.insert({
    part: ['snippet','status'],
    requestBody: {
      snippet: { title: title.slice(0,100), description: `${desc}\n\n#quiz #trivia #shorts`, tags: ['quiz','trivia','shorts'], categoryId: '27' },
      status:  { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    },
    media: { body: fs.createReadStream(fpath) },
  });
  return `https://youtube.com/shorts/${r.data.id}`;
}

async function postInstagram(fpath, pubUrl, title, desc, c) {
  const caption = `${title}\n\n${desc}\n\n#quiz #trivia #reels`;
  const con = await axios.post(`https://graph.facebook.com/v19.0/${c.instagram_account_id}/media`, null,
    { params: { video_url: pubUrl, media_type: 'REELS', caption, access_token: c.access_token }, timeout: 30000 });
  for (let i = 0; i < 30; i++) {
    await sleep(10000);
    const s = await axios.get(`https://graph.facebook.com/v19.0/${con.data.id}`,
      { params: { fields: 'status_code,status', access_token: c.access_token }, timeout: 15000 });
    if (s.data.status_code === 'FINISHED') break;
    if (s.data.status_code === 'ERROR') throw new Error(`Instagram processing failed: ${JSON.stringify(s.data.status)}`);
  }
  const pub = await axios.post(`https://graph.facebook.com/v19.0/${c.instagram_account_id}/media_publish`, null,
    { params: { creation_id: con.data.id, access_token: c.access_token }, timeout: 30000 });
  return `https://www.instagram.com/p/${pub.data.id}/`;
}

async function postTwitter(fpath, pubUrl, title, desc, c) {
  const client  = new TwitterApi({ appKey: c.api_key, appSecret: c.api_secret, accessToken: c.access_token, accessSecret: c.access_token_secret });
  const mediaId = await client.v1.uploadMedia(fpath, { mimeType: 'video/mp4' });
  const tweet   = await client.v2.tweet({ text: `${title}\n\n#quiz #trivia`.slice(0,280), media: { media_ids: [mediaId] } });
  return `https://twitter.com/i/web/status/${tweet.data.id}`;
}

async function postTikTok(fpath, pubUrl, title, desc, c) {
  await axios.post('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
    { post_info: { title: `${title} #quiz`.slice(0,150), privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, disable_duet: false, disable_stitch: false },
      source_info: { source: 'URL', video_url: pubUrl } },
    { headers: { Authorization: `Bearer ${c.access_token}`, 'Content-Type': 'application/json' }, timeout: 30000 });
  return 'https://www.tiktok.com/';
}

async function postFacebook(fpath, pubUrl, title, desc, c) {
  const r = await axios.post(`https://graph-video.facebook.com/v19.0/${c.page_id}/videos`, null,
    { params: { file_url: pubUrl, title: title.slice(0,255), description: desc, access_token: c.page_access_token }, timeout: 60000 });
  return `https://www.facebook.com/video.php?v=${r.data.id}`;
}

async function postLinkedIn(fpath, pubUrl, title, desc, c) {
  const h = { Authorization: `Bearer ${c.access_token}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' };
  const reg = await axios.post('https://api.linkedin.com/v2/assets?action=registerUpload',
    { registerUploadRequest: { owner: c.person_urn, recipes: ['urn:li:digitalmediaRecipe:feedshare-video'],
        serviceRelationships: [{ identifier: 'urn:li:userGeneratedContent', relationshipType: 'OWNER' }],
        supportedUploadMechanism: ['SYNCHRONOUS_UPLOAD'] } }, { headers: h, timeout: 20000 });
  const uploadUrl = reg.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
  const assetId   = reg.data.value.asset;
  await axios.put(uploadUrl, fs.readFileSync(fpath), { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 120000, maxBodyLength: Infinity });
  const post = await axios.post('https://api.linkedin.com/v2/ugcPosts',
    { author: c.person_urn, lifecycleState: 'PUBLISHED',
      specificContent: { 'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: `${title}\n\n${desc}\n\n#quiz`.slice(0,700) },
        shareMediaCategory: 'VIDEO',
        media: [{ status: 'READY', media: assetId, title: { text: title.slice(0,200) } }] } },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' } },
    { headers: h, timeout: 20000 });
  return `https://www.linkedin.com/feed/update/${post.headers['x-restli-id'] || ''}/`;
}

const POSTERS = { 'YouTube Shorts': postYouTube, 'Instagram Reels': postInstagram, 'X (Twitter)': postTwitter, 'TikTok': postTikTok, 'Facebook': postFacebook, 'LinkedIn': postLinkedIn };

// ── Core runner ───────────────────────────────────────────────────────────────
async function postToPlatforms(jobId, userId, videoUrl, question, platforms) {
  console.log(`[POST] job#${jobId} → platforms: ${JSON.stringify(platforms)}, videoUrl: ${videoUrl}`);
  // Stage video on Scheduler server so all platform APIs can reliably fetch it
  let staged = null;
  try {
    staged = await stageVideo(videoUrl);
    console.log(`[POST] Video staged at ${staged.pubUrl}`);
  } catch (e) {
    console.error(`[POST] Failed to stage video: ${e.message}`);
    // Record failure for all platforms
    for (const p of platforms) {
      db.prepare(`INSERT INTO postings (job_id,platform,status,error) VALUES (?,?,'error',?)`).run(jobId, p, `Video download failed: ${e.message}`.slice(0,400));
    }
    return;
  }
  try {
    for (const p of platforms) {
      if (!POSTERS[p]) { console.warn(`[POST] Unknown platform: ${p}`); continue; }
      const creds = getUserCreds(userId, p);
      if (!creds) {
        console.warn(`[POST] ${p} — no credentials in SQLite for user ${userId}`);
        db.prepare(`INSERT INTO postings (job_id,platform,status,error) VALUES (?,?,'skipped','No credentials')`).run(jobId, p);
        continue;
      }
      console.log(`[POST] ${p} — uploading…`);
      const pid = db.prepare(`INSERT INTO postings (job_id,platform,status) VALUES (?,?,'running')`).run(jobId, p).lastInsertRowid;
      try {
        const url = await POSTERS[p](staged.fpath, staged.pubUrl, question || 'Quiz Time!', `Quiz: ${question}`, creds);
        db.prepare(`UPDATE postings SET status='done',post_url=? WHERE id=?`).run(url, pid);
        console.log(`[POST] ${p} ✓ ${url}`);
      } catch (e) {
        db.prepare(`UPDATE postings SET status='error',error=? WHERE id=?`).run(e.message?.slice(0,400), pid);
        console.error(`[POST] ${p} ✗ ${e.message}`);
      }
    }
  } finally {
    // Keep the file alive for 3h (set in stageVideo), just clean up tmp if any
  }
}

async function runSchedule(scheduleId) {
  const s = db.prepare('SELECT * FROM schedules WHERE id=?').get(scheduleId);
  if (!s) return;
  const platforms = JSON.parse(s.platforms || '[]');
  // Sync credentials from Supabase if any platform's creds are missing (handles Railway restarts)
  if (platforms.length) {
    const missingCreds = platforms.some(p => !getUserCreds(s.user_id, p));
    if (missingCreds) await syncCredsFromSupabase();
  }
  const jobId = db.prepare(`INSERT INTO jobs (schedule_id,user_id,status) VALUES (?,?,'running')`).run(s.id, s.user_id).lastInsertRowid;
  console.log(`[CRON] #${s.id} "${s.name}" → job #${jobId}`);
  try {
    const resp = await axios.post(`${QUIZ_API}/api/generate-random`, { category: s.category, subcategory: s.subcategory, format: s.format }, { timeout: 300000 });
    if (!resp.data.success) throw new Error(resp.data.error || 'Video generation failed');
    let { videoUrl, question, options, correctIndex } = resp.data;
    // Ensure videoUrl is absolute (guard against missing BACKEND_URL in quiz-video service)
    if (videoUrl && !videoUrl.startsWith('http')) videoUrl = `${QUIZ_API}${videoUrl}`;
    db.prepare(`UPDATE jobs SET status='done',video_url=?,question=?,options=?,correct_idx=? WHERE id=?`)
      .run(videoUrl, question, JSON.stringify(options||[]), correctIndex??0, jobId);
    db.prepare(`UPDATE schedules SET last_run=datetime('now'),next_run=?,total_runs=total_runs+1 WHERE id=?`).run(nextRun(s.cron_expr), s.id);
    if (platforms.length) postToPlatforms(jobId, s.user_id, videoUrl, question, platforms).catch(console.error);
  } catch (e) {
    db.prepare(`UPDATE jobs SET status='error',error=? WHERE id=?`).run(e.message?.slice(0,500), jobId);
    db.prepare(`UPDATE schedules SET total_errors=total_errors+1 WHERE id=?`).run(s.id);
    console.error(`[CRON] Job #${jobId} failed:`, e.message);
  }
}

const cronTasks = new Map();
function startCron(s) {
  const key = `${s.user_id}_${s.id}`;
  if (cronTasks.has(key)) { cronTasks.get(key).stop(); cronTasks.delete(key); }
  if (!s.active || !cron.validate(s.cron_expr)) return;
  const task = cron.schedule(s.cron_expr, () => runSchedule(s.id), { timezone: TZ });
  cronTasks.set(key, task);
  const nr = nextRun(s.cron_expr);
  db.prepare('UPDATE schedules SET next_run=? WHERE id=?').run(nr, s.id);
}
function stopCron(userId, schedId) {
  const key = `${userId}_${schedId}`;
  if (cronTasks.has(key)) { cronTasks.get(key).stop(); cronTasks.delete(key); }
}

// ── Express ───────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));
app.use('/serve', express.static(SERVE_DIR)); // staged videos for platform APIs

// ── YouTube OAuth ─────────────────────────────────────────────────────────────
app.get('/auth/youtube', (req, res) => {
  const { client_id, client_secret, user_id } = req.query;
  if (!client_id || !client_secret || !user_id) return res.status(400).send('Missing params');
  const state = Buffer.from(JSON.stringify({ client_id, client_secret, user_id })).toString('base64url');
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, `${BASE_URL}/auth/youtube/callback`);
  res.redirect(oauth2.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/youtube.upload'], prompt: 'consent', state }));
});

app.get('/auth/youtube/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state. Please try again.');
  let client_id, client_secret, user_id;
  try { ({ client_id, client_secret, user_id } = JSON.parse(Buffer.from(state, 'base64url').toString())); }
  catch { return res.status(400).send('Invalid state parameter. Please try again.'); }
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, `${BASE_URL}/auth/youtube/callback`);
  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) return res.status(400).send(`
      <html><body style="font-family:sans-serif;background:#08080f;color:#e8e8f0;padding:2rem">
      <h2 style="color:#f59e0b">⚠ No refresh token returned</h2>
      <p>Your Google account already authorized this app. Revoke access first:</p>
      <ol><li>Go to <a href="https://myaccount.google.com/permissions" style="color:#a78bfa" target="_blank">Google Account Permissions</a></li>
      <li>Remove this app</li>
      <li><a href="/auth/youtube?client_id=${encodeURIComponent(client_id)}&client_secret=${encodeURIComponent(client_secret)}&user_id=${encodeURIComponent(user_id)}" style="color:#a78bfa">Try again</a></li></ol>
      </body></html>`);
    db.prepare(`INSERT OR REPLACE INTO credentials (user_id,platform,config_json,updated_at) VALUES (?,?,?,datetime('now'))`)
      .run(user_id, 'YouTube Shorts', JSON.stringify({ client_id, client_secret, refresh_token: tokens.refresh_token }));
    res.send(`<html><body style="font-family:sans-serif;background:#08080f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center"><div style="font-size:3rem">✅</div><h2 style="color:#10b981">YouTube Connected!</h2>
      <p>Your credentials have been saved. Close this tab and return to Scheduler.</p>
      <script>setTimeout(()=>window.close(),2500)</script></div></body></html>`);
  } catch (e) { res.status(500).send(`OAuth failed: ${e.message}<br><a href="/auth/youtube?client_id=${encodeURIComponent(client_id)}&client_secret=${encodeURIComponent(client_secret)}&user_id=${encodeURIComponent(user_id)}" style="color:#a78bfa">Try again</a>`); }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', crons: cronTasks.size }));

app.get('/api/categories', async (_, res) => {
  try { res.json((await axios.get(`${QUIZ_API}/api/categories`, { timeout: 10000 })).data); }
  catch (e) { res.status(502).json({ success: false, error: e.message }); }
});

// ── Credentials ───────────────────────────────────────────────────────────────
app.get('/api/credentials', authMiddleware, (req, res) => {
  const rows = db.prepare(`SELECT platform,updated_at FROM credentials WHERE user_id=? AND platform NOT LIKE '__%%__'`).all(req.user.id);
  const out = {};
  rows.forEach(r => out[r.platform] = { configured: true, updated_at: r.updated_at });
  res.json({ success: true, credentials: out });
});

app.post('/api/credentials/:platform', authMiddleware, (req, res) => {
  const platform = decodeURIComponent(req.params.platform);
  const config   = req.body;
  if (!config || !Object.keys(config).length) return res.status(400).json({ success: false, error: 'No credentials provided' });
  db.prepare(`INSERT OR REPLACE INTO credentials (user_id,platform,config_json,updated_at) VALUES (?,?,?,datetime('now'))`).run(req.user.id, platform, JSON.stringify(config));
  res.json({ success: true });
});

app.delete('/api/credentials/:platform', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM credentials WHERE user_id=? AND platform=?').run(req.user.id, decodeURIComponent(req.params.platform));
  res.json({ success: true });
});

app.get('/api/credentials/:platform/config', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT config_json FROM credentials WHERE user_id=? AND platform=?').get(req.user.id, decodeURIComponent(req.params.platform));
  if (!row) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, config: JSON.parse(row.config_json) });
});

app.post('/api/credentials/:platform/test', authMiddleware, async (req, res) => {
  const platform = decodeURIComponent(req.params.platform);
  const creds = getUserCreds(req.user.id, platform);
  if (!creds) return res.status(400).json({ success: false, error: 'No credentials saved' });
  try {
    if (platform === 'YouTube Shorts') {
      const o = new google.auth.OAuth2(creds.client_id, creds.client_secret);
      o.setCredentials({ refresh_token: creds.refresh_token });
      const { token } = await o.getAccessToken();
      if (!token) throw new Error('Token refresh failed');
    } else if (platform === 'Instagram Reels') {
      const r = await axios.get('https://graph.facebook.com/v19.0/me', { params: { access_token: creds.access_token }, timeout: 10000 });
      if (!r.data.id) throw new Error('Invalid token');
    } else if (platform === 'X (Twitter)') {
      await new TwitterApi({ appKey: creds.api_key, appSecret: creds.api_secret, accessToken: creds.access_token, accessSecret: creds.access_token_secret }).v2.me();
    } else if (platform === 'Facebook') {
      const r = await axios.get(`https://graph.facebook.com/v19.0/${creds.page_id}`, { params: { access_token: creds.page_access_token, fields: 'id,name' }, timeout: 10000 });
      if (!r.data.id) throw new Error('Invalid page token');
    } else if (platform === 'LinkedIn') {
      const r = await axios.get('https://api.linkedin.com/v2/me', { headers: { Authorization: `Bearer ${creds.access_token}` }, timeout: 10000 });
      if (!r.data.id) throw new Error('Invalid token');
    } else if (platform === 'TikTok') {
      // TikTok token validation
    }
    res.json({ success: true, message: 'Credentials verified!' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', authMiddleware, (req, res) => {
  const uid = req.user.id;
  res.json({ success: true, stats: {
    total:     db.prepare('SELECT COUNT(*) as n FROM schedules WHERE user_id=?').get(uid).n,
    active:    db.prepare('SELECT COUNT(*) as n FROM schedules WHERE user_id=? AND active=1').get(uid).n,
    totalJobs: db.prepare("SELECT COUNT(*) as n FROM jobs WHERE user_id=? AND status='done'").get(uid).n,
    todayJobs: db.prepare("SELECT COUNT(*) as n FROM jobs WHERE user_id=? AND status='done' AND date(created_at)=date('now')").get(uid).n,
    posted:    db.prepare("SELECT COUNT(*) as n FROM postings p JOIN jobs j ON j.id=p.job_id WHERE j.user_id=? AND p.status='done'").get(uid).n,
  }});
});

// ── Schedules ─────────────────────────────────────────────────────────────────
function fmtSched(r) { return { ...r, platforms: JSON.parse(r.platforms||'[]'), freq_label: FREQ_LABELS[r.freq_type]||r.freq_type }; }

app.get('/api/schedules', authMiddleware, (_, res) => {
  res.json({ success: true, schedules: db.prepare('SELECT * FROM schedules WHERE user_id=? ORDER BY created_at DESC').all(_.user.id).map(fmtSched) });
});

app.post('/api/schedules', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const { name, category, subcategory, format='16:9', freq_type, freq_value, run_time='09:00', run_day=1, platforms=[] } = req.body||{};
  if (!name||!category||!subcategory||!freq_type) return res.status(400).json({ success:false, error:'name, category, subcategory, freq_type required' });
  const expr = buildCronExpr(freq_type, freq_value, run_time, run_day);
  if (!cron.validate(expr)) return res.status(400).json({ success:false, error:'Invalid schedule' });
  const nr = nextRun(expr);
  const id = db.prepare(`INSERT INTO schedules (user_id,name,category,subcategory,format,freq_type,freq_value,run_time,run_day,cron_expr,platforms,next_run) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid,name.trim(),category,subcategory,format,freq_type,freq_value||null,run_time,+run_day,expr,JSON.stringify(platforms),nr).lastInsertRowid;
  const s = db.prepare('SELECT * FROM schedules WHERE id=?').get(id);
  startCron(s);
  res.json({ success:true, schedule: fmtSched(s) });
});

app.put('/api/schedules/:id', authMiddleware, (req, res) => {
  const { id } = req.params; const uid = req.user.id;
  if (!db.prepare('SELECT id FROM schedules WHERE id=? AND user_id=?').get(+id, uid)) return res.status(404).json({ success:false, error:'Not found' });
  const { name, category, subcategory, format='16:9', freq_type, freq_value, run_time='09:00', run_day=1, platforms=[] } = req.body||{};
  const expr = buildCronExpr(freq_type, freq_value, run_time, run_day);
  const nr = nextRun(expr);
  db.prepare(`UPDATE schedules SET name=?,category=?,subcategory=?,format=?,freq_type=?,freq_value=?,run_time=?,run_day=?,cron_expr=?,platforms=?,next_run=? WHERE id=? AND user_id=?`)
    .run(name.trim(),category,subcategory,format,freq_type,freq_value||null,run_time,+run_day,expr,JSON.stringify(platforms),nr,+id,uid);
  const s = db.prepare('SELECT * FROM schedules WHERE id=?').get(+id);
  startCron(s);
  res.json({ success:true, schedule: fmtSched(s) });
});

app.patch('/api/schedules/:id/toggle', authMiddleware, (req, res) => {
  const uid = req.user.id; const s = db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=?').get(+req.params.id, uid);
  if (!s) return res.status(404).json({ success:false, error:'Not found' });
  const na = s.active ? 0 : 1;
  db.prepare('UPDATE schedules SET active=? WHERE id=?').run(na, s.id);
  const updated = db.prepare('SELECT * FROM schedules WHERE id=?').get(s.id);
  if (na) startCron(updated); else stopCron(uid, s.id);
  res.json({ success:true, active: na });
});

app.delete('/api/schedules/:id', authMiddleware, (req, res) => {
  const uid = req.user.id;
  stopCron(uid, +req.params.id);
  db.prepare('DELETE FROM schedules WHERE id=? AND user_id=?').run(+req.params.id, uid);
  res.json({ success:true });
});

app.post('/api/schedules/:id/run', authMiddleware, (req, res) => {
  const s = db.prepare('SELECT id FROM schedules WHERE id=? AND user_id=?').get(+req.params.id, req.user.id);
  if (!s) return res.status(404).json({ success:false, error:'Not found' });
  runSchedule(s.id).catch(console.error);
  res.json({ success:true, message:'Job started' });
});

// ── Debug / Diagnostics ──────────────────────────────────────────────────────
app.get('/api/debug/posting', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const creds = db.prepare('SELECT platform, updated_at FROM credentials WHERE user_id=?').all(uid);
  const jobs  = db.prepare(`SELECT j.id,j.status,j.video_url,j.created_at,j.error,s.name sname,s.platforms FROM jobs j JOIN schedules s ON s.id=j.schedule_id WHERE j.user_id=? ORDER BY j.created_at DESC LIMIT 5`).all(uid);
  res.json({
    service_key_set: !!SUPABASE_SERVICE_KEY,
    credentials_in_sqlite: creds,
    recent_jobs: jobs.map(j => ({
      id: j.id, schedule: j.sname, status: j.status, error: j.error,
      video_url: j.video_url, created_at: j.created_at,
      schedule_platforms: JSON.parse(j.platforms||'[]'),
      postings: db.prepare('SELECT platform,status,error,post_url FROM postings WHERE job_id=?').all(j.id)
    }))
  });
});

// Bulk credential push — called by frontend on login to ensure creds are in SQLite
app.post('/api/push-creds', authMiddleware, (req, res) => {
  const uid  = req.user.id;
  const list = req.body; // [{ platform, config }]
  if (!Array.isArray(list) || !list.length) return res.status(400).json({ success: false, error: 'Empty list' });
  const stmt = db.prepare(`INSERT OR REPLACE INTO credentials (user_id,platform,config_json,updated_at) VALUES (?,?,?,datetime('now'))`);
  let count = 0;
  for (const { platform, config } of list) {
    if (!platform || !config || !Object.keys(config).length) continue;
    stmt.run(uid, platform, typeof config === 'string' ? config : JSON.stringify(config));
    count++;
  }
  console.log(`[PUSH] ${count} credential(s) pushed for user ${uid}`);
  res.json({ success: true, count });
});

app.get('/api/jobs', authMiddleware, (req, res) => {
  const { schedule_id, limit=50 } = req.query; const uid = req.user.id;
  const rows = schedule_id
    ? db.prepare(`SELECT j.*,s.name as sname FROM jobs j JOIN schedules s ON s.id=j.schedule_id WHERE j.user_id=? AND j.schedule_id=? ORDER BY j.created_at DESC LIMIT ?`).all(uid,+schedule_id,+limit)
    : db.prepare(`SELECT j.*,s.name as sname FROM jobs j JOIN schedules s ON s.id=j.schedule_id WHERE j.user_id=? ORDER BY j.created_at DESC LIMIT ?`).all(uid,+limit);
  res.json({ success:true, jobs: rows.map(r => ({ ...r, options: r.options?JSON.parse(r.options):[], postings: db.prepare('SELECT * FROM postings WHERE job_id=?').all(r.id) })) });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n📅  Quiz Scheduler  →  http://localhost:${PORT}\n`);
  // On startup: sync all credentials from Supabase so cron jobs can post even after restarts
  await syncCredsFromSupabase();
  // Re-register all active cron jobs
  db.prepare('SELECT * FROM schedules WHERE active=1').all().forEach(startCron);
});
