# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

A multi-service AI content generation and distribution platform deployed on Railway. Each subdirectory is an independent service with its own `Dockerfile` and `package.json`/`requirements.txt`.

## Services & Ports

| Service | Tech | Port | Purpose |
|---|---|---|---|
| `my-video/` | Node.js + Remotion (TypeScript) | 3001 | Quiz video generation |
| `social-media/` | Node.js + Express | 3001 | Multi-platform video uploader |
| `Scheduler/` | Node.js + SQLite | 3003 | Cron-based orchestration |
| `aiExplainer/` | Python + Flask + Manim | 3002 | AI explanation video generator |
| `main-page/` | Static HTML/JS | — | Hub page with Supabase auth |

## Commands

### my-video
```bash
cd my-video
npm install
npm run dev          # Remotion Studio (visual editor)
npm run server       # Express API server (port 3001)
npm run build        # Bundle for production
npm run lint         # eslint src && tsc
```

### social-media
```bash
cd social-media
npm install
npm run dev          # nodemon server.js (auto-reload)
npm start            # node server.js (production)
```

### Scheduler
```bash
cd Scheduler
npm install
npm start            # node server.js
```

### aiExplainer
```bash
cd aiExplainer
pip install -r requirements.txt
python server.py
```

### Testing (root)
```bash
npm install                          # installs Playwright
npx playwright test                  # run all tests
npx playwright test tests/foo.spec.js  # run single test file
npx playwright show-report           # view HTML report
```

## Architecture

### Data Flow
1. **Scheduler** fires cron jobs → calls `my-video /api/generate-random` → downloads MP4
2. Scheduler reads stored credentials from SQLite → calls `social-media /api/upload/:platform`
3. Users can also trigger "Run Now" manually from the Scheduler web UI
4. `main-page` authenticates users via Supabase JWT; that JWT is passed to Scheduler for auth

### Authentication
- Supabase Auth (JWT) is the identity layer across all services
- Scheduler verifies JWTs server-side using `SUPABASE_SERVICE_KEY`
- Social platform credentials (YouTube, TikTok, etc.) are passed in request bodies — **not** stored in `.env`; Scheduler stores them in its SQLite `credentials` table keyed by `(user_id, platform)`

### Scheduler Database (SQLite via better-sqlite3)
Four tables: `schedules`, `credentials`, `jobs`, `postings`. Schema in `Scheduler/supabase-schema.sql`. The database file lives at `/data/` (volume-mounted in production).

### Video Generation (my-video)
- React/TypeScript components in `src/` define Remotion compositions
- `server.js` spawns `remotion render` as a child process and writes output to `out/`
- TTS audio is generated via `edge-tts` (Python subprocess) and synced with FFmpeg

### Social-Media Uploader
- All platform uploads in `server.js`; each platform has its own endpoint (`/api/upload/youtube`, etc.)
- AI caption generation supports Groq, Gemini, Hugging Face, and Ollama
- File uploads handled by `multer`; 2GB limit; files stored temporarily in `uploads/`

### aiExplainer
- Flask app calls Groq API to solve a problem, then generates Manim animation code
- Renders animation + edge-tts narration, synced with FFmpeg into final MP4
- Heavy CPU/memory workload; `manimcommunity/manim:latest` Docker base image

## Environment Variables

### Scheduler (required)
```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_KEY
QUIZ_API_URL          # URL of my-video service
BASE_URL              # URL of this scheduler service
TZ_NAME               # Timezone for cron (e.g. America/New_York)
```

### social-media
```
PORT=3001
BASE_URL              # Public URL of this service (for OAuth callbacks)
```

### my-video (Docker)
```
REMOTION_CHROME_EXECUTABLE_PATH=/usr/bin/chromium
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
```

## Deployment

All services deploy independently on Railway using their own `Dockerfile`. Each has a `railway.json` specifying `"builder": "DOCKERFILE"` and a `/health` healthcheck endpoint. Restart policy is `ON_FAILURE` with 3 max retries.
