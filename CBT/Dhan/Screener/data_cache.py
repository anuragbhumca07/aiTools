"""
Phase 1 — Historical OHLCV cache.

Confirmed Dhan SDK details (dhanhq 2.2.0):
  Init:               DhanContext(client_id, access_token) -> dhanhq(ctx)
  Daily history:      dhan.historical_daily_data(security_id, exchange_segment,
                        instrument_type, from_date, to_date, expiry_code=0)
  Intraday:           dhan.intraday_minute_data(security_id, exchange_segment,
                        instrument_type, from_date, to_date, interval=5)
  Live LTP:           dhan.ticker_data({"NSE_EQ": [int_id, ...]})
  Live OHLC:          dhan.ohlc_data({"NSE_EQ": [int_id, ...]})
  Live full quote:    dhan.quote_data({"NSE_EQ": [int_id, ...]})
  Exchange segment:   dhanhq.NSE == "NSE_EQ"
  Response shape:     {"status": "success"|"failure", "remarks": ...,
                        "data": {"open":[f], "high":[f], "low":[f],
                                  "close":[f], "volume":[f], "timestamp":[epoch_f]}}

Data source priority:
  1. Dhan historical API — primary; requires Data API subscription active in Dhan app.
  2. yfinance (.NS suffix) — automatic fallback if Dhan returns DH-902 (subscription inactive).
"""
from __future__ import annotations
import logging
import os
import time
from datetime import date, timedelta

import pandas as pd

import config

logger = logging.getLogger(__name__)

try:
    from dhanhq import DhanContext, dhanhq as DhanHQ
    _DHAN_AVAILABLE = True
except ImportError:
    DhanContext = DhanHQ = None
    _DHAN_AVAILABLE = False
    logger.warning("dhanhq not installed. Run: pip install dhanhq")

try:
    import yfinance as yf
    _YF_AVAILABLE = True
except ImportError:
    yf = None
    _YF_AVAILABLE = False
    logger.warning("yfinance not installed. Run: pip install yfinance")

# Set to True when Dhan returns DH-902 — triggers fallback to yfinance.
# Cleared when force_refresh=True so a re-subscribe is picked up immediately.
_dhan_access_denied: bool = False


def reset_dhan_access_flag():
    """Call this when credentials change or force_refresh to re-try Dhan."""
    global _dhan_access_denied
    _dhan_access_denied = False


def get_dhan_client():
    if not _DHAN_AVAILABLE:
        raise RuntimeError("dhanhq not installed — run: pip install dhanhq")
    if not config.DHAN_CLIENT_ID or not config.DHAN_ACCESS_TOKEN:
        raise RuntimeError("DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN not set in .env")
    ctx = DhanContext(config.DHAN_CLIENT_ID, config.DHAN_ACCESS_TOKEN)
    return DhanHQ(ctx)


# ── Daily OHLCV via Dhan ──────────────────────────────────────────────────────

def download_daily_ohlcv_dhan(
    dhan,
    security_id: str,
    from_date: date,
    to_date: date,
) -> pd.DataFrame | None:
    """
    Fetch daily OHLCV via Dhan historical_daily_data.
    Returns None on failure (caller falls back to yfinance).
    """
    global _dhan_access_denied

    for attempt in range(1, config.HIST_MAX_RETRIES + 1):
        try:
            resp = dhan.historical_daily_data(
                security_id=security_id,
                exchange_segment=DhanHQ.NSE,   # "NSE_EQ"
                instrument_type="EQUITY",
                from_date=from_date.strftime("%Y-%m-%d"),
                to_date=to_date.strftime("%Y-%m-%d"),
                expiry_code=0,
            )

            if resp.get("status") == "failure":
                remarks = resp.get("remarks", {})
                code    = remarks.get("error_code", "") if isinstance(remarks, dict) else str(remarks)
                if "DH-902" in str(code) or "451" in str(remarks):
                    if not _dhan_access_denied:
                        logger.warning(
                            "Dhan Data API not subscribed (DH-902). "
                            "Activate: Dhan app > Profile > API Access > Data APIs. "
                            "Falling back to yfinance for all stocks."
                        )
                    _dhan_access_denied = True
                    return None
                logger.debug("Dhan failure for %s: %s", security_id, remarks)
                return None

            raw = resp.get("data")
            if not raw:
                return None

            return _parse_column_dict(raw)

        except Exception as exc:
            logger.warning("Dhan attempt %d/%d for %s: %s",
                           attempt, config.HIST_MAX_RETRIES, security_id, exc)
            if attempt < config.HIST_MAX_RETRIES:
                time.sleep(2 ** attempt)

    return None


def download_intraday_dhan(
    dhan,
    security_id: str,
    trade_date: date,
    interval: int = 1,
) -> pd.DataFrame | None:
    """
    Fetch intraday minute bars via Dhan intraday_minute_data.
    Returns df with IST-aware 'datetime' column + OHLCV.
    interval: 1 | 5 | 15 | 25 | 60 minutes
    """
    date_str = trade_date.strftime("%Y-%m-%d")
    try:
        resp = dhan.intraday_minute_data(
            security_id=security_id,
            exchange_segment=DhanHQ.NSE,
            instrument_type="EQUITY",
            from_date=date_str,
            to_date=date_str,
            interval=interval,
        )
        if resp.get("status") != "success":
            return None
        raw = resp.get("data")
        if not raw:
            return None
        return _parse_intraday_dict(raw)
    except Exception as e:
        logger.debug("Intraday fetch failed for %s: %s", security_id, e)
        return None


def download_intraday_nifty(
    dhan,
    trade_date: date,
    interval: int = 1,
) -> pd.DataFrame | None:
    """
    Fetch NIFTY 50 index intraday bars.
    VERIFY: Dhan may require exchange_segment="IDX_I" and instrument_type="INDEX"
    for indices — check DhanHQ documentation if this returns failure.
    Returns df with IST-aware 'datetime' column + OHLCV.
    """
    date_str = trade_date.strftime("%Y-%m-%d")
    try:
        resp = dhan.intraday_minute_data(
            security_id=config.NIFTY_SECURITY_ID,
            exchange_segment=config.NIFTY_EXCHANGE_SEG,  # "IDX_I"
            instrument_type="INDEX",
            from_date=date_str,
            to_date=date_str,
            interval=interval,
        )
        if resp.get("status") != "success":
            return None
        raw = resp.get("data")
        if not raw:
            return None
        return _parse_intraday_dict(raw)
    except Exception as e:
        logger.debug("NIFTY intraday fetch failed: %s", e)
        return None


def get_live_ltp(dhan, security_ids: list[str]) -> dict[str, float]:
    """
    Fetch last traded price for a list of security IDs.
    Returns {security_id: ltp} dict.
    Uses dhan.ticker_data({"NSE_EQ": [int_id, ...]}).
    """
    try:
        int_ids = [int(sid) for sid in security_ids]
        resp = dhan.ticker_data({DhanHQ.NSE: int_ids})
        if resp.get("status") != "success":
            logger.debug("LTP failure: %s", resp.get("remarks"))
            return {}
        data = resp.get("data", {})
        # Response shape: {"NSE_EQ": {"1333": {"last_price": 753.0}, ...}}
        # or flat dict — inspect and adapt
        result = {}
        if isinstance(data, dict):
            seg_data = data.get(DhanHQ.NSE, data)
            for sid_key, info in seg_data.items():
                if isinstance(info, dict):
                    result[str(sid_key)] = float(info.get("last_price", 0) or
                                                  info.get("ltp", 0) or
                                                  info.get("lastPrice", 0))
                elif isinstance(info, (int, float)):
                    result[str(sid_key)] = float(info)
        return result
    except Exception as e:
        logger.debug("get_live_ltp error: %s", e)
        return {}


def get_live_ohlc(dhan, security_ids: list[str]) -> dict[str, dict]:
    """
    Fetch live OHLC + LTP for a list of security IDs.
    Uses dhan.ohlc_data({"NSE_EQ": [int_id, ...]}).
    """
    try:
        int_ids = [int(sid) for sid in security_ids]
        resp = dhan.ohlc_data({DhanHQ.NSE: int_ids})
        if resp.get("status") != "success":
            return {}
        data = resp.get("data", {})
        result = {}
        if isinstance(data, dict):
            seg_data = data.get(DhanHQ.NSE, data)
            for sid_key, info in seg_data.items():
                if isinstance(info, dict):
                    result[str(sid_key)] = info
        return result
    except Exception as e:
        logger.debug("get_live_ohlc error: %s", e)
        return {}


# ── yfinance fallback ─────────────────────────────────────────────────────────

def download_daily_ohlcv_yf(
    symbol: str,
    from_date: date,
    to_date: date,
) -> pd.DataFrame | None:
    """Free fallback via yfinance (.NS suffix for NSE stocks)."""
    if not _YF_AVAILABLE:
        return None
    ticker = f"{symbol}.NS"
    try:
        df = yf.download(
            ticker,
            start=from_date.strftime("%Y-%m-%d"),
            end=(to_date + timedelta(days=1)).strftime("%Y-%m-%d"),
            progress=False,
            auto_adjust=True,
            multi_level_index=False,
        )
        if df is None or df.empty:
            return None
        df = df.reset_index()
        df.columns = [c.lower() for c in df.columns]
        return _normalise_df(df)
    except Exception as exc:
        logger.debug("yfinance failed for %s: %s", ticker, exc)
        return None


# ── Internal helpers ──────────────────────────────────────────────────────────

def _parse_intraday_dict(data) -> pd.DataFrame | None:
    """
    Parse Dhan's column-oriented intraday dict, preserving full IST datetime.
    Handles: {"open":[], "high":[], "low":[], "close":[], "volume":[],
               "timestamp":[epoch_float, ...]}
    Returns df with IST-aware 'datetime' column (not truncated to date).
    """
    if not isinstance(data, dict):
        return None
    ts_key = next((k for k in ("timestamp", "startTime") if k in data), None)
    if ts_key is None:
        return None
    col_map = {"open": "open", "high": "high", "low": "low",
               "close": "close", "volume": "volume"}
    mapped = {col_map[k]: v for k, v in data.items() if k in col_map}
    mapped["datetime"] = data[ts_key]
    try:
        df = pd.DataFrame(mapped)
    except Exception:
        return None

    ts_col = df["datetime"]
    if pd.api.types.is_float_dtype(ts_col) or pd.api.types.is_integer_dtype(ts_col):
        df["datetime"] = (pd.to_datetime(ts_col, unit="s", utc=True)
                          .dt.tz_convert("Asia/Kolkata"))
    else:
        df["datetime"] = pd.to_datetime(ts_col, errors="coerce")
        if df["datetime"].dt.tz is None:
            df["datetime"] = df["datetime"].dt.tz_localize("Asia/Kolkata")

    for c in ["open", "high", "low", "close", "volume"]:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")

    df = df.dropna(subset=["open", "high", "low", "close", "datetime"])
    return df.sort_values("datetime").reset_index(drop=True)


def _parse_column_dict(data) -> pd.DataFrame | None:
    """
    Parse Dhan's column-oriented candle dict:
      {"open": [f,...], "high": [f,...], "low": [f,...],
       "close": [f,...], "volume": [f,...], "timestamp": [epoch_f,...]}
    """
    if not isinstance(data, dict):
        return None
    col_map = {
        "open": "open", "high": "high", "low": "low",
        "close": "close", "volume": "volume",
        "timestamp": "date", "startTime": "date",
    }
    mapped = {}
    for k, v in data.items():
        if k in col_map:
            mapped[col_map[k]] = v
    if not mapped:
        return None
    try:
        df = pd.DataFrame(mapped)
    except Exception:
        return None
    return _normalise_df(df)


def _normalise_df(df: pd.DataFrame) -> pd.DataFrame | None:
    """Parse types, standardise date column, sort ascending."""
    if df is None or df.empty:
        return None

    # Rename common variant column names
    rn = {"Date": "date", "Datetime": "date"}
    df = df.rename(columns={k: v for k, v in rn.items() if k in df.columns})

    # Parse date — handle epoch ints/floats and date strings
    if "date" in df.columns:
        col = df["date"]
        if pd.api.types.is_float_dtype(col) or pd.api.types.is_integer_dtype(col):
            df["date"] = (pd.to_datetime(col, unit="s", utc=True)
                          .dt.tz_convert("Asia/Kolkata")
                          .dt.date)
        else:
            df["date"] = pd.to_datetime(col, errors="coerce").dt.date

    for c in ["open", "high", "low", "close", "volume"]:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")

    required = {"open", "high", "low", "close"}
    if not required.issubset(df.columns):
        return None

    df = df.dropna(subset=list(required))
    keep = [c for c in ["date", "open", "high", "low", "close", "volume"] if c in df.columns]
    return df[keep].sort_values("date").reset_index(drop=True)


# ── Bootstrap & cache management ──────────────────────────────────────────────

def bootstrap_cache(
    universe: pd.DataFrame,
    force_refresh: bool = False,
) -> dict[str, int]:
    """
    Download daily OHLCV for universe stocks. Tries Dhan first, falls back to yfinance.
    force_refresh=True: deletes existing cache and re-downloads everything from Dhan.
    Returns {security_id: row_count}.
    """
    global _dhan_access_denied
    os.makedirs(config.OHLCV_DIR, exist_ok=True)

    if force_refresh:
        reset_dhan_access_flag()  # re-try Dhan after credential/subscription change

    to_date   = date.today()
    from_date = to_date - timedelta(days=config.HISTORY_DAYS_CAL)

    securities = universe["security_id"].tolist()
    if config.MAX_INSTRUMENTS > 0:
        securities = securities[: config.MAX_INSTRUMENTS]
        logger.info("MAX_INSTRUMENTS=%d: capping to %d stocks",
                    config.MAX_INSTRUMENTS, len(securities))

    dhan = None
    if _DHAN_AVAILABLE and config.DHAN_CLIENT_ID:
        try:
            dhan = get_dhan_client()
        except Exception as e:
            logger.warning("Cannot create Dhan client: %s", e)

    results: dict[str, int] = {}
    total    = len(securities)
    skipped  = 0
    dhan_ok  = 0
    yf_ok    = 0
    failed   = 0

    for i, sid in enumerate(securities, 1):
        path = os.path.join(config.OHLCV_DIR, f"{sid}.parquet")

        if not force_refresh and os.path.exists(path):
            try:
                n = len(pd.read_parquet(path, columns=["date"]))
                results[sid] = n
                skipped += 1
                continue
            except Exception:
                pass  # corrupted — re-download

        sym_rows = universe.loc[universe["security_id"] == sid, "symbol"]
        symbol   = str(sym_rows.values[0]) if len(sym_rows) else None

        df = None

        # 1. Dhan (primary — if subscription active)
        if dhan and not _dhan_access_denied:
            df = download_daily_ohlcv_dhan(dhan, sid, from_date, to_date)
            if df is not None and not df.empty:
                dhan_ok += 1

        # 2. yfinance (fallback)
        if df is None and symbol and _YF_AVAILABLE:
            df = download_daily_ohlcv_yf(symbol, from_date, to_date)
            if df is not None and not df.empty:
                yf_ok += 1

        if df is not None and not df.empty:
            df.to_parquet(path, index=False)
            results[sid] = len(df)
            if i <= 5 or i % 25 == 0:
                src = "Dhan" if dhan_ok > 0 and df is not None else "yf"
                logger.info("[%d/%d] %s — %d rows", i, total, symbol or sid, len(df))
        else:
            results[sid] = 0
            failed += 1
            logger.debug("[%d/%d] %s — no data", i, total, symbol or sid)

        time.sleep(config.HIST_REQUEST_DELAY if (dhan and not _dhan_access_denied) else 0.08)

    logger.info("Bootstrap: %d Dhan | %d yfinance | %d cached | %d failed",
                dhan_ok, yf_ok, skipped, failed)
    if _dhan_access_denied:
        logger.warning("Using yfinance (Dhan subscription inactive). "
                       "To switch: activate Data API in Dhan app, then click Force Refresh.")
    return results


def clear_ohlcv_cache() -> int:
    """Delete all cached parquet files. Returns count deleted."""
    if not os.path.exists(config.OHLCV_DIR):
        return 0
    deleted = 0
    for f in os.listdir(config.OHLCV_DIR):
        if f.endswith(".parquet"):
            os.remove(os.path.join(config.OHLCV_DIR, f))
            deleted += 1
    logger.info("Cleared %d cached parquet files", deleted)
    return deleted


def load_ohlcv(security_id: str) -> pd.DataFrame | None:
    """Load cached daily OHLCV parquet for one stock."""
    path = os.path.join(config.OHLCV_DIR, f"{security_id}.parquet")
    if not os.path.exists(path):
        return None
    df = pd.read_parquet(path)
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"]).dt.date
    return df.sort_values("date").reset_index(drop=True)


def get_cache_stats(universe: pd.DataFrame) -> dict:
    securities = universe["security_id"].tolist()
    if config.MAX_INSTRUMENTS > 0:
        securities = securities[: config.MAX_INSTRUMENTS]
    cached, missing = [], []
    for sid in securities:
        path = os.path.join(config.OHLCV_DIR, f"{sid}.parquet")
        if os.path.exists(path):
            try:
                n = len(pd.read_parquet(path, columns=["date"]))
                cached.append({"security_id": sid, "rows": n})
            except Exception:
                missing.append(sid)
        else:
            missing.append(sid)
    return {
        "cached": len(cached),
        "missing": len(missing),
        "total": len(securities),
        "dhan_active": not _dhan_access_denied,
        "sample_cached": cached[:5],
    }
