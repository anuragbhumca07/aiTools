"""
FastAPI backend for the Alpaca/Robinhood multi-stock intraday trading system.

Endpoints:
  GET  /                    — dashboard HTML
  GET  /api/status          — engine state snapshot
  GET  /api/screener        — last screener results
  GET  /api/positions       — open positions
  POST /api/start           — start the engine
  POST /api/stop            — stop the engine
  POST /api/close-all       — close all open positions immediately
  WS   /ws                  — live state push (1-second interval)

Run:
  uvicorn server:app --host 0.0.0.0 --port 5100 --reload
"""
from __future__ import annotations
import asyncio
import logging
import os
import sys
from pathlib import Path

# Force UTF-8 on Windows consoles so non-ASCII log chars don't crash the process
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import config as cfg
import engine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# Ensure the script's directory is on sys.path
_HERE = Path(__file__).parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
os.chdir(_HERE)

_WEB_DIR = _HERE / "web"
app = FastAPI(title="Alpaca Intraday Algo")
app.mount("/static", StaticFiles(directory=str(_WEB_DIR)), name="static")

_broker = None


def _get_broker():
    global _broker
    if _broker is None:
        if cfg.BROKER == "alpaca":
            from alpaca_broker import AlpacaBroker
            _broker = AlpacaBroker()
        else:
            raise RuntimeError(f"Unknown broker: {cfg.BROKER}")
    return _broker


# ── REST endpoints ────────────────────────────────────────────────────────────

@app.get("/")
async def index():
    from fastapi.responses import FileResponse
    return FileResponse(str(_WEB_DIR / "index.html"))


@app.get("/api/status")
async def api_status():
    state = engine.get_state()
    state.pop("log", None)
    return JSONResponse(state)


@app.get("/api/log")
async def api_log():
    return JSONResponse({"log": engine.get_state().get("log", [])[-100:]})


@app.get("/api/screener")
async def api_screener():
    return JSONResponse(engine.get_state().get("screener", []))


@app.get("/api/positions")
async def api_positions():
    return JSONResponse(engine.get_state().get("positions", {}))


@app.get("/api/config")
async def api_config():
    return JSONResponse({
        "BROKER":               cfg.BROKER,
        "MODE":                 cfg.MODE,
        "CANDLE_INTERVAL":      cfg.CANDLE_INTERVAL,
        "MAX_CONCURRENT":       cfg.MAX_CONCURRENT,
        "CAPITAL_CAP_USD":      cfg.CAPITAL_CAP_USD,
        "PORTFOLIO_RISK_CAP_PCT": cfg.PORTFOLIO_RISK_CAP_PCT * 100,
        "RISK_PER_TRADE_PCT":   cfg.RISK_PER_TRADE_PCT * 100,
        "STOP_ATR_MULT":        cfg.STOP_ATR_MULT,
        "TP_RR_RATIO":          cfg.TP_RR_RATIO,
        "ADX_MIN":              cfg.ADX_MIN,
        "SIGNAL_THRESHOLD":     cfg.SIGNAL_THRESHOLD,
        "SCAN_TOP_N":           cfg.SCAN_TOP_N,
        "EOD_STOP_ENTRIES":     cfg.EOD_STOP_ENTRIES_HM,
        "EOD_CLOSE_START":      cfg.EOD_CLOSE_START_HM,
    })


@app.post("/api/start")
async def api_start():
    state = engine.get_state()
    if state["status"] in ("running", "screening", "loading"):
        return JSONResponse({"error": "Already running"}, status_code=409)
    try:
        broker = _get_broker()
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)

    # engine.start() spawns its own daemon thread — call directly from the handler
    engine.start(broker)
    return JSONResponse({"status": "starting", "mode": cfg.MODE, "broker": cfg.BROKER})


@app.post("/api/stop")
async def api_stop():
    engine.stop()
    return JSONResponse({"status": "stopping"})


@app.post("/api/close-all")
async def api_close_all():
    engine.manual_close_all("manual close via API")
    return JSONResponse({"status": "closing all positions"})


# ── WebSocket live feed ───────────────────────────────────────────────────────

_ws_clients: set[WebSocket] = set()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    _ws_clients.add(ws)
    try:
        while True:
            state = engine.get_state()
            # Condense for bandwidth
            payload = {
                "status":             state["status"],
                "mode":               state["mode"],
                "broker":             state["broker"],
                "balance":            round(state.get("balance", 0), 2),
                "equity":             round(state.get("equity", 0), 2),
                "session_pnl":        round(state.get("session_pnl", 0), 2),
                "total_trades":       state.get("total_trades", 0),
                "wins":               state.get("wins", 0),
                "win_rate":           (
                    round(state["wins"] / state["total_trades"] * 100, 1)
                    if state.get("total_trades", 0) > 0 else 0.0
                ),
                "portfolio_risk_pct": state.get("portfolio_risk_pct", 0),
                "eod_phase":          state.get("eod_phase"),
                "positions":          state.get("positions", {}),
                "screener":           state.get("screener", [])[:10],
                "log":                state.get("log", [])[-20:],
                "error":              state.get("error"),
            }
            await ws.send_json(payload)
            await asyncio.sleep(1)
    except (WebSocketDisconnect, Exception):
        _ws_clients.discard(ws)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    sep = "-" * 56
    print()
    print(f"  {sep}")
    print(f"  Alpaca Intraday Multi-Stock Algo - Dashboard")
    print(f"  Broker: {cfg.BROKER}  |  Mode: {cfg.MODE}")
    print(f"  Open:   http://localhost:{cfg.PORT}")
    print(f"  {sep}")
    print()
    uvicorn.run("server:app", host="0.0.0.0", port=cfg.PORT, reload=False)
