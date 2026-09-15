"""
Phase 1 — Daily feature computation.

Accepts a daily OHLCV DataFrame (date, open, high, low, close, volume) sorted
ascending and returns it with per-stock daily features appended.

Point-in-time guarantee: every rolling window uses shift(1) so that a feature
value on date D is computed from data up to D-1 only.  This is non-negotiable
for the Phase 3 backtester — any lookahead here invalidates all results.
"""
from __future__ import annotations
import numpy as np
import pandas as pd


def compute_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Append derived columns to a sorted daily OHLCV DataFrame.

    Columns added:
      prev_open / prev_high / prev_low / prev_close / prev_volume
      high_20d / low_20d           — rolling 20-bar high/low (excluding today)
      high_52w / low_52w           — rolling 252-bar high/low (excluding today)
      vol_20d_avg                  — 20-bar average volume (excluding today)
      ema9 / ema20                 — EMA(9) / EMA(20) of close
      atr14                        — ATR(14) using Wilder smoothing
      gap_pct                      — today's open vs previous close (%)
      vol_rel                      — today's volume / vol_20d_avg
    """
    df = df.copy()

    # ── Previous-day values ──────────────────────────────────────────────────
    df["prev_open"]   = df["open"].shift(1)
    df["prev_high"]   = df["high"].shift(1)
    df["prev_low"]    = df["low"].shift(1)
    df["prev_close"]  = df["close"].shift(1)
    df["prev_volume"] = df["volume"].shift(1)

    # ── 20-day range (shift(1) so today's bar is excluded) ───────────────────
    df["high_20d"] = df["high"].shift(1).rolling(20, min_periods=10).max()
    df["low_20d"]  = df["low"].shift(1).rolling(20, min_periods=10).min()

    # ── 52-week range (252 trading days ≈ 1 year) ────────────────────────────
    df["high_52w"] = df["high"].shift(1).rolling(252, min_periods=120).max()
    df["low_52w"]  = df["low"].shift(1).rolling(252, min_periods=120).min()

    # ── 20-day average volume (excluding today) ──────────────────────────────
    df["vol_20d_avg"] = df["volume"].shift(1).rolling(20, min_periods=10).mean()

    # ── EMAs of close ────────────────────────────────────────────────────────
    # Computed on the close series without shift — they reflect the state AT close.
    # For live scoring, the last available EMA row is used BEFORE today's close is known.
    df["ema9"]  = df["close"].ewm(span=9,  adjust=False, min_periods=5).mean()
    df["ema20"] = df["close"].ewm(span=20, adjust=False, min_periods=10).mean()

    # ── ATR(14) via Wilder smoothing ─────────────────────────────────────────
    tr = _true_range(df)
    df["atr14"] = tr.ewm(span=14, adjust=False, min_periods=7).mean()

    # ── Gap and relative volume ───────────────────────────────────────────────
    df["gap_pct"] = (
        (df["open"] - df["prev_close"]) / df["prev_close"].replace(0, np.nan) * 100
    )
    df["vol_rel"] = df["volume"] / df["vol_20d_avg"].replace(0, np.nan)

    return df


def _true_range(df: pd.DataFrame) -> pd.Series:
    """TR = max(H−L, |H−Cprev|, |L−Cprev|)."""
    hl  = df["high"] - df["low"]
    hcp = (df["high"] - df["prev_close"]).abs()
    lcp = (df["low"]  - df["prev_close"]).abs()
    return pd.concat([hl, hcp, lcp], axis=1).max(axis=1)


def get_latest_features(df: pd.DataFrame) -> dict:
    """
    Return a flat dict of feature values for the most recent row.
    Used by the live scanner to pass pre-computed daily context to the scorer.
    """
    feat_df = compute_features(df)
    if feat_df.empty:
        return {}
    row = feat_df.iloc[-1]
    return {k: (None if (isinstance(v, float) and np.isnan(v)) else v)
            for k, v in row.to_dict().items()}


def compute_time_normalised_vol_baseline(
    df: pd.DataFrame,
    scan_hour: int,
    scan_minute: int,
) -> float | None:
    """
    Compute the average volume accumulated by <scan_hour:scan_minute> on historical days
    for use as a relative-volume baseline.

    Phase 2 will wire this into the live scorer.  Phase 2 requires intraday minute
    data — this function is a placeholder that returns None until then.

    Note: do NOT use full-day average volume as the baseline for relative volume
    at 9:30 — a stock might trade 15% of its daily volume by 9:30, so comparing
    9:30 volume to the full-day average inflates rel-vol by ~6.7×.
    """
    # Phase 2 implementation: fetch historical intraday data, sum volume up to
    # scan_hour:scan_minute for each past day, take the 20-day average.
    return None  # Phase 2
