"""
Pre-market screener — ranks seed universe stocks by intraday momentum signals.

Runs once at startup (or on-demand) and produces an ordered candidate list.
The trading engine then runs generate_signal() on these candidates each bar.

Ranking criteria (weighted sum):
  1. RVOL   — relative volume vs 20-day average   (higher = more interest)
  2. Gap %  — |today_open - prev_close| / prev_close  (higher = more momentum)
  3. ATR%   — ATR / price  (target 0.5–3%; too low = no range, too high = risky)
  4. Liquidity — penalise stocks with < MIN_AVG_VOL

Output:
  list of dicts: {symbol, price, rvol, gap_pct, atr_pct, score, etb}
  sorted by score descending.
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta, timezone as _tz

import pytz

from broker import BrokerInterface
import config as cfg

logger = logging.getLogger(__name__)

ET = pytz.timezone(cfg.MARKET_TZ)


def _trading_day_start(days_back: int = 0) -> str:
    """Return ISO 8601 date string for N trading days ago (approximate — ignores holidays)."""
    now = datetime.now(ET)
    d = now.date() - timedelta(days=days_back + (days_back // 5) * 2)
    return d.isoformat()


def run_screener(broker: BrokerInterface, symbols: list[str] | None = None) -> list[dict]:
    """
    Fetch recent daily bars for the seed universe and rank by signal strength.
    Returns the top SCAN_TOP_N candidates as a list of dicts.
    """
    universe = symbols or cfg.SEED_UNIVERSE
    logger.info("Screener: fetching daily bars for %d symbols...", len(universe))

    # Fetch ~25 daily bars per symbol (enough for 20-day avg volume + ATR14)
    start = _trading_day_start(30)
    end   = datetime.now(ET).astimezone(_tz.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    try:
        bars_map = broker.get_bars_multi(universe, "1D", start, end, limit=35)
    except Exception as exc:
        logger.error("Screener bar fetch failed: %s", exc)
        return []

    candidates: list[dict] = []

    for sym in universe:
        bars = bars_map.get(sym) or []
        if len(bars) < 5:
            continue

        closes  = [b["close"]  for b in bars]
        highs   = [b["high"]   for b in bars]
        lows    = [b["low"]    for b in bars]
        volumes = [b["volume"] for b in bars]

        price = closes[-1]
        if price < cfg.MIN_PRICE:
            continue

        # 20-day average volume
        vol_window = volumes[-21:-1] if len(volumes) >= 21 else volumes[:-1]
        avg_vol = sum(vol_window) / len(vol_window) if vol_window else 0
        if avg_vol < cfg.MIN_AVG_VOL:
            continue

        today_vol = volumes[-1]
        rvol = today_vol / avg_vol if avg_vol > 0 else 1.0

        # Gap from previous close
        prev_close = closes[-2]
        today_open = bars[-1].get("open", price)
        gap_pct = abs(today_open - prev_close) / prev_close * 100 if prev_close > 0 else 0.0

        # ATR14 (simple calc for screener)
        atr_vals = []
        for i in range(max(1, len(bars) - 14), len(bars)):
            tr = max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]),
            )
            atr_vals.append(tr)
        atr = sum(atr_vals) / len(atr_vals) if atr_vals else 0.0
        atr_pct = atr / price * 100 if price > 0 else 0.0

        # Composite score
        rvol_score = min(rvol / 3.0, 1.0)                # 0–1, cap at 3×
        gap_score  = min(gap_pct / 5.0, 1.0)             # 0–1, cap at 5%
        atr_score  = 1.0 - abs(atr_pct - 1.5) / 3.0     # peaks at 1.5% ATR
        atr_score  = max(0.0, atr_score)

        score = 0.50 * rvol_score + 0.30 * gap_score + 0.20 * atr_score

        candidates.append({
            "symbol":   sym,
            "price":    round(price, 4),
            "rvol":     round(rvol, 2),
            "gap_pct":  round(gap_pct, 2),
            "atr_pct":  round(atr_pct, 3),
            "avg_vol":  int(avg_vol),
            "score":    round(score, 4),
            "etb":      False,   # filled in by engine for short candidates
        })

    candidates.sort(key=lambda x: x["score"], reverse=True)
    top = candidates[: cfg.SCAN_TOP_N]

    logger.info(
        "Screener done: %d / %d qualify - top: %s",
        len(candidates), len(universe),
        ", ".join(f"{c['symbol']}({c['rvol']:.1f}x)" for c in top[:5]),
    )
    return top
