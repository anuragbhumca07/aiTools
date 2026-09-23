"""
Dashboard backend — Flask server for the NSE Opening-Range Scanner UI.

Endpoints:
  GET  /                  — serve dashboard HTML
  GET  /api/config        — current config + weights
  GET  /api/status        — scan status, log tail, universe size
  GET  /api/results       — latest scan results for all scan-time slots
  GET  /api/universe      — universe info (size + sample)
  GET  /api/cache-stats   — OHLCV cache coverage
  POST /api/scan          — trigger a fresh scan (background thread)

Run:  python dashboard.py
Open: http://localhost:5000
"""
from __future__ import annotations
import dataclasses
import logging
import math
import os
import sys
import threading
from datetime import datetime

import pytz
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

# Ensure the script's own directory is always on sys.path and is the cwd.
# This makes imports and relative paths (web/, cache/) work regardless of
# which directory the user launches from.
_HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(_HERE)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import config
from backtester import run_backtest, get_bt_state, _set_bt, BacktestResults
from data_cache import (bootstrap_cache, load_ohlcv, get_cache_stats,
                        clear_ohlcv_cache, reset_dhan_access_flag, _dhan_access_denied)
from features import get_latest_features
from scanner import run_scan, get_all_results
from universe import fetch_instrument_master, build_universe

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

_WEB_DIR = os.path.join(_HERE, "web")
app = Flask(__name__, static_folder=_WEB_DIR, static_url_path="")
CORS(app)

IST = pytz.timezone(config.TIMEZONE)

# ── Shared scan state ─────────────────────────────────────────────────────────
_state: dict = {
    "status":        "idle",   # idle | loading | caching | computing | scanning | done | error
    "progress":      0,        # 0–100 for progress bar
    "log":           [],
    "last_scan_at":  None,
    "universe_size": 0,
    "universe_df":   None,
    "features_map":  {},
    "error":         None,
}
_lock = threading.Lock()


def _log(msg: str, level: str = "info"):
    getattr(logger, level)(msg)
    with _lock:
        _state["log"].append({"ts": _now_ist(), "msg": msg})
        if len(_state["log"]) > 300:
            _state["log"] = _state["log"][-300:]


def _now_ist() -> str:
    return datetime.now(IST).strftime("%H:%M:%S")


# ── Static + index ────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(_WEB_DIR, "index.html")


# ── API endpoints ─────────────────────────────────────────────────────────────

@app.route("/api/config")
def api_config():
    return jsonify({
        "MIN_PRICE":        config.MIN_PRICE,
        "MIN_ADTV_CR":      config.MIN_ADTV_CR,
        "MAX_INSTRUMENTS":  config.MAX_INSTRUMENTS,
        "TOP_N":            config.TOP_N,
        "HISTORY_DAYS_CAL": config.HISTORY_DAYS_CAL,
        "SCAN_TIMES":       config.SCAN_TIMES,
        "OR_START":         config.OR_START,
        "OR_END":           config.OR_END,
        "weights": {
            "Opening Range Breakout": config.W_OPENING_RANGE_BREAKOUT,
            "Relative Volume":        config.W_RELATIVE_VOLUME,
            "VWAP Position":          config.W_VWAP_POSITION,
            "5-min Momentum":         config.W_MOMENTUM_5MIN,
            "Prev-day H/L Break":     config.W_PREV_DAY_HL_BREAK,
            "EMA Structure":          config.W_EMA_STRUCTURE,
            "20d/52w Level Break":    config.W_LEVEL_BREAKOUT,
            "RS vs NIFTY":            config.W_RS_NIFTY,
            "Sector RS (Phase 4)":    config.W_SECTOR_RS,
            "Candle Quality":         config.W_CANDLE_QUALITY,
            "Gap Quality":            config.W_GAP_QUALITY,
        },
        "total_weight":  config.TOTAL_WEIGHT,
        "weights_status": "UNVALIDATED — Phase 3 backtesting will replace these values",
    })


@app.route("/api/status")
def api_status():
    from data_cache import _dhan_access_denied
    with _lock:
        return jsonify({
            "status":        _state["status"],
            "progress":      _state["progress"],
            "last_scan_at":  _state["last_scan_at"],
            "universe_size": _state["universe_size"],
            "log":           _state["log"][-50:],
            "error":         _state["error"],
            "data_source":   "yfinance (fallback)" if _dhan_access_denied else "Dhan",
        })


@app.route("/api/results")
def api_results():
    all_results = get_all_results()
    out = {}
    for slot, data in all_results.items():
        out[slot] = {
            "LONG":       [_serialise(r) for r in data.get("LONG", [])],
            "SHORT":      [_serialise(r) for r in data.get("SHORT", [])],
            "scan_time":  data.get("scan_time", slot),
            "regime":     data.get("regime", "NEUTRAL"),
            "confirmed":  data.get("confirmed", []),
            "failed":     data.get("failed", []),
            "note":       data.get("note", ""),
        }
    return jsonify(out)


@app.route("/api/universe")
def api_universe():
    with _lock:
        u = _state["universe_df"]
        size = _state["universe_size"]
    if u is None:
        return jsonify({"size": 0, "sample": [], "status": "not loaded"})
    sample = u.head(30).fillna("").to_dict(orient="records")
    return jsonify({"size": size, "sample": sample, "status": "loaded"})


@app.route("/api/cache-stats")
def api_cache_stats():
    from data_cache import _dhan_access_denied
    with _lock:
        u = _state["universe_df"]
    if u is None:
        return jsonify({"error": "Universe not loaded yet — run a scan first"})
    stats = get_cache_stats(u)
    stats["dhan_active"] = not _dhan_access_denied
    return jsonify(stats)


@app.route("/api/clear-cache", methods=["POST"])
def api_clear_cache():
    """Delete all cached OHLCV parquet files and reset Dhan access flag."""
    with _lock:
        if _state["status"] in ("loading", "caching", "computing", "scanning"):
            return jsonify({"error": "Cannot clear cache while scan is running"}), 409
    reset_dhan_access_flag()
    n = clear_ohlcv_cache()
    _log(f"Cache cleared: {n} files deleted. Dhan access flag reset.")
    return jsonify({"deleted": n, "message": f"Cleared {n} cached files. Next scan will re-download from Dhan."})


@app.route("/api/scan", methods=["POST"])
def api_scan():
    body = request.get_json(silent=True) or {}
    params = {
        "MIN_PRICE":       float(body.get("MIN_PRICE",       config.MIN_PRICE)),
        "MIN_ADTV_CR":     float(body.get("MIN_ADTV_CR",     config.MIN_ADTV_CR)),
        "TOP_N":           int(body.get("TOP_N",             config.TOP_N)),
        "MAX_INSTRUMENTS": int(body.get("MAX_INSTRUMENTS",   config.MAX_INSTRUMENTS)),
        "force_refresh":   bool(body.get("force_refresh",    False)),
        "scan_time":       str(body.get("scan_time",         "09:30")),
    }

    with _lock:
        if _state["status"] in ("loading", "caching", "computing", "scanning"):
            return jsonify({"error": "Scan already in progress"}), 409
        _state["status"]   = "loading"
        _state["progress"] = 0
        _state["log"]      = []
        _state["error"]    = None

    t = threading.Thread(target=_scan_worker, args=(params,), daemon=True)
    t.start()
    return jsonify({"status": "started", "params": params})


# ── Background scan worker ────────────────────────────────────────────────────

def _scan_worker(params: dict):
    try:
        _set_state(status="loading", progress=5)
        _log("Fetching instrument master …")
        master = fetch_instrument_master(force_refresh=params["force_refresh"])
        _log(f"Instrument master: {len(master):,} rows")

        _log("Filtering NSE equity universe …")
        universe = build_universe(master)
        _set_state(progress=15, universe_df=universe, universe_size=len(universe))
        _log(f"Eligible universe: {len(universe):,} stocks")

        if universe.empty:
            raise RuntimeError(
                "Universe is empty — check VERIFY markers in universe.py "
                "or run: python phase1_verify.py --inspect"
            )

        _set_state(status="caching", progress=20)
        _log("Bootstrapping OHLCV cache (skipping already-cached) …")

        # Override MAX_INSTRUMENTS from params
        original_max = config.MAX_INSTRUMENTS
        config.MAX_INSTRUMENTS = params["MAX_INSTRUMENTS"]
        try:
            dl_results = bootstrap_cache(universe, force_refresh=params["force_refresh"])
        finally:
            config.MAX_INSTRUMENTS = original_max

        ok = sum(1 for v in dl_results.values() if v > 0)
        _log(f"OHLCV cache: {ok} stocks with data")
        _set_state(progress=60)

        _set_state(status="computing", progress=65)
        _log("Computing daily features …")
        features_map: dict = {}
        sids = universe["security_id"].tolist()
        if params["MAX_INSTRUMENTS"] > 0:
            sids = sids[: params["MAX_INSTRUMENTS"]]

        for sid in sids:
            df = load_ohlcv(sid)
            if df is not None and not df.empty:
                features_map[sid] = get_latest_features(df)

        _set_state(progress=80, features_map=features_map)
        _log(f"Features computed: {len(features_map)} stocks")

        _set_state(status="scanning", progress=85)
        scan_time = params["scan_time"]
        _log(f"Running scan at {scan_time} …")
        run_scan(universe, scan_time, features_map, params)
        _set_state(progress=100)

        now = _now_ist()
        _set_state(status="done", last_scan_at=now)
        _log(f"Scan complete at {now}")
        _log("⚠  Results use UNVALIDATED weights — paper trade only until Phase 3 validates them.")

    except Exception as exc:
        logger.exception("Scan worker error: %s", exc)
        _set_state(status="error", error=str(exc))
        _log(f"ERROR: {exc}", level="error")


def _set_state(**kwargs):
    with _lock:
        _state.update(kwargs)


# ── Serialisation helpers ─────────────────────────────────────────────────────

def _serialise(obj) -> dict:
    """Convert ScanResult (or any dataclass) to a JSON-safe dict."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        d = dataclasses.asdict(obj)
    else:
        try:
            d = dict(vars(obj))
        except TypeError:
            return str(obj)

    # Replace NaN / Inf with None for JSON
    def _clean(v):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        return v

    return {k: _clean(v) for k, v in d.items()}


# ── Backtest endpoints ────────────────────────────────────────────────────────

@app.route("/api/backtest/run", methods=["POST"])
def api_backtest_run():
    body = request.get_json(silent=True) or {}
    lookback  = int(body.get("lookback_days", 60))
    min_score = float(body.get("min_score", 52.0))

    bt = get_bt_state()
    if bt["status"] == "running":
        return jsonify({"error": "Backtest already running"}), 409

    t = threading.Thread(
        target=_backtest_worker,
        args=(lookback, min_score),
        daemon=True,
    )
    t.start()
    return jsonify({"status": "started", "lookback_days": lookback, "min_score": min_score})


@app.route("/api/backtest/status")
def api_backtest_status():
    bt = get_bt_state()
    return jsonify({
        "status":   bt["status"],
        "progress": bt["progress"],
        "message":  bt["message"],
        "error":    bt["error"],
    })


@app.route("/api/backtest/results")
def api_backtest_results():
    import dataclasses
    bt = get_bt_state()
    results: BacktestResults | None = bt.get("results")
    if results is None:
        return jsonify({"error": "No backtest results yet — run a backtest first"}), 404

    d = dataclasses.asdict(results)
    d.pop("trades", None)   # omit raw trade list from API (large); use /api/backtest/trades
    return jsonify(d)


@app.route("/api/backtest/trades")
def api_backtest_trades():
    import dataclasses
    bt = get_bt_state()
    results: BacktestResults | None = bt.get("results")
    if results is None:
        return jsonify([])

    def _clean_trade(t):
        d = dataclasses.asdict(t)
        return {k: (None if isinstance(v, float) and (math.isnan(v) or math.isinf(v)) else v)
                for k, v in d.items()}

    return jsonify([_clean_trade(t) for t in results.trades])


def _backtest_worker(lookback_days: int, min_score: float):
    try:
        _log("Backtest started — loading universe …")

        # Load universe (may already be in memory from a prior scan)
        with _lock:
            universe = _state.get("universe_df")

        if universe is None or universe.empty:
            _log("Fetching instrument master for backtest …")
            master   = fetch_instrument_master(force_refresh=False)
            universe = build_universe(master)
            with _lock:
                _state["universe_df"]   = universe
                _state["universe_size"] = len(universe)
            _log(f"Universe: {len(universe):,} stocks")

        _log(f"Backtest: {lookback_days}d lookback | min_score={min_score} | "
             f"OHLCV cache (real Dhan data)")
        run_backtest(universe=universe, lookback_days=lookback_days, min_score=min_score)

        bt = get_bt_state()
        r  = bt.get("results")
        if r:
            _log(f"Backtest done: {r.total_trades} trades | WR={r.win_rate}% | "
                 f"PF={r.profit_factor} | Sharpe={r.sharpe}")
            _log(f"Long WR={r.long_win_rate}% | Short WR={r.short_win_rate}% | "
                 f"Avg R={r.avg_r:+.3f} | MaxDD={r.max_drawdown:.2f}R")
    except Exception as exc:
        logger.exception("Backtest worker error: %s", exc)
        _set_bt(status="error", error=str(exc))
        _log(f"Backtest ERROR: {exc}", level="error")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("DASHBOARD_PORT", "5000"))
    print()
    print("  ┌─────────────────────────────────────────────────┐")
    print("  │  NSE Opening-Range Breakout Scanner — Dashboard  │")
    print("  ├─────────────────────────────────────────────────┤")
    print(f"  │  Open in browser: http://localhost:{port}          │")
    print("  │                                                 │")
    print("  │  Phase 1 ✓  |  Phase 2 scaffold  |  Phase 3 —  │")
    print("  │  Weights: UNVALIDATED — paper trade only        │")
    print("  └─────────────────────────────────────────────────┘")
    print()
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
