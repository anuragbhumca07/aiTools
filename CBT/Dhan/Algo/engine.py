"""
Multi-position intraday trading engine — Dhan NSE.

Lifecycle:
  1. engine.start() -> runs screener, loads historical bars, begins tick loop
  2. Every 5 min (new bar): for each candidate
       a. In position: check_exit() -> close if triggered
       b. No position: generate_signal() -> enter if BUY/SELL passes all gates
  3. EOD (IST):
       3:10 PM - block new entries
       3:20 PM - place marketable limit orders for all open positions
       3:25 PM - market order fallback for anything still open

Risk gates before entry:
  - max concurrent positions (MAX_CONCURRENT = 15)
  - portfolio risk cap  (sum of open risks <= 6% of equity)
  - capital cap         (price * qty <= Rs 50,000)
  - all NSE EQ intraday shorts allowed
"""
from __future__ import annotations
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import pytz

from broker import BrokerInterface, BrokerError
from strategy_core import (
    compute_indicators, generate_signal, check_exit,
    compute_stop_dist, compute_position_size,
)
from screener import run_screener, _build_sym_map
import config as cfg

logger = logging.getLogger(__name__)
IST = pytz.timezone(cfg.TIMEZONE)

# ── Engine state ──────────────────────────────────────────────────────────────
_state: dict[str, Any] = {
    "status":           "idle",
    "mode":             cfg.MODE,
    "broker":           cfg.BROKER,
    "candle_interval":  cfg.CANDLE_INTERVAL,
    "balance":          0.0,
    "equity":           0.0,
    "session_pnl":      0.0,
    "total_trades":     0,
    "wins":             0,
    "portfolio_risk_pct": 0.0,
    "eod_phase":        None,
    "positions":        {},
    "closed_trades":    [],
    "screener":         [],
    "log":              [],
    "error":            None,
}
_state_lock = threading.Lock()
_stop_event = threading.Event()
_broker_ref: BrokerInterface | None = None

# symbol map: security_id -> display symbol
_sym_map: dict[str, str] = {}


# ── Public API ────────────────────────────────────────────────────────────────

def get_state() -> dict:
    with _state_lock:
        s = dict(_state)
        s["positions"]     = {k: dict(v) for k, v in _state["positions"].items()}
        s["closed_trades"] = list(_state["closed_trades"])
        s["screener"]      = list(_state["screener"])
        s["log"]           = list(_state["log"][-100:])
    return s


def start(broker: BrokerInterface, candle_interval: int | None = None):
    global _broker_ref
    with _state_lock:
        if _state["status"] == "running":
            return
        interval = candle_interval or cfg.CANDLE_INTERVAL
        _state.update(
            status="running", error=None,
            session_pnl=0.0, total_trades=0, wins=0,
            positions={}, closed_trades=[], eod_phase=None,
            candle_interval=interval,
            mode="paper" if getattr(broker, "is_paper", False) else "live",
            broker=broker.name,
        )
    _broker_ref = broker
    _stop_event.clear()
    t = threading.Thread(target=_engine_loop, daemon=True)
    t.start()
    _log(f"Engine started (Dhan NSE | {interval}-min bars)")


def stop():
    _stop_event.set()
    _set("status", "stopping")
    _log("Stop requested - finishing current tick", "WARN")


def manual_close_all(reason: str = "manual close"):
    with _state_lock:
        sids = list(_state["positions"].keys())
    for sid in sids:
        _close_position(sid, reason)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _set(key: str, val):
    with _state_lock:
        _state[key] = val


def _log(msg: str, level: str = "INFO"):
    now = datetime.now(IST).strftime("%H:%M:%S")
    entry = {"ts": now, "msg": msg, "level": level}
    getattr(logger, level.lower(), logger.info)(msg)
    with _state_lock:
        _state["log"].append(entry)
        if len(_state["log"]) > 500:
            _state["log"] = _state["log"][-500:]


def _now_ist() -> datetime:
    return datetime.now(IST)


def _hm_to_minutes(hm: str) -> int:
    h, m = hm.split(":")
    return int(h) * 60 + int(m)


def _eod_phase() -> str | None:
    now  = _now_ist()
    mins = now.hour * 60 + now.minute
    if mins >= _hm_to_minutes(cfg.EOD_MARKET_FALLBACK_HM):
        return "fallback"
    if mins >= _hm_to_minutes(cfg.EOD_CLOSE_START_HM):
        return "closing"
    if mins >= _hm_to_minutes(cfg.EOD_STOP_ENTRIES_HM):
        return "stop_entries"
    return None


def _is_market_hours() -> bool:
    now  = _now_ist()
    mins = now.hour * 60 + now.minute
    return 9 * 60 + 15 <= mins < 15 * 60 + 30


def _portfolio_risk(equity: float) -> float:
    with _state_lock:
        total_risk = sum(
            abs(p["entry_price"] - p["stop_loss"]) * p["qty"]
            for p in _state["positions"].values()
        )
    return total_risk / equity if equity > 0 else 0.0


def _display(security_id: str) -> str:
    return _sym_map.get(security_id, security_id)


def _close_position(security_id: str, reason: str, price: float | None = None):
    broker = _broker_ref
    if broker is None:
        return
    with _state_lock:
        pos = _state["positions"].get(security_id)
    if pos is None:
        return

    qty  = int(pos["qty"])
    side = pos["side"]
    close_side = "sell" if side == "long" else "buy"
    sym = _display(security_id)

    if price is None:
        try:
            quote = broker.get_latest_quote(security_id)
            price = quote["price"]
        except Exception:
            candles = _candle_cache.get(security_id)
            price = candles[-1]["close"] if candles else pos["entry_price"]

    try:
        if "EOD" in reason or "closing" in reason:
            limit_price = price * (0.999 if close_side == "sell" else 1.001)
            broker.place_limit_order(security_id, qty, close_side, limit_price)
        else:
            broker.place_market_order(security_id, qty, close_side)
    except BrokerError as exc:
        _log(f"Close order for {sym} failed: {exc} - check broker manually", "ERROR")
        return

    with _state_lock:
        pos = _state["positions"].pop(security_id, pos)

    entry = pos["entry_price"]
    pnl   = (price - entry) * qty if side == "long" else (entry - price) * qty

    closed = {
        **pos,
        "exit_price":  price,
        "pnl":         pnl,
        "close_reason": reason,
        "closed_at":   datetime.now(IST).strftime("%H:%M:%S"),
    }

    with _state_lock:
        _state["session_pnl"] += pnl
        _state["total_trades"] += 1
        if pnl > 0:
            _state["wins"] += 1
        _state["closed_trades"].append(closed)
        if len(_state["closed_trades"]) > 200:
            _state["closed_trades"] = _state["closed_trades"][-200:]

    _log(f"CLOSED {sym} {side.upper()} qty={qty} @ {price:.2f}  pnl=Rs{pnl:+.2f}  [{reason}]")


def _enter_position(
    broker: BrokerInterface,
    security_id: str,
    side: str,
    price: float,
    stop_loss: float,
    take_profit: float,
    qty: int,
):
    entry_side = "buy" if side == "long" else "sell"
    sym = _display(security_id)
    try:
        broker.place_market_order(security_id, qty, entry_side)
    except BrokerError as exc:
        _log(f"Entry order for {sym} failed: {exc}", "ERROR")
        return

    pos = {
        "security_id":     security_id,
        "symbol":          sym,
        "side":            side,
        "qty":             qty,
        "entry_price":     price,
        "entry_time":      _now_ist().strftime("%H:%M:%S"),
        "stop_loss":       stop_loss,
        "take_profit":     take_profit,
        "phase":           1,
        "candles_held":    0,
        "last_candle_time": None,
        "mae":             0.0,
        "unrealized_pnl":  0.0,
        "open_risk_inr":   abs(price - stop_loss) * qty,
    }
    with _state_lock:
        _state["positions"][security_id] = pos

    _log(
        f"ENTERED {side.upper()} {sym}  qty={qty}  @ {price:.2f}  "
        f"SL={stop_loss:.2f}  TP={take_profit:.2f}  "
        f"risk=Rs{abs(price - stop_loss) * qty:.2f}"
    )


# ── Bar management ────────────────────────────────────────────────────────────

_candle_cache: dict[str, list[dict]] = {}
_last_bar_times: dict[str, int] = {}


def _history_days(interval: int) -> int:
    """Calendar days of history needed to collect ~220 bars at the given interval."""
    bars_per_trading_day = max(1, 375 // interval)
    trading_days_needed  = max(6, (220 // bars_per_trading_day) + 3)
    calendar_days        = int(trading_days_needed * 1.5) + 3
    return min(calendar_days, 40)          # cap to keep startup fast


def _min_bars(interval: int) -> int:
    """Minimum bars required before the engine runs signals on a symbol."""
    bars_per_trading_day = max(1, 375 // interval)
    return min(201, bars_per_trading_day * 10)  # 10 trading days or 201, whichever less


def _load_history(broker: BrokerInterface, security_ids: list[str]) -> int:
    from datetime import date, timedelta as td
    interval = _state.get("candle_interval", cfg.CANDLE_INTERVAL)
    h_days   = _history_days(interval)
    today    = date.today()
    start    = (today - td(days=h_days)).isoformat()
    end      = today.isoformat()
    _log(f"Loading {h_days}d of {interval}-min bars for {len(security_ids)} securities...")
    try:
        bars_map = broker.get_bars_multi(security_ids, str(interval), start, end, limit=2000)
    except Exception as exc:
        _log(f"History load failed: {exc}", "ERROR")
        return 0

    loaded = 0
    for sid, bars in bars_map.items():
        if bars:
            _candle_cache[sid] = bars
            _last_bar_times[sid] = bars[-1]["time"]
            loaded += 1

    _log(f"History loaded: {loaded}/{len(security_ids)} securities have bars")
    return loaded


def _update_bars(broker: BrokerInterface, security_ids: list[str]) -> set[str]:
    from datetime import date, timedelta as td
    interval = _state.get("candle_interval", cfg.CANDLE_INTERVAL)
    today    = date.today()
    start    = (today - td(days=1)).isoformat()
    end      = today.isoformat()
    new_bar_sids: set[str] = set()

    try:
        bars_map = broker.get_bars_multi(security_ids, str(interval), start, end, limit=100)
    except Exception as exc:
        _log(f"Bar update failed: {exc}", "WARN")
        return new_bar_sids

    for sid, bars in bars_map.items():
        if not bars:
            continue
        prev_time = _last_bar_times.get(sid, 0)
        new_bars = [b for b in bars if b["time"] > prev_time]
        if new_bars:
            cache = _candle_cache.get(sid, [])
            cache.extend(new_bars)
            if len(cache) > 600:
                cache = cache[-600:]
            _candle_cache[sid] = cache
            _last_bar_times[sid] = cache[-1]["time"]
            new_bar_sids.add(sid)

    return new_bar_sids


# ── Main loop ─────────────────────────────────────────────────────────────────

def _engine_loop():
    global _sym_map
    broker = _broker_ref

    # ── 1. Build symbol map ───────────────────────────────────────────────────
    _log("Building NSE universe...")
    _set("status", "screening")
    _sym_map = _build_sym_map()

    # ── 2. Screener ───────────────────────────────────────────────────────────
    _log("Running screener...")
    candidates = run_screener(broker, sym_map=_sym_map)
    with _state_lock:
        _state["screener"] = candidates
    security_ids = [c["security_id"] for c in candidates]

    if not security_ids:
        _log("Screener returned 0 candidates - check universe and market hours", "WARN")
        _set("status", "error")
        return

    # ── 3. Load historical bars ───────────────────────────────────────────────
    _set("status", "loading")
    loaded = _load_history(broker, security_ids)
    if loaded == 0:
        _log("No bars loaded - cannot trade", "ERROR")
        _set("status", "error")
        return

    _set("status", "running")
    mode = "paper" if getattr(broker, "is_paper", False) else "live"
    _log(f"Engine running - {len(security_ids)} candidates | broker={broker.name} | mode={mode}")

    last_account_refresh = 0.0
    rsi_exit_cooldown: dict[str, dict] = {}

    while not _stop_event.is_set():
        tick_start = time.monotonic()

        # Refresh account every 60s
        if time.monotonic() - last_account_refresh > 60:
            try:
                acct = broker.get_account()
                with _state_lock:
                    _state["balance"] = acct["buying_power"]
                    _state["equity"]  = acct["equity"]
                last_account_refresh = time.monotonic()
            except Exception as exc:
                _log(f"Account refresh failed: {exc}", "WARN")

        equity = _state.get("equity") or _state.get("balance") or 500_000.0

        eod = _eod_phase()
        _set("eod_phase", eod)

        # ── EOD market fallback ───────────────────────────────────────────────
        if eod == "fallback":
            with _state_lock:
                open_sids = list(_state["positions"].keys())
            if open_sids:
                _log(f"EOD fallback: market orders for {[_display(s) for s in open_sids]}")
                for sid in open_sids:
                    _close_position(sid, "EOD market fallback")
            _set("status", "stopped")
            _log("EOD done - engine stopped")
            return

        if not _is_market_hours():
            time.sleep(30)
            continue

        new_bars = _update_bars(broker, security_ids)

        interval   = _state.get("candle_interval", cfg.CANDLE_INTERVAL)
        need_bars  = _min_bars(interval)

        for sid in security_ids:
            if _stop_event.is_set():
                break
            candles = _candle_cache.get(sid)
            if not candles or len(candles) < need_bars:
                continue

            with _state_lock:
                pos = _state["positions"].get(sid)

            sym = _display(sid)

            # ── Exit management ───────────────────────────────────────────────
            if pos is not None:
                try:
                    quote = broker.get_latest_quote(sid)
                    price = quote["price"]
                except Exception:
                    price = candles[-1]["close"]

                check_candles = candles[:-1] + [{**candles[-1], "close": price}]
                ex = check_exit(pos, check_candles)

                with _state_lock:
                    if sid in _state["positions"]:
                        _state["positions"][sid].update({
                            "stop_loss":      ex["new_stop"],
                            "phase":          ex["new_phase"],
                            "candles_held":   pos["candles_held"],
                            "mae":            pos["mae"],
                            "unrealized_pnl": (
                                (price - pos["entry_price"]) * pos["qty"]
                                if pos["side"] == "long"
                                else (pos["entry_price"] - price) * pos["qty"]
                            ),
                            "open_risk_inr": abs(pos["entry_price"] - ex["new_stop"]) * pos["qty"],
                        })

                if eod == "closing":
                    _close_position(sid, "EOD closing", price=price)
                    continue

                if ex["exit"]:
                    _close_position(sid, " | ".join(ex["reasons"]), price=price)
                    reason_str = " ".join(ex["reasons"])
                    if "RSI overbought" in reason_str or "RSI oversold" in reason_str:
                        rsi_exit_cooldown[sid] = {
                            "side":     pos["side"],
                            "bar_time": candles[-1]["time"],
                        }
                continue

            # ── Entry logic ───────────────────────────────────────────────────
            if eod in ("closing", "fallback", "stop_entries"):
                continue
            if sid not in new_bars:
                continue

            result = generate_signal(candles)
            signal = result["signal"]
            if signal == "HOLD":
                continue

            side = "long" if signal == "BUY" else "short"

            # RSI cooldown
            cd = rsi_exit_cooldown.get(sid)
            if cd and cd["side"] == side:
                bars_since = sum(1 for b in candles if b["time"] > cd["bar_time"])
                if bars_since < cfg.RSI_COOLDOWN_BARS:
                    continue
                else:
                    del rsi_exit_cooldown[sid]

            ind   = result["indicators"]
            price = ind.get("price", candles[-1]["close"])
            atr   = ind.get("atr")
            if not atr or not price:
                continue

            # Pause new entries when available margin is too low
            balance = _state.get("balance", 0.0)
            if balance < cfg.MIN_MARGIN_INR:
                _log(f"Low margin Rs{balance:.0f} < Rs{cfg.MIN_MARGIN_INR:.0f} — waiting for trades to close", "WARN")
                continue

            stop_dist = compute_stop_dist(atr, price)
            qty       = compute_position_size(equity, stop_dist, price)
            if qty < cfg.MIN_QTY:
                continue

            port_risk = _portfolio_risk(equity)
            new_risk  = stop_dist * qty / equity
            if port_risk + new_risk > cfg.PORTFOLIO_RISK_CAP_PCT:
                _log(f"Risk cap: skip {sym} (port={port_risk:.1%} + new={new_risk:.1%} > {cfg.PORTFOLIO_RISK_CAP_PCT:.0%})")
                continue

            with _state_lock:
                n_pos = len(_state["positions"])
            if n_pos >= cfg.MAX_CONCURRENT:
                _log(f"Max concurrent ({cfg.MAX_CONCURRENT}) reached - skip {sym}")
                continue

            sl = price - stop_dist if side == "long" else price + stop_dist
            tp = price + stop_dist * cfg.TP_RR_RATIO if side == "long" else price - stop_dist * cfg.TP_RR_RATIO

            _log(
                f"SIGNAL {signal} {sym}  score={result['buy_score'] if signal=='BUY' else result['sell_score']}/7  "
                f"price={price:.2f}  atr={atr:.4f}  qty={qty}  SL={sl:.2f}  TP={tp:.2f}"
            )
            _enter_position(broker, sid, side, price, sl, tp, qty)

        with _state_lock:
            eq = _state.get("equity") or 1.0
        _set("portfolio_risk_pct", round(_portfolio_risk(eq) * 100, 2))

        elapsed  = time.monotonic() - tick_start
        sleep_for = max(0.0, 30.0 - elapsed)
        _stop_event.wait(sleep_for)

    _set("status", "stopped")
    _log("Engine stopped")
