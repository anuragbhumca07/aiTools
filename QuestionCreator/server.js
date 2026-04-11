'use strict';

const express = require('express');
const multer  = require('multer');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3004;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'web')));

// ── File upload (memory storage — no temp files needed) ───────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|txt|docx|doc)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only PDF, DOCX, and TXT files are supported'), ok);
  }
});

// ── Text extractors ───────────────────────────────────────────────────────────
async function extractFromPdf(buffer) {
  // Use lib path to avoid pdf-parse's internal test-file require
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const data = await pdfParse(buffer);
  return data.text;
}

async function extractFromDocx(buffer) {
  const mammoth = require('mammoth');
  const result  = await mammoth.extractRawText({ buffer });
  return result.value;
}

function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf')              return extractFromPdf(buffer);
  if (ext === '.docx' || ext === '.doc') return extractFromDocx(buffer);
  return Promise.resolve(buffer.toString('utf8'));
}

// ── AI providers ──────────────────────────────────────────────────────────────
function buildPrompt(content, n) {
  const text = content.length > 14000 ? content.slice(0, 14000) + '\n...[content truncated]' : content;
  return `You are a quiz question generator. Read the content below and create exactly ${n} multiple-choice questions.

OUTPUT FORMAT — output ONLY the questions, no numbering, no intro, no extra text:

Q: [question]
A: [option]
B: [option]
C: [option]
D: [option]
Answer: [A, B, C, or D]

Separate each question with one blank line.

RULES:
- Exactly 4 options (A B C D) per question
- Exactly one correct answer
- Make wrong options plausible, not obviously wrong
- Cover different parts of the content
- Questions should test real understanding, not just recall of exact phrases

CONTENT:
${text}

Output exactly ${n} questions now:`;
}

async function callGroq(prompt, apiKey) {
  const r = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 4096
    },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 90000 }
  );
  return r.data.choices[0].message.content.trim();
}

async function callGemini(prompt, apiKey) {
  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 4096 }
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 90000 }
  );
  return r.data.candidates[0].content.parts[0].text.trim();
}

// ── Output cleaner/validator ──────────────────────────────────────────────────
function cleanQuestions(raw) {
  // Strip markdown bold/italic and leading numbers
  let text = raw.replace(/\*\*/g, '').replace(/\*/g, '');
  text = text.replace(/^\s*\d+[\.\)]\s*/gm, '');

  const valid = [];
  let buf = [];

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^Q:/i.test(t)) {
      buf = [t];
    } else if (/^[A-D]:/i.test(t) && buf.length > 0) {
      buf.push(t);
    } else if (/^Answer\s*:/i.test(t) && buf.length >= 5) {
      // Normalise "Answer :" → "Answer:"
      buf.push(t.replace(/^Answer\s*:\s*/i, 'Answer: ').trim());
      const hasQ    = buf.filter(l => /^Q:/i.test(l)).length === 1;
      const hasOpts = buf.filter(l => /^[A-D]:/i.test(l)).length === 4;
      const hasAns  = /^Answer:\s*[A-D]$/i.test(buf[buf.length - 1]);
      if (hasQ && hasOpts && hasAns) valid.push(buf.join('\n'));
      buf = [];
    }
  }

  return valid.join('\n\n');
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/api/generate', upload.single('file'), async (req, res) => {
  try {
    const { numQuestions = '10', provider = 'groq', apiKey, pastedText } = req.body;
    const n = Math.min(Math.max(parseInt(numQuestions) || 10, 1), 50);

    if (!apiKey?.trim()) return res.status(400).json({ success: false, error: 'API key is required' });

    let content = '';
    if (req.file) {
      try {
        content = await extractText(req.file.buffer, req.file.originalname);
      } catch (e) {
        return res.status(400).json({ success: false, error: `Could not read file: ${e.message}` });
      }
    } else if (pastedText?.trim()) {
      content = pastedText.trim();
    } else {
      return res.status(400).json({ success: false, error: 'Upload a file or paste text' });
    }

    if (!content.trim()) return res.status(400).json({ success: false, error: 'No readable text found in the file' });

    const prompt = buildPrompt(content, n);

    let raw;
    if      (provider === 'groq')   raw = await callGroq(prompt, apiKey.trim());
    else if (provider === 'gemini') raw = await callGemini(prompt, apiKey.trim());
    else return res.status(400).json({ success: false, error: 'Unknown provider' });

    const questions = cleanQuestions(raw);
    if (!questions) return res.status(500).json({ success: false, error: 'AI did not return valid questions. Try again or reduce the count.' });

    const count = (questions.match(/^Q:/gim) || []).length;
    res.json({ success: true, questions, count, requested: n });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.response?.data?.error || e.message;
    res.status(500).json({ success: false, error: msg });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`\n📝  Question Creator  →  http://localhost:${PORT}\n`));
