"""
Multi-position intraday trading engine.

Lifecycle
─────────
  1. engine.start() → runs screener, loads historical bars, begins the tick loop
  2. Every 5 min (new bar): for each candidate symbol
       a. If in position: check_exit() → close if triggered
       b. If no position: generate_signal() → enter if BUY/SELL passes all gates
  3. EOD:
       3:15 PM ET — block new entries
       3:30 PM ET — place marketable limit orders for all open positions
       3:40 PM ET — market order fallback for anything still open

Risk gates before any entry:
  - max concurrent positions (MAX_CONCURRENT = 15)
  - portfolio risk cap  (sum of open risks ≤ 6% of equity)
  - capital cap         (price × qty ≤ $500)
  - SHORT: Alpaca only, easy_to_borrow must be True

State is stored in the module-level `_engine_state` dict and exposed via
get_state() for the FastAPI server to broadcast.
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
from screener import run_screener
import config as cfg

logger = logging.getLogger(__name__)
ET = pytz.timezone(cfg.MARKET_TZ)

# ── Engine state ──────────────────────────────────────────────────────────────
_state: dict[str, Any] = {
    "status":         "idle",    # idle | running | stopping | stopped | error
    "mode":           cfg.MODE,
    "broker":         cfg.BROKER,
    "balance":        0.0,
    "equity":         0.0,
    "session_pnl":    0.0,
    "total_trades":   0,
    "wins":           0,
    "portfolio_risk_pct": 0.0,
    "eod_phase":      None,      # None | stop_entries | closing | done
    "positions":      {},        # symbol → position dict
    "screener":       [],        # last screener output
    "log":            [],
    "error":          None,
}
_state_lock = threading.Lock()
_stop_event = threading.Event()
_broker_ref: BrokerInterface | None = None


# ── Public API ────────────────────────────────────────────────────────────────

def get_state() -> dict:
    with _state_lock:
        s = dict(_state)
        s["positions"] = {k: dict(v) for k, v in _state["positions"].items()}
        s["screener"]  = list(_state["screener"])
        s["log"]       = list(_state["log"][-100:])
    return s


def start(broker: BrokerInterface):
    global _broker_ref
    with _state_lock:
        if _state["status"] == "running":
            return
        _state.update(
            status="running", error=None,
            session_pnl=0.0, total_trades=0, wins=0,
            positions={}, eod_phase=None,
        )
    _broker_ref = broker
    _stop_event.clear()
    t = threading.Thread(target=_engine_loop, daemon=True)
    t.start()
    _log("Engine started", "INFO")


def stop():
    _stop_event.set()
    _set("status", "stopping")
    _log("Stop requested - finishing current tick", "WARN")


def manual_close_all(reason: str = "manual close"):
    with _state_lock:
        syms = list(_state["positions"].keys())
    for sym in syms:
        _close_position(sym, reason)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _set(key: str, val):
    with _state_lock:
        _state[key] = val


def _log(msg: str, level: str = "INFO"):
    now = datetime.now(ET).strftime("%H:%M:%S")
    entry = {"ts": now, "msg": msg, "level": level}
    getattr(logger, level.lower(), logger.info)(msg)
    with _state_lock:
        _state["log"].append(entry)
        if len(_state["log"]) > 500:
            _state["log"] = _state["log"][-500:]


def _now_et() -> datetime:
    return datetime.now(ET)


def _hm_to_minutes(hm: str) -> int:
    h, m = hm.split(":")
    return int(h) * 60 + int(m)


def _eod_phase() -> str | None:
    now = _now_et()
    mins = now.hour * 60 + now.minute
    if mins >= _hm_to_minutes(cfg.EOD_MARKET_FALLBACK_HM):
        return "fallback"
    if mins >= _hm_to_minutes(cfg.EOD_CLOSE_START_HM):
        return "closing"
    if mins >= _hm_to_minutes(cfg.EOD_STOP_ENTRIES_HM):
        return "stop_entries"
    return None


def _is_market_hours() -> bool:
    now = _now_et()
    mins = now.hour * 60 + now.minute
    return 9 * 60 + 30 <= mins < 16 * 60


def _portfolio_risk(equity: float) -> float:
    """Sum of (entry_price - stop_loss) * qty for all open positions / equity."""
    with _state_lock:
        total_risk = sum(
            abs(p["entry_price"] - p["stop_loss"]) * p["qty"]
            for p in _state["positions"].values()
        )
    return total_risk / equity if equity > 0 else 0.0


def _open_risk_usd(p: dict) -> float:
    return abs(p["entry_price"] - p["stop_loss"]) * p["qty"]


def _close_position(symbol: str, reason: str, price: float | None = None):
    broker = _broker_ref
    if broker is None:
        return
    with _state_lock:
        pos = _state["positions"].get(symbol)
    if pos is None:
        return

    qty  = int(pos["qty"])
    side = pos["side"]
    close_side = "sell" if side == "long" else "buy"

    # If no price provided, fetch latest quote (for manual close)
    if price is None:
        try:
            quote = broker.get_latest_quote(symbol)
            price = quote["price"]
        except Exception:
            candles = _candle_cache.get(symbol)
            price = candles[-1]["close"] if candles else pos["entry_price"]

    try:
        if "EOD" in reason or "closing" in reason:
            # Marketable limit for EOD exits
            limit_price = price * (0.999 if close_side == "sell" else 1.001)
            broker.place_limit_order(symbol, qty, close_side, limit_price)
        else:
            broker.place_market_order(symbol, qty, close_side)
    except BrokerError as exc:
        _log(f"Close order for {symbol} failed: {exc} - check broker manually", "ERROR")
        return

    with _state_lock:
        pos = _state["positions"].pop(symbol, pos)

    entry = pos["entry_price"]
    pnl   = (price - entry) * qty if side == "long" else (entry - price) * qty

    with _state_lock:
        _state["session_pnl"] += pnl
        _state["total_trades"] += 1
        if pnl > 0:
            _state["wins"] += 1

    _log(f"CLOSED {symbol} {side.upper()} qty={qty} @ {price:.2f}  pnl={pnl:+.2f}  [{reason}]")


def _enter_position(
    broker: BrokerInterface,
    symbol: str,
    side: str,
    price: float,
    stop_loss: float,
    take_profit: float,
    qty: int,
):
    entry_side = "buy" if side == "long" else "sell"
    try:
        broker.place_market_order(symbol, qty, entry_side)
    except BrokerError as exc:
        _log(f"Entry order for {symbol} failed: {exc}", "ERROR")
        return

    pos = {
        "symbol":          symbol,
        "side":            side,
        "qty":             qty,
        "entry_price":     price,
        "stop_loss":       stop_loss,
        "take_profit":     take_profit,
        "phase":           1,
        "candles_held":    0,
        "last_candle_time": None,
        "mae":             0.0,
        "unrealized_pnl":  0.0,
        "open_risk_usd":   abs(price - stop_loss) * qty,
    }
    with _state_lock:
        _state["positions"][symbol] = pos

    _log(
        f"ENTERED {side.upper()} {symbol}  qty={qty}  @ {price:.2f}  "
        f"SL={stop_loss:.2f}  TP={take_profit:.2f}  "
        f"risk=${abs(price - stop_loss) * qty:.2f}"
    )


# ── Bar management ────────────────────────────────────────────────────────────

_candle_cache: dict[str, list[dict]] = {}
_last_bar_times: dict[str, int] = {}


def _utc_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_history(broker: BrokerInterface, symbols: list[str]) -> int:
    """Fetch historical bars for all symbols to seed the indicator cache."""
    et_now = _now_et()
    end   = _utc_iso(et_now)
    # load CANDLE_HISTORY_DAYS of 5-min bars — need ≥ 200 bars for EMA200
    # 5-min bars: ~78/day → 6 days → ~468 bars
    start = _utc_iso(et_now - timedelta(days=cfg.CANDLE_HISTORY_DAYS))
    _log(f"Loading {cfg.CANDLE_HISTORY_DAYS}d of {cfg.CANDLE_INTERVAL} bars for {len(symbols)} symbols...")
    try:
        bars_map = broker.get_bars_multi(symbols, cfg.CANDLE_INTERVAL, start, end, limit=2000)
    except Exception as exc:
        _log(f"History load failed: {exc}", "ERROR")
        return 0

    loaded = 0
    for sym, bars in bars_map.items():
        if bars:
            _candle_cache[sym] = bars
            _last_bar_times[sym] = bars[-1]["time"]
            loaded += 1

    _log(f"History loaded: {loaded}/{len(symbols)} symbols have bars")
    return loaded


def _update_bars(broker: BrokerInterface, symbols: list[str]) -> set[str]:
    """Fetch latest bars, append to cache, return set of symbols with a new bar."""
    et_now = _now_et()
    end   = _utc_iso(et_now)
    start = _utc_iso(et_now - timedelta(minutes=30))
    new_bar_syms: set[str] = set()

    try:
        bars_map = broker.get_bars_multi(symbols, cfg.CANDLE_INTERVAL, start, end, limit=20)
    except Exception as exc:
        _log(f"Bar update failed: {exc}", "WARN")
        return new_bar_syms

    for sym, bars in bars_map.items():
        if not bars:
            continue
        prev_time = _last_bar_times.get(sym, 0)
        # Filter to only bars newer than what we already have
        new_bars = [b for b in bars if b["time"] > prev_time]
        if new_bars:
            cache = _candle_cache.get(sym, [])
            cache.extend(new_bars)
            # keep last 600 bars (~50 trading hours of 5-min data) to bound memory
            if len(cache) > 600:
                cache = cache[-600:]
            _candle_cache[sym] = cache
            _last_bar_times[sym] = cache[-1]["time"]
            new_bar_syms.add(sym)

    return new_bar_syms


# ── Main loop ─────────────────────────────────────────────────────────────────

def _engine_loop():
    broker = _broker_ref

    # ── 1. Screener ───────────────────────────────────────────────────────────
    _log("Running screener...")
    _set("status", "screening")
    candidates = run_screener(broker)
    with _state_lock:
        _state["screener"] = candidates
    symbols = [c["symbol"] for c in candidates]

    if not symbols:
        _log("Screener returned 0 candidates - check seed universe and market hours", "WARN")
        symbols = cfg.SEED_UNIVERSE[:cfg.SCAN_TOP_N]

    # Check ETB for all candidates (for short logic)
    for c in candidates:
        try:
            c["etb"] = broker.is_easy_to_borrow(c["symbol"])
        except Exception:
            c["etb"] = False

    # ── 2. Load historical bars ───────────────────────────────────────────────
    _set("status", "loading")
    loaded = _load_history(broker, symbols)
    if loaded == 0:
        _log("No bars loaded - cannot trade", "ERROR")
        _set("status", "error")
        return

    _set("status", "running")

    # ── 3. Tick loop ──────────────────────────────────────────────────────────
    _log(f"Engine running - {len(symbols)} candidates | mode={cfg.MODE} | broker={cfg.BROKER}")

    last_account_refresh = 0.0
    rsi_exit_cooldown: dict[str, dict] = {}  # symbol → {side, bar_time}

    while not _stop_event.is_set():
        tick_start = time.monotonic()

        # Refresh account balance every 60s
        if time.monotonic() - last_account_refresh > 60:
            try:
                acct = broker.get_account()
                with _state_lock:
                    _state["balance"] = acct["buying_power"]
                    _state["equity"]  = acct["equity"]
                last_account_refresh = time.monotonic()
            except Exception as exc:
                _log(f"Account refresh failed: {exc}", "WARN")

        equity = _state.get("equity") or _state.get("balance") or 10_000.0

        # EOD phase check
        eod = _eod_phase()
        _set("eod_phase", eod)

        # ── EOD market fallback ───────────────────────────────────────────────
        if eod == "fallback":
            with _state_lock:
                open_syms = list(_state["positions"].keys())
            if open_syms:
                _log(f"EOD fallback: market orders for {open_syms}")
                for sym in open_syms:
                    _close_position(sym, "EOD market fallback")
            _set("status", "stopped")
            _log("EOD done - engine stopped")
            return

        # ── Fetch new bars ────────────────────────────────────────────────────
        if not _is_market_hours():
            time.sleep(30)
            continue

        new_bars = _update_bars(broker, symbols)

        # ── Process each symbol ───────────────────────────────────────────────
        for sym in symbols:
            if _stop_event.is_set():
                break
            candles = _candle_cache.get(sym)
            if not candles or len(candles) < 201:
                continue

            with _state_lock:
                pos = _state["positions"].get(sym)

            # ── Exit management ───────────────────────────────────────────────
            if pos is not None:
                # Unconditionally re-run exit logic every loop (SL can be hit intra-bar)
                try:
                    quote = broker.get_latest_quote(sym)
                    price = quote["price"]
                except Exception:
                    price = candles[-1]["close"]

                # Inject current price as a fake last bar for exit check
                check_candles = candles[:-1] + [{**candles[-1], "close": price}]
                ex = check_exit(pos, check_candles)

                # Update position state
                with _state_lock:
                    if sym in _state["positions"]:
                        _state["positions"][sym].update({
                            "stop_loss":       ex["new_stop"],
                            "phase":           ex["new_phase"],
                            "candles_held":    pos["candles_held"],
                            "last_candle_time": pos["last_candle_time"],
                            "mae":             pos["mae"],
                            "unrealized_pnl":  (
                                (price - pos["entry_price"]) * pos["qty"]
                                if pos["side"] == "long"
                                else (pos["entry_price"] - price) * pos["qty"]
                            ),
                            "open_risk_usd":   abs(pos["entry_price"] - ex["new_stop"]) * pos["qty"],
                        })

                # EOD closing phase — don't wait for SL, use marketable limit
                if eod == "closing":
                    _close_position(sym, "EOD closing", price=price)
                    continue

                if ex["exit"]:
                    _close_position(sym, " | ".join(ex["reasons"]), price=price)
                    # Track RSI exit cooldown
                    reason_str = " ".join(ex["reasons"])
                    if "RSI overbought" in reason_str or "RSI oversold" in reason_str:
                        rsi_exit_cooldown[sym] = {
                            "side": pos["side"],
                            "bar_time": candles[-1]["time"],
                        }
                continue

            # ── Entry logic — only on new bars and not in EOD ─────────────────
            if eod in ("closing", "fallback", "stop_entries"):
                continue
            if sym not in new_bars:
                continue

            result = generate_signal(candles)
            signal = result["signal"]
            if signal == "HOLD":
                continue

            side = "long" if signal == "BUY" else "short"

            # Skip SELL on Robinhood
            if side == "short" and cfg.BROKER == "robinhood":
                continue

            # Skip SHORT if not easy_to_borrow
            if side == "short":
                etb = next((c["etb"] for c in candidates if c["symbol"] == sym), False)
                if not etb:
                    continue

            # RSI cooldown check
            cd = rsi_exit_cooldown.get(sym)
            if cd and cd["side"] == side:
                bars_since = sum(
                    1 for b in candles if b["time"] > cd["bar_time"]
                )
                if bars_since < cfg.RSI_COOLDOWN_BARS:
                    continue
                else:
                    del rsi_exit_cooldown[sym]

            ind   = result["indicators"]
            price = ind.get("price", candles[-1]["close"])
            atr   = ind.get("atr")
            if not atr or not price:
                continue

            stop_dist   = compute_stop_dist(atr, price)
            qty         = compute_position_size(equity, stop_dist, price)
            if qty < cfg.MIN_QTY:
                continue

            # Portfolio risk cap
            port_risk = _portfolio_risk(equity)
            new_risk  = stop_dist * qty / equity
            if port_risk + new_risk > cfg.PORTFOLIO_RISK_CAP_PCT:
                _log(f"Risk cap: skip {sym} (port_risk={port_risk:.1%} + new={new_risk:.1%} > {cfg.PORTFOLIO_RISK_CAP_PCT:.0%})")
                continue

            # Max concurrent positions
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
            _enter_position(broker, sym, side, price, sl, tp, qty)

        # Update portfolio risk stat
        with _state_lock:
            eq = _state.get("equity") or 1.0
        _set("portfolio_risk_pct", round(_portfolio_risk(eq) * 100, 2))

        # Sleep remainder of 30-second polling interval
        elapsed = time.monotonic() - tick_start
        sleep_for = max(0.0, 30.0 - elapsed)
        _stop_event.wait(sleep_for)

    _set("status", "stopped")
    _log("Engine stopped")
