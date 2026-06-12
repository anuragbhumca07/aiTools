'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = parseInt(process.env.PORT || '3009', 10);
const PYTHON = process.env.PYTHON_CMD || 'python';
const TRADER_DIR = path.join(__dirname, 'kronos_trader');

// ── Startup diagnostics ─────────────────────────────────────────────
console.log(`BUILD_TAG=server_v6 | TRADER_DIR=${TRADER_DIR}`);
try {
  console.log(`trader_files=${JSON.stringify(fs.readdirSync(TRADER_DIR))}`);
  console.log(`data_exists=${fs.existsSync(path.join(TRADER_DIR, 'data'))}`);
} catch(e) {
  console.log(`stat_error=${e.message}`);
}

// ── Write a path-injecting wrapper at startup (bypasses Docker cache) ─
const WRAPPER = path.join('/tmp', 'kronos_run.py');
fs.writeFileSync(WRAPPER,
  'import sys, os\n' +
  `_D = ${JSON.stringify(TRADER_DIR)}\n` +
  'sys.path.insert(0, _D)\n' +
  'os.chdir(_D)\n' +
  `exec(open(os.path.join(_D, 'main.py')).read())\n`
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

// ── Python runner ───────────────────────────────────────────────────
function runPython(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [WRAPPER, ...args], {
      cwd: TRADER_DIR,
      env: { ...process.env, PYTHONPATH: TRADER_DIR },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Python timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      try {
        const jsonMatch = stdout.match(/(\{[\s\S]*\})\s*$/);
        if (jsonMatch) {
          resolve(JSON.parse(jsonMatch[1]));
        } else if (code !== 0) {
          reject(new Error(stderr || `Python exited ${code}`));
        } else {
          reject(new Error('No JSON output from Python'));
        }
      } catch (e) {
        reject(new Error(`JSON parse error: ${e.message}\nstdout: ${stdout.slice(0, 500)}`));
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Spawn error: ${err.message}`));
    });
  });
}

// ── Routes ──────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok',
  service: 'kronos-trader',
  port: PORT,
  build: 'server_v6',
  data_exists: fs.existsSync(path.join(TRADER_DIR, 'data')),
}));

app.get('/api/status', async (req, res) => {
  try {
    const result = await runPython(['status'], 10000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/api/signals', async (req, res) => {
  const { symbol, timeframe } = req.query;
  const args = ['signals'];
  if (symbol) args.push('--symbol', symbol);
  if (timeframe) args.push('--timeframe', timeframe);
  try {
    const result = await runPython(args, 25000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/api/backtest', async (req, res) => {
  const { symbol, timeframe, days, capital } = req.body || {};
  const args = ['backtest'];
  if (symbol) args.push('--symbol', symbol);
  if (timeframe) args.push('--timeframe', timeframe);
  if (days) args.push('--days', String(days));
  if (capital) args.push('--capital', String(capital));
  try {
    const result = await runPython(args, 120000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Static fallback ──────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'web', 'index.html')));

app.listen(PORT, () => {
  console.log(`Kronos Trader running on :${PORT}`);
});
