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

app.use(cors());
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

// ─── TTS ─────────────────────────────────────────────────────────────
function runEdgeTts(text, outputPath, voice) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', outputPath]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`edge-tts failed: ${stderr}`))));
    proc.on('error', reject);
  });
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
async function generateNarration(storyText, audioOutPath) {
  const voice    = isHindi(storyText) ? VOICE_HI : VOICE_EN;
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

// ─── ASS subtitle: karaoke word-level colour — uses display text ──────
// ASS colour: &HAABBGGRR
//   Gold    #F5C842 → &H0042C8F5  (highlighted / spoken word)
//   Lavender#C3A0FF → &H00FFA0C3  (upcoming / unspoken words)
//   Dark bg #1A0A2E → &H002E0A1A  (outline)
function formatAssTime(s) {
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.round((s % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function generateASS(timings, format = '16:9') {
  const portrait = format === '9:16';
  const playResX = portrait ? 720  : 1280;
  const playResY = portrait ? 1280 : 720;
  const marginH  = portrait ? 40   : 80;
  const marginV  = portrait ? 60   : 50;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans,40,&H0042C8F5,&H00FFA0C3,&H002E0A1A,&HA0000000,1,0,0,0,100,100,0,0,1,2,1,2,${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  // Use display text for subtitles (original user input, not sanitized TTS text)
  const dialogues = timings.map(({ display, start, end }) => {
    const words = display.split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const csPerWord = Math.max(1, Math.round(((end - start) / words.length) * 100));
    const karaoke   = words.map(w => `{\\k${csPerWord}}${w}`).join(' ');
    return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${karaoke}`;
  }).filter(Boolean);

  return [header, ...dialogues].join('\n');
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

// ─── Video generation: varied xfade slideshow + original-text CC ─────
async function generateVideo(storyText, imagePaths, outputPath, format = '16:9') {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'bhakti_vid_'));
  const audioPath = path.join(tmpDir, 'narration.mp3');
  const assPath   = path.join(tmpDir, 'subs.ass');

  try {
    const timings  = await generateNarration(storyText, audioPath);
    const totalDur = timings[timings.length - 1].end;

    // Subtitles use original display text
    fs.writeFileSync(assPath, generateASS(timings, format), 'utf8');

    const portrait   = format === '9:16';
    const W          = portrait ? 720  : 1280;
    const H          = portrait ? 1280 : 720;
    const n          = imagePaths.length;
    const TRANSITION = n > 1 ? Math.min(0.8, (totalDur / n) * 0.15) : 0;
    const imgDur     = n > 1 ? (totalDur + (n - 1) * TRANSITION) / n : totalDur;

    const scale      = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=#1a0a2e`;
    const assLinux   = assPath.replace(/\\/g, '/');

    // Pick a unique random transition for each image pair
    const transitions = pickTransitions(n - 1);

    const filterParts = [];

    if (n === 1) {
      filterParts.push(`[0]${scale},fps=25[sv]`);
    } else {
      for (let i = 0; i < n; i++) {
        filterParts.push(`[${i}]${scale},fps=25[s${i}]`);
      }
      let lastLabel = 's0';
      for (let i = 1; i < n; i++) {
        const offset   = (i * (imgDur - TRANSITION)).toFixed(3);
        const outLabel = i === n - 1 ? 'sv' : `x${i}`;
        const tr       = transitions[i - 1];
        filterParts.push(
          `[${lastLabel}][s${i}]xfade=transition=${tr}:duration=${TRANSITION.toFixed(3)}:offset=${offset}[${outLabel}]`
        );
        lastLabel = outLabel;
      }
    }

    // Embed ASS subtitles via libass
    filterParts.push(`[sv]subtitles=${assLinux}[v]`);

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
        videos.push({ url: `/out/bhakti_${ts}.mp4`, story: i + 1 });
        if (i < stories.length - 1) await new Promise(r => setTimeout(r, 1500));
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

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aiBhakti' }));

app.listen(PORT, () => console.log(`aiBhakti listening on port ${PORT}`));
