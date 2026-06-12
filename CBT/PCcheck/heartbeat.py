"""
heartbeat.py  — runs on THIS PC
Sends a POST ping to the monitor server every 30 s so it knows the PC is alive.
If the monitor stops receiving pings for 2+ minutes it fires a WhatsApp alert.
"""

import os
import sys
import time
import logging
import requests
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

# ── Config ────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

WA_INSTANCE         = os.getenv("WA_INSTANCE", "")
WA_TOKEN            = os.getenv("WA_TOKEN", "")
WA_GROUP            = os.getenv("WA_GROUP", "")
MONITOR_URL         = os.getenv("MONITOR_URL", "").rstrip("/")
HEARTBEAT_INTERVAL  = int(os.getenv("HEARTBEAT_INTERVAL", "30"))

LOG_FILE = BASE_DIR / "heartbeat.log"

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("heartbeat")


# ── GREEN-API WhatsApp helper ─────────────────────────────────────────────────
def send_whatsapp(text: str, retry: bool = True) -> bool:
    if not (WA_INSTANCE and WA_TOKEN and WA_GROUP):
        log.warning("WhatsApp credentials not set — skipping notification")
        return False
    chat_id = WA_GROUP if "@" in WA_GROUP else f"{WA_GROUP}@g.us"
    url = f"https://api.green-api.com/waInstance{WA_INSTANCE}/sendMessage/{WA_TOKEN}"
    try:
        resp = requests.post(url, json={"chatId": chat_id, "message": text}, timeout=15)
        if resp.status_code == 200:
            log.info("WhatsApp sent OK")
            return True
        log.warning("WhatsApp send failed: %s %s", resp.status_code, resp.text[:120])
    except Exception as exc:
        log.warning("WhatsApp send error: %s", exc)

    if retry:
        log.info("Retrying WhatsApp in 10 s…")
        time.sleep(10)
        return send_whatsapp(text, retry=False)
    return False


# ── Heartbeat ping ────────────────────────────────────────────────────────────
def send_ping() -> bool:
    if not MONITOR_URL:
        log.warning("MONITOR_URL not set — heartbeat ping skipped")
        return False
    try:
        resp = requests.post(
            f"{MONITOR_URL}/heartbeat",
            json={"ts": datetime.utcnow().isoformat()},
            timeout=10,
        )
        ok = resp.status_code == 200
        log.info("Ping %s → %s", MONITOR_URL, "OK" if ok else f"HTTP {resp.status_code}")
        return ok
    except Exception as exc:
        log.warning("Ping failed: %s", exc)
        return False


# ── Main loop ─────────────────────────────────────────────────────────────────
def main():
    log.info("=" * 60)
    log.info("PC Heartbeat starting up")
    log.info("Monitor URL  : %s", MONITOR_URL or "(not set)")
    log.info("Interval     : %s s", HEARTBEAT_INTERVAL)
    log.info("Log file     : %s", LOG_FILE)
    log.info("=" * 60)

    send_whatsapp("✅ PC Heartbeat STARTED — monitoring is active")

    while True:
        send_ping()
        time.sleep(HEARTBEAT_INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Heartbeat stopped by user (Ctrl+C)")
        send_whatsapp("🛑 PC Heartbeat STOPPED manually (Ctrl+C)")
