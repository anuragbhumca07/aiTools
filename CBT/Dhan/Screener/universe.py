"""
Phase 1 — Universe builder.

Downloads the Dhan instrument master CSV, filters to eligible NSE equities,
and returns a clean DataFrame with security_id and symbol columns.

IMPORTANT — run phase1_verify.py --inspect first to see actual column names from
the downloaded CSV, then verify the filter logic below matches them.
"""
from __future__ import annotations
import io
import logging
import os

import pandas as pd
import requests

import config

logger = logging.getLogger(__name__)

# VERIFY: DhanHQ publishes an instrument master CSV daily. Confirm this URL is current.
# Check: https://api.dhan.co (Docs > Market Feed > Instrument Master) or DhanHQ GitHub.
INSTRUMENT_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"


def fetch_instrument_master(force_refresh: bool = False) -> pd.DataFrame:
    """Download or load cached Dhan instrument master CSV."""
    os.makedirs(config.CACHE_DIR, exist_ok=True)
    path = os.path.join(config.CACHE_DIR, "instrument_master.csv")

    if not force_refresh and os.path.exists(path):
        logger.info("Loaded cached instrument master: %s", path)
        return pd.read_csv(path, low_memory=False)

    logger.info("Downloading instrument master from Dhan …")
    # VERIFY: Does this endpoint require Authorization headers with client_id / token?
    headers = {}
    if config.DHAN_CLIENT_ID and config.DHAN_ACCESS_TOKEN:
        headers["access-token"] = config.DHAN_ACCESS_TOKEN   # VERIFY header name
    r = requests.get(INSTRUMENT_MASTER_URL, headers=headers, timeout=60)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text), low_memory=False)
    df.to_csv(path, index=False)
    logger.info("Instrument master: %d rows → %s", len(df), path)
    return df


def inspect_master(df: pd.DataFrame) -> None:
    """
    Print column names + sample so you can verify the filter logic below.
    Run: python phase1_verify.py --inspect
    """
    print("\n=== Instrument Master Columns ===")
    for i, col in enumerate(df.columns):
        print(f"  [{i:02d}] {col}")
    print(f"\n=== Sample rows (first 5) ===")
    print(df.head(5).to_string(index=False))
    print(f"\nTotal rows: {len(df):,}")


def build_universe(df_master: pd.DataFrame) -> pd.DataFrame:
    """
    Filter instrument master to eligible NSE equities.

    Expected master columns (VERIFY all against actual CSV output from inspect_master):
      SEM_SMST_SECURITY_ID  — numeric security ID for API calls
      SEM_TRADING_SYMBOL    — ticker, e.g. "RELIANCE"
      SEM_INSTRUMENT_NAME   — e.g. "EQUITY"
      SEM_SEGMENT           — e.g. "NSE_EQ" for NSE cash equity
      SEM_SERIES            — e.g. "EQ", "BE", "BL", "SM"
      SM_SYMBOL_NAME        — company name
    """
    df = df_master.copy()
    pre = len(df)

    # ── Filter 1: NSE equity segment ─────────────────────────────────────────
    # Confirmed from instrument master: SEM_SEGMENT == "E" for all equities
    # (both NSE and BSE). We then filter by SEM_EXM_EXCH_ID == "NSE" below.
    seg_col = _find_col(df, ["SEM_SEGMENT"])
    if seg_col:
        df = df[df[seg_col].astype(str).str.upper() == "E"]
        logger.info("Segment filter (E): %d → %d", pre, len(df))
    else:
        logger.warning("SEM_SEGMENT column not found — skipping segment filter.")

    # ── Filter 1b: NSE exchange only (exclude BSE equities) ──────────────────
    exch_col = _find_col(df, ["SEM_EXM_EXCH_ID"])
    if exch_col:
        pre1b = len(df)
        df = df[df[exch_col].astype(str).str.upper() == "NSE"]
        logger.info("Exchange filter (NSE): %d → %d", pre1b, len(df))
    else:
        logger.warning("SEM_EXM_EXCH_ID column not found — BSE stocks may be included.")

    # ── Filter 2: EQ series only ──────────────────────────────────────────────
    # Excludes: BE (trade-to-trade), SM (SME), BL, IL, etc.
    # Confirmed from master: "EQ" is the correct series value for regular equities.
    series_col = _find_col(df, ["SEM_SERIES"])
    if series_col:
        pre2 = len(df)
        df = df[df[series_col].astype(str).str.upper() == "EQ"]
        logger.info("Series filter (EQ): %d → %d", pre2, len(df))
    else:
        logger.warning("SEM_SERIES column not found — SME/BE stocks may be included.")

    # ── Filter 3: EQUITY instrument type ─────────────────────────────────────
    # Confirmed: all segment-E rows have SEM_INSTRUMENT_NAME == "EQUITY".
    instr_col = _find_col(df, ["SEM_INSTRUMENT_NAME"])
    if instr_col:
        pre3 = len(df)
        df = df[df[instr_col].astype(str).str.upper() == "EQUITY"]
        logger.info("Instrument filter (EQUITY): %d → %d", pre3, len(df))
    else:
        logger.warning("SEM_INSTRUMENT_NAME column not found — filter skipped.")

    # ── Standardise column names ──────────────────────────────────────────────
    rename: dict[str, str] = {}

    sec_id_col = _find_col(df, ["SEM_SMST_SECURITY_ID", "SEM_SECURITY_ID", "SECURITY_ID", "SECID"])
    if sec_id_col:
        rename[sec_id_col] = "security_id"
    else:
        logger.warning("Could not find security_id column — API calls will fail.")

    sym_col = _find_col(df, ["SEM_TRADING_SYMBOL", "TRADING_SYMBOL", "SYMBOL", "SEM_CUSTOM_SYMBOL"])
    if sym_col:
        rename[sym_col] = "symbol"

    name_col = _find_col(df, ["SM_SYMBOL_NAME", "SEM_SYMBOL_NAME", "COMPANY_NAME", "NAME"])
    if name_col:
        rename[name_col] = "company"

    df = df.rename(columns=rename)

    keep = [c for c in ["security_id", "symbol", "company"] if c in df.columns]
    df = df[keep].copy()

    id_key = "security_id" if "security_id" in keep else keep[0]
    df = df.drop_duplicates(subset=[id_key]).dropna(subset=[id_key])
    df["security_id"] = df["security_id"].astype(str).str.strip()

    logger.info("Final universe (pre-price filter): %d stocks", len(df))
    return df.reset_index(drop=True)


def _find_col(df: pd.DataFrame, candidates: list[str]) -> str | None:
    """Return the first candidate column name that exists (case-insensitive)."""
    upper_map = {c.upper(): c for c in df.columns}
    for c in candidates:
        if c.upper() in upper_map:
            return upper_map[c.upper()]
    return None
