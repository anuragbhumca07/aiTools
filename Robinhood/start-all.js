'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

// Load .env if present (simple parser — no extra dependencies needed)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 1) return;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  });
}

const ALGOS = [
  { symbol: 'BTCUSDT',  port: 4001, name: 'Bitcoin'  },
  { symbol: 'ETHUSDT',  port: 4002, name: 'Ethereum' },
  { symbol: 'SOLUSDT',  port: 4003, name: 'Solana'   },
  { symbol: 'DOGEUSDT', port: 4004, name: 'Dogecoin' },
  { symbol: 'XRPUSDT',  port: 4005, name: 'XRP'      },
  { symbol: 'ADAUSDT',  port: 4006, name: 'Cardano'  },
];

const procs = [];

function startProc(label, script, extraEnv) {
  const proc = spawn('node', [script], {
    env:   { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`));
  proc.on('exit', code => { if (code) console.error(`[${label}] exited ${code}`); });
  procs.push(proc);
  return proc;
}

startProc('Hub', path.join(__dirname, 'dashboard', 'server.js'), { PORT: '4000' });

for (const { symbol, port, name } of ALGOS) {
  startProc(name, path.join(__dirname, 'algo', 'server.js'), {
    PORT:   String(port),
    SYMBOL: symbol,
  });
}

console.log('\nRobinhood Algo Trading — all services starting');
console.log('  Hub Dashboard  : http://localhost:4000');
ALGOS.forEach(a => console.log(`  ${a.name.padEnd(10)}: http://localhost:${a.port}`));
console.log('\nPress Ctrl+C to stop all\n');

function shutdown() {
  procs.forEach(p => {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)], { shell: true, stdio: 'ignore' });
      } else {
        p.kill('SIGTERM');
      }
    } catch {}
  });
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
