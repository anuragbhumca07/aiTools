"""
FastAPI server for Dhan NSE intraday algo.
Port: 5051
"""
from __future__ import annotations
import sys

# Ensure UTF-8 output on Windows to avoid cp1252 encoding errors
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import asyncio
import json
import logging
import os
from pathlib import Path

import uvicorn
from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import config as cfg
import engine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Dhan NSE Intraday Algo", version="1.0.0")

# ── Static files (dashboard) ──────────────────────────────────────────────────
_WEB_DIR = Path(__file__).parent / "web"
if _WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_WEB_DIR)), name="static")


@app.get("/")
async def root():
    index = _WEB_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return JSONResponse({"status": "Dhan NSE Intraday Algo running", "port": cfg.PORT})


# ── REST API ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "broker": "dhan", "port": cfg.PORT}


@app.get("/api/state")
async def api_state():
    return engine.get_state()


@app.post("/api/start")
async def api_start(candle_interval: int = Body(default=5, embed=True)):
    from dhan_broker import DhanBroker
    try:
        broker = DhanBroker()
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    engine.start(broker, candle_interval=candle_interval)
    return {"status": "started", "candle_interval": candle_interval}


@app.post("/api/update_token")
async def api_update_token(token: str = Body(..., embed=True)):
    """Update Dhan access token at runtime without restarting the server."""
    token = token.strip()
    if not token:
        return JSONResponse({"error": "empty token"}, status_code=400)
    cfg.DHAN_ACCESS_TOKEN = token
    os.environ["DHAN_ACCESS_TOKEN"] = token
    logger.info("Dhan access token updated via API")
    return {"status": "updated", "hint": "stop + restart engine to use new token"}


@app.post("/api/stop")
async def api_stop():
    engine.stop()
    return {"status": "stopping"}


@app.post("/api/close_all")
async def api_close_all():
    engine.manual_close_all("manual close via API")
    return {"status": "closing all positions"}


@app.get("/api/config")
async def api_config():
    return {
        "broker":            cfg.BROKER,
        "mode":              cfg.MODE,
        "capital_cap_inr":   cfg.CAPITAL_CAP_INR,
        "risk_per_trade_pct": cfg.RISK_PER_TRADE_PCT,
        "max_concurrent":    cfg.MAX_CONCURRENT,
        "scan_top_n":        cfg.SCAN_TOP_N,
        "candle_interval":   cfg.CANDLE_INTERVAL,
        "eod_stop_entries":  cfg.EOD_STOP_ENTRIES_HM,
        "eod_close_start":   cfg.EOD_CLOSE_START_HM,
        "eod_fallback":      cfg.EOD_MARKET_FALLBACK_HM,
        "port":              cfg.PORT,
    }


# ── WebSocket ─────────────────────────────────────────────────────────────────

_ws_clients: list[WebSocket] = []
_ws_lock = asyncio.Lock()


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    async with _ws_lock:
        _ws_clients.append(ws)
    try:
        while True:
            state = engine.get_state()
            try:
                await ws.send_text(json.dumps(state, default=str))
            except Exception:
                break
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        pass
    finally:
        async with _ws_lock:
            if ws in _ws_clients:
                _ws_clients.remove(ws)


if __name__ == "__main__":
    print("=" * 60)
    print("  Dhan NSE Intraday Algo")
    print(f"  http://localhost:{cfg.PORT}")
    print(f"  Capital cap: Rs {cfg.CAPITAL_CAP_INR:,.0f} per position")
    print(f"  EOD: stop={cfg.EOD_STOP_ENTRIES_HM}  close={cfg.EOD_CLOSE_START_HM}  fallback={cfg.EOD_MARKET_FALLBACK_HM} IST")
    print("=" * 60)
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=cfg.PORT,
        reload=False,
        log_level="info",
    )
