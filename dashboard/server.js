'use strict';
const express = require('express');
const { exec } = require('child_process');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3099;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ── PM2 helpers ──────────────────────────────────────────────────────────────

const EXEC_OPTS = { windowsHide: true };

function pm2List() {
  return new Promise((resolve, reject) => {
    exec('pm2 jlist', EXEC_OPTS, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch { resolve([]); }
    });
  });
}

function pm2Action(action, name) {
  return new Promise((resolve, reject) => {
    exec(`pm2 ${action} ${name}`, EXEC_OPTS, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

// ── Service metadata ─────────────────────────────────────────────────────────

const SERVICES = [
  { name: 'main-page',        label: 'AI Hub',               icon: '🏠', port: 3000, desc: 'Main hub dashboard'              },
  { name: 'my-video',         label: 'Quiz Video Generator',  icon: '🎬', port: 3001, desc: 'AI quiz video generation'        },
  { name: 'aiExplainer',      label: 'AI Explainer',          icon: '🧠', port: 3002, desc: 'Manim animated explainer videos' },
  { name: 'scheduler',        label: 'Quiz Scheduler',        icon: '📅', port: 3003, desc: 'Cron-based video scheduler'      },
  { name: 'question-creator', label: 'Question Creator',      icon: '📝', port: 3004, desc: 'PDF/DOCX to quiz question bank'  },
  { name: 'social-media',     label: 'Social Media Uploader', icon: '🚀', port: 3005, desc: 'Multi-platform video uploader'   },
  { name: 'bhakti',           label: 'aiBhakti',              icon: '🪔', port: 3007, desc: 'Spiritual story video generator' },
  { name: 'vcreator',         label: 'vCreator',              icon: '⚡', port: 3008, desc: 'Motivational video creator'     },
];

const VALID_ACTIONS = new Set(['start', 'stop', 'restart']);

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  try {
    const list = await pm2List();
    const byName = {};
    for (const p of list) byName[p.name] = p;

    const result = SERVICES.map(svc => {
      const p       = byName[svc.name];
      const status  = p ? p.pm2_env.status : 'stopped';
      const uptime  = p && p.pm2_env.status === 'online' ? Date.now() - p.pm2_env.pm_uptime : 0;
      const memory  = p ? Math.round((p.monit?.memory || 0) / 1024 / 1024) : 0;
      const cpu     = p ? (p.monit?.cpu || 0) : 0;
      const restarts = p ? p.pm2_env.restart_time : 0;
      return { ...svc, status, uptime, memory, cpu, restarts };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/logs/:name', (req, res) => {
  const { name } = req.params;
  if (!SERVICES.find(s => s.name === name))
    return res.status(400).json({ error: 'Unknown service' });
  exec(`pm2 logs ${name} --lines 40 --nostream --no-color`, EXEC_OPTS, (err, stdout, stderr) => {
    const raw = (stdout + stderr)
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/^[^|]+\| /, '').trim())
      .filter(l => l.length > 0 && !l.startsWith('Tailing') && !l.startsWith('C:\\'))
      .slice(-40)
      .join('\n');
    res.json({ lines: raw || '(no log output yet)' });
  });
});

app.post('/api/all/:action', async (req, res) => {
  const { action } = req.params;
  if (!VALID_ACTIONS.has(action)) return res.status(400).json({ error: 'Invalid action' });
  try {
    // Operate only on the listed services — never touches the dashboard itself
    await Promise.all(SERVICES.map(svc => pm2Action(action, svc.name).catch(() => {})));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/:action/:name', async (req, res) => {
  const { action, name } = req.params;
  if (!VALID_ACTIONS.has(action)) return res.status(400).json({ error: 'Invalid action' });
  if (!SERVICES.find(s => s.name === name))
    return res.status(400).json({ error: 'Unknown service' });
  try {
    await pm2Action(action, name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () =>
  console.log(`\n🖥️  PM2 Dashboard  →  http://localhost:${PORT}\n`)
);
