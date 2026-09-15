"""
Phase 3 — Backtester (SCAFFOLD).

Replays historical trading days, reconstructs the scan-time state using
ONLY point-in-time data, runs the exact scoring engine, and measures
forward outcomes at 15min / 30min / 60min / end-of-day.

⚠  NOT YET IMPLEMENTED — scaffold only. Build after Phase 2 review.

⚠  CRITICAL LOOKAHEAD WARNING:
   Any calculation for a given scan time MUST use ONLY data that existed
   at or before that moment on that day. This applies to:
     - Daily features: shift(1) so scan-day's own OHLCV is not included
     - Intraday bars: sliced to [open, scan_time], never beyond
     - Volume baseline: computed from past days, not the current day
   Before trusting any result, run the explicit lookahead check below.
   Lookahead leak invalidates the ENTIRE result set — not just biases it.

Purpose: Phase 3 is where placeholder scoring weights get replaced with
evidence-based values. Until that step, the scanner output is decoration.
"""

LOOKAHEAD_CONTRACT = """
Backtester point-in-time contract — verify before using results:

1. daily_features for scan_day D must NOT include D's own OHLCV.
   features.compute_features() uses shift(1) for all rolling windows.
   The EMA rows are computed without shift — use the row for D-1.

2. intraday_bars must be sliced to bars with timestamp < scan_time.
   Never include the bar that closes AT scan_time — that bar's close
   reveals information only available after the scan decision is made.

3. Volume baseline for relative_volume must be computed from past days
   only, not from today's accumulated volume.

Lookahead detection: for each scan day, randomly shuffle future bars and
recompute scores. If scores change, there is lookahead leakage.
"""


def run_backtest(
    universe,               # pd.DataFrame
    daily_features_map,     # {security_id: pd.DataFrame with compute_features applied}
    start_date,             # date
    end_date,               # date
    params=None,            # dict overrides
) -> dict:
    """
    Phase 3 entry point — not yet implemented.

    Will:
    1. Iterate each trading day in [start_date, end_date]
    2. For each day, compute scan-time state (point-in-time)
    3. Run scorer.score_stock() for each universe member
    4. Record TOP_N LONG and TOP_N SHORT
    5. Measure forward returns at 15m, 30m, 60m, EOD
    6. Aggregate: win_rate, avg_return, profit_factor, 1R_hit, 2R_hit,
       Sharpe, Sortino, max_drawdown — by direction and by regime

    Returns a full results dict. Phase 3 implementation goes here.
    """
    raise NotImplementedError(
        "Phase 3 backtester not yet implemented. "
        "Complete Phase 1 + Phase 2 review first.\n\n"
        + LOOKAHEAD_CONTRACT
    )


def check_lookahead(scan_day, scan_time_str, features_row, intraday_bars) -> bool:
    """
    Explicit lookahead check: returns True if no leakage detected.
    Shuffle future bars → recompute → assert scores unchanged.
    Phase 3 implementation goes here.
    """
    raise NotImplementedError("Phase 3")


def print_backtest_report(results: dict) -> None:
    """Format and print the Phase 3 backtest report. Phase 3 implementation goes here."""
    raise NotImplementedError("Phase 3")
