'use strict';

const express       = require('express');
const multer        = require('multer');
const cors          = require('cors');
const { spawn }     = require('child_process');
const { promisify } = require('util');
const { exec }      = require('child_process');
const execAsync     = promisify(exec);
const path          = require('path');
const fs            = require('fs');
const os            = require('os');

const app  = express();
const PORT = process.env.PORT || 3008;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/out', express.static(path.join(__dirname, 'out')));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ─── Health ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'vCreator' }));

// ─── TTS sanitizer ────────────────────────────────────────────────────
function sanitizeForTts(text) {
  return text
    .replace(/[\u2018\u2019\u02BC\u02B9]/g, "'")
    .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u2023\u25E6\u2043]/g, '.')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/  +/g, ' ')
    .trim();
}

// ─── TTS with retry / back-off ────────────────────────────────────────
async function runEdgeTts(text, audioPath, vttPath, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 3000;
      console.log(`[vCreator] TTS attempt ${attempt + 1}/${maxRetries}, waiting ${wait}ms…`);
      await new Promise(r => setTimeout(r, wait));
    }
    try {
      await new Promise((resolve, reject) => {
        const args = [
          '-m', 'edge_tts',
          '--voice', 'en-US-AriaNeural',
          '--text', text,
          '--write-media', audioPath,
          '--write-subtitles', vttPath,
        ];
        const proc = spawn('python', args);
        let stderr = '';
        proc.stderr.on('data', d => (stderr += d.toString()));
        proc.on('close', code =>
          code === 0 ? resolve() : reject(new Error(`edge-tts failed (code ${code}): ${stderr.slice(-400)}`))
        );
        proc.on('error', reject);
      });
      return; // success
    } catch (err) {
      lastErr = err;
      console.warn(`[vCreator] TTS attempt ${attempt + 1} failed: ${err.message.slice(0, 200)}`);
    }
  }
  throw lastErr;
}

// ─── Parse WebVTT word timings ────────────────────────────────────────
// Returns [{word, start, end}] where start/end are seconds (floats)
function parseVtt(vttContent) {
  const timings = [];
  // VTT timestamps: HH:MM:SS.mmm --> HH:MM:SS.mmm
  const lines = vttContent.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const match = line.match(
      /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/
    );
    if (match) {
      const start = vttTimeToSeconds(match[1]);
      const end   = vttTimeToSeconds(match[2]);
      // Next non-empty line is the word/phrase
      let textLine = '';
      i++;
      while (i < lines.length && lines[i].trim() === '') i++;
      if (i < lines.length) {
        textLine = lines[i].trim();
        // Remove any VTT cue tags like <c.color> or <00:00:00.000>
        textLine = textLine.replace(/<[^>]+>/g, '').trim();
      }
      if (textLine) {
        // Split multi-word cues into individual words, evenly distributing time
        const words = textLine.split(/\s+/).filter(Boolean);
        const dur   = (end - start) / words.length;
        words.forEach((w, wi) => {
          timings.push({ word: w, start: start + wi * dur, end: start + (wi + 1) * dur });
        });
      }
    }
    i++;
  }
  return timings;
}

function vttTimeToSeconds(ts) {
  const [hh, mm, ss] = ts.split(':');
  return parseInt(hh, 10) * 3600 + parseInt(mm, 10) * 60 + parseFloat(ss);
}

// ─── Audio duration via mutagen ───────────────────────────────────────
async function getAudioDuration(filePath) {
  const fp = filePath.replace(/\\/g, '/');
  const { stdout } = await execAsync(
    `python -c "from mutagen.mp3 import MP3; print(MP3(r'${fp}').info.length)"`,
    { timeout: 10_000 }
  );
  return parseFloat(stdout.trim());
}

// ─── ASS color constants (BGR format for ASS) ─────────────────────────
// ASS uses &HAABBGGRR& — alpha=00 means opaque
// White:  RGB #FFFFFF → BGR #FFFFFF → &H00FFFFFF&
// Gold:   RGB #FFD700 → BGR #00D7FF → &H00D7FF&  (wait: #FFD700 → B=00,G=D7,R=FF → &H0000D7FF&)
// Orange: RGB #FF8C00 → BGR #008CFF → &H00008CFF&
const COLOR_WHITE  = '&H00FFFFFF&';  // unspoken
const COLOR_GOLD   = '&H0000D7FF&';  // currently spoken  (RGB FFD700)
const COLOR_ORANGE = '&H00008CFF&';  // already spoken    (RGB FF8C00)

// ─── Build ASS subtitle file ──────────────────────────────────────────
// Strategy: one event per word-timing window. Each event renders ALL words
// of the quote. Words before current word = orange, current = gold, rest = white.
function buildAssFile(displayQuote, wordTimings, totalDur, W, H) {
  const fontSize  = W >= 1280 ? 36 : 30;
  const marginV   = Math.round(H * 0.08);
  const playResX  = W;
  const playResY  = H;

  // Split the display quote into tokens (preserve punctuation attached to words)
  const quoteWords = displayQuote.split(/\s+/).filter(Boolean);

  // Map word timings to quoteWords best-effort by index
  // edge-tts may emit more or fewer cues than words; we clamp
  const n = quoteWords.length;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Liberation Sans,${fontSize},${COLOR_WHITE},${COLOR_WHITE},&H00000000&,&H80000000&,1,0,0,0,100,100,0,0,1,2,1,2,20,20,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  // Helper: seconds → ASS timestamp h:mm:ss.cc
  function toAssTs(s) {
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const cc  = Math.round((sec - Math.floor(sec)) * 100);
    return `${h}:${String(Math.floor(m)).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
  }

  // Build events array
  const events = [];

  // Add a "before first word" event showing all words in white
  const firstWordStart = wordTimings.length > 0 ? wordTimings[0].start : 0;
  if (firstWordStart > 0.05) {
    const lineText = quoteWords.map(w => `{\\c${COLOR_WHITE}}${escAss(w)}`).join(' ');
    events.push(`Dialogue: 0,${toAssTs(0)},${toAssTs(firstWordStart)},Default,,0,0,0,,${lineText}`);
  }

  // One event per word timing
  wordTimings.forEach((timing, ti) => {
    const eventStart = timing.start;
    const eventEnd   = ti + 1 < wordTimings.length ? wordTimings[ti + 1].start : timing.end;

    // Map timing index to quote word index (proportional)
    const wordIdx = Math.min(Math.round((ti / Math.max(wordTimings.length - 1, 1)) * (n - 1)), n - 1);

    const parts = quoteWords.map((w, qi) => {
      let color;
      if (qi < wordIdx)      color = COLOR_ORANGE;  // already spoken
      else if (qi === wordIdx) color = COLOR_GOLD;   // currently spoken
      else                   color = COLOR_WHITE;    // upcoming
      return `{\\c${color}}${escAss(w)}`;
    });

    const lineText = parts.join(' ');
    events.push(`Dialogue: 0,${toAssTs(eventStart)},${toAssTs(eventEnd)},Default,,0,0,0,,${lineText}`);
  });

  // Tail event: all orange after last word
  const lastWordEnd = wordTimings.length > 0 ? wordTimings[wordTimings.length - 1].end : totalDur;
  if (lastWordEnd < totalDur - 0.05) {
    const lineText = quoteWords.map(w => `{\\c${COLOR_ORANGE}}${escAss(w)}`).join(' ');
    events.push(`Dialogue: 0,${toAssTs(lastWordEnd)},${toAssTs(totalDur)},Default,,0,0,0,,${lineText}`);
  }

  return header + '\n' + events.join('\n') + '\n';
}

// Escape special ASS characters in text
function escAss(s) {
  return s.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

// ─── Monk image paths ─────────────────────────────────────────────────
const MONK_PATH = {
  '16:9': path.join(__dirname, 'public', 'monk_169.png'),
  '9:16': path.join(__dirname, 'public', 'monk_916.png'),
};

// Python/PIL script to generate a seated monk silhouette (transparent PNG)
const MONK_PY = `
import sys
from PIL import Image, ImageDraw, ImageFilter

def make(out, W, H):
    img = Image.new('RGBA', (W, H), (0,0,0,0))
    d   = ImageDraw.Draw(img)
    cx  = W // 2
    s   = min(W, H) / 720.0

    # --- golden aura glow ---
    aura_cy = int(H * 0.46)
    aura_r  = int(190 * s)
    for r in range(aura_r, int(aura_r * 0.28), -3):
        progress = (aura_r - r) / (aura_r * 0.72)
        alpha    = int(55 * progress)
        d.ellipse([cx-r, aura_cy-r, cx+r, aura_cy+r], fill=(255,205,55,alpha))

    # --- seated robe ---
    vc  = int(H * 0.50)
    rw  = int(158 * s)
    rt  = vc - int(98 * s)
    rb  = int(H * 0.87)
    d.polygon([(cx, rt),(cx-rw, rb),(cx+rw, rb)], fill=(188,88,0,255))
    # shadow fold
    d.polygon([(cx, rt),(cx-int(18*s), rb),(cx+int(18*s), rb)], fill=(118,52,0,200))
    # right highlight
    d.polygon([(cx+int(30*s), rt+int(10*s)),(cx+rw, rb),(cx+int(60*s), rb)],
              fill=(205,105,0,170))

    # --- shoulders ---
    sh = int(88 * s)
    d.ellipse([cx-sh, rt-int(22*s), cx+sh, rt+int(22*s)], fill=(188,88,0,255))

    # --- neck ---
    nw = int(19*s); nt = rt - int(55*s)
    d.rectangle([cx-nw, nt, cx+nw, rt], fill=(193,160,117,255))

    # --- head (shaved, round) ---
    hr  = int(47*s)
    hcy = nt - hr
    d.ellipse([cx-hr, hcy-hr, cx+hr, hcy+hr], fill=(198,161,114,255))
    # subtle head-top highlight
    d.ellipse([cx-int(28*s), hcy-int(38*s), cx+int(10*s), hcy-int(8*s)],
              fill=(215,178,130,180))

    # --- eyes (half-closed, serene) ---
    ey = hcy + int(7*s)
    for ex0 in [cx-int(23*s), cx+int(5*s)]:
        d.arc([ex0, ey-int(6*s), ex0+int(18*s), ey+int(7*s)],
              start=0, end=180, fill=(48,30,12,255), width=max(1,int(2*s)))

    # --- nose ---
    d.line([(cx-int(3*s), hcy+int(5*s)),(cx-int(6*s), hcy+int(18*s))],
           fill=(160,120,80,200), width=max(1,int(2*s)))

    # --- mouth open (speaking) ---
    my = hcy + int(28*s)
    mw = int(14*s)
    d.arc([cx-mw, my-int(5*s), cx+mw, my+int(10*s)],
          start=18, end=162, fill=(85,42,18,255), width=max(1,int(3*s)))
    # open gap (teeth hint)
    d.ellipse([cx-int(7*s), my-int(1*s), cx+int(7*s), my+int(5*s)],
              fill=(70,35,15,140))

    # --- ears ---
    for ex in [cx-hr, cx+hr-int(8*s)]:
        d.ellipse([ex-int(8*s), hcy-int(8*s), ex+int(8*s), hcy+int(18*s)],
                  fill=(185,150,108,255))

    # --- prayer hands (mudra) ---
    hy = rt + int(58*s)
    hw = int(30*s); hh = int(16*s)
    d.ellipse([cx-hw, hy-hh, cx+hw, hy+hh], fill=(190,157,114,255))
    # finger dividers
    for i in range(-2, 3):
        fx = cx + int(i*10*s)
        d.ellipse([fx-int(4*s), hy-hh-int(10*s), fx+int(4*s), hy-hh+int(2*s)],
                  fill=(178,145,102,255))

    # --- speech-bubble dots (beside mouth, show monk is speaking) ---
    dot_r = max(2, int(5*s))
    bx = cx + hr + int(12*s)
    for i, dy in enumerate([0, int(-14*s), int(-28*s)]):
        a = 210 - i*55
        d.ellipse([bx-dot_r, hcy+dy-dot_r, bx+dot_r, hcy+dy+dot_r],
                  fill=(255,215,0,a))

    # smooth edges
    img = img.filter(ImageFilter.SMOOTH_MORE)
    img.save(out, 'PNG')
    print(f'monk saved {out}', flush=True)

make(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
`;

// Synthesised ambient music expressions for FFmpeg aevalsrc
// (no MP3 files needed — generated on-the-fly)
const MUSIC_EXPR = {
  uplifting: "0.07*sin(2*PI*t*440)+0.05*sin(2*PI*t*554.4)+0.04*sin(2*PI*t*659.3)*(0.6+0.4*sin(2*PI*t*0.4))",
  calm:      "0.05*sin(2*PI*t*220)+0.04*sin(2*PI*t*293.7)+0.03*sin(2*PI*t*349.2)+0.02*sin(2*PI*t*440)",
  epic:      "0.09*sin(2*PI*t*55)+0.06*sin(2*PI*t*82.4)+0.04*sin(2*PI*t*110)+0.03*sin(2*PI*t*164.8)",
};

// Generate monk PNGs at startup (both orientations)
async function ensureMonkImages() {
  const scriptPath = path.join(os.tmpdir(), 'vcreator_monk.py');
  fs.writeFileSync(scriptPath, MONK_PY, 'utf8');
  for (const [fmt, W, H] of [['16:9', 1280, 720], ['9:16', 720, 1280]]) {
    const p = MONK_PATH[fmt];
    if (fs.existsSync(p)) { console.log(`[vCreator] Monk ${fmt} exists`); continue; }
    try {
      await execAsync(`python3 "${scriptPath}" "${p}" ${W} ${H}`, { timeout: 30000 });
      console.log(`[vCreator] Monk ${fmt} generated`);
    } catch (e) {
      console.warn(`[vCreator] Monk ${fmt} generation failed: ${e.message.slice(0,200)}`);
    }
  }
}

ensureMonkImages().catch(e => console.warn('[vCreator] ensureMonkImages error:', e.message));

// ─── Core video generator ─────────────────────────────────────────────
async function generateVideo(quote, outputPath, music = 'none', format = '16:9') {
  const portrait = format === '9:16';
  const W = portrait ? 720  : 1280;
  const H = portrait ? 1280 : 720;

  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'vcreator_'));
  const audioPath = path.join(tmpDir, 'tts.mp3');
  const vttPath   = path.join(tmpDir, 'tts.vtt');
  const assPath   = path.join(tmpDir, 'subs.ass');

  try {
    const ttsText = sanitizeForTts(quote);
    if (!ttsText) throw new Error('Quote is empty after sanitization.');

    console.log(`[vCreator] TTS for: "${ttsText.slice(0, 80)}…"`);
    await runEdgeTts(ttsText, audioPath, vttPath);

    // Parse VTT
    let wordTimings = [];
    if (fs.existsSync(vttPath)) {
      const vttContent = fs.readFileSync(vttPath, 'utf8');
      wordTimings = parseVtt(vttContent);
      console.log(`[vCreator] Parsed ${wordTimings.length} word timing(s) from VTT`);
    } else {
      console.warn('[vCreator] VTT file not produced; subtitles will be static');
    }

    // Get audio duration
    const totalDur = await getAudioDuration(audioPath);
    console.log(`[vCreator] Audio duration: ${totalDur.toFixed(2)}s`);

    // If we got no word timings, create a single timing spanning the full audio
    if (wordTimings.length === 0) {
      const words = ttsText.split(/\s+/).filter(Boolean);
      const dur   = totalDur / words.length;
      words.forEach((w, i) => {
        wordTimings.push({ word: w, start: i * dur, end: (i + 1) * dur });
      });
    }

    // Build ASS subtitle file
    const assContent = buildAssFile(quote, wordTimings, totalDur, W, H);
    fs.writeFileSync(assPath, assContent, 'utf8');
    console.log(`[vCreator] ASS written: ${assPath}`);

    // Background music via FFmpeg aevalsrc synthesis (no MP3 files needed)
    const musicExpr  = MUSIC_EXPR[music] || null;
    const hasMusic   = !!musicExpr;

    // Monk overlay (generated at startup)
    const monkFile   = MONK_PATH[format] || MONK_PATH['16:9'];
    const hasMonk    = fs.existsSync(monkFile);
    if (!hasMonk) console.warn(`[vCreator] Monk image missing: ${monkFile} — no overlay`);

    // Escape ASS path for FFmpeg subtitles filter
    const assPathEscaped = assPath
      .replace(/\\/g, '/')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'");

    // Build input list:
    //   [0] lavfi bg   [1] monk PNG (if available)   [ttsIdx] TTS mp3   [musicIdx] aevalsrc (if selected)
    const inputArgs = ['-f', 'lavfi', '-i', `color=c=0x0d0820:size=${W}x${H}:rate=25,format=yuv420p`];
    if (hasMonk) inputArgs.push('-loop', '1', '-t', totalDur.toFixed(3), '-i', monkFile);
    const ttsIdx = hasMonk ? 2 : 1;
    inputArgs.push('-t', totalDur.toFixed(3), '-i', audioPath);
    let musicIdx = null;
    if (hasMusic) {
      musicIdx = ttsIdx + 1;
      inputArgs.push('-f', 'lavfi', '-t', totalDur.toFixed(3), '-i',
        `aevalsrc='${musicExpr}':s=44100`);
      console.log(`[vCreator] Music: ${music} (synthesised via aevalsrc)`);
    }

    // Build filter_complex
    const fp = [];
    let vLabel = '0:v';
    if (hasMonk) {
      fp.push(`[0:v][1:v]overlay=0:0:format=auto[bg_monk]`);
      vLabel = 'bg_monk';
    }
    fp.push(`[${vLabel}]subtitles='${assPathEscaped}'[v]`);
    if (hasMusic) {
      fp.push(`[${ttsIdx}:a][${musicIdx}:a]amix=inputs=2:weights=1 0.13:normalize=0[a]`);
    }

    const filterComplex = fp.join(';');
    const mapArgs = hasMusic
      ? ['-map', '[v]', '-map', '[a]']
      : ['-map', '[v]', '-map', `${ttsIdx}:a`];

    const ffArgs = [
      ...inputArgs,
      '-filter_complex', filterComplex,
      ...mapArgs,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '25',
      '-c:a', 'aac', '-b:a', '128k',
      '-t', totalDur.toFixed(3),
      '-y', outputPath,
    ];

    console.log(`[vCreator] FFmpeg args: ${ffArgs.slice(0, 12).join(' ')} …`);

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ffArgs);
      let stderr = '';
      ff.stderr.on('data', d => (stderr += d.toString()));
      ff.on('close', code =>
        code === 0
          ? resolve()
          : reject(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(-1200)}`))
      );
      ff.on('error', reject);
    });

    console.log(`[vCreator] Video ready: ${outputPath}`);
  } finally {
    // Clean up temp directory
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── POST /api/generate ───────────────────────────────────────────────
app.post(
  '/api/generate',
  upload.fields([{ name: 'quotefile', maxCount: 1 }]),
  async (req, res) => {
    const cleanupFiles = [];

    try {
      // Collect quotes text: from field or uploaded file
      let rawText = (req.body.quotes || '').trim();

      const uploadedFile = req.files?.quotefile?.[0];
      if (uploadedFile) {
        cleanupFiles.push(uploadedFile.path);
        const fileText = fs.readFileSync(uploadedFile.path, 'utf8').trim();
        if (fileText) rawText = fileText; // file overrides textarea if non-empty
      }

      if (!rawText) {
        return res.status(400).json({ error: 'No quotes provided. Enter quotes in the textarea or upload a .txt file.' });
      }

      // Parse quotes: split on newlines, also support --- separator
      let quotes = rawText
        .split(/\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .filter(l => l !== '---');

      // Also handle block separator (multiple lines per block)
      // If user used --- as block separator treat each block as one quote
      if (rawText.includes('---')) {
        quotes = rawText
          .split(/---/)
          .map(b => b.trim())
          .filter(Boolean);
      }

      if (quotes.length === 0) {
        return res.status(400).json({ error: 'No valid quotes found after parsing.' });
      }

      const music  = ['none', 'uplifting', 'calm', 'epic'].includes(req.body.music) ? req.body.music : 'none';
      const format = ['16:9', '9:16'].includes(req.body.format) ? req.body.format : '16:9';

      console.log(`[vCreator] Generating ${quotes.length} video(s) — music: ${music}, format: ${format}`);

      const outDir = path.join(__dirname, 'out');
      fs.mkdirSync(outDir, { recursive: true });

      const videos = [];
      for (let i = 0; i < quotes.length; i++) {
        const ts      = `${Date.now()}_${i}`;
        const outFile = path.join(outDir, `vc_${ts}.mp4`);
        console.log(`[vCreator] Video ${i + 1}/${quotes.length}: "${quotes[i].slice(0, 60)}…"`);

        let attempt = 0;
        const maxVideoRetries = 3;
        while (attempt < maxVideoRetries) {
          try {
            await generateVideo(quotes[i], outFile, music, format);
            break;
          } catch (err) {
            attempt++;
            console.error(`[vCreator] Video ${i + 1} attempt ${attempt} failed: ${err.message}`);
            if (attempt >= maxVideoRetries) throw err;
            await new Promise(r => setTimeout(r, attempt * 3000));
          }
        }

        videos.push({
          url:   `/out/vc_${ts}.mp4`,
          quote: quotes[i],
          index: i + 1,
        });

        // Small pause between videos to avoid rate-limiting TTS
        if (i < quotes.length - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // Cleanup uploaded file
      for (const fp of cleanupFiles) {
        try { fs.unlinkSync(fp); } catch {}
      }

      res.json({ videos });
    } catch (err) {
      console.error('[vCreator] Error:', err.message);
      for (const fp of cleanupFiles) {
        try { fs.unlinkSync(fp); } catch {}
      }
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Start ────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[vCreator] Listening on port ${PORT}`));
