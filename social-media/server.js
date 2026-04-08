require('dotenv').config();
const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const axios    = require('axios');
const FormData = require('form-data');
const { google } = require('googleapis');
const crypto = require('crypto');
const fs   = require('fs');
const path = require('path');

// ── Config ─────────────────────────────────────────────────────────────────────
const PORT     = process.env.PORT     || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── PKCE helpers ───────────────────────────────────────────────────────────────
function generateCodeVerifier()      { return crypto.randomBytes(48).toString('base64url'); }
function generateCodeChallenge(v)    { return crypto.createHash('sha256').update(v).digest('base64url'); }

// ── OAuth 1.0a helper (Twitter/X) ─────────────────────────────────────────────
function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g,'%21').replace(/\*/g,'%2A').replace(/'/g,'%27')
    .replace(/\(/g,'%28').replace(/\)/g,'%29');
}
function buildOAuth1Header(method, url, bodyParams, consumerKey, consumerSecret, token, tokenSecret) {
  const op = {
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        String(Math.floor(Date.now() / 1000)),
    oauth_token:            token,
    oauth_version:          '1.0',
  };
  const allParams = { ...op, ...(bodyParams || {}) };
  const paramStr  = Object.keys(allParams).sort()
    .map(k => `${percentEncode(k)}=${percentEncode(allParams[k])}`).join('&');
  const base       = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramStr)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret || '')}`;
  op.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  return 'OAuth ' + Object.entries(op).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>`${percentEncode(k)}="${percentEncode(v)}"`).join(', ');
}

// ── App setup ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded files publicly (needed for Instagram/TikTok URL-based uploads)
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Multer ─────────────────────────────────────────────────────────────────────
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ═══════════════════════════════════════════════════════════════════════════════
//  AI CONTENT GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

async function generateWithGroq(prompt, apiKey) {
  const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    { model:'llama-3.1-8b-instant', messages:[{role:'user',content:prompt}], temperature:0.7, max_tokens:700 },
    { headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json' } });
  return r.data.choices[0].message.content;
}

async function generateWithGemini(prompt, apiKey) {
  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    { contents:[{ parts:[{ text:prompt }] }] },
    { headers:{ 'Content-Type':'application/json' } });
  return r.data.candidates[0].content.parts[0].text;
}

async function generateWithHF(prompt, apiKey) {
  const r = await axios.post(
    'https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.3',
    { inputs:`<s>[INST] ${prompt} [/INST]`, parameters:{ max_new_tokens:700 } },
    { headers:{ Authorization:`Bearer ${apiKey}` } });
  return (r.data[0]?.generated_text || '').split('[/INST]').pop().trim();
}

async function generateWithOllama(prompt, baseUrl) {
  const r = await axios.post(`${baseUrl || 'http://localhost:11434'}/api/generate`,
    { model:'llama3', prompt, stream:false });
  return r.data.response;
}

app.post('/api/generate', async (req, res) => {
  const { videoTitle, niche, provider, apiKey, ollamaUrl } = req.body;
  if (!videoTitle) return res.status(400).json({ error: 'videoTitle required' });

  const prompt = `You are a viral social media expert. For a video titled "${videoTitle}" in the "${niche||'general'}" niche, generate platform-specific content optimized for each platform's algorithm and audience.

Return ONLY a valid JSON object with this exact structure (no markdown, no text outside JSON):
{
  "youtube": {
    "title": "catchy SEO title max 100 chars",
    "description": "engaging description 300-400 words with keywords naturally placed, include call-to-action and timestamps if relevant",
    "tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10"]
  },
  "instagram": {
    "caption": "engaging hook first line, then value, then call-to-action. 150-300 words. End with 25-30 relevant hashtags on new lines starting with #"
  },
  "facebook": {
    "title": "attention-grabbing title max 80 chars",
    "description": "conversational engaging post 100-200 words, ask a question, encourage shares"
  },
  "tiktok": {
    "title": "viral hook title max 100 chars, use trending language"
  },
  "twitter": {
    "tweet": "punchy engaging tweet max 250 chars with 2-3 relevant hashtags and a hook"
  },
  "linkedin": {
    "post": "professional insightful post 200-300 words. Start with a bold statement, share value/learnings, end with question to drive comments. Include 5 relevant hashtags at end."
  }
}`;

  try {
    let raw;
    switch(provider) {
      case 'groq':   raw = await generateWithGroq(prompt, apiKey); break;
      case 'gemini': raw = await generateWithGemini(prompt, apiKey); break;
      case 'hf':     raw = await generateWithHF(prompt, apiKey); break;
      case 'ollama': raw = await generateWithOllama(prompt, ollamaUrl); break;
      default: return res.status(400).json({ error: 'Unknown provider' });
    }
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: 'AI did not return JSON', raw });
    res.json(JSON.parse(m[0]));
  } catch(err) {
    console.error('AI error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  YOUTUBE
// ═══════════════════════════════════════════════════════════════════════════════

function ytOAuth(clientId, clientSecret) {
  return new google.auth.OAuth2(clientId, clientSecret, `${BASE_URL}/auth/youtube/callback`);
}

app.get('/auth/youtube', (req, res) => {
  const clientId     = req.query.client_id     || '';
  const clientSecret = req.query.client_secret || '';
  if (clientId && clientSecret) {
    const state  = Buffer.from(JSON.stringify({ clientId, clientSecret })).toString('base64url');
    const auth   = ytOAuth(clientId, clientSecret);
    return res.redirect(auth.generateAuthUrl({ access_type:'offline', scope:['https://www.googleapis.com/auth/youtube.upload'], prompt:'consent', state }));
  }
  res.send(authForm('YouTube', 'purple', `/auth/youtube`,
    [{ name:'client_id', label:'Client ID', placeholder:'xxxx.apps.googleusercontent.com' },
     { name:'client_secret', label:'Client Secret', placeholder:'GOCSPX-xxxx', type:'password' }],
    `<a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a> → Enable YouTube Data API v3 → Create OAuth Credentials (Web App)<br>Add redirect URI: <code>${BASE_URL}/auth/youtube/callback</code>`));
});

app.get('/auth/youtube/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(authError(error, '/auth/youtube'));
  if (!code || !state) return res.status(400).send(authError('Missing code/state', '/auth/youtube'));
  let clientId, clientSecret;
  try { ({ clientId, clientSecret } = JSON.parse(Buffer.from(state,'base64url').toString())); }
  catch { return res.status(400).send(authError('Invalid state', '/auth/youtube')); }
  try {
    const auth = ytOAuth(clientId, clientSecret);
    const { tokens } = await auth.getToken(code);
    if (!tokens.refresh_token) return res.send(`
      <div style="${PAGE_STYLE}"><h2 style="color:#f59e0b">No refresh token</h2>
      <p>Your account already authorized this app. Revoke access first:</p>
      <ol><li><a href="https://myaccount.google.com/permissions" style="color:#a78bfa" target="_blank">Google Account Permissions</a> → remove your app</li>
      <li><a href="/auth/youtube?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}" style="color:#a78bfa">Authorize again</a></li></ol></div>`);
    res.send(tokenPage('YouTube Authorized', 'YT_REFRESH_TOKEN', tokens.refresh_token, null));
  } catch(err) { res.status(500).send(authError(err.message, '/auth/youtube')); }
});

app.post('/api/upload/youtube', upload.single('video'), async (req, res) => {
  const { clientId, clientSecret, refreshToken, title, description, tags, privacyStatus } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No video file' });
  const videoPath = req.file.path;
  try {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const yt = google.youtube({ version:'v3', auth });
    const tagArr = typeof tags === 'string' ? tags.split(',').map(t=>t.trim()).filter(Boolean) : (Array.isArray(tags)?tags:[]);
    const r = await yt.videos.insert({
      part: ['snippet','status'],
      requestBody: {
        snippet: { title: title||'Untitled', description: description||'', tags: tagArr, categoryId:'22' },
        status:  { privacyStatus: privacyStatus||'public' },
      },
      media: { body: fs.createReadStream(videoPath) },
    });
    fs.unlinkSync(videoPath);
    res.json({ success:true, platform:'youtube', videoId:r.data.id, url:`https://www.youtube.com/watch?v=${r.data.id}` });
  } catch(err) {
    safeUnlink(videoPath);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FACEBOOK
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/upload/facebook', upload.single('video'), async (req, res) => {
  const { pageAccessToken, pageId, title, description } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No video file' });
  if (!pageAccessToken || !pageId) return res.status(400).json({ error: 'pageAccessToken and pageId required' });
  const videoPath = req.file.path;
  try {
    const fileSize = fs.statSync(videoPath).size;
    const initR = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/videos`,
      new URLSearchParams({ upload_phase:'start', file_size:String(fileSize), access_token:pageAccessToken }));
    const { upload_session_id } = initR.data;
    let startOff = parseInt(initR.data.start_offset), endOff = parseInt(initR.data.end_offset);
    while (startOff < fileSize) {
      const chunk = Buffer.alloc(endOff - startOff);
      const fd = fs.openSync(videoPath, 'r');
      fs.readSync(fd, chunk, 0, endOff - startOff, startOff);
      fs.closeSync(fd);
      const form = new FormData();
      form.append('upload_phase','transfer'); form.append('upload_session_id',upload_session_id);
      form.append('start_offset',String(startOff)); form.append('access_token',pageAccessToken);
      form.append('video_file_chunk', chunk, { filename:'chunk', contentType:'application/octet-stream' });
      const tR = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/videos`, form, { headers: form.getHeaders() });
      startOff = parseInt(tR.data.start_offset); endOff = parseInt(tR.data.end_offset);
    }
    const finR = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/videos`,
      new URLSearchParams({ upload_phase:'finish', upload_session_id, title:title||'', description:description||'', access_token:pageAccessToken }));
    fs.unlinkSync(videoPath);
    res.json({ success:true, platform:'facebook', videoId:finR.data.video_id, url:`https://www.facebook.com/${pageId}/videos/${finR.data.video_id}` });
  } catch(err) {
    safeUnlink(videoPath);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  INSTAGRAM REELS (via Facebook Graph API)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/upload/instagram', upload.single('video'), async (req, res) => {
  const { pageAccessToken, igUserId, description } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No video file' });
  if (!pageAccessToken || !igUserId) return res.status(400).json({ error: 'pageAccessToken and igUserId required' });
  const videoPath = req.file.path;
  // Rename to .mp4 so static serve works correctly
  const mp4Path = videoPath + '.mp4';
  fs.renameSync(videoPath, mp4Path);
  const filename   = path.basename(mp4Path);
  const publicUrl  = `${BASE_URL}/uploads/${filename}`;
  try {
    // 1. Create container
    const containerR = await axios.post(
      `https://graph.facebook.com/v19.0/${igUserId}/media`,
      { media_type:'REELS', video_url:publicUrl, caption:description||'', access_token:pageAccessToken },
      { headers:{ 'Content-Type':'application/json' } });
    const creationId = containerR.data.id;
    // 2. Poll for FINISHED
    let status = 'IN_PROGRESS', attempts = 0;
    while (status !== 'FINISHED' && attempts < 40) {
      await sleep(4000);
      const sr = await axios.get(`https://graph.facebook.com/v19.0/${creationId}`,
        { params:{ fields:'status_code', access_token:pageAccessToken } });
      status = sr.data.status_code;
      attempts++;
      if (status === 'ERROR') throw new Error('Instagram container processing error');
    }
    if (status !== 'FINISHED') throw new Error('Instagram container timed out');
    // 3. Publish
    const pubR = await axios.post(
      `https://graph.facebook.com/v19.0/${igUserId}/media_publish`,
      { creation_id:creationId, access_token:pageAccessToken },
      { headers:{ 'Content-Type':'application/json' } });
    // Cleanup after 30s (give Instagram time to fetch the video)
    setTimeout(() => safeUnlink(mp4Path), 30000);
    res.json({ success:true, platform:'instagram', mediaId:pubR.data.id, url:`https://www.instagram.com/` });
  } catch(err) {
    safeUnlink(mp4Path);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TIKTOK
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/auth/tiktok', (req, res) => {
  const clientKey    = req.query.client_key    || '';
  const clientSecret = req.query.client_secret || '';
  if (!clientKey || !clientSecret) {
    return res.send(authForm('TikTok', '#69c9d0', '/auth/tiktok',
      [{ name:'client_key', label:'Client Key', placeholder:'Your TikTok Client Key' },
       { name:'client_secret', label:'Client Secret', placeholder:'Your TikTok Client Secret', type:'password' }],
      `<a href="https://developers.tiktok.com/apps/" target="_blank">TikTok Developer Portal</a> → Create App → Add Content Posting API<br>Redirect URI: <code>${BASE_URL}/auth/tiktok/callback</code>`));
  }
  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const stateData     = Buffer.from(JSON.stringify({ clientKey, clientSecret, codeVerifier })).toString('base64url');
  const redirectUri   = encodeURIComponent(`${BASE_URL}/auth/tiktok/callback`);
  const scope         = encodeURIComponent('video.upload,video.publish');
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?client_key=${clientKey}&response_type=code&scope=${scope}&redirect_uri=${redirectUri}&state=${stateData}&code_challenge=${codeChallenge}&code_challenge_method=S256`);
});

app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(authError(error, '/auth/tiktok'));
  if (!code || !state) return res.status(400).send(authError('Missing code/state', '/auth/tiktok'));
  let clientKey, clientSecret, codeVerifier;
  try { ({ clientKey, clientSecret, codeVerifier } = JSON.parse(Buffer.from(state,'base64url').toString())); }
  catch { return res.status(400).send(authError('Invalid state', '/auth/tiktok')); }
  try {
    const r = await axios.post('https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({ client_key:clientKey, client_secret:clientSecret, code, grant_type:'authorization_code', redirect_uri:`${BASE_URL}/auth/tiktok/callback`, code_verifier:codeVerifier }),
      { headers:{ 'Content-Type':'application/x-www-form-urlencoded' } });
    res.send(tokenPage('TikTok Authorized', 'TIKTOK_ACCESS_TOKEN', r.data.access_token, { label:'TIKTOK_OPEN_ID', value:r.data.open_id }));
  } catch(err) { res.status(500).send(authError(err.response?.data?.message || err.message, '/auth/tiktok')); }
});

app.post('/api/upload/tiktok', upload.single('video'), async (req, res) => {
  const { accessToken, openId, title, privacyLevel } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No video file' });
  if (!accessToken || !openId) return res.status(400).json({ error: 'accessToken and openId required' });
  const videoPath = req.file.path;
  const mp4Path   = videoPath + '.mp4';
  fs.renameSync(videoPath, mp4Path);
  const publicUrl  = `${BASE_URL}/uploads/${path.basename(mp4Path)}`;
  try {
    // Use URL-based upload (simpler than chunked)
    const initR = await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      post_info: { title:(title||'My Video').slice(0,150), privacy_level:privacyLevel||'PUBLIC_TO_EVERYONE', disable_duet:false, disable_comment:false, disable_stitch:false },
      source_info: { source:'PULL_FROM_URL', video_url:publicUrl },
    }, { headers:{ Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json; charset=UTF-8' } });
    setTimeout(() => safeUnlink(mp4Path), 120000); // Cleanup after 2min
    res.json({ success:true, platform:'tiktok', publishId:initR.data.data.publish_id, note:'TikTok is processing your video.' });
  } catch(err) {
    safeUnlink(mp4Path);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TWITTER / X
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/upload/twitter', upload.single('video'), async (req, res) => {
  const { apiKey, apiSecret, accessToken, accessTokenSecret, tweetText } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No video file' });
  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret)
    return res.status(400).json({ error: 'All 4 Twitter credentials required' });
  const videoPath = req.file.path;
  try {
    const fileSize   = fs.statSync(videoPath).size;
    const UPLOAD_URL = 'https://upload.twitter.com/1.1/media/upload.json';
    const creds      = [apiKey, apiSecret, accessToken, accessTokenSecret];

    // INIT
    const initParams = { command:'INIT', total_bytes:String(fileSize), media_type:'video/mp4', media_category:'tweet_video' };
    const initHeader = buildOAuth1Header('POST', UPLOAD_URL, initParams, ...creds);
    const initR = await axios.post(UPLOAD_URL, new URLSearchParams(initParams),
      { headers:{ Authorization:initHeader, 'Content-Type':'application/x-www-form-urlencoded' } });
    const mediaId = initR.data.media_id_string;

    // APPEND (5 MB chunks)
    const CHUNK = 5 * 1024 * 1024;
    const chunks = Math.ceil(fileSize / CHUNK);
    for (let i = 0; i < chunks; i++) {
      const start = i * CHUNK, end = Math.min(start + CHUNK, fileSize);
      const buf = Buffer.alloc(end - start);
      const fd  = fs.openSync(videoPath, 'r');
      fs.readSync(fd, buf, 0, end - start, start);
      fs.closeSync(fd);
      const form = new FormData();
      form.append('command', 'APPEND'); form.append('media_id', mediaId);
      form.append('segment_index', String(i)); form.append('media', buf, { filename:'chunk.mp4', contentType:'video/mp4' });
      const appendHeader = buildOAuth1Header('POST', UPLOAD_URL, {}, ...creds);
      await axios.post(UPLOAD_URL, form, { headers:{ Authorization:appendHeader, ...form.getHeaders() } });
    }

    // FINALIZE
    const finalParams  = { command:'FINALIZE', media_id:mediaId };
    const finalHeader  = buildOAuth1Header('POST', UPLOAD_URL, finalParams, ...creds);
    const finalR = await axios.post(UPLOAD_URL, new URLSearchParams(finalParams),
      { headers:{ Authorization:finalHeader, 'Content-Type':'application/x-www-form-urlencoded' } });

    // Poll for processing
    if (finalR.data.processing_info?.state !== 'succeeded') {
      let state = finalR.data.processing_info?.state || 'pending';
      let polls = 0;
      while (state !== 'succeeded' && polls < 20) {
        await sleep((finalR.data.processing_info?.check_after_secs || 5) * 1000);
        const statusHeader = buildOAuth1Header('GET', UPLOAD_URL, {}, ...creds);
        const statusR = await axios.get(`${UPLOAD_URL}?command=STATUS&media_id=${mediaId}`,
          { headers:{ Authorization:statusHeader } });
        state = statusR.data.processing_info?.state;
        if (state === 'failed') throw new Error('Twitter media processing failed');
        polls++;
      }
    }

    // Post tweet
    const TWEET_URL    = 'https://api.twitter.com/2/tweets';
    const tweetHeader  = buildOAuth1Header('POST', TWEET_URL, {}, ...creds);
    const tweetR = await axios.post(TWEET_URL,
      { text:(tweetText||'').slice(0,280)||'Check out my latest video!', media:{ media_ids:[mediaId] } },
      { headers:{ Authorization:tweetHeader, 'Content-Type':'application/json' } });

    fs.unlinkSync(videoPath);
    res.json({ success:true, platform:'twitter', tweetId:tweetR.data.data?.id,
      url:tweetR.data.data?.id ? `https://twitter.com/i/web/status/${tweetR.data.data.id}` : 'Posted' });
  } catch(err) {
    safeUnlink(videoPath);
    res.status(500).json({ error: err.response?.data?.detail || err.response?.data?.errors?.[0]?.message || err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  LINKEDIN
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/auth/linkedin', (req, res) => {
  const clientId     = req.query.client_id     || '';
  const clientSecret = req.query.client_secret || '';
  if (!clientId || !clientSecret) {
    return res.send(authForm('LinkedIn', '#0a66c2', '/auth/linkedin',
      [{ name:'client_id', label:'Client ID', placeholder:'Your LinkedIn App Client ID' },
       { name:'client_secret', label:'Client Secret', placeholder:'Your LinkedIn App Client Secret', type:'password' }],
      `<a href="https://www.linkedin.com/developers/apps/new" target="_blank">LinkedIn Developer Apps</a> → Create App → Request r_liteprofile, w_member_social<br>Redirect URI: <code>${BASE_URL}/auth/linkedin/callback</code>`));
  }
  const state = Buffer.from(JSON.stringify({ clientId, clientSecret })).toString('base64url');
  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(`${BASE_URL}/auth/linkedin/callback`)}&state=${state}&scope=openid%20profile%20w_member_social%20r_basicprofile`);
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(authError(error, '/auth/linkedin'));
  if (!code || !state) return res.status(400).send(authError('Missing code/state', '/auth/linkedin'));
  let clientId, clientSecret;
  try { ({ clientId, clientSecret } = JSON.parse(Buffer.from(state,'base64url').toString())); }
  catch { return res.status(400).send(authError('Invalid state', '/auth/linkedin')); }
  try {
    const r = await axios.post('https://www.linkedin.com/oauth/v2/accessToken',
      new URLSearchParams({ grant_type:'authorization_code', code, redirect_uri:`${BASE_URL}/auth/linkedin/callback`, client_id:clientId, client_secret:clientSecret }),
      { headers:{ 'Content-Type':'application/x-www-form-urlencoded' } });
    // Fetch person URN
    const profile = await axios.get('https://api.linkedin.com/v2/userinfo',
      { headers:{ Authorization:`Bearer ${r.data.access_token}` } });
    const sub = profile.data.sub; // person URN suffix
    res.send(tokenPage('LinkedIn Authorized', 'LINKEDIN_ACCESS_TOKEN', r.data.access_token,
      { label:'LINKEDIN_PERSON_URN', value:`urn:li:person:${sub}` }));
  } catch(err) { res.status(500).send(authError(err.response?.data?.message || err.message, '/auth/linkedin')); }
});

app.post('/api/upload/linkedin', upload.single('video'), async (req, res) => {
  const { accessToken, personUrn, title, description } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No video file' });
  if (!accessToken || !personUrn) return res.status(400).json({ error: 'accessToken and personUrn required' });
  const videoPath = req.file.path;
  try {
    const liHeaders = { Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json', 'X-Restli-Protocol-Version':'2.0.0' };
    // 1. Register upload
    const regR = await axios.post('https://api.linkedin.com/v2/assets?action=registerUpload', {
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-video'],
        owner: personUrn,
        serviceRelationships: [{ relationshipType:'OWNER', identifier:'urn:li:userGeneratedContent' }],
      },
    }, { headers: liHeaders });
    const uploadUrl  = regR.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    const assetUrn   = regR.data.value.asset;

    // 2. Upload video
    await axios.put(uploadUrl, fs.createReadStream(videoPath),
      { headers:{ 'Content-Type':'video/mp4', Authorization:`Bearer ${accessToken}` }, maxBodyLength:Infinity });

    // 3. Create post
    const postR = await axios.post('https://api.linkedin.com/v2/ugcPosts', {
      author: personUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: description||'' },
          shareMediaCategory: 'VIDEO',
          media: [{ status:'READY', description:{ text:(description||'').substring(0,200) }, media:assetUrn, title:{ text:title||'Video' } }],
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility':'PUBLIC' },
    }, { headers: liHeaders });

    fs.unlinkSync(videoPath);
    const postId = postR.headers['x-restli-id'] || postR.data?.id || '';
    res.json({ success:true, platform:'linkedin', postId, url:'https://www.linkedin.com/feed/' });
  } catch(err) {
    safeUnlink(videoPath);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  HTML HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const PAGE_STYLE = 'font-family:sans-serif;background:#0f0f1a;color:#e2e0ff;padding:2rem;min-height:100vh;margin:0';

function authForm(platform, color, action, fields, hint) {
  const inputs = fields.map(f => `
    <label style="display:block;font-size:12px;color:#8884a8;margin-top:12px;margin-bottom:4px">${f.label}</label>
    <input name="${f.name}" type="${f.type||'text'}" placeholder="${f.placeholder}" required
      style="width:100%;padding:8px 12px;background:#0f0f1a;border:1px solid #2a2a3a;border-radius:8px;color:#e2e0ff;font-size:13px;box-sizing:border-box" />`).join('');
  return `<!DOCTYPE html><html><head><title>${platform} Auth</title></head>
<body style="${PAGE_STYLE};display:flex;align-items:center;justify-content:center">
<div style="background:#1a1a26;border:1px solid #2a2a3a;border-radius:12px;padding:2rem;width:440px;max-width:95vw">
  <h2 style="margin:0 0 1rem;color:${color}">${platform} OAuth Setup</h2>
  <form method="GET" action="${action}">${inputs}
    <button type="submit" style="margin-top:1.25rem;width:100%;padding:10px;background:${color};border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Authorize →</button>
  </form>
  <p style="font-size:12px;color:#8884a8;margin-top:1rem">${hint}</p>
  <p style="font-size:12px;margin-top:.5rem"><a href="/" style="color:#a78bfa">← Back to app</a></p>
</div></body></html>`;
}

function tokenPage(title, key1, val1, extra) {
  const extraHtml = extra ? `
    <p style="font-size:12px;color:#8884a8;margin-top:1rem">Also paste as <strong>${extra.label}</strong>:</p>
    <code id="extra" style="display:block;background:#0f0f1a;padding:10px;border-radius:8px;word-break:break-all;font-size:12px;color:#a78bfa;border:1px solid #2a2a3a">${extra.value}</code>
    <button onclick="navigator.clipboard.writeText('${extra.value.replace(/'/g,"\\'")}');this.textContent='Copied!'" style="margin-top:4px;padding:6px 14px;background:#6c63ff;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:12px">Copy</button>` : '';
  return `<!DOCTYPE html><html><head><title>${title}</title></head>
<body style="${PAGE_STYLE};display:flex;align-items:center;justify-content:center">
<div style="background:#1a1a26;border:1px solid #10b981;border-radius:12px;padding:2rem;width:540px;max-width:95vw">
  <h2 style="color:#10b981;margin:0 0 1rem">✓ ${title}</h2>
  <p style="font-size:12px;color:#8884a8">Copy this as <strong>${key1}</strong> in your .env:</p>
  <code style="display:block;background:#0f0f1a;padding:10px;border-radius:8px;word-break:break-all;font-size:12px;color:#a78bfa;border:1px solid #2a2a3a;margin:4px 0">${val1}</code>
  <button onclick="navigator.clipboard.writeText('${val1.replace(/'/g,"\\'")}');this.textContent='Copied!'" style="padding:6px 14px;background:#6c63ff;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:12px">Copy</button>
  ${extraHtml}
  <p style="font-size:13px;color:#8884a8;margin-top:1rem">Close this tab and return to the app.</p>
  <a href="/" style="color:#a78bfa;font-size:13px">← Back to app</a>
</div></body></html>`;
}

function authError(msg, retryUrl) {
  return `<div style="${PAGE_STYLE}"><h2 style="color:#ef4444">Auth Error</h2><p style="color:#8884a8">${msg}</p><a href="${retryUrl}" style="color:#a78bfa">Try again</a> · <a href="/" style="color:#a78bfa">Back to app</a></div>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function safeUnlink(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Social Media Uploader → http://localhost:${PORT}`);
  console.log(`  BASE_URL: ${BASE_URL}`);
  console.log(`  Auth flows: /auth/youtube  /auth/tiktok  /auth/linkedin\n`);
});
