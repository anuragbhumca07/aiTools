# PC Heartbeat Monitor

Detects when your PC goes offline (power cut, shutdown, crash) and sends a WhatsApp alert via GREEN-API.

## How it works

```
[This PC]  heartbeat.py  ──POST /heartbeat──►  [Cloud]  monitor_server.py
                                                            │
                                            silence > 2 min │
                                                            ▼
                                                  GREEN-API WhatsApp alert
```

## Files

| File | Where it runs | Purpose |
|------|--------------|---------|
| `heartbeat.py` | **This PC** | Pings monitor every 30 s |
| `monitor_server.py` | **Railway/Render** | Detects silence → WhatsApp alert |
| `setup_autostart.py` | This PC (run once) | Registers heartbeat at Windows startup |
| `start_heartbeat.bat` | This PC | Batch launcher for the heartbeat script |
| `.env` | Both | All credentials & config |

## Quick Start

### Step 1 — Deploy monitor_server.py to Railway

```bash
cd CBT/PCcheck
railway link         # link to your Railway project
railway up --detach  # deploy
railway domain       # URL: https://pccheck-production.up.railway.app
```

Set these env vars in Railway dashboard for this service:
- `WA_INSTANCE` = 7107634527
- `WA_TOKEN` = ef56b765b24343ce8c42a279f64ceeb53cec3
- `WA_GROUP` = 120363425758251459
- `ALERT_THRESHOLD` = 120  *(seconds — alert if no ping for 2 min)*

### Step 2 — Configure heartbeat.py

Edit `.env` on this PC:
```
MONITOR_URL=https://pccheck-production.up.railway.app   ← already set
```

### Step 3 — Test manually

```bash
python heartbeat.py    # should log "Ping OK" every 30 s
```

Open `https://pccheck-production.up.railway.app/status` — you should see `"pc_online": true`.

### Step 4 — Register at Windows startup (run once)

```bash
python setup_autostart.py
```

This adds a Task Scheduler entry that starts `heartbeat.py` silently at every login/boot.

## Alerts

**PC goes down:**
```
⚠️ PC IS DOWN
━━━━━━━━━━━━━━━━━━
Time: 2025-06-11 14:35:02 IST
Last seen: 2025-06-11 14:33:01 IST
Status: No heartbeat for 2.0 minutes
━━━━━━━━━━━━━━━━━━
Possible cause: Power cut / crash / shutdown
```

**PC comes back:**
```
✅ PC IS BACK ONLINE
━━━━━━━━━━━━━━━━━━
Time: 2025-06-11 14:45:00 IST
Downtime: ~12.0 minutes
━━━━━━━━━━━━━━━━━━
Heartbeat resumed normally.
```

## API Endpoints (monitor server)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/heartbeat` | POST | Receives ping from PC |
| `/status` | GET | JSON status of PC |
| `/health` | GET | Health check for Railway |

## Remove startup task

```
schtasks /Delete /TN PCHeartbeatMonitor /F
```
