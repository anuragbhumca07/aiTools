"""
Dhan instrument master downloader + NSE EQ universe builder.
Self-contained copy — does not depend on ../Screener/.
"""
from __future__ import annotations
import io
import logging
import os

import pandas as pd
import requests

import config

logger = logging.getLogger(__name__)

INSTRUMENT_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"


def fetch_instrument_master(force_refresh: bool = False) -> pd.DataFrame:
    os.makedirs(config.CACHE_DIR, exist_ok=True)
    path = os.path.join(config.CACHE_DIR, "instrument_master.csv")

    if not force_refresh and os.path.exists(path):
        logger.info("Loaded cached instrument master: %s", path)
        return pd.read_csv(path, low_memory=False)

    logger.info("Downloading instrument master from Dhan...")
    headers = {}
    if config.DHAN_CLIENT_ID and config.DHAN_ACCESS_TOKEN:
        headers["access-token"] = config.DHAN_ACCESS_TOKEN
    r = requests.get(INSTRUMENT_MASTER_URL, headers=headers, timeout=60)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text), low_memory=False)
    df.to_csv(path, index=False)
    logger.info("Instrument master: %d rows → %s", len(df), path)
    return df


def build_universe(df_master: pd.DataFrame) -> pd.DataFrame:
    df = df_master.copy()

    seg_col = _find_col(df, ["SEM_SEGMENT"])
    if seg_col:
        df = df[df[seg_col].astype(str).str.upper() == "E"]

    exch_col = _find_col(df, ["SEM_EXM_EXCH_ID"])
    if exch_col:
        df = df[df[exch_col].astype(str).str.upper() == "NSE"]

    series_col = _find_col(df, ["SEM_SERIES"])
    if series_col:
        df = df[df[series_col].astype(str).str.upper() == "EQ"]

    instr_col = _find_col(df, ["SEM_INSTRUMENT_NAME"])
    if instr_col:
        df = df[df[instr_col].astype(str).str.upper() == "EQUITY"]

    rename: dict[str, str] = {}
    sec_id_col = _find_col(df, ["SEM_SMST_SECURITY_ID", "SEM_SECURITY_ID", "SECURITY_ID"])
    if sec_id_col:
        rename[sec_id_col] = "security_id"
    sym_col = _find_col(df, ["SEM_TRADING_SYMBOL", "TRADING_SYMBOL", "SYMBOL"])
    if sym_col:
        rename[sym_col] = "symbol"
    name_col = _find_col(df, ["SM_SYMBOL_NAME", "SEM_SYMBOL_NAME", "COMPANY_NAME"])
    if name_col:
        rename[name_col] = "company"

    df = df.rename(columns=rename)
    keep = [c for c in ["security_id", "symbol", "company"] if c in df.columns]
    df = df[keep].copy()

    id_key = "security_id" if "security_id" in keep else keep[0]
    df = df.drop_duplicates(subset=[id_key]).dropna(subset=[id_key])
    df["security_id"] = df["security_id"].astype(str).str.strip()

    logger.info("Universe: %d NSE EQ stocks", len(df))
    return df.reset_index(drop=True)


def _find_col(df: pd.DataFrame, candidates: list[str]) -> str | None:
    upper_map = {c.upper(): c for c in df.columns}
    for c in candidates:
        if c.upper() in upper_map:
            return upper_map[c.upper()]
    return None
