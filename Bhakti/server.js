'use strict';
const express   = require('express');
const multer    = require('multer');
const cors      = require('cors');
const { spawn } = require('child_process');
const { promisify } = require('util');
const { exec }  = require('child_process');
const execAsync = promisify(exec);
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const app  = express();
const PORT = process.env.PORT || 3007;

const VOICE_EN = 'en-IN-NeerjaExpressiveNeural';
const VOICE_HI = 'hi-IN-SwaraNeural';

const GROQ_API_KEY       = process.env.GROQ_API_KEY;
const HIGGSFIELD_TOKEN   = process.env.HIGGSFIELD_TOKEN;
const BACKEND_URL        = (process.env.BACKEND_URL || 'https://ai-bhakti-production.up.railway.app').replace(/\/$/, '');

// ─── Higgsfield REST API (pure Node.js — no CLI needed) ───────────────
const HF_API = 'https://fnf.higgsfield.ai/agents';
let _hfToken = HIGGSFIELD_TOKEN || '';
let _hfRefresh = process.env.HIGGSFIELD_REFRESH_TOKEN || '';

async function hfRefreshToken() {
  if (!_hfRefresh) return;
  try {
    const resp = await fetch(`${HF_API}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: _hfRefresh }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.access_token) { _hfToken = data.access_token; console.log('[hf] Token refreshed'); }
    }
  } catch {}
}

async function hfFetch(path, opts = {}) {
  const doRequest = async () => fetch(`${HF_API}${path}`, {
    ...opts,
    headers: { 'Authorization': `Bearer ${_hfToken}`, ...(opts.headers || {}) },
  });
  let resp = await doRequest();
  if (resp.status === 401) { await hfRefreshToken(); resp = await doRequest(); }
  return resp;
}

// Upload an image file to Higgsfield, return the upload UUID
async function hfUploadImage(imgPath) {
  // Step 1: create upload slot
  const slotResp = await hfFetch('/uploads?type=image', { method: 'POST' });
  if (!slotResp.ok) throw new Error(`HF upload slot: ${slotResp.status} ${await slotResp.text()}`);
  const { id: uploadId, upload_url } = await slotResp.json();
  // Step 2: PUT binary to the pre-signed URL
  const imgBuf = fs.readFileSync(imgPath);
  const ext = path.extname(imgPath).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/jpeg';
  const putResp = await fetch(upload_url, { method: 'PUT', body: imgBuf, headers: { 'Content-Type': mime } });
  if (!putResp.ok) throw new Error(`HF upload PUT: ${putResp.status}`);
  console.log(`[hf] Uploaded image → ${uploadId}`);
  return uploadId;
}

// Create a Seedance 2.0 image-to-video job, poll until done, return result URL
async function hfGenerateVideo(prompt, uploadId, aspectRatio = '9:16', durationSec = 5) {
  const body = {
    job_set_type: 'seedance_2_0',
    params: {
      prompt,
      aspect_ratio: aspectRatio,
      duration: durationSec,
      generate_audio: true,
      medias: [{ role: 'start_image', id: uploadId }],
    },
  };
  const createResp = await hfFetch('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!createResp.ok) throw new Error(`HF create job: ${createResp.status} ${await createResp.text()}`);
  const job = await createResp.json();
  const jobId = job.id || (Array.isArray(job) && job[0]);
  if (!jobId) throw new Error(`HF create job: no id in response: ${JSON.stringify(job).slice(0, 200)}`);
  console.log(`[hf] Job created: ${jobId}`);

  // Poll every 5s for up to 8 min
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const pollResp = await hfFetch(`/jobs/${jobId}`);
    if (!pollResp.ok) continue;
    const status = await pollResp.json();
    const s = status.status;
    console.log(`[hf] Job ${jobId}: ${s}`);
    if (s === 'completed') return status.result_url;
    if (s === 'failed' || s === 'error') throw new Error(`HF job ${jobId} failed: ${JSON.stringify(status).slice(0, 200)}`);
  }
  throw new Error(`HF job ${jobId} timed out after 8 min`);
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/out', express.static(path.join(__dirname, 'out')));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ─── Language detection ──────────────────────────────────────────────
function isHindi(text) {
  const devanagari = (text.match(/[\u0900-\u097F]/g) || []).length;
  const nonSpace   = text.replace(/\s/g, '').length;
  return nonSpace > 0 && devanagari / nonSpace > 0.1;
}

// ─── TTS sanitizer ────────────────────────────────────────────────────
// Only used for edge-tts input — NOT for subtitle display
function sanitizeForTts(text, hindi) {
  let s = text
    .replace(/[\u2018\u2019\u02BC\u02B9]/g, "'")
    .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u2023\u25E6\u2043]/g, '.');
  if (hindi) {
    s = s.replace(/।/g, '. ')                      // danda → period for TTS
         .replace(/[^\x20-\x7E\u0900-\u097F]/g, ' '); // keep Devanagari
  } else {
    s = s.replace(/[^\x20-\x7E]/g, ' ');           // ASCII only
  }
  return s.replace(/  +/g, ' ').trim();
}

// ─── Segment splitter ─────────────────────────────────────────────────
// Returns [{display, tts}] — display = original text shown in subtitles
// tts = sanitized version sent to edge-tts only
function makeSegments(text, maxLen = 150) {
  const hindi = isHindi(text);

  // Split at natural sentence boundaries, preserving original chars
  const rawParts = hindi
    ? text.split(/(?<=।)\s*|(?<=[!?।])\s+/).filter(s => s.trim())
    : text.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  const parts = rawParts.length > 0 ? rawParts : [text];

  const result = [];
  for (const part of parts) {
    const display = part.trim();
    if (!display) continue;
    const tts = sanitizeForTts(display, hindi);
    if (!tts) continue;

    // If TTS text fits within maxLen, keep as single segment
    if (tts.length <= maxLen) {
      result.push({ display, tts });
      continue;
    }

    // Sub-split long sentences at word boundaries
    // Keep display words paired with tts words (same count because
    // sanitization only replaces individual characters, not words)
    const dWords = display.split(/\s+/);
    const tWords = tts.split(/\s+/);
    const n = Math.min(dWords.length, tWords.length);
    let dChunk = [], tChunk = [], tLen = 0;
    for (let i = 0; i < n; i++) {
      const tw = tWords[i], dw = dWords[i];
      if (tLen + tw.length + 1 > maxLen && tChunk.length) {
        result.push({ display: dChunk.join(' '), tts: tChunk.join(' ') });
        dChunk = []; tChunk = []; tLen = 0;
      }
      dChunk.push(dw); tChunk.push(tw); tLen += tw.length + 1;
    }
    if (tChunk.length) result.push({ display: dChunk.join(' '), tts: tChunk.join(' ') });
  }

  return result.length
    ? result
    : [{ display: text.trim(), tts: sanitizeForTts(text, hindi) }];
}

// ─── TTS with retry / back-off (handles Microsoft 503 rate-limits) ───
async function runEdgeTts(text, outputPath, voice, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 3000;   // 3 s, 6 s back-off
      console.log(`[bhakti] TTS attempt ${attempt + 1}/${maxRetries}, waiting ${wait}ms…`);
      await new Promise(r => setTimeout(r, wait));
    }
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn('python', ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', outputPath]);
        let stderr = '';
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`edge-tts failed: ${stderr}`))));
        proc.on('error', reject);
      });
      return;  // success
    } catch (err) {
      lastErr = err;
      console.warn(`[bhakti] TTS attempt ${attempt + 1} failed: ${err.message.slice(0, 120)}`);
    }
  }
  throw lastErr;
}

// ─── Audio duration ───────────────────────────────────────────────────
async function getAudioDuration(filePath) {
  const fp = filePath.replace(/\\/g, '/');
  const { stdout } = await execAsync(
    `python -c "from mutagen.mp3 import MP3; print(MP3(r'${fp}').info.length)"`,
    { timeout: 10_000 }
  );
  return parseFloat(stdout.trim());
}

// ─── Generate narration; returns [{display, tts, start, end}] ────────
// display = original text for subtitles  |  tts = sanitized for audio
async function generateNarration(storyText, audioOutPath, forceVoice = null) {
  // Prefer Hindi voice for Hindi text, but fall back to English if Hindi TTS fails
  // (some hosting IPs are rate-limited by Microsoft for hi-IN voices)
  const preferHindi = isHindi(storyText);
  const voice       = forceVoice || (preferHindi ? VOICE_HI : VOICE_EN);
  const segments = makeSegments(storyText);
  console.log(`[bhakti] Narration: ${segments.length} segment(s), voice=${voice}`);
  segments.forEach((s, i) =>
    console.log(`[bhakti]   [${i + 1}] display="${s.display.slice(0, 60)}" tts="${s.tts.slice(0, 60)}"`)
  );

  if (segments.length === 0) throw new Error('Story text is empty after sanitisation.');

  if (segments.length === 1) {
    await runEdgeTts(segments[0].tts, audioOutPath, voice);
    const dur = await getAudioDuration(audioOutPath);
    return [{ display: segments[0].display, tts: segments[0].tts, start: 0, end: dur }];
  }

  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'bhakti_seg_'));
  const segFiles = [];
  const timings  = [];
  let   currentTime = 0;

  try {
    for (let i = 0; i < segments.length; i++) {
      const segPath = path.join(tmpDir, `seg_${i}.mp3`);
      await runEdgeTts(segments[i].tts, segPath, voice);
      const dur = await getAudioDuration(segPath);
      timings.push({ display: segments[i].display, tts: segments[i].tts, start: currentTime, end: currentTime + dur });
      currentTime += dur;
      segFiles.push(segPath);
    }

    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, segFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c', 'copy', '-y', audioOutPath,
      ]);
      let stderr = '';
      ff.stderr.on('data', d => (stderr += d.toString()));
      ff.on('close', code =>
        code === 0 ? resolve() : reject(new Error(`FFmpeg audio concat failed: ${stderr.slice(-400)}`))
      );
      ff.on('error', reject);
    });

    return timings;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Wrapper: try Hindi voice first; if it fails fall back to English voice
async function generateNarrationWithFallback(storyText, audioOutPath) {
  const preferHindi = isHindi(storyText);
  if (!preferHindi) return generateNarration(storyText, audioOutPath, VOICE_EN);
  try {
    return await generateNarration(storyText, audioOutPath, VOICE_HI);
  } catch (err) {
    console.warn(`[bhakti] Hindi voice failed (${err.message.slice(0, 80)}), falling back to English voice…`);
    return generateNarration(storyText, audioOutPath, VOICE_EN);
  }
}

// ─── Single-shot TTS for song lyrics (no segmentation) ───────────────
// Song lyrics can be long but we send as one call to avoid sequential
// rate-limit hits from many small segment calls.
// espeak-ng — fully offline TTS, works regardless of server IP
async function runEspeakTts(text, outputPath, lang = 'hi') {
  const wavOut = outputPath.replace(/\.mp3$/, '.wav');
  await new Promise((resolve, reject) => {
    // Use stdin to avoid UTF-8 file encoding issues on some systems
    // -p 65: higher pitch (more melodic/feminine, default 50)
    // -s 115: slower speed (more musical pacing, default 175)
    // -a 160: slightly louder amplitude
    const proc = spawn('espeak-ng', ['-v', `${lang}+f3`, '-p', '65', '-s', '115', '-a', '160', '-w', wavOut]);
    let stderr = '';
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.stdin.write(text, 'utf8');
    proc.stdin.end();
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`espeak-ng: ${stderr.slice(-300)}`)));
    proc.on('error', reject);
  });
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-i', wavOut, '-codec:a', 'libmp3lame', '-b:a', '128k', outputPath]);
    let stderr = '';
    ff.stderr.on('data', d => (stderr += d.toString()));
    ff.on('close', code => {
      try { fs.unlinkSync(wavOut); } catch {}
      code === 0 ? resolve() : reject(new Error(`ffmpeg wav→mp3: ${stderr.slice(-200)}`));
    });
    ff.on('error', reject);
  });
}

// Google TTS fallback — works for Hindi from any server IP
async function runGTts(text, outputPath, lang = 'hi') {
  const tmpTxt = outputPath + '.gtts_in.txt';
  fs.writeFileSync(tmpTxt, text, 'utf8');
  await new Promise((resolve, reject) => {
    const proc = spawn('python3', [
      '-c',
      `import sys; from gtts import gTTS; gTTS(open(sys.argv[1], encoding='utf-8').read(), lang=sys.argv[2]).save(sys.argv[3])`,
      tmpTxt, lang, outputPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => {
      try { fs.unlinkSync(tmpTxt); } catch {}
      code === 0 ? resolve() : reject(new Error(`gTTS(${lang}) failed: ${stderr.slice(-400)}`));
    });
    proc.on('error', reject);
  });
}

// ─── Bhakti tanpura drone music using FFmpeg sine generators ─────────
// Creates a spiritual tanpura-like drone (SA, PA, SA octaves) with echo
// entirely offline — no network required.
async function generateBhaktiDrone(durationSec, outputPath) {
  const dur = Math.ceil(durationSec) + 2; // generate slightly longer, trim at end
  // Tanpura frequencies: low SA (C3), low PA (G3), SA (C4), PA (G4), high SA (C5)
  const tones = [
    [130.81, 0.55],  // C3 — low SA (foundation)
    [196.00, 0.40],  // G3 — low PA
    [261.63, 0.70],  // C4 — SA (main)
    [392.00, 0.38],  // G4 — PA
    [523.25, 0.30],  // C5 — high SA (shimmer)
  ];
  const inputs = tones.flatMap(([freq]) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`]);
  const volChain = tones.map(([, v], i) => `[${i}]volume=${v}[a${i}]`).join(';');
  const labels   = tones.map((_, i) => `[a${i}]`).join('');
  const fadeStart = Math.max(0.5, durationSec - 2.0).toFixed(1);
  const filterComplex = [
    volChain,
    `${labels}amix=inputs=${tones.length}:normalize=0[m]`,
    `[m]aecho=0.65:0.75:250|550|1100:0.55|0.38|0.22[e]`,
    `[e]lowpass=f=2000[l]`,
    `[l]afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeStart}:d=2.0[out]`,
  ].join(';');

  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-t', durationSec.toString(),
      '-y', outputPath,
    ]);
    let stderr = '';
    ff.stderr.on('data', d => (stderr += d.toString()));
    ff.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`Bhakti drone gen failed: ${stderr.slice(-500)}`))
    );
    ff.on('error', reject);
  });
}

async function generateSongNarration(lyricsText, audioOutPath) {
  // Song lyrics are always Hindi bhakti — always keep Devanagari, never strip to ASCII
  const tts = sanitizeForTts(lyricsText, true);
  if (!tts.trim()) throw new Error('Lyrics are empty after sanitisation.');
  console.log(`[song] TTS input: ${tts.length} chars, first20="${tts.slice(0, 20)}"`);

  // Try Hindi edge-tts voices first (1 attempt only — these are typically blocked on Railway)
  for (const voice of ['hi-IN-MadhurNeural', 'hi-IN-SwaraNeural']) {
    try {
      console.log(`[song] edge-tts, voice=${voice}`);
      await runEdgeTts(tts, audioOutPath, voice, 1); // maxRetries=1: fail fast
      const dur = await getAudioDuration(audioOutPath);
      console.log(`[song] edge-tts done — ${dur.toFixed(1)}s`);
      return dur;
    } catch (err) {
      console.warn(`[song] Voice ${voice} failed: ${err.message.slice(0, 80)}`);
    }
  }

  // Fallback 1: espeak-ng — fully offline, works from any server IP
  console.log('[song] Falling back to espeak-ng (offline, hi)…');
  try {
    await runEspeakTts(tts, audioOutPath, 'hi');
    const dur = await getAudioDuration(audioOutPath);
    console.log(`[song] espeak-ng done — ${dur.toFixed(1)}s`);
    return dur;
  } catch (err) {
    console.warn(`[song] espeak-ng failed: ${err.message.slice(0, 200)}`);
  }

  // Fallback 2: Google TTS
  console.log('[song] Falling back to gTTS (hi)…');
  try {
    await runGTts(tts, audioOutPath, 'hi');
    const dur = await getAudioDuration(audioOutPath);
    console.log(`[song] gTTS done — ${dur.toFixed(1)}s`);
    return dur;
  } catch (err) {
    console.warn(`[song] gTTS(hi) failed: ${err.message.slice(0, 300)}`);
  }

  throw new Error('All TTS engines failed for song narration. Please try again later.');
}

// ─── xfade transitions pool (spiritual / cinematic) ──────────────────
const XFADE_POOL = [
  'fade', 'fadeblack', 'fadewhite', 'dissolve',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'smoothleft', 'smoothright',
  'circleopen', 'circleclose', 'distance', 'radial',
  'diagtl', 'diagtr', 'diagbl', 'diagbr',
];

function pickTransitions(count) {
  // Shuffle pool and cycle through for variety — never the same back-to-back
  const shuffled = [...XFADE_POOL].sort(() => Math.random() - 0.5);
  const out = [];
  for (let i = 0; i < count; i++) out.push(shuffled[i % shuffled.length]);
  return out;
}

// ─── Video generation: xfade slideshow, audio only — no subtitles ────
async function generateVideo(storyText, imagePaths, outputPath, format = '16:9') {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'bhakti_vid_'));
  const audioPath = path.join(tmpDir, 'narration.mp3');

  try {
    const timings  = await generateNarrationWithFallback(storyText, audioPath);
    const totalDur = timings[timings.length - 1].end;

    const portrait   = format === '9:16';
    const W          = portrait ? 720  : 1280;
    const H          = portrait ? 1280 : 720;
    const n          = imagePaths.length;
    const TRANSITION = n > 1 ? Math.min(0.8, (totalDur / n) * 0.15) : 0;
    const imgDur     = n > 1 ? (totalDur + (n - 1) * TRANSITION) / n : totalDur;

    const scale      = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=#1a0a2e`;

    // Pick a unique random transition for each image pair
    const transitions = pickTransitions(n - 1);

    const filterParts = [];

    if (n === 1) {
      filterParts.push(`[0]${scale},fps=25[v]`);
    } else {
      for (let i = 0; i < n; i++) {
        filterParts.push(`[${i}]${scale},fps=25[s${i}]`);
      }
      let lastLabel = 's0';
      for (let i = 1; i < n; i++) {
        const offset   = (i * (imgDur - TRANSITION)).toFixed(3);
        const outLabel = i === n - 1 ? 'v' : `x${i}`;
        const tr       = transitions[i - 1];
        filterParts.push(
          `[${lastLabel}][s${i}]xfade=transition=${tr}:duration=${TRANSITION.toFixed(3)}:offset=${offset}[${outLabel}]`
        );
        lastLabel = outLabel;
      }
    }

    const inputArgs = [];
    for (const imgPath of imagePaths) {
      inputArgs.push('-loop', '1', '-t', imgDur.toFixed(3), '-i', imgPath);
    }

    const args = [
      ...inputArgs,
      '-i', audioPath,
      '-filter_complex', filterParts.join(';'),
      '-map', '[v]',
      '-map', `${n}:a`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '25',
      '-c:a', 'aac', '-b:a', '128k',
      '-t', totalDur.toFixed(3),
      '-y', outputPath,
    ];

    console.log(`[bhakti] transitions: ${transitions.join(', ')}`);

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args);
      let stderr = '';
      ff.stderr.on('data', d => (stderr += d.toString()));
      ff.on('close', code =>
        code === 0 ? resolve() : reject(new Error(`FFmpeg video failed: ${stderr.slice(-1200)}`))
      );
      ff.on('error', reject);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Groq: generate Hindi bhakti song lyrics ─────────────────────────
async function generateHindiLyrics(deity, theme, mood) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured on server.');
  const subject = deity ? `deity/devta: ${deity}` : `theme: ${theme}`;
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You are a master Hindi bhakti poet. Write only in Hindi Devanagari script. Produce beautifully rhythmic, devotional song lyrics that can be sung as a bhajan or geet.',
        },
        {
          role: 'user',
          content: `Write a complete Hindi bhakti geet (song) about ${subject}.\nMood: ${mood || 'शांत, भक्तिमय, दिव्य'}.\n\nFormat (use these section labels in Hindi):\n- मुखड़ा (refrain, 2-4 lines) — repeat after each verse\n- अंतरा १ (verse 1, 4-6 lines)\n- मुखड़ा\n- अंतरा २ (verse 2, 4-6 lines)\n- मुखड़ा\n- अंतरा ३ (verse 3, 4-6 lines)\n- मुखड़ा\n\nWrite ONLY in Hindi Devanagari. Make the lyrics melodious, devotional and deeply spiritual.`,
        },
      ],
      max_tokens: 1200,
      temperature: 0.85,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Groq error ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

// ─── Higgsfield image-to-video (Seedance 2.0 via REST API) ───────────
// No CLI required — uses pure Node.js fetch calls.
async function animateImageHighgsfield(imgPath, prompt, aspectRatio) {
  console.log(`[song] Higgsfield Seedance 2.0 — uploading image…`);
  const uploadId = await hfUploadImage(imgPath);
  console.log(`[song] Higgsfield — creating video job…`);
  const resultUrl = await hfGenerateVideo(prompt, uploadId, aspectRatio, 5);
  console.log(`[song] Higgsfield — video ready: ${resultUrl}`);
  return resultUrl;
}

// FFmpeg fallback: fast crop-pan animation
async function animateImageFfmpeg(imgPath, idx, durationSec, W, H, fps, outPath) {
  const TYPES = ['pan-lr', 'pan-rl', 'pan-tb', 'pan-bt', 'diag', 'static'];
  const type = TYPES[idx % TYPES.length];
  const BW = Math.round(W * 1.2), BH = Math.round(H * 1.2);
  const dx = BW - W, dy = BH - H;
  const dur = durationSec.toFixed(3);
  let vf;
  switch (type) {
    case 'pan-lr': vf = `scale=${BW}:${BH},crop=${W}:${H}:'min(${dx}\\,${dx}*n/(${fps}*${dur}))':${Math.round(dy/2)}`; break;
    case 'pan-rl': vf = `scale=${BW}:${BH},crop=${W}:${H}:'max(0\\,${dx}-${dx}*n/(${fps}*${dur}))':${Math.round(dy/2)}`; break;
    case 'pan-tb': vf = `scale=${BW}:${BH},crop=${W}:${H}:${Math.round(dx/2)}:'min(${dy}\\,${dy}*n/(${fps}*${dur}))'`; break;
    case 'pan-bt': vf = `scale=${BW}:${BH},crop=${W}:${H}:${Math.round(dx/2)}:'max(0\\,${dy}-${dy}*n/(${fps}*${dur}))'`; break;
    case 'diag':   vf = `scale=${BW}:${BH},crop=${W}:${H}:'min(${dx}\\,${dx}*n/(${fps}*${dur}))':'min(${dy}\\,${dy}*n/(${fps}*${dur}))'`; break;
    default:       vf = `scale=${W}:${H},crop=${W}:${H}`; break;
  }
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-loop', '1', '-i', imgPath, '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', fps.toString(), '-t', dur, '-y', outPath]);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 10000) stderr = stderr.slice(-5000); });
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg animate: ${stderr.slice(-600)}`)));
    ff.on('error', reject);
  });
}

// ─── Full song video pipeline ──────────────────────────────────────────
// 1. TTS lyrics → audio (espeak-ng offline fallback)
// 2. Higgsfield Seedance 2.0 animates each image (falls back to FFmpeg crop-pan)
// 3. Download clips → xfade concat → mux audio → final MP4
async function generateSongVideo(lyricsText, imagePaths, outputPath, format = '9:16') {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'bhakti_song_'));
  const audioPath = path.join(tmpDir, 'song.mp3');

  try {
    // Step 1: TTS
    console.log('[song] Generating TTS audio…');
    const rawDur   = await generateSongNarration(lyricsText, audioPath);
    const totalDur = Math.max(5.0, rawDur);
    console.log(`[song] Audio: ${rawDur.toFixed(1)}s (effective: ${totalDur.toFixed(1)}s)`);

    if (rawDur < totalDur) {
      const padded = audioPath + '_pad.mp3';
      await execAsync(`ffmpeg -y -i "${audioPath}" -af "apad=whole_dur=${totalDur}" "${padded}"`);
      fs.renameSync(padded, audioPath);
    }

    const portrait    = format === '9:16';
    const aspectRatio = portrait ? '9:16' : '16:9';
    const W = portrait ? 720 : 1280, H = portrait ? 1280 : 720, FPS = 15;
    const n = imagePaths.length;
    const XFADE_DUR = n > 1 ? 0.8 : 0;
    const imgDur    = n > 1 ? (totalDur + (n - 1) * XFADE_DUR) / n : totalDur;

    // Step 1b: Generate bhakti tanpura drone music and mix with TTS voice
    console.log('[song] Generating bhakti tanpura drone music…');
    const dronePath    = path.join(tmpDir, 'drone.mp3');
    const mixedPath    = path.join(tmpDir, 'mixed.mp3');
    try {
      await generateBhaktiDrone(totalDur, dronePath);
      // Mix: TTS voice at 1.0 + tanpura drone at 0.45 (music prominent but lyrics audible)
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          '-i', audioPath,
          '-i', dronePath,
          '-filter_complex',
          `[0]volume=1.0[v];[1]volume=0.45[d];[v][d]amix=inputs=2:normalize=0[mx];[mx]apad=whole_dur=${totalDur}[a]`,
          '-map', '[a]',
          '-t', totalDur.toString(),
          '-y', mixedPath,
        ]);
        let stderr = '';
        ff.stderr.on('data', d => (stderr += d.toString()));
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`Audio mix failed: ${stderr.slice(-400)}`)));
        ff.on('error', reject);
      });
      console.log('[song] TTS + drone mix done');
    } catch (err) {
      console.warn(`[song] Drone/mix failed: ${err.message.slice(0, 120)} — using plain TTS`);
      fs.copyFileSync(audioPath, mixedPath); // fallback: plain TTS audio
    }

    // Step 2: Animate images — try Higgsfield, fallback to FFmpeg
    const clipPaths = imagePaths.map((_, i) => path.join(tmpDir, `clip_${i}.mp4`));
    const bhaktiPrompts = [
      'Divine golden light, spiritual energy, petals falling, cinematic slow zoom, devotional atmosphere',
      'Sacred temple, sunrise, sacred fire glow, ethereal mist, bhakti spiritual mood',
      'Lotus flowers blooming, divine radiance, peaceful meditation, cinematic pan',
      'Holy river, spiritual pilgrimage, golden hour light, devotional energy',
    ];
    const useHighgsfield = !!HIGGSFIELD_TOKEN;
    console.log(`[song] Animating ${n} image(s) via ${useHighgsfield ? 'Higgsfield Seedance 2.0' : 'FFmpeg crop-pan'}…`);

    if (useHighgsfield) {
      // Higgsfield: animate each image in parallel, download clips
      const videoUrls = await Promise.all(
        imagePaths.map((imgPath, i) =>
          animateImageHighgsfield(imgPath, bhaktiPrompts[i % bhaktiPrompts.length], aspectRatio, clipPaths[i])
            .catch(err => {
              console.warn(`[song] Higgsfield img ${i+1} failed: ${err.message.slice(0, 100)}, using FFmpeg fallback`);
              return null; // signal FFmpeg fallback
            })
        )
      );
      // Download Higgsfield clips or fallback to FFmpeg
      await Promise.all(
        imagePaths.map(async (imgPath, i) => {
          if (videoUrls[i]) {
            // Download Higgsfield MP4 clip using fetch
            console.log(`[song] Downloading Higgsfield clip ${i+1}…`);
            const dlResp = await fetch(videoUrls[i]);
            if (!dlResp.ok) throw new Error(`Failed to download HF clip: ${dlResp.status}`);
            const buf = Buffer.from(await dlResp.arrayBuffer());
            fs.writeFileSync(clipPaths[i], buf);
          } else {
            await animateImageFfmpeg(imgPath, i, imgDur, W, H, FPS, clipPaths[i]);
          }
        })
      );
    } else {
      await Promise.all(imagePaths.map((imgPath, i) => animateImageFfmpeg(imgPath, i, imgDur, W, H, FPS, clipPaths[i])));
    }

    // Step 3: Xfade concat + mux audio (use mixed audio with drone)
    console.log('[song] Compositing final video…');
    if (n === 1) {
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          '-i', clipPaths[0], '-i', mixedPath,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
          '-map', '0:v', '-map', '1:a', '-shortest', '-y', outputPath,
        ]);
        let stderr = '';
        ff.stderr.on('data', d => (stderr += d.toString()));
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg mux: ${stderr.slice(-800)}`)));
        ff.on('error', reject);
      });
    } else {
      const XFADE_POOL = ['fade', 'dissolve', 'wipeleft', 'wiperight', 'wipeup', 'circleopen', 'radial', 'smoothleft'];
      const inputArgs = clipPaths.flatMap(p => ['-i', p]);
      const filterParts = [];
      let lastLabel = '0:v';
      for (let i = 1; i < n; i++) {
        const offset = (i * (imgDur - XFADE_DUR)).toFixed(3);
        const outLbl = i === n - 1 ? 'vout' : `v${i}`;
        filterParts.push(`[${lastLabel}][${i}:v]xfade=transition=${XFADE_POOL[i % XFADE_POOL.length]}:duration=${XFADE_DUR}:offset=${offset}[${outLbl}]`);
        lastLabel = outLbl;
      }
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          ...inputArgs, '-i', mixedPath,
          '-filter_complex', filterParts.join(';'),
          '-map', '[vout]', '-map', `${n}:a`,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
          '-shortest', '-y', outputPath,
        ]);
        let stderr = '';
        ff.stderr.on('data', d => (stderr += d.toString()));
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg xfade: ${stderr.slice(-1200)}`)));
        ff.on('error', reject);
      });
    }

    console.log(`[song] Done → ${outputPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────
app.post(
  '/api/generate',
  upload.fields([{ name: 'images', maxCount: 20 }]),
  async (req, res) => {
    const storiesRaw = req.body.stories || '';
    const imageFiles = req.files?.images || [];
    const cleanup    = () => imageFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });

    if (!storiesRaw.trim()) {
      cleanup();
      return res.status(400).json({ error: 'No story text provided.' });
    }
    if (!imageFiles.length) {
      return res.status(400).json({ error: 'Upload at least one image.' });
    }

    const stories = storiesRaw.split(/\n\s*---\s*\n/).map(s => s.trim()).filter(Boolean);
    const format  = ['9:16', '16:9'].includes(req.body.format) ? req.body.format : '16:9';

    const EXT_MAP = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' };
    const imagePaths = imageFiles.map(f => {
      const ext = EXT_MAP[f.mimetype] || '.jpg';
      const newPath = f.path + ext;
      fs.renameSync(f.path, newPath);
      return newPath;
    });

    const outDir = path.join(__dirname, 'out');
    fs.mkdirSync(outDir, { recursive: true });

    try {
      const videos = [];
      for (let i = 0; i < stories.length; i++) {
        const ts      = `${Date.now()}_${i}`;
        const outFile = path.join(outDir, `bhakti_${ts}.mp4`);
        console.log(`[bhakti] Video ${i + 1}/${stories.length}… (format: ${format})`);
        await generateVideo(stories[i], imagePaths, outFile, format);
        videos.push({
          url:   `/out/bhakti_${ts}.mp4`,
          story: i + 1,
        });
        if (i < stories.length - 1) await new Promise(r => setTimeout(r, 3000));
      }
      cleanup();
      res.json({ videos });
    } catch (err) {
      console.error('[bhakti] Error:', err.message);
      cleanup();
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/generate-lyrics — Groq generates Hindi bhakti song lyrics
app.post('/api/generate-lyrics', async (req, res) => {
  try {
    const { deity, theme, mood } = req.body || {};
    if (!deity && !theme) return res.status(400).json({ error: 'Provide deity or theme.' });
    const lyrics = await generateHindiLyrics(deity, theme, mood);
    res.json({ lyrics });
  } catch (err) {
    console.error('[bhakti] Lyrics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generate-song-video — lyrics + images → Higgsfield animated song video
app.post(
  '/api/generate-song-video',
  upload.fields([{ name: 'images', maxCount: 10 }]),
  async (req, res) => {
    const lyrics     = req.body.lyrics || '';
    const imageFiles = req.files?.images || [];
    const cleanup    = () => imageFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });

    if (!lyrics.trim()) { cleanup(); return res.status(400).json({ error: 'No lyrics provided.' }); }
    if (!imageFiles.length) { cleanup(); return res.status(400).json({ error: 'Upload at least one image.' }); }

    const format  = ['9:16', '16:9'].includes(req.body.format) ? req.body.format : '9:16';
    const EXT_MAP = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' };
    const imagePaths = imageFiles.map(f => {
      const ext     = EXT_MAP[f.mimetype] || '.jpg';
      const newPath = f.path + ext;
      fs.renameSync(f.path, newPath);
      return newPath;
    });

    const outDir  = path.join(__dirname, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const ts      = Date.now();
    const outFile = path.join(outDir, `song_${ts}.mp4`);

    try {
      await generateSongVideo(lyrics, imagePaths, outFile, format);
      cleanup();
      res.json({ videoUrl: `/out/song_${ts}.mp4` });
    } catch (err) {
      console.error('[bhakti] Song video error:', err.message);
      cleanup();
      res.status(500).json({ error: err.message });
    }
  }
);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aiBhakti', version: 'higgsfield-rest-v1', hasToken: !!HIGGSFIELD_TOKEN }));

app.listen(PORT, () => console.log(`aiBhakti listening on port ${PORT}`));
// DEPLOY_TS: 1778360001 — bhakti drone music + singing voice params
