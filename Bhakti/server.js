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

// ─── Split long story into short segments (≤150 chars) ───────────────
function splitSegments(text, maxLen = 150) {
  const hindi = isHindi(text);

  let clean = text
    .replace(/[\u2018\u2019\u02BC\u02B9]/g, "'")
    .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u2023\u25E6\u2043]/g, '.');

  if (hindi) {
    clean = clean.replace(/।/g, '. ');                    // danda → period
    clean = clean.replace(/[^\x20-\x7E\u0900-\u097F]/g, ' ');  // keep Devanagari
  } else {
    clean = clean.replace(/[^\x20-\x7E]/g, ' ');          // ASCII only
  }

  clean = clean.replace(/  +/g, ' ').trim();

  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const segments = [];
  let remaining = clean;
  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    const best = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf(', '),
    );
    const cut = best > maxLen * 0.3 ? best + 1 : maxLen;
    const seg = remaining.slice(0, cut).trim();
    if (seg) segments.push(seg);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) segments.push(remaining);
  return segments;
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

// ─── Generate narration; returns [{text, start, end}] timings ────────
async function generateNarration(storyText, audioOutPath) {
  const voice    = isHindi(storyText) ? VOICE_HI : VOICE_EN;
  const segments = splitSegments(storyText);
  console.log(`[bhakti] Narration: ${segments.length} segment(s), voice=${voice}`);
  segments.forEach((s, i) =>
    console.log(`[bhakti]   [${i + 1}] (${s.length}ch) "${s.slice(0, 70)}${s.length > 70 ? '…' : ''}"`)
  );

  if (segments.length === 0) throw new Error('Story text is empty after sanitisation.');

  if (segments.length === 1) {
    await runEdgeTts(segments[0], audioOutPath, voice);
    const dur = await getAudioDuration(audioOutPath);
    return [{ text: segments[0], start: 0, end: dur }];
  }

  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'bhakti_seg_'));
  const segFiles = [];
  const timings  = [];
  let   currentTime = 0;

  try {
    for (let i = 0; i < segments.length; i++) {
      const segPath = path.join(tmpDir, `seg_${i}.mp3`);
      console.log(`[bhakti]   segment ${i + 1}/${segments.length}: "${segments[i].slice(0, 60)}"`);
      await runEdgeTts(segments[i], segPath, voice);
      const dur = await getAudioDuration(segPath);
      timings.push({ text: segments[i], start: currentTime, end: currentTime + dur });
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

// ─── ASS subtitle file with karaoke word-level colour change ─────────
// ASS colour format: &HAABBGGRR  (alpha=00 → opaque)
//   Gold    #F5C842 → BGR 42,C8,F5 → &H0042C8F5  (spoken / highlighted)
//   Lavender#C3A0FF → BGR FF,A0,C3 → &H00FFA0C3  (waiting / unspoken)
//   Dark bg #1A0A2E → BGR 2E,0A,1A → &H002E0A1A  (outline)
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

  const dialogues = timings.map(({ text, start, end }) => {
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const csPerWord = Math.max(1, Math.round(((end - start) / words.length) * 100));
    const karaoke   = words.map(w => `{\\k${csPerWord}}${w}`).join(' ');
    return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${karaoke}`;
  }).filter(Boolean);

  return [header, ...dialogues].join('\n');
}

// ─── Video generation: xfade slideshow + embedded CC subtitles ───────
async function generateVideo(storyText, imagePaths, outputPath, format = '16:9') {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'bhakti_vid_'));
  const audioPath = path.join(tmpDir, 'narration.mp3');
  const assPath   = path.join(tmpDir, 'subs.ass');

  try {
    const timings  = await generateNarration(storyText, audioPath);
    const totalDur = timings[timings.length - 1].end;

    fs.writeFileSync(assPath, generateASS(timings, format), 'utf8');

    const portrait   = format === '9:16';
    const W          = portrait ? 720  : 1280;
    const H          = portrait ? 1280 : 720;
    const n          = imagePaths.length;
    // Crossfade transition duration (min of 0.7 s or 15% of per-image time)
    const TRANSITION = n > 1 ? Math.min(0.7, (totalDur / n) * 0.15) : 0;
    // Each image stream must be slightly longer to compensate for overlap
    const imgDur     = n > 1 ? (totalDur + (n - 1) * TRANSITION) / n : totalDur;

    const scale      = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=#1a0a2e`;
    const assLinux   = assPath.replace(/\\/g, '/');

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
        filterParts.push(
          `[${lastLabel}][s${i}]xfade=transition=fade:duration=${TRANSITION.toFixed(3)}:offset=${offset}[${outLabel}]`
        );
        lastLabel = outLabel;
      }
    }

    // Embed ASS subtitles (libass renders karaoke colour change per word)
    filterParts.push(`[sv]subtitles=${assLinux}[v]`);

    // Build input list: each image as a timed still-image stream, then audio
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

    console.log(`[bhakti] FFmpeg filter_complex: ${filterParts.join(';')}`);

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
