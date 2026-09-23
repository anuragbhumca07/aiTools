"""
Phase 3 — Point-in-time backtester for the NSE ORB Scanner.

Uses the daily OHLCV parquet cache (real Dhan historical data).
For each trading day D in the lookback window:
  1. Features computed from rows 0..D-1 only (shift(1) enforced in features.py)
  2. Opening-range bar approximated from prev-day H/L (see NOTE below)
  3. Entry at day D's open (best available proxy for 9:30 price)
  4. Stop / target from prior-day ATR × multiplier
  5. Outcome evaluated from same-day H/L (never from signal inputs)
  6. Per-factor rank correlation → evidence-based weight proposal

NOTE — daily OHLCV approximation:
  Real ORB uses 9:15–9:30 intraday bars. We approximate:
    or_high = prev-day high  (resistance the breakout must clear)
    or_low  = prev-day low   (support the breakdown must break)
    entry   = today's open   (first observable price)
  This is the standard "previous-day range breakout" proxy, valid for
  daily OHLCV backtesting. Intraday-accurate simulation requires 1-min
  history (Phase 3b — download_intraday_dhan for each backtest day).

LOOKAHEAD CONTRACT (non-negotiable):
  • No same-day data enters signal computation for day D.
  • features.compute_features() shift(1) enforces this for rolling windows.
  • EMA values are taken from row D-1 (computed without shift, but the
    D-1 EMA is available before D opens).
  • Target / stop are computed from ATR at D-1, not D.
  • Same-day H/L/close used ONLY for outcome, never for signal.
"""
from __future__ import annotations
import logging
import math
import os
import threading
from dataclasses import dataclass, field
from datetime import date

import numpy as np
import pandas as pd

import config
from data_cache import load_ohlcv
from features import compute_features
from scorer import score_stock, ORBar

logger = logging.getLogger(__name__)

# ── Shared backtest state (thread-safe) ───────────────────────────────────────
_bt_state: dict = {
    "status":   "idle",      # idle | running | done | error
    "progress": 0,
    "message":  "",
    "results":  None,
    "error":    None,
}
_bt_lock = threading.Lock()


def get_bt_state() -> dict:
    with _bt_lock:
        return dict(_bt_state)


def _set_bt(**kwargs):
    with _bt_lock:
        _bt_state.update(kwargs)


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class TradeRecord:
    date:          str
    security_id:   str
    symbol:        str
    direction:     str      # LONG | SHORT
    score:         float
    fb_risk:       float
    entry:         float
    stop:          float
    target:        float
    day_high:      float
    day_low:       float
    day_close:     float
    outcome:             str    # WIN | LOSS | NEUTRAL
    r_multiple:          float  # +1.0 = 1R win, -1.0 = full stop
    directional_correct: bool   # did stock close in predicted direction vs entry?
    return_pct:          float  # % move from entry to EOD close (+ = profitable direction)
    factor_scores: dict = field(default_factory=dict)


@dataclass
class BacktestResults:
    total_trades:    int   = 0
    win_count:       int   = 0
    loss_count:      int   = 0
    neutral_count:   int   = 0
    win_rate:        float = 0.0      # %
    avg_r:           float = 0.0      # mean R-multiple per trade
    profit_factor:   float = 0.0      # gross wins / gross losses
    sharpe:          float = 0.0      # annualised Sharpe on daily R-stream
    sortino:         float = 0.0
    max_drawdown:    float = 0.0      # max peak-to-trough cumulative R
    long_win_rate:   float = 0.0
    short_win_rate:  float = 0.0
    # ── Directional accuracy (answers "does the LONG list actually go up?") ──
    directional_accuracy:       float = 0.0  # % trades where stock moved in predicted direction
    long_directional_accuracy:  float = 0.0
    short_directional_accuracy: float = 0.0
    avg_return_pct:             float = 0.0  # mean % move from entry to EOD (+ = right direction)
    avg_long_return_pct:        float = 0.0
    avg_short_return_pct:       float = 0.0
    days_tested:     int   = 0
    stocks_per_day:  float = 0.0
    lookback_days:   int   = 0
    factor_auc:      dict  = field(default_factory=dict)    # factor → AUC (0–1)
    current_weights: dict  = field(default_factory=dict)    # from config
    proposed_weights:dict  = field(default_factory=dict)    # evidence-based
    disclaimer:      str   = ""


# ── Main entry point ──────────────────────────────────────────────────────────

def run_backtest(
    universe: pd.DataFrame,
    lookback_days: int = 60,
    min_score: float = 52.0,    # minimum score to simulate a trade
    top_n: int | None = None,
) -> BacktestResults:
    """
    Run a point-in-time backtest over the last `lookback_days` trading days.
    Loads OHLCV from the parquet cache; no API calls are made.
    """
    _set_bt(status="running", progress=2, message="Loading OHLCV cache…", error=None)

    sids    = universe["security_id"].tolist()
    sym_map = dict(zip(universe["security_id"], universe["symbol"]))
    top_n   = top_n or config.TOP_N

    # Load all parquet data
    daily_data: dict[str, pd.DataFrame] = {}
    for sid in sids:
        df = load_ohlcv(sid)
        if df is not None and not df.empty:
            daily_data[sid] = df

    if not daily_data:
        _set_bt(status="error", error="No OHLCV cache found — run a scan first to populate the cache.")
        return BacktestResults()

    # Collect all trading dates across all stocks
    all_dates: set = set()
    for df in daily_data.values():
        if "date" in df.columns:
            all_dates.update(df["date"].tolist())

    trading_days = sorted(all_dates)
    if len(trading_days) < 10:
        _set_bt(status="error", error=f"Too few trading days in cache ({len(trading_days)}). Run a scan first.")
        return BacktestResults()

    # Restrict to lookback window
    if len(trading_days) > lookback_days:
        trading_days = trading_days[-lookback_days:]

    # Index 0 is needed for prior features → we test from index 1 onwards
    test_days = trading_days[1:]
    total     = len(test_days)
    logger.info("Backtesting %d days × %d stocks (min_score=%.0f)",
                total, len(daily_data), min_score)

    _set_bt(progress=5, message=f"Backtesting {total} days × {len(daily_data)} stocks…")

    trades: list[TradeRecord] = []
    days_with_trades = 0

    for i, day_D in enumerate(test_days, 1):
        if i % max(1, total // 20) == 0:
            pct = 5 + int(i / total * 85)
            _set_bt(progress=pct, message=f"Day {i}/{total}: {day_D}")

        day_trades = _backtest_day(
            day_D    =day_D,
            daily_data=daily_data,
            sids     =sids,
            sym_map  =sym_map,
            min_score=min_score,
            top_n    =top_n,
        )
        trades.extend(day_trades)
        if day_trades:
            days_with_trades += 1

    _set_bt(progress=92, message="Computing metrics and factor AUC…")

    results = _compute_metrics(
        trades        =trades,
        days_tested   =days_with_trades,
        stocks_count  =len(daily_data),
        lookback_days =lookback_days,
    )

    _set_bt(status="done", progress=100, message="Backtest complete", results=results)
    logger.info(
        "Backtest done: %d trades | WR=%.1f%% | PF=%.2f | Sharpe=%.2f",
        results.total_trades, results.win_rate, results.profit_factor, results.sharpe,
    )
    return results


# ── Per-day simulation ────────────────────────────────────────────────────────

def _backtest_day(
    day_D: date,
    daily_data: dict,
    sids: list,
    sym_map: dict,
    min_score: float,
    top_n: int,
) -> list[TradeRecord]:
    """
    Score all stocks for day D using only data from D-1.
    Return trades for stocks scoring above min_score.
    """
    candidates: list[tuple[float, str, str, any, any, dict]] = []  # (score, direction, sid, long_r, short_r)
    long_cands:  list = []
    short_cands: list = []

    for sid in sids:
        df = daily_data.get(sid)
        if df is None or df.empty or "date" not in df.columns:
            continue

        dates = df["date"].tolist()
        try:
            idx_D = dates.index(day_D)
        except ValueError:
            continue

        if idx_D < 5:          # need at least 5 prior rows for EMA/ATR
            continue

        # --- SIGNAL COMPUTATION — only rows 0..idx_D-1 ---
        df_prior = df.iloc[:idx_D].copy()
        try:
            feat_df = compute_features(df_prior)
        except Exception:
            continue

        if feat_df.empty:
            continue

        last_row = feat_df.iloc[-1]
        feat = {k: (None if isinstance(v, float) and math.isnan(v) else v)
                for k, v in last_row.to_dict().items()}

        prev_close = feat.get("prev_close") or feat.get("close")
        if not prev_close or prev_close <= 0:
            continue

        # OR bar approximation (see module docstring)
        prev_high = feat.get("prev_high") or prev_close * 1.01
        prev_low  = feat.get("prev_low")  or prev_close * 0.99
        or_bar = ORBar(
            or_high  =prev_high,
            or_low   =prev_low,
            or_vwap  =prev_close,
            or_volume=(feat.get("vol_20d_avg") or 0) * 0.04,   # 15-min ≈ 4% of day
            or_open  =prev_close,
        )

        # Synthetic intraday "9:30" snapshot — single bar, entry = day open
        row_D    = df.iloc[idx_D]
        day_open = float(row_D["open"])
        if day_open <= 0:
            continue

        # Neutral volume (15-min expected) so rel_volume factor returns ~0.5
        neutral_vol = (feat.get("vol_20d_avg") or 0) * 0.04
        intraday_bar = pd.DataFrame([{
            "datetime": pd.Timestamp(f"{day_D} 09:30:00", tz="Asia/Kolkata"),
            "open":     day_open,
            "high":     day_open,
            "low":      day_open,
            "close":    day_open,
            "volume":   neutral_vol,
        }])

        try:
            result = score_stock(
                security_id   =sid,
                symbol        =sym_map.get(sid, sid),
                daily_features=feat,
                or_bar        =or_bar,
                intraday_bars =intraday_bar,
                nifty_return  =0.0,       # no intraday NIFTY in daily backtest
                market_regime ="NEUTRAL",
                scan_time     ="09:30",
            )
        except Exception:
            continue

        if result is None:
            continue

        long_r, short_r = result
        long_r.company  = sym_map.get(sid, sid)
        short_r.company = sym_map.get(sid, sid)

        day_high  = float(row_D["high"])
        day_low   = float(row_D["low"])
        day_close = float(row_D["close"])

        # Daily breakout gate: only trade when stock actually gapped into breakout territory.
        # LONG = opened above prev-day high (gap-up breakout of OR proxy).
        # SHORT = opened below prev-day low (gap-down breakdown).
        if day_open > prev_high:
            long_cands.append( (long_r.score,  sid, long_r,  day_open, day_high, day_low, day_close))
        if day_open < prev_low:
            short_cands.append((short_r.score, sid, short_r, day_open, day_high, day_low, day_close))

    # Select top N each direction
    long_cands.sort( key=lambda x: x[0], reverse=True)
    short_cands.sort(key=lambda x: x[0], reverse=True)

    day_trades: list[TradeRecord] = []

    for score, sid, r, entry, day_high, day_low, day_close in long_cands[:top_n]:
        if score < min_score:
            continue
        risk = entry - r.stop_loss
        if risk <= 0:
            continue
        outcome, r_mult = _evaluate_trade(
            direction="LONG", entry=entry,
            stop=r.stop_loss, target=r.target_1r,
            day_high=day_high, day_low=day_low,
            day_close=day_close, risk=risk,
        )
        dir_correct = day_close > entry
        ret_pct     = (day_close - entry) / entry * 100 if entry > 0 else 0.0
        day_trades.append(TradeRecord(
            date=str(day_D), security_id=sid, symbol=r.symbol,
            direction="LONG", score=score, fb_risk=r.fb_risk,
            entry=entry, stop=r.stop_loss, target=r.target_1r,
            day_high=day_high, day_low=day_low, day_close=day_close,
            outcome=outcome, r_multiple=r_mult,
            directional_correct=dir_correct, return_pct=round(ret_pct, 3),
            factor_scores=r.factor_scores,
        ))

    for score, sid, r, entry, day_high, day_low, day_close in short_cands[:top_n]:
        if score < min_score:
            continue
        risk = r.stop_loss - entry
        if risk <= 0:
            continue
        outcome, r_mult = _evaluate_trade(
            direction="SHORT", entry=entry,
            stop=r.stop_loss, target=r.target_1r,
            day_high=day_high, day_low=day_low,
            day_close=day_close, risk=risk,
        )
        dir_correct = day_close < entry                          # SHORT wins when price falls
        ret_pct     = (entry - day_close) / entry * 100 if entry > 0 else 0.0
        day_trades.append(TradeRecord(
            date=str(day_D), security_id=sid, symbol=r.symbol,
            direction="SHORT", score=score, fb_risk=r.fb_risk,
            entry=entry, stop=r.stop_loss, target=r.target_1r,
            day_high=day_high, day_low=day_low, day_close=day_close,
            outcome=outcome, r_multiple=r_mult,
            directional_correct=dir_correct, return_pct=round(ret_pct, 3),
            factor_scores=r.factor_scores,
        ))

    return day_trades


# ── Trade outcome evaluation ──────────────────────────────────────────────────

def _evaluate_trade(
    direction: str,
    entry: float,
    stop: float,
    target: float,
    day_high: float,
    day_low: float,
    day_close: float,
    risk: float,
) -> tuple[str, float]:
    """
    Determine outcome from daily OHLCV.

    When both target and stop were potentially hit in the same session,
    use the close price as tiebreaker (close in profit direction → target first).
    """
    if direction == "LONG":
        hit_tgt  = day_high  >= target
        hit_stop = day_low   <= stop
        if hit_tgt and not hit_stop:
            return "WIN",    1.0
        if hit_stop and not hit_tgt:
            return "LOSS",  -1.0
        if hit_tgt and hit_stop:
            if day_close >= entry:
                return "WIN",   0.75   # uncertain — give partial credit
            return "LOSS",     -0.75
        # Time exit at close
        r = (day_close - entry) / risk
        return "NEUTRAL", round(max(-0.9, min(0.9, r)), 3)
    else:  # SHORT
        hit_tgt  = day_low   <= target
        hit_stop = day_high  >= stop
        if hit_tgt and not hit_stop:
            return "WIN",    1.0
        if hit_stop and not hit_tgt:
            return "LOSS",  -1.0
        if hit_tgt and hit_stop:
            if day_close <= entry:
                return "WIN",   0.75
            return "LOSS",     -0.75
        r = (entry - day_close) / risk
        return "NEUTRAL", round(max(-0.9, min(0.9, r)), 3)


# ── Metrics computation ───────────────────────────────────────────────────────

def _compute_metrics(
    trades: list[TradeRecord],
    days_tested: int,
    stocks_count: int,
    lookback_days: int,
) -> BacktestResults:
    if not trades:
        return BacktestResults(
            days_tested=days_tested,
            lookback_days=lookback_days,
            disclaimer=_disclaimer(),
        )

    r_vals = np.array([t.r_multiple for t in trades], dtype=float)
    wins   = [t for t in trades if t.outcome == "WIN"]
    losses = [t for t in trades if t.outcome == "LOSS"]
    longs  = [t for t in trades if t.direction == "LONG"]
    shorts = [t for t in trades if t.direction == "SHORT"]

    n      = len(trades)
    win_ct = len(wins)
    win_rate = win_ct / n * 100

    gross_w  = max(r_vals[r_vals > 0].sum(), 0)
    gross_l  = abs(r_vals[r_vals < 0].sum())
    pf       = gross_w / gross_l if gross_l > 1e-9 else (999.0 if gross_w > 0 else 0.0)

    avg_r    = float(r_vals.mean())
    std_r    = float(r_vals.std()) if n > 1 else 1.0
    sharpe   = float(avg_r / std_r * math.sqrt(252)) if std_r > 1e-9 else 0.0

    neg_r    = r_vals[r_vals < 0]
    downdev  = float(neg_r.std()) if len(neg_r) > 1 else (std_r or 0.001)
    sortino  = float(avg_r / downdev * math.sqrt(252)) if downdev > 1e-9 else 0.0

    cum_r    = np.cumsum(r_vals)
    peak     = np.maximum.accumulate(cum_r)
    max_dd   = float((cum_r - peak).min()) if len(cum_r) > 0 else 0.0

    long_wr  = sum(1 for t in longs  if t.outcome == "WIN") / len(longs)  * 100 if longs  else 0.0
    short_wr = sum(1 for t in shorts if t.outcome == "WIN") / len(shorts) * 100 if shorts else 0.0

    # ── Directional accuracy ──────────────────────────────────────────────────
    dir_acc  = sum(1 for t in trades if t.directional_correct) / n * 100
    long_da  = sum(1 for t in longs  if t.directional_correct) / len(longs)  * 100 if longs  else 0.0
    short_da = sum(1 for t in shorts if t.directional_correct) / len(shorts) * 100 if shorts else 0.0

    ret_vals       = [t.return_pct for t in trades]
    long_ret_vals  = [t.return_pct for t in longs]
    short_ret_vals = [t.return_pct for t in shorts]
    avg_ret        = float(np.mean(ret_vals))       if ret_vals       else 0.0
    avg_long_ret   = float(np.mean(long_ret_vals))  if long_ret_vals  else 0.0
    avg_short_ret  = float(np.mean(short_ret_vals)) if short_ret_vals else 0.0

    factor_auc    = _compute_factor_auc(trades)
    current_w     = _current_weights()
    proposed_w    = _propose_weights(factor_auc)

    return BacktestResults(
        total_trades  =n,
        win_count     =win_ct,
        loss_count    =len(losses),
        neutral_count =n - win_ct - len(losses),
        win_rate      =round(win_rate, 1),
        avg_r         =round(avg_r, 3),
        profit_factor =round(pf, 2),
        sharpe        =round(sharpe, 2),
        sortino       =round(sortino, 2),
        max_drawdown  =round(max_dd, 2),
        long_win_rate =round(long_wr, 1),
        short_win_rate=round(short_wr, 1),
        directional_accuracy      =round(dir_acc,  1),
        long_directional_accuracy =round(long_da,  1),
        short_directional_accuracy=round(short_da, 1),
        avg_return_pct            =round(avg_ret,       3),
        avg_long_return_pct       =round(avg_long_ret,  3),
        avg_short_return_pct      =round(avg_short_ret, 3),
        days_tested   =days_tested,
        stocks_per_day=round(n / max(days_tested, 1), 1),
        lookback_days =lookback_days,
        factor_auc    =factor_auc,
        current_weights=current_w,
        proposed_weights=proposed_w,
        disclaimer    =_disclaimer(),
    )


def _compute_factor_auc(trades: list[TradeRecord]) -> dict:
    """
    Per-factor rank correlation with realized R-multiple → AUC-like score.
    For LONG trades: higher factor → positive R.
    For SHORT trades: lower factor → positive R (so we use 1 - factor).
    AUC = (rank_corr + 1) / 2, mapping [-1, 1] → [0, 1].
    """
    if not trades or not trades[0].factor_scores:
        return {}

    factor_names = list(trades[0].factor_scores.keys())
    auc: dict[str, float] = {}

    for fname in factor_names:
        scores, r_mults = [], []
        for t in trades:
            f = t.factor_scores.get(fname)
            if f is None:
                continue
            directional_f = f if t.direction == "LONG" else (1 - f)
            scores.append(directional_f)
            r_mults.append(t.r_multiple)

        if len(scores) < 10:
            auc[fname] = 0.50
            continue

        s = np.array(scores, dtype=float)
        r = np.array(r_mults, dtype=float)

        # Spearman rank correlation (manual — no scipy dependency)
        rs = np.argsort(np.argsort(s)).astype(float)
        rr = np.argsort(np.argsort(r)).astype(float)
        corr = float(np.corrcoef(rs, rr)[0, 1])
        if math.isnan(corr):
            corr = 0.0

        auc[fname] = round((corr + 1) / 2, 3)

    return auc


def _propose_weights(factor_auc: dict) -> dict:
    """
    Convert per-factor AUC to proposed scoring weights.
    Weight ∝ excess AUC above 0.5 (chance level).
    sector_rs capped at 5 (Phase 4 — insufficient data).
    """
    name_map = {
        "or_breakout": "Opening Range Breakout",
        "rel_volume":  "Relative Volume",
        "vwap":        "VWAP Position",
        "momentum5":   "5-min Momentum",
        "prev_hl":     "Prev-day H/L Break",
        "ema_struct":  "EMA Structure",
        "level_break": "20d/52w Level Break",
        "rs_nifty":    "RS vs NIFTY",
        "sector_rs":   "Sector RS (Phase 4)",
        "candle_qual": "Candle Quality",
        "gap_qual":    "Gap Quality",
    }

    excess = {k: max(0.0, factor_auc.get(k, 0.5) - 0.5)
              for k in name_map if k != "sector_rs"}
    total_exc = sum(excess.values())

    proposed: dict[str, float] = {}
    reserved_sector = 5.0   # keep 5 pts for sector RS (Phase 4)

    if total_exc < 0.001:
        # All factors at chance: equal weights
        n = len(excess)
        for k, label in name_map.items():
            proposed[label] = reserved_sector if k == "sector_rs" else round((100 - reserved_sector) / n, 1)
    else:
        budget = 100 - reserved_sector
        for k, label in name_map.items():
            if k == "sector_rs":
                proposed[label] = reserved_sector
            else:
                proposed[label] = round(excess.get(k, 0) / total_exc * budget, 1)

    return proposed


def _current_weights() -> dict:
    return {
        "Opening Range Breakout": config.W_OPENING_RANGE_BREAKOUT,
        "Relative Volume":        config.W_RELATIVE_VOLUME,
        "VWAP Position":          config.W_VWAP_POSITION,
        "5-min Momentum":         config.W_MOMENTUM_5MIN,
        "Prev-day H/L Break":     config.W_PREV_DAY_HL_BREAK,
        "EMA Structure":          config.W_EMA_STRUCTURE,
        "20d/52w Level Break":    config.W_LEVEL_BREAKOUT,
        "RS vs NIFTY":            config.W_RS_NIFTY,
        "Sector RS (Phase 4)":    config.W_SECTOR_RS,
        "Candle Quality":         config.W_CANDLE_QUALITY,
        "Gap Quality":            config.W_GAP_QUALITY,
    }


def _disclaimer() -> str:
    return (
        "Daily OHLCV approximation: entry=open, OR=prev-day H/L. "
        "Win/loss determined by same-day H/L vs 1R target/stop. "
        "Proposed weights are indicative only — validate with intraday data before trading."
    )
