"""
monitor_server.py  — deploy this on Railway / Render / Replit (free tier)
Receives heartbeat pings from the PC.
If the PC goes silent for 2+ minutes, sends a WhatsApp alert via GREEN-API.
When pings resume, sends a recovery alert.
"""

import os
import sys
import time
import logging
import threading
import requests
from datetime import datetime, timezone, timedelta
from flask import Flask, jsonify, request
from dotenv import load_dotenv

load_dotenv()

# ── Config ─────────────────────────────────────────────────────────────────────
WA_INSTANCE      = os.getenv("WA_INSTANCE", "")
WA_TOKEN         = os.getenv("WA_TOKEN", "")
WA_GROUP         = os.getenv("WA_GROUP", "")
ALERT_THRESHOLD  = int(os.getenv("ALERT_THRESHOLD", "120"))   # seconds
PORT             = int(os.getenv("PORT", "5000"))

IST = timezone(timedelta(hours=5, minutes=30))

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("monitor")

# ── Shared state ───────────────────────────────────────────────────────────────
state = {
    "last_heartbeat": None,      # datetime (UTC)
    "pc_online": None,           # True / False / None (unknown)
    "down_since": None,          # datetime (UTC) when we first noticed it down
    "alert_sent": False,
}
state_lock = threading.Lock()

app = Flask(__name__)


# ── GREEN-API helper ───────────────────────────────────────────────────────────
def send_whatsapp(text: str, retry: bool = True) -> bool:
    if not (WA_INSTANCE and WA_TOKEN and WA_GROUP):
        log.warning("WhatsApp credentials not set — skipping")
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


def fmt_ist(dt_utc: datetime) -> str:
    return dt_utc.astimezone(IST).strftime("%Y-%m-%d %H:%M:%S IST")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ── Flask endpoints ────────────────────────────────────────────────────────────
@app.route("/heartbeat", methods=["POST"])
def heartbeat():
    with state_lock:
        was_down   = state["pc_online"] is False
        down_since = state["down_since"]
        state["last_heartbeat"] = now_utc()
        state["pc_online"]      = True
        state["down_since"]     = None

    log.info("Heartbeat received from PC")

    if was_down and down_since:
        downtime_minutes = round((now_utc() - down_since).total_seconds() / 60, 1)
        msg = (
            f"✅ PC IS BACK ONLINE\n"
            f"━━━━━━━━━━━━━━━━━━\n"
            f"Time: {fmt_ist(now_utc())}\n"
            f"Downtime: ~{downtime_minutes} minutes\n"
            f"━━━━━━━━━━━━━━━━━━\n"
            f"Heartbeat resumed normally."
        )
        log.info("PC back online after %s min — sending recovery alert", downtime_minutes)
        threading.Thread(target=send_whatsapp, args=(msg,), daemon=True).start()
        with state_lock:
            state["alert_sent"] = False

    return jsonify({"ok": True, "ts": now_utc().isoformat()})


@app.route("/status", methods=["GET"])
def status():
    with state_lock:
        lh = state["last_heartbeat"]
        online = state["pc_online"]
        ds = state["down_since"]

    seconds_ago = round((now_utc() - lh).total_seconds()) if lh else None
    return jsonify({
        "pc_online":          online,
        "last_heartbeat_utc": lh.isoformat() if lh else None,
        "last_heartbeat_ist": fmt_ist(lh) if lh else None,
        "seconds_since_ping": seconds_ago,
        "down_since_ist":     fmt_ist(ds) if ds else None,
        "alert_threshold_s":  ALERT_THRESHOLD,
    })


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


# ── Background watcher thread ──────────────────────────────────────────────────
def watcher():
    log.info("Watcher thread started (threshold=%s s)", ALERT_THRESHOLD)
    while True:
        time.sleep(60)
        with state_lock:
            lh         = state["last_heartbeat"]
            alert_sent = state["alert_sent"]
            online     = state["pc_online"]

        if lh is None:
            log.info("Watcher: no heartbeat received yet")
            continue

        elapsed = (now_utc() - lh).total_seconds()

        if elapsed > ALERT_THRESHOLD:
            with state_lock:
                if state["pc_online"] is not False:
                    state["pc_online"]  = False
                    state["down_since"] = lh
                already_sent = state["alert_sent"]
                if not already_sent:
                    state["alert_sent"] = True

            if not already_sent:
                minutes = round(elapsed / 60, 1)
                last_seen = fmt_ist(lh)
                msg = (
                    f"⚠️ PC IS DOWN\n"
                    f"━━━━━━━━━━━━━━━━━━\n"
                    f"Time: {fmt_ist(now_utc())}\n"
                    f"Last seen: {last_seen}\n"
                    f"Status: No heartbeat for {minutes} minutes\n"
                    f"━━━━━━━━━━━━━━━━━━\n"
                    f"Possible cause: Power cut / crash / shutdown"
                )
                log.warning("PC DOWN — no heartbeat for %s min — sending alert", minutes)
                send_whatsapp(msg)
        else:
            log.info("Watcher: PC OK (last ping %ss ago)", round(elapsed))
            with state_lock:
                if state["pc_online"] is None and online is not False:
                    state["pc_online"] = True


# ── Startup ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    watcher_thread = threading.Thread(target=watcher, daemon=True)
    watcher_thread.start()
    log.info("Monitor server starting on port %s", PORT)
    app.run(host="0.0.0.0", port=PORT, debug=False)
