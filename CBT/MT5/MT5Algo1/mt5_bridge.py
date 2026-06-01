"""
MT5 Bridge — stdin/stdout JSON-RPC bridge between Node.js and MT5 terminal.
Node.js spawns this script once; sends JSON commands on stdin, reads
JSON responses on stdout. Each message is a single newline-terminated line.
Every request includes "_id" which is echoed back in the response.

Startup: prints {"ok": true/false, "ready": bool} as the very first line.

Requires: pip install MetaTrader5
Windows only (MetaTrader5 package is Windows-exclusive).
"""

import sys
import json
from datetime import datetime, timedelta

# ── MT5 import ────────────────────────────────────────────────────
try:
    import MetaTrader5 as mt5
    MT5_PKG = True
except ImportError:
    MT5_PKG = False

def out(obj):
    print(json.dumps(obj), flush=True)

# ── Startup handshake ─────────────────────────────────────────────
# Never exit early — always stay alive so Node.js pipe stays open.
# When MT5 is unavailable, every command returns a fast error response.
MT5_READY = False

if not MT5_PKG:
    out({"ok": False, "ready": False,
         "error": "MetaTrader5 package not installed. Run: pip install MetaTrader5"})
elif not mt5.initialize():
    err = mt5.last_error()
    out({"ok": False, "ready": False,
         "error": f"MT5 initialize failed: {err}. Ensure MT5 terminal is open and logged in."})
else:
    MT5_READY = True
    out({"ok": True, "ready": True, "version": list(mt5.version())})

# ── Timeframe map ─────────────────────────────────────────────────
TF_MAP = {
    "1m":  mt5.TIMEFRAME_M1,  "5m":  mt5.TIMEFRAME_M5,
    "15m": mt5.TIMEFRAME_M15, "30m": mt5.TIMEFRAME_M30,
    "1h":  mt5.TIMEFRAME_H1,  "4h":  mt5.TIMEFRAME_H4,
    "1d":  mt5.TIMEFRAME_D1,
}

def candle_list(rates):
    return [
        {
            "time":   int(r["time"]) * 1000,   # seconds → ms
            "open":   float(r["open"]),
            "high":   float(r["high"]),
            "low":    float(r["low"]),
            "close":  float(r["close"]),
            "volume": float(r["tick_volume"]),
        }
        for r in rates
    ]

def get_filling_mode(symbol):
    info = mt5.symbol_info(symbol)
    if info is None:
        return mt5.ORDER_FILLING_IOC
    fm = info.filling_mode
    # Prefer RETURN > IOC > FOK
    if fm & 4:
        return mt5.ORDER_FILLING_RETURN
    if fm & 2:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_FOK

# ── Command handlers ──────────────────────────────────────────────
def handle(cmd):
    action = cmd.get("cmd")

    # ── ping ──────────────────────────────────────────────────────
    if action == "ping":
        return {"ok": True, "data": "pong"}

    # ── get_candles ───────────────────────────────────────────────
    elif action == "get_candles":
        symbol = cmd.get("symbol", "BTCUSD")
        tf     = TF_MAP.get(cmd.get("timeframe", "1m"), mt5.TIMEFRAME_M1)
        count  = int(cmd.get("count", 251))
        rates  = mt5.copy_rates_from_pos(symbol, tf, 0, count)
        if rates is None or len(rates) == 0:
            return {"ok": False, "error": f"No candles for {symbol}: {mt5.last_error()}"}
        return {"ok": True, "data": candle_list(rates)}

    # ── get_candles_historical ────────────────────────────────────
    elif action == "get_candles_historical":
        symbol = cmd.get("symbol", "BTCUSD")
        tf     = TF_MAP.get(cmd.get("timeframe", "1m"), mt5.TIMEFRAME_M1)
        months = int(cmd.get("months", 3))
        from_dt = datetime.now() - timedelta(days=months * 31)
        to_dt   = datetime.now()
        rates   = mt5.copy_rates_range(symbol, tf, from_dt, to_dt)
        if rates is None or len(rates) == 0:
            return {"ok": False, "error": f"No historical rates for {symbol}: {mt5.last_error()}"}
        return {"ok": True, "data": candle_list(rates)}

    # ── get_price ─────────────────────────────────────────────────
    elif action == "get_price":
        symbol = cmd.get("symbol", "BTCUSD")
        tick   = mt5.symbol_info_tick(symbol)
        if tick is None:
            return {"ok": False, "error": f"No tick for {symbol}: {mt5.last_error()}"}
        return {"ok": True, "data": {"bid": float(tick.bid), "ask": float(tick.ask),
                                     "time": int(tick.time) * 1000}}

    # ── place_order ───────────────────────────────────────────────
    elif action == "place_order":
        symbol     = cmd.get("symbol", "BTCUSD")
        order_side = cmd.get("type", "BUY")
        volume     = float(cmd.get("volume", 1.0))
        sl         = float(cmd.get("sl", 0))
        tp         = float(cmd.get("tp", 0))
        comment    = cmd.get("comment", "CBT MT5Algo1")

        order_type = mt5.ORDER_TYPE_BUY if order_side == "BUY" else mt5.ORDER_TYPE_SELL
        tick       = mt5.symbol_info_tick(symbol)
        if tick is None:
            return {"ok": False, "error": f"No tick for {symbol}"}
        price      = tick.ask if order_type == mt5.ORDER_TYPE_BUY else tick.bid

        request = {
            "action":       mt5.TRADE_ACTION_DEAL,
            "symbol":       symbol,
            "volume":       volume,
            "type":         order_type,
            "price":        price,
            "sl":           sl,
            "tp":           tp,
            "deviation":    20,
            "magic":        234001,
            "comment":      comment,
            "type_time":    mt5.ORDER_TIME_GTC,
            "type_filling": get_filling_mode(symbol),
        }
        result = mt5.order_send(request)
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return {"ok": False,
                    "error": f"Order failed retcode={result.retcode}: {result.comment}"}
        return {"ok": True, "data": {"ticket": int(result.order), "price": float(result.price)}}

    # ── close_order ───────────────────────────────────────────────
    elif action == "close_order":
        ticket = int(cmd.get("ticket", 0))
        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            return {"ok": False, "error": f"Position {ticket} not found (already closed?)"}
        pos        = positions[0]
        close_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
        tick       = mt5.symbol_info_tick(pos.symbol)
        price      = tick.bid if close_type == mt5.ORDER_TYPE_SELL else tick.ask
        request = {
            "action":       mt5.TRADE_ACTION_DEAL,
            "symbol":       pos.symbol,
            "volume":       pos.volume,
            "type":         close_type,
            "position":     ticket,
            "price":        price,
            "deviation":    20,
            "magic":        234001,
            "comment":      "CBT MT5Algo1 close",
            "type_time":    mt5.ORDER_TIME_GTC,
            "type_filling": get_filling_mode(pos.symbol),
        }
        result = mt5.order_send(request)
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return {"ok": False,
                    "error": f"Close failed retcode={result.retcode}: {result.comment}"}
        return {"ok": True, "data": {"ticket": int(result.order), "price": float(result.price)}}

    # ── modify_sl ─────────────────────────────────────────────────
    elif action == "modify_sl":
        ticket = int(cmd.get("ticket", 0))
        new_sl = float(cmd.get("sl", 0))
        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            return {"ok": False, "error": f"Position {ticket} not found"}
        pos = positions[0]
        request = {
            "action":   mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol":   pos.symbol,
            "sl":       new_sl,
            "tp":       pos.tp,   # preserve existing TP
        }
        result = mt5.order_send(request)
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return {"ok": False,
                    "error": f"Modify SL failed retcode={result.retcode}: {result.comment}"}
        return {"ok": True, "data": {"ticket": ticket, "sl": new_sl}}

    # ── shutdown ──────────────────────────────────────────────────
    elif action == "shutdown":
        mt5.shutdown()
        return {"ok": True, "data": "shutdown"}

    else:
        return {"ok": False, "error": f"Unknown command: {action}"}

# ── Main read loop ─────────────────────────────────────────────────
for raw_line in sys.stdin:
    raw_line = raw_line.strip()
    if not raw_line:
        continue
    req_id = None
    try:
        cmd    = json.loads(raw_line)
        req_id = cmd.get("_id")
        if not MT5_READY:
            result = {"ok": False, "error": "MT5 not available (terminal not running or package not installed)"}
        else:
            result = handle(cmd)
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}
    if req_id is not None:
        result["_id"] = req_id
    out(result)

mt5.shutdown()
