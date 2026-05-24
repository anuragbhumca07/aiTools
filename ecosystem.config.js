// PM2 ecosystem — runs all 8 AI tools locally
// Usage:
//   pm2 start ecosystem.config.js   ← start all
//   pm2 stop all                    ← stop all
//   pm2 restart <name>              ← restart one
//   pm2 logs <name>                 ← tail logs
//   pm2 list                        ← status table

const path = require('path');
const ROOT = __dirname;

module.exports = {
  apps: [
    // ── PM2 Control Dashboard ─────────────────────────────────
    {
      name: 'dashboard',
      script: path.join(ROOT, 'dashboard', 'server.js'),
      cwd: path.join(ROOT, 'dashboard'),
      env: { PORT: 3099, NODE_ENV: 'development' },
    },

    // ── Hub (static) ─────────────────────────────────────────
    {
      name: 'main-page',
      script: path.join(ROOT, 'main-page', 'server.js'),
      cwd: path.join(ROOT, 'main-page'),
      env: { PORT: 3000, NODE_ENV: 'development' },
    },

    // ── Quiz Video Generator ──────────────────────────────────
    {
      name: 'my-video',
      script: path.join(ROOT, 'my-video', 'server.js'),
      cwd: path.join(ROOT, 'my-video'),
      env: { PORT: 3001, NODE_ENV: 'development' },
    },

    // ── AI Explainer (Python/Flask) ───────────────────────────
    {
      name: 'aiExplainer',
      script: path.join(ROOT, 'aiExplainer', 'server.py'),
      interpreter: path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
      cwd: path.join(ROOT, 'aiExplainer'),
      env: { PORT: '3002', NODE_ENV: 'development' },
    },

    // ── Quiz Scheduler ────────────────────────────────────────
    {
      name: 'scheduler',
      script: path.join(ROOT, 'Scheduler', 'server.js'),
      cwd: path.join(ROOT, 'Scheduler'),
      env: {
        PORT: 3003,
        NODE_ENV: 'development',
        QUIZ_API_URL:   'http://localhost:3001',
        BHAKTI_API_URL: 'http://localhost:3007',
        BASE_URL:       'http://localhost:3003',
      },
    },

    // ── Question Creator ──────────────────────────────────────
    {
      name: 'question-creator',
      script: path.join(ROOT, 'QuestionCreator', 'server.js'),
      cwd: path.join(ROOT, 'QuestionCreator'),
      env: { PORT: 3004, NODE_ENV: 'development' },
    },

    // ── Social Media Uploader ─────────────────────────────────
    {
      name: 'social-media',
      script: path.join(ROOT, 'social-media', 'server.js'),
      cwd: path.join(ROOT, 'social-media'),
      env: {
        PORT: 3005,
        NODE_ENV: 'development',
        BASE_URL: 'http://localhost:3005',
      },
    },

    // ── aiBhakti ─────────────────────────────────────────────
    {
      name: 'bhakti',
      script: path.join(ROOT, 'Bhakti', 'server.js'),
      cwd: path.join(ROOT, 'Bhakti'),
      env: { PORT: 3007, NODE_ENV: 'development' },
    },

    // ── vCreator ─────────────────────────────────────────────
    {
      name: 'vcreator',
      script: path.join(ROOT, 'vCreator', 'server.js'),
      cwd: path.join(ROOT, 'vCreator'),
      env: { PORT: 3008, NODE_ENV: 'development' },
    },

    // ── CBT Algo Trading ──────────────────────────────────────
    {
      name: 'cbt-algo1',
      script: path.join(ROOT, 'CBT', 'Strategy', 'algo1', 'server.js'),
      cwd: path.join(ROOT, 'CBT', 'Strategy', 'algo1'),
      env: { PORT: 3006, NODE_ENV: 'development' },
    },

    // ── CBT Algo2 Swing Trading (Tickmill) ────────────────────
    {
      name: 'cbt-algo2',
      script: path.join(ROOT, 'CBT', 'Strategy', 'algo2', 'server.js'),
      cwd: path.join(ROOT, 'CBT', 'Strategy', 'algo2'),
      env: { PORT: 3009, NODE_ENV: 'development' },
    },
  ],
};
