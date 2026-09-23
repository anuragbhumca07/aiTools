"""
Phase 2 — Live scan orchestrator.

Fetches today's intraday 1-min bars from Dhan, captures the 9:15–9:30
opening range, and runs the scoring engine at 09:20, 09:30, 09:45, and 10:00.
At each re-scan it compares with the previous slot to flag confirmed / failed signals.

Point-in-time contract: intraday_bars are sliced to scan_time before scoring —
no future data is ever passed to the scorer.
"""
from __future__ import annotations
import logging
import time
import threading
from datetime import date, timedelta
from typing import Any

import pandas as pd
import pytz

import config
from scorer import ScanResult, ORBar, score_stock

logger = logging.getLogger(__name__)

IST = pytz.timezone(config.TIMEZONE)

_results_store: dict[str, dict] = {}
_store_lock = threading.Lock()

_OPEN_MINUTES  = 9 * 60 + 15   # 09:15 IST


def get_all_results() -> dict[str, dict]:
    with _store_lock:
        return dict(_results_store)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _scan_time_to_minutes(scan_time: str) -> int:
    h, m = int(scan_time[:2]), int(scan_time[3:])
    return h * 60 + m


def _slice_to_scan_time(bars: pd.DataFrame, scan_time: str) -> pd.DataFrame:
    """Keep only bars whose datetime ≤ scan_time (point-in-time contract)."""
    if bars is None or bars.empty or "datetime" not in bars.columns:
        return pd.DataFrame()
    cutoff = _scan_time_to_minutes(scan_time)
    dt     = bars["datetime"]
    mask   = (dt.dt.hour * 60 + dt.dt.minute) <= cutoff
    return bars[mask].copy()


def _build_or_bar(bars: pd.DataFrame) -> ORBar | None:
    """
    Extract the 9:15–9:30 opening-range composite from intraday bars.
    bars must have an IST-aware 'datetime' column.
    """
    if bars is None or bars.empty or "datetime" not in bars.columns:
        return None

    or_start = _scan_time_to_minutes(config.OR_START)
    or_end   = _scan_time_to_minutes(config.OR_END)
    dt_min   = bars["datetime"].dt.hour * 60 + bars["datetime"].dt.minute
    or_bars  = bars[(dt_min >= or_start) & (dt_min <= or_end)]

    if or_bars.empty:
        return None

    or_high  = float(or_bars["high"].max())
    or_low   = float(or_bars["low"].min())
    or_open  = float(or_bars["open"].iloc[0])
    vol      = float(or_bars["volume"].sum()) if "volume" in or_bars.columns else 0.0
    if "volume" in or_bars.columns and vol > 0:
        vwap = float((or_bars["close"] * or_bars["volume"]).sum() / vol)
    else:
        vwap = float(or_bars["close"].mean())

    return ORBar(or_high=or_high, or_low=or_low, or_vwap=vwap,
                 or_volume=vol, or_open=or_open)


def _detect_regime_from_intraday(nifty_bars: pd.DataFrame | None) -> tuple[str, float]:
    """
    Classify market regime from NIFTY intraday bars.
    Returns (regime_label, nifty_pct_return_from_open).
    """
    if nifty_bars is None or nifty_bars.empty:
        return "NEUTRAL", 0.0
    open_p = float(nifty_bars["open"].iloc[0])
    last_p = float(nifty_bars["close"].iloc[-1])
    if open_p == 0:
        return "NEUTRAL", 0.0
    pct = (last_p - open_p) / open_p * 100
    if pct > 1.0:
        regime = "STRONG_BULL"
    elif pct > 0.3:
        regime = "BULL"
    elif pct < -1.0:
        regime = "STRONG_BEAR"
    elif pct < -0.3:
        regime = "BEAR"
    else:
        regime = "NEUTRAL"
    return regime, round(pct, 3)


def _get_trade_date(dhan) -> date:
    """
    Find the most recent weekday with intraday data (handles closed days / weekends).
    Probes NIFTY index; if IDX_I is unavailable falls back to today.
    """
    from data_cache import download_intraday_nifty
    today = date.today()
    for delta in range(7):
        d = today - timedelta(days=delta)
        if d.weekday() >= 5:    # skip Saturday/Sunday
            continue
        try:
            nf = download_intraday_nifty(dhan, d)
            if nf is not None and not nf.empty:
                logger.info("Trade date resolved: %s", d)
                return d
        except Exception:
            continue
    return today


def _is_valid_long(r: "ScanResult") -> bool:
    """
    Hard gate for LONG: price must have actually broken above OR high,
    volume must confirm (RVOL ≥ MIN_RVOL_BREAKOUT), and price must be
    above the intraday VWAP.  All three conditions are required.
    """
    return (
        r.ltp > r.or_high and
        r.rel_volume >= config.MIN_RVOL_BREAKOUT and
        r.ltp >= r.vwap
    )


def _is_valid_short(r: "ScanResult") -> bool:
    """
    Hard gate for SHORT: price must have broken below OR low with volume,
    and price must be below intraday VWAP.
    """
    return (
        r.ltp < r.or_low and
        r.rel_volume >= config.MIN_RVOL_BREAKOUT and
        r.ltp <= r.vwap
    )


def _get_prev_scan_time(current: str) -> str | None:
    order = config.SCAN_TIMES
    try:
        idx = order.index(current)
        return order[idx - 1] if idx > 0 else None
    except ValueError:
        return None


# ── Main scan entry point ─────────────────────────────────────────────────────

def run_scan(
    universe: Any,
    scan_time: str,
    daily_features_map: dict,
    params: dict | None = None,
) -> dict:
    """
    Execute one scan using Dhan intraday data and return scored results.

    Flow:
      1. Resolve the most recent trading date with available intraday data.
      2. Fetch NIFTY intraday → determine regime + NIFTY return.
      3. For each stock: fetch 1-min bars → slice to scan_time → build ORBar → score.
      4. Sort by score, top N LONG + SHORT, compare vs previous slot.

    Point-in-time contract: bars sliced to scan_time before scoring.
    """
    from data_cache import (get_dhan_client, download_intraday_dhan,
                            download_intraday_nifty, _DHAN_AVAILABLE)

    top_n          = (params or {}).get("TOP_N",           config.TOP_N)
    max_instruments = (params or {}).get("MAX_INSTRUMENTS", config.MAX_INSTRUMENTS)

    sids = universe["security_id"].tolist()
    if max_instruments > 0:
        sids = sids[:max_instruments]

    sym_map     = dict(zip(universe["security_id"], universe["symbol"]))
    company_col = "company" if "company" in universe.columns else "symbol"
    company_map = dict(zip(universe["security_id"], universe[company_col]))

    # Dhan client
    dhan = None
    if _DHAN_AVAILABLE and config.DHAN_CLIENT_ID:
        try:
            dhan = get_dhan_client()
        except Exception as exc:
            logger.warning("Dhan client unavailable: %s", exc)

    # Resolve trade date
    trade_date = date.today()
    if dhan:
        try:
            trade_date = _get_trade_date(dhan)
        except Exception:
            pass

    logger.info("run_scan(%s): trade_date=%s, %d stocks", scan_time, trade_date, len(sids))

    # NIFTY regime
    nifty_ret = 0.0
    regime    = "NEUTRAL"
    if dhan:
        try:
            nifty_bars = download_intraday_nifty(dhan, trade_date)
            if nifty_bars is not None and not nifty_bars.empty:
                nifty_sliced = _slice_to_scan_time(nifty_bars, scan_time)
                if not nifty_sliced.empty:
                    regime, nifty_ret = _detect_regime_from_intraday(nifty_sliced)
        except Exception as exc:
            logger.debug("NIFTY fetch failed: %s", exc)

    logger.info("Regime: %s | NIFTY Δ: %.2f%%", regime, nifty_ret)

    long_results:  list[ScanResult] = []
    short_results: list[ScanResult] = []
    live_count  = 0
    skip_count  = 0

    for sid in sids:
        feat = daily_features_map.get(sid)
        if not feat:
            skip_count += 1
            continue

        intraday = None
        if dhan:
            intraday = download_intraday_dhan(dhan, sid, trade_date, interval=1)
            time.sleep(config.HIST_REQUEST_DELAY)

        if intraday is None or intraday.empty:
            skip_count += 1
            continue

        bars = _slice_to_scan_time(intraday, scan_time)
        if bars.empty:
            skip_count += 1
            continue

        or_bar = _build_or_bar(bars)
        if or_bar is None:
            # Fallback: treat first bar as the OR
            or_bar = ORBar(
                or_high  =float(bars["high"].max()),
                or_low   =float(bars["low"].min()),
                or_vwap  =float(bars["close"].iloc[-1]),
                or_volume=float(bars["volume"].sum()) if "volume" in bars.columns else 0.0,
                or_open  =float(bars["open"].iloc[0]),
            )

        results = score_stock(
            security_id  =sid,
            symbol       =sym_map.get(sid, sid),
            daily_features=feat,
            or_bar       =or_bar,
            intraday_bars=bars,
            nifty_return =nifty_ret,
            market_regime=regime,
            scan_time    =scan_time,
        )
        if results is None:
            skip_count += 1
            continue

        long_r, short_r = results
        co = company_map.get(sid, sym_map.get(sid, sid))
        long_r.company  = co
        short_r.company = co

        long_results.append(long_r)
        short_results.append(short_r)
        live_count += 1

    # ── Hard breakout gate ────────────────────────────────────────────────────
    # Only show stocks that are ACTUALLY breaking out with confirming volume.
    # Gate: ltp > or_high (LONG) or ltp < or_low (SHORT), RVOL ≥ MIN_RVOL_BREAKOUT,
    #       price on the right side of intraday VWAP.
    valid_longs  = [r for r in long_results  if _is_valid_long(r)]
    valid_shorts = [r for r in short_results if _is_valid_short(r)]

    # Sort by score within the gated set, mark confirmed
    valid_longs.sort( key=lambda r: r.score, reverse=True)
    valid_shorts.sort(key=lambda r: r.score, reverse=True)
    for r in valid_longs:  r.breakout_confirmed = True
    for r in valid_shorts: r.breakout_confirmed = True

    # Signal tracking vs previous slot
    prev_scan = _get_prev_scan_time(scan_time)
    confirmed, failed = [], []
    with _store_lock:
        prev_slot = _results_store.get(prev_scan) if prev_scan else None
    if prev_slot:
        prev_long_syms = {r.symbol for r in (prev_slot.get("LONG") or [])}
        for r in valid_longs[:top_n]:
            if r.symbol in prev_long_syms:
                confirmed.append(r.symbol)

    if live_count == 0:
        note = (f"No intraday data for {trade_date} — "
                "market may be closed or pre-open.")
    elif not valid_longs and not valid_shorts:
        note = (f"No confirmed OR breakouts at {scan_time}. "
                f"{live_count} stocks scanned — none broke out with RVOL ≥ {config.MIN_RVOL_BREAKOUT}×. "
                "Market may still be establishing range.")
    else:
        note = (f"Confirmed breakouts: {len(valid_longs)} LONG, {len(valid_shorts)} SHORT "
                f"(from {live_count} stocks with intraday data). "
                f"Gate: ltp beyond OR + RVOL ≥ {config.MIN_RVOL_BREAKOUT}× + price vs VWAP.")

    out = {
        "LONG":          valid_longs[:top_n],
        "SHORT":         valid_shorts[:top_n],
        "scan_time":     scan_time,
        "prev_scan":     prev_scan,
        "confirmed":     confirmed,
        "failed":        failed,
        "regime":        regime,
        "universe_size": len(universe) if universe is not None else 0,
        "note":          note,
        "trade_date":    str(trade_date),
    }

    with _store_lock:
        _results_store[scan_time] = out

    logger.info(
        "Scan done: %d scored | top LONG %.1f | top SHORT %.1f",
        live_count,
        long_results[0].score  if long_results  else 0.0,
        short_results[0].score if short_results else 0.0,
    )
    return out


def score_change(prev: ScanResult | None, curr: ScanResult | None) -> str:
    """Classify how a stock's score changed between scan slots."""
    if prev is None:
        return "new"
    if curr is None:
        return "dropped"
    delta = curr.score - prev.score
    if delta > 5:
        return "confirmed"
    if delta < -5:
        return "failed"
    return "unchanged"
