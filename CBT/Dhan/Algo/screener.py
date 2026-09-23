"""
Pre-market screener for Dhan NSE intraday algo.

Fetches the Dhan instrument master, filters to NSE EQ universe,
then scores each stock by RVOL, gap%, and ATR% using DAILY bars
(one API call per stock via historical_daily_data — fast).

Returns top SCAN_TOP_N candidates as list of dicts:
  {security_id, symbol, price, rvol, gap_pct, atr_pct, score}
sorted by score descending.
"""
from __future__ import annotations
import logging
import time
from datetime import date, timedelta

import pytz

from broker import BrokerInterface
import config as cfg

logger = logging.getLogger(__name__)
IST = pytz.timezone(cfg.TIMEZONE)


def run_screener(broker: BrokerInterface, sym_map: dict[str, str] | None = None) -> list[dict]:
    """
    Build NSE universe, score by momentum using daily bars, return top SCAN_TOP_N candidates.
    sym_map: pre-built {security_id: symbol} — skips re-downloading master if provided.
    """
    # ── Build universe ────────────────────────────────────────────────────────
    if sym_map is None:
        sym_map = _build_sym_map()

    if not sym_map:
        logger.error("Empty universe — screener cannot run")
        return []

    security_ids = list(sym_map.keys())[: cfg.MAX_INSTRUMENTS]
    logger.info("Screener: scoring %d NSE EQ securities using daily bars...", len(security_ids))

    # ── Fetch DAILY bars (Dhan API, fallback to yfinance) ────────────────────
    end_date   = date.today()
    start_date = end_date - timedelta(days=45)

    bars_map = _fetch_daily_bars(security_ids, sym_map, start_date, end_date)

    candidates: list[dict] = []

    for sid in security_ids:
        bars = bars_map.get(sid) or []
        if len(bars) < 5:  # need at least 5 daily bars to compute scores
            continue

        closes  = [b["close"]  for b in bars]
        highs   = [b["high"]   for b in bars]
        lows    = [b["low"]    for b in bars]
        volumes = [b["volume"] for b in bars]

        price = closes[-1]
        if price < cfg.MIN_PRICE:
            continue

        # 20-bar average volume
        vol_window = volumes[-21:-1] if len(volumes) >= 21 else volumes[:-1]
        avg_vol = sum(vol_window) / len(vol_window) if vol_window else 0
        if avg_vol < cfg.MIN_ADTV_CR:
            continue

        today_vol = volumes[-1]
        rvol = today_vol / avg_vol if avg_vol > 0 else 1.0

        # Gap from previous close
        prev_close = closes[-2]
        today_open = bars[-1].get("open", price)
        gap_pct = abs(today_open - prev_close) / prev_close * 100 if prev_close > 0 else 0.0

        # ATR14
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
        rvol_score = min(rvol / 3.0, 1.0)
        gap_score  = min(gap_pct / 5.0, 1.0)
        atr_score  = 1.0 - abs(atr_pct - 1.5) / 3.0
        atr_score  = max(0.0, atr_score)
        score = 0.50 * rvol_score + 0.30 * gap_score + 0.20 * atr_score

        candidates.append({
            "security_id": sid,
            "symbol":      sym_map.get(sid, sid),
            "price":       round(price, 2),
            "rvol":        round(rvol, 2),
            "gap_pct":     round(gap_pct, 2),
            "atr_pct":     round(atr_pct, 3),
            "avg_vol":     int(avg_vol),
            "score":       round(score, 4),
        })

    candidates.sort(key=lambda x: x["score"], reverse=True)
    top = candidates[: cfg.SCAN_TOP_N]

    logger.info(
        "Screener done: %d / %d qualify - top: %s",
        len(candidates),
        len(security_ids),
        ", ".join(f"{c['symbol']}({c['rvol']:.1f}x)" for c in top[:5]),
    )
    return top


def _fetch_daily_bars(
    security_ids: list[str],
    sym_map: dict[str, str],
    start_date: date,
    end_date: date,
) -> dict[str, list[dict]]:
    """
    Fetch daily OHLCV bars for each security_id.
    Primary: Dhan historical_daily_data API (one call per stock).
    Fallback: yfinance (.NS suffix) — used when Dhan token is expired or API fails.
    """
    bars_map: dict[str, list[dict]] = {}

    # ── Try Dhan daily API first ──────────────────────────────────────────────
    dhan_ok = False
    try:
        import config as _cfg
        from dhanhq import DhanContext, dhanhq as DhanHQ
        ctx  = DhanContext(_cfg.DHAN_CLIENT_ID, _cfg.DHAN_ACCESS_TOKEN)
        dhan = DhanHQ(ctx)

        # Quick probe with first stock to check if token is valid
        probe_sid = security_ids[0]
        probe = dhan.historical_daily_data(
            security_id=probe_sid,
            exchange_segment=DhanHQ.NSE,
            instrument_type="EQUITY",
            from_date=start_date.strftime("%Y-%m-%d"),
            to_date=end_date.strftime("%Y-%m-%d"),
            expiry_code=0,
        )
        err_code = ""
        remarks = probe.get("remarks", {})
        if probe.get("status") == "failure":
            err_code = remarks.get("error_code", "") if isinstance(remarks, dict) else str(remarks)

        if "DH-901" in err_code or "DH-902" in err_code or "Invalid_Authentication" in str(remarks):
            logger.warning("Dhan API unavailable (%s) — using yfinance for screener", err_code)
        else:
            dhan_ok = True
            logger.info("Dhan daily API active — fetching %d stocks...", len(security_ids))
            for i, sid in enumerate(security_ids):
                try:
                    resp = dhan.historical_daily_data(
                        security_id=sid,
                        exchange_segment=DhanHQ.NSE,
                        instrument_type="EQUITY",
                        from_date=start_date.strftime("%Y-%m-%d"),
                        to_date=end_date.strftime("%Y-%m-%d"),
                        expiry_code=0,
                    )
                    if resp.get("status") == "success":
                        raw = resp.get("data")
                        if raw and isinstance(raw, dict):
                            bars = _parse_daily_raw(raw)
                            if bars:
                                bars_map[sid] = bars
                except Exception as exc:
                    logger.debug("Dhan daily skip %s: %s", sid, exc)
                time.sleep(cfg.HIST_REQUEST_DELAY)
                if (i + 1) % 20 == 0:
                    logger.info("Screener progress: %d/%d, %d qualify", i + 1, len(security_ids), len(bars_map))
    except Exception as exc:
        logger.warning("Dhan API probe failed: %s", exc)

    if not dhan_ok:
        # ── yfinance fallback ─────────────────────────────────────────────────
        logger.info("Screener: using yfinance for %d symbols...", len(security_ids))
        try:
            import yfinance as yf
        except ImportError:
            logger.error("yfinance not installed — run: pip install yfinance")
            return bars_map

        symbols_ns = [sym_map.get(sid, sid) + ".NS" for sid in security_ids]
        try:
            df_all = yf.download(
                symbols_ns,
                start=start_date.strftime("%Y-%m-%d"),
                end=(end_date + timedelta(days=1)).strftime("%Y-%m-%d"),
                progress=False,
                auto_adjust=True,
            )
        except Exception as exc:
            logger.error("yfinance bulk download failed: %s", exc)
            return bars_map

        # yfinance returns multi-level columns: (field, symbol)
        import pandas as pd
        for i, sid in enumerate(security_ids):
            sym_ns = sym_map.get(sid, sid) + ".NS"
            try:
                if isinstance(df_all.columns, pd.MultiIndex):
                    if sym_ns not in df_all.columns.get_level_values(1):
                        continue
                    df = df_all.xs(sym_ns, axis=1, level=1).dropna()
                else:
                    df = df_all.dropna()
                if df.empty:
                    continue
                df.columns = [c.lower() for c in df.columns]
                bars = [
                    {
                        "open":   float(row.get("open",  0)),
                        "high":   float(row.get("high",  0)),
                        "low":    float(row.get("low",   0)),
                        "close":  float(row.get("close", 0)),
                        "volume": float(row.get("volume", 0)),
                    }
                    for _, row in df.iterrows()
                    if float(row.get("close", 0)) > 0
                ]
                if bars:
                    bars_map[sid] = bars
            except Exception as exc:
                logger.debug("yfinance parse %s: %s", sym_ns, exc)

        logger.info("yfinance fetched bars for %d/%d symbols", len(bars_map), len(security_ids))

    return bars_map


def _parse_daily_raw(raw: dict) -> list[dict]:
    """Parse Dhan column-oriented daily response."""
    ts_key = next((k for k in ("timestamp", "startTime") if k in raw), None)
    if ts_key is None:
        return []
    n = len(raw[ts_key])
    opens   = raw.get("open",   [0] * n)
    highs   = raw.get("high",   [0] * n)
    lows    = raw.get("low",    [0] * n)
    closes  = raw.get("close",  [0] * n)
    volumes = raw.get("volume", [0] * n)
    return [
        {
            "open":   float(opens[i]),
            "high":   float(highs[i]),
            "low":    float(lows[i]),
            "close":  float(closes[i]),
            "volume": float(volumes[i]),
        }
        for i in range(n)
        if float(closes[i]) > 0
    ]


def _build_sym_map() -> dict[str, str]:
    """Download Dhan instrument master and return {security_id: symbol} for NSE EQ."""
    try:
        from universe import fetch_instrument_master, build_universe
        df_master = fetch_instrument_master()
        df = build_universe(df_master)
        if df.empty or "security_id" not in df.columns:
            logger.warning("Universe build returned empty — check instrument master columns")
            return {}
        sym_col = "symbol" if "symbol" in df.columns else df.columns[1]
        m = {str(row["security_id"]): str(row[sym_col]) for _, row in df.iterrows()}
        logger.info("Universe loaded: %d stocks", len(m))
        return m
    except Exception as exc:
        logger.error("Failed to build universe: %s", exc)
        return {}
