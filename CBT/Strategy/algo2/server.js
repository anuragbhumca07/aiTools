'use strict';

const express = require('express');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = parseInt(process.env.PORT || '3009', 10);
const PYTHON = process.env.PYTHON_CMD || 'python';
const TRADER_DIR = path.join(__dirname, 'kronos_trader');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

// ── Python runner ───────────────────────────────────────────────────
function runPython(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, ['-m', 'main', ...args], {
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
        // Find last JSON object in stdout (some libraries print warnings before it)
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
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'kronos-trader', port: PORT }));

app.get('/debug', (_, res) => {
  const info = {};
  try { info.trader_dir = TRADER_DIR; } catch(e) {}
  try { info.data_dir_exists = fs.existsSync(path.join(TRADER_DIR, 'data')); } catch(e) {}
  try { info.data_init_exists = fs.existsSync(path.join(TRADER_DIR, 'data', '__init__.py')); } catch(e) {}
  try { info.main_py_lines = fs.readFileSync(path.join(TRADER_DIR, 'main.py'), 'utf8').split('\n').slice(0, 8).join(' | '); } catch(e) { info.main_py_err = e.message; }
  try { info.kronos_trader_files = fs.readdirSync(TRADER_DIR); } catch(e) {}
  try { info.python_path = execSync('python --version', { encoding: 'utf8' }).trim(); } catch(e) {}
  try {
    info.python_syspath = execSync(
      `python -c "import sys; print(sys.path)"`,
      { env: { ...process.env, PYTHONPATH: TRADER_DIR }, encoding: 'utf8' }
    ).trim();
  } catch(e) { info.python_syspath_err = e.message; }
  try {
    info.data_import_test = execSync(
      `python -c "from data.kraken_rest import get_ohlcv; print('ok')"`,
      { env: { ...process.env, PYTHONPATH: TRADER_DIR }, encoding: 'utf8' }
    ).trim();
  } catch(e) { info.data_import_err = e.stderr || e.message; }
  res.json(info);
});

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
  console.log(`Python: ${PYTHON}  |  Trader dir: ${TRADER_DIR}`);
});
