"""
Phase 2 — Scoring engine.

Computes a 0–100 bullish/bearish score for each stock at scan time.
Each factor returns a 0–1 component score; final score = weighted sum × 100.

⚠  ALL WEIGHTS are unvalidated placeholders from config.py.
   Do NOT treat output as meaningful until Phase 3 backtesting replaces them.
"""
from __future__ import annotations
import logging
import math
from dataclasses import dataclass, field

import pandas as pd

import config

logger = logging.getLogger(__name__)

UNVALIDATED_WARNING = (
    "⚠ UNVALIDATED WEIGHTS — paper trade only until Phase 3 validates them."
)

_OPEN_MINUTES  = 9 * 60 + 15   # 09:15 IST = market open
_TOTAL_MINUTES = 375            # 09:15–15:30


@dataclass
class ORBar:
    """Opening range bar (9:15–9:30 IST)."""
    or_high:   float
    or_low:    float
    or_vwap:   float
    or_volume: float
    or_open:   float


@dataclass
class ScanResult:
    security_id:        str
    symbol:             str
    company:            str   = ""
    direction:          str   = "LONG"    # "LONG" or "SHORT"
    score:              float = 0.0       # 0–100 conviction within gated set
    fb_risk:            float = 50.0      # 0–100 false-breakout risk
    ltp:                float = 0.0       # last traded price at scan time
    entry:              float = 0.0
    stop_loss:          float = 0.0
    target_1r:          float = 0.0
    target_2r:          float = 0.0
    rel_volume:         float = 1.0       # time-normalised RVOL ×multiple
    vwap:               float = 0.0       # intraday VWAP from open to scan_time
    or_high:            float = 0.0       # OR high (9:15–9:30)
    or_low:             float = 0.0       # OR low  (9:15–9:30)
    breakout_pct:       float = 0.0       # % beyond OR boundary in signal direction
    breakout_confirmed: bool  = False      # passed hard gate (ltp>orH, rvol≥1.5, ltp≥vwap)
    day_move_pct:       float = 0.0       # % from prev close to ltp
    rs_nifty:           float = 0.0       # stock return minus NIFTY return
    buy_imbalance:      float = float("nan")  # Phase 4 (order book)
    reasons:            list[str] = field(default_factory=list)
    factor_scores:      dict       = field(default_factory=dict)
    scan_time:          str        = "09:30"
    unvalidated:        bool       = True


def score_stock(
    security_id: str,
    symbol: str,
    daily_features: dict,
    or_bar: ORBar,
    intraday_bars: pd.DataFrame,   # 1-min bars from market open to scan time (point-in-time)
    nifty_return: float,           # NIFTY % move from prev close to scan time
    market_regime: str,            # STRONG_BULL | BULL | NEUTRAL | BEAR | STRONG_BEAR
    scan_time: str = "09:30",
) -> tuple[ScanResult, ScanResult] | None:
    """
    Return (long_result, short_result) scored independently.
    Returns None if insufficient data.

    Point-in-time contract: all inputs must use ONLY data available at scan time.
    intraday_bars must be sliced to [open … scan_time] before calling.
    """
    if intraday_bars is None or intraday_bars.empty:
        return None

    ltp = float(intraday_bars["close"].iloc[-1])
    prev_close = daily_features.get("prev_close") or daily_features.get("close")
    if not prev_close or prev_close == 0:
        return None

    atr   = daily_features.get("atr14") or 1.0
    risk  = config.ATR_RISK_MULTIPLIER * atr
    day_move      = (ltp - prev_close) / prev_close * 100
    rs_nifty      = day_move - nifty_return
    display_rvol  = _compute_display_rvol(intraday_bars, daily_features)
    intraday_vwap = _compute_intraday_vwap(intraday_bars)

    factors = {
        "or_breakout": _f_or_breakout(ltp, or_bar),
        "rel_volume":  _f_rel_volume(intraday_bars, daily_features),
        "vwap":        _f_vwap(ltp, intraday_vwap),
        "momentum5":   _f_momentum5(intraday_bars),
        "prev_hl":     _f_prev_hl(ltp, daily_features),
        "ema_struct":  _f_ema_structure(ltp, daily_features),
        "level_break": _f_level_breakout(ltp, daily_features),
        "rs_nifty":    _f_rs_nifty(rs_nifty),
        "sector_rs":   0.5,    # Phase 4 reserved
        "candle_qual": _f_candle_quality(intraday_bars),
        "gap_qual":    _f_gap_quality(daily_features),
    }
    weights = {
        "or_breakout": config.W_OPENING_RANGE_BREAKOUT,
        "rel_volume":  config.W_RELATIVE_VOLUME,
        "vwap":        config.W_VWAP_POSITION,
        "momentum5":   config.W_MOMENTUM_5MIN,
        "prev_hl":     config.W_PREV_DAY_HL_BREAK,
        "ema_struct":  config.W_EMA_STRUCTURE,
        "level_break": config.W_LEVEL_BREAKOUT,
        "rs_nifty":    config.W_RS_NIFTY,
        "sector_rs":   config.W_SECTOR_RS,
        "candle_qual": config.W_CANDLE_QUALITY,
        "gap_qual":    config.W_GAP_QUALITY,
    }

    bull_score = sum(factors[k] * weights[k] for k in factors) / max(config.TOTAL_WEIGHT, 1) * 100
    bear_score = sum((1 - factors[k]) * weights[k] for k in factors) / max(config.TOTAL_WEIGHT, 1) * 100

    fb_risk = compute_false_breakout_risk(or_bar, intraday_bars, daily_features)

    def make_result(direction: str, score: float) -> ScanResult:
        mult    = 1 if direction == "LONG" else -1
        reasons = _build_reasons(factors, direction, daily_features, or_bar, ltp, intraday_vwap)
        if market_regime in ("STRONG_BEAR", "BEAR") and direction == "LONG":
            reasons.insert(0, f"Bearish regime ({market_regime}) — long carries extra risk")
        if market_regime in ("STRONG_BULL", "BULL") and direction == "SHORT":
            reasons.insert(0, f"Bullish regime ({market_regime}) — short carries extra risk")
        # Breakout distance: how far % beyond OR boundary in the signal direction
        if direction == "LONG":
            bp = (ltp - or_bar.or_high) / max(or_bar.or_high, 0.01) * 100
        else:
            bp = (or_bar.or_low - ltp) / max(or_bar.or_low, 0.01) * 100
        return ScanResult(
            security_id       =security_id,
            symbol            =symbol,
            direction         =direction,
            score             =round(score, 1),
            fb_risk           =round(fb_risk, 1),
            ltp               =round(ltp, 2),
            entry             =round(ltp, 2),
            stop_loss         =round(ltp - mult * risk, 2),
            target_1r         =round(ltp + mult * risk, 2),
            target_2r         =round(ltp + mult * 2 * risk, 2),
            rel_volume        =round(display_rvol, 2),
            vwap              =round(intraday_vwap, 2),
            or_high           =round(or_bar.or_high, 2),
            or_low            =round(or_bar.or_low, 2),
            breakout_pct      =round(bp, 2),
            breakout_confirmed=False,   # set by scanner after gate check
            day_move_pct      =round(day_move, 2),
            rs_nifty          =round(rs_nifty, 2),
            buy_imbalance     =float("nan"),   # Phase 4
            reasons           =reasons,
            factor_scores     ={k: round(v, 3) for k, v in factors.items()},
            scan_time         =scan_time,
            unvalidated       =True,
        )

    return make_result("LONG", bull_score), make_result("SHORT", bear_score)


# ─────────────────────────────────────────────────────────────────────────────
# Factor functions — each returns 0.0 (bearish) to 1.0 (bullish), 0.5 = neutral
# ─────────────────────────────────────────────────────────────────────────────

def _f_or_breakout(ltp: float, or_bar: ORBar) -> float:
    """Is price breaking above OR_HIGH (bull) or below OR_LOW (bear)?"""
    or_range = max(or_bar.or_high - or_bar.or_low, 0.01)
    if ltp > or_bar.or_high:
        excess = (ltp - or_bar.or_high) / or_range
        return min(0.5 + 0.5 * min(excess * 2, 1.0), 1.0)
    if ltp < or_bar.or_low:
        excess = (or_bar.or_low - ltp) / or_range
        return max(0.5 - 0.5 * min(excess * 2, 1.0), 0.0)
    # Inside OR — position within range
    pos = (ltp - or_bar.or_low) / or_range
    return 0.35 + pos * 0.30   # 0.35–0.65 inside OR


def _f_rel_volume(bars: pd.DataFrame, feat: dict) -> float:
    """
    Time-normalised relative volume vs 20-day baseline.
    Avoids comparing 9:30 volume to full-day average (would over-inflate ~6×).
    """
    if bars is None or bars.empty or "volume" not in bars.columns:
        return 0.5
    vol_20d = feat.get("vol_20d_avg")
    if not vol_20d or vol_20d <= 0:
        return 0.5

    actual_vol = float(bars["volume"].sum())
    elapsed = _elapsed_minutes(bars)
    fraction = min(elapsed / _TOTAL_MINUTES, 1.0)
    expected = vol_20d * fraction
    if expected <= 0:
        return 0.5

    rvol = actual_vol / expected
    return _sigmoid_norm(rvol - 1.0, scale=1.5)


def _f_vwap(ltp: float, vwap: float) -> float:
    """Price position relative to intraday VWAP (open → scan_time)."""
    if vwap <= 0:
        return 0.5
    diff_pct = (ltp - vwap) / vwap * 100
    return _sigmoid_norm(diff_pct, scale=0.5)


def _f_momentum5(bars: pd.DataFrame) -> float:
    """5-bar close momentum (last 5 minutes)."""
    if bars is None or len(bars) < 5:
        return 0.5
    recent = bars["close"].iloc[-5:]
    ref = float(recent.iloc[0])
    if ref == 0:
        return 0.5
    pct = (float(recent.iloc[-1]) - ref) / ref * 100
    return _sigmoid_norm(pct, scale=0.4)


def _f_prev_hl(ltp: float, feat: dict) -> float:
    """Is price above prev-day high (bull) or below prev-day low (bear)?"""
    ph = feat.get("prev_high")
    pl = feat.get("prev_low")
    if ph and ltp > ph:
        return 0.80
    if pl and ltp < pl:
        return 0.20
    # Position within prev-day range
    if ph and pl and ph > pl:
        pos = (ltp - pl) / (ph - pl)
        return 0.35 + pos * 0.30
    return 0.5


def _f_ema_structure(ltp: float, feat: dict) -> float:
    """EMA9 vs EMA20 alignment and price vs EMA20."""
    ema9  = feat.get("ema9")
    ema20 = feat.get("ema20")
    if not ema9 or not ema20 or ema20 == 0:
        return 0.5
    score = 0.5
    if ema9 > ema20:
        score += 0.15   # EMAs bullish aligned
    elif ema9 < ema20:
        score -= 0.15   # EMAs bearish aligned
    if ltp > ema20:
        score += 0.10   # price above EMA20
    elif ltp < ema20:
        score -= 0.10
    return max(0.0, min(1.0, score))


def _f_level_breakout(ltp: float, feat: dict) -> float:
    """Price vs 20-day and 52-week key levels."""
    h20 = feat.get("high_20d")
    l20 = feat.get("low_20d")
    h52 = feat.get("high_52w")
    l52 = feat.get("low_52w")
    score = 0.5
    if h20 and ltp > h20:
        score += 0.15
    if l20 and ltp < l20:
        score -= 0.15
    if h52 and ltp > h52:
        score += 0.10   # 52-week high breakout is stronger
    if l52 and ltp < l52:
        score -= 0.10
    return max(0.0, min(1.0, score))


def _f_rs_nifty(rs: float) -> float:
    """Relative strength vs NIFTY."""
    return _sigmoid_norm(rs, scale=0.4)


def _f_candle_quality(bars: pd.DataFrame) -> float:
    """
    Quality of the opening composite candle (09:15–09:30 window or all available bars).
    Bull quality = large body + close near high of range.
    Bear quality = large body + close near low of range.
    """
    if bars is None or len(bars) < 2:
        return 0.5
    # Use first 15 bars (OR window)
    sample = bars.iloc[:min(15, len(bars))]
    c_open  = float(sample["open"].iloc[0])
    c_close = float(sample["close"].iloc[-1])
    c_high  = float(sample["high"].max())
    c_low   = float(sample["low"].min())

    rng = c_high - c_low
    if rng < 0.0001:
        return 0.5

    body_pct  = abs(c_close - c_open) / rng         # 0=doji, 1=no wicks
    close_pos = (c_close - c_low) / rng              # 0=closed at low, 1=at high

    if c_close > c_open:
        return 0.5 + 0.5 * body_pct * close_pos     # bullish: big body near high
    if c_close < c_open:
        return 0.5 - 0.5 * body_pct * (1 - close_pos)  # bearish: big body near low
    return 0.5


def _f_gap_quality(feat: dict) -> float:
    """Gap size and direction vs previous close."""
    gap = feat.get("gap_pct", 0) or 0
    return _sigmoid_norm(gap, scale=0.8)


# ─────────────────────────────────────────────────────────────────────────────
# False-breakout risk
# ─────────────────────────────────────────────────────────────────────────────

def compute_false_breakout_risk(
    or_bar: ORBar,
    intraday_bars: pd.DataFrame,
    feat: dict,
) -> float:
    """
    Estimate false-breakout risk 0–100 (higher = more likely to fail).
    Factors: narrow OR range, low relative volume, large overnight gap, wide ATR vs OR.
    """
    risk = 50.0

    # Narrow OR range → easier to spike through and reverse
    if or_bar.or_vwap > 0:
        or_range_pct = (or_bar.or_high - or_bar.or_low) / or_bar.or_vwap * 100
    else:
        or_range_pct = 1.0

    if or_range_pct < 0.2:
        risk += 25
    elif or_range_pct < 0.5:
        risk += 12
    elif or_range_pct > 1.5:
        risk -= 15

    # Low volume → thin participation → easier reversal
    if intraday_bars is not None and "volume" in intraday_bars.columns:
        vol_20d = feat.get("vol_20d_avg", 0) or 0
        if vol_20d > 0:
            elapsed  = _elapsed_minutes(intraday_bars)
            fraction = min(elapsed / _TOTAL_MINUTES, 1.0)
            expected = vol_20d * fraction
            if expected > 0:
                rvol = float(intraday_bars["volume"].sum()) / expected
                if rvol < 0.7:
                    risk += 15
                elif rvol > 2.0:
                    risk -= 10

    # Large overnight gap → gap-fill risk (counter-direction snap-back)
    gap = feat.get("gap_pct", 0) or 0
    if abs(gap) > 3.0:
        risk += 15
    elif abs(gap) > 1.5:
        risk += 7

    # Wide ATR vs OR range → daily volatility dwarfs the OR level
    atr14 = feat.get("atr14", 0) or 0
    if atr14 > 0 and or_bar.or_vwap > 0 and or_range_pct > 0:
        atr_pct = atr14 / or_bar.or_vwap * 100
        if atr_pct / or_range_pct > 3:
            risk += 10

    return max(0.0, min(100.0, risk))


def detect_market_regime(nifty_daily: pd.DataFrame) -> str:
    """
    Classify NIFTY into STRONG_BULL | BULL | NEUTRAL | BEAR | STRONG_BEAR
    using daily OHLCV (prev close vs current price).

    Phase 2 uses _detect_regime_from_intraday() in scanner.py for live data.
    This function is the daily-data fallback for when intraday is unavailable.
    """
    if nifty_daily is None or nifty_daily.empty or len(nifty_daily) < 2:
        return "NEUTRAL"
    prev_close = float(nifty_daily["close"].iloc[-2])
    last_close = float(nifty_daily["close"].iloc[-1])
    if prev_close == 0:
        return "NEUTRAL"
    pct = (last_close - prev_close) / prev_close * 100
    if pct > 1.0:
        return "STRONG_BULL"
    if pct > 0.3:
        return "BULL"
    if pct < -1.0:
        return "STRONG_BEAR"
    if pct < -0.3:
        return "BEAR"
    return "NEUTRAL"


# ─────────────────────────────────────────────────────────────────────────────
# Reason builder
# ─────────────────────────────────────────────────────────────────────────────

def _build_reasons(
    factors: dict,
    direction: str,
    feat: dict,
    or_bar: ORBar,
    ltp: float,
    intraday_vwap: float = 0.0,
) -> list[str]:
    """Generate plain-language reason strings for the card display."""
    reasons = []
    bull = direction == "LONG"

    # OR breakout
    f = factors.get("or_breakout", 0.5)
    or_range = max(or_bar.or_high - or_bar.or_low, 0.01)
    if f > 0.65:
        excess_pct = (ltp - or_bar.or_high) / or_range * 100
        reasons.append(f"▲ OR breakout +{excess_pct:.0f}% above OR-high {or_bar.or_high:.2f}")
    elif f < 0.35:
        excess_pct = (or_bar.or_low - ltp) / or_range * 100
        reasons.append(f"▼ OR breakdown {excess_pct:.0f}% below OR-low {or_bar.or_low:.2f}")
    else:
        reasons.append(f"— Price inside OR ({or_bar.or_low:.2f}–{or_bar.or_high:.2f})")

    # VWAP
    f = factors.get("vwap", 0.5)
    vwap_disp = intraday_vwap if intraday_vwap > 0 else or_bar.or_vwap
    if f > 0.62:
        reasons.append(f"▲ Above VWAP {vwap_disp:.2f}")
    elif f < 0.38:
        reasons.append(f"▼ Below VWAP {vwap_disp:.2f}")

    # Relative volume
    f = factors.get("rel_volume", 0.5)
    if f > 0.65:
        reasons.append("▲ Above-average volume (strong participation)")
    elif f < 0.35:
        reasons.append("⚠ Below-average volume (thin participation)")

    # 5-min momentum
    f = factors.get("momentum5", 0.5)
    if bull and f > 0.65:
        reasons.append("▲ Positive 5-min price momentum")
    elif not bull and f < 0.35:
        reasons.append("▼ Negative 5-min price momentum")

    # EMA structure
    f = factors.get("ema_struct", 0.5)
    ema9  = feat.get("ema9")
    ema20 = feat.get("ema20")
    if f > 0.62:
        reasons.append(f"▲ Bullish EMA stack (EMA9 > EMA20, price > EMA20)")
    elif f < 0.38:
        reasons.append(f"▼ Bearish EMA stack (EMA9 < EMA20, price < EMA20)")

    # Prev-day levels
    f = factors.get("prev_hl", 0.5)
    ph = feat.get("prev_high")
    pl = feat.get("prev_low")
    if f > 0.72 and ph:
        reasons.append(f"▲ Above prev-day high {ph:.2f}")
    elif f < 0.28 and pl:
        reasons.append(f"▼ Below prev-day low {pl:.2f}")

    # Level breakout
    f = factors.get("level_break", 0.5)
    if bull and f > 0.60:
        h20 = feat.get("high_20d")
        h52 = feat.get("high_52w")
        if h52 and ltp > h52:
            reasons.append(f"▲ 52-week high breakout {h52:.2f}")
        elif h20 and ltp > h20:
            reasons.append(f"▲ 20-day high breakout {h20:.2f}")
    elif not bull and f < 0.40:
        l20 = feat.get("low_20d")
        l52 = feat.get("low_52w")
        if l52 and ltp < l52:
            reasons.append(f"▼ 52-week low breakdown {l52:.2f}")
        elif l20 and ltp < l20:
            reasons.append(f"▼ 20-day low breakdown {l20:.2f}")

    # RS vs NIFTY
    f = factors.get("rs_nifty", 0.5)
    if bull and f > 0.65:
        reasons.append("▲ Outperforming NIFTY")
    elif not bull and f < 0.35:
        reasons.append("▼ Underperforming NIFTY")

    # Gap
    gap = feat.get("gap_pct", 0) or 0
    if abs(gap) > 0.5:
        arrow = "▲" if gap > 0 else "▼"
        reasons.append(f"{arrow} Gap {'up' if gap > 0 else 'down'} {abs(gap):.1f}%")

    return reasons


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _compute_intraday_vwap(bars: pd.DataFrame) -> float:
    """Volume-weighted average price from market open to scan_time."""
    if bars is None or bars.empty:
        return 0.0
    if "volume" in bars.columns:
        vol = float(bars["volume"].sum())
        if vol > 0:
            return float((bars["close"] * bars["volume"]).sum() / vol)
    return float(bars["close"].mean())


def _elapsed_minutes(bars: pd.DataFrame) -> int:
    """Minutes elapsed from market open (09:15) to last bar's timestamp."""
    if bars is None or bars.empty or "datetime" not in bars.columns:
        return 15  # default: assume 09:30
    try:
        last_dt = bars["datetime"].iloc[-1]
        cur = last_dt.hour * 60 + last_dt.minute
        return max(cur - _OPEN_MINUTES, 1)
    except Exception:
        return 15


def _compute_display_rvol(bars: pd.DataFrame, feat: dict) -> float:
    """Actual relative volume multiple for display (not sigmoid-normalized)."""
    if bars is None or bars.empty or "volume" not in bars.columns:
        return 1.0
    vol_20d = feat.get("vol_20d_avg")
    if not vol_20d or vol_20d <= 0:
        return 1.0
    actual  = float(bars["volume"].sum())
    elapsed = _elapsed_minutes(bars)
    frac    = min(elapsed / _TOTAL_MINUTES, 1.0)
    expected = vol_20d * frac
    if expected <= 0:
        return 1.0
    return round(actual / expected, 2)


def _sigmoid_norm(x: float, scale: float = 1.0) -> float:
    """Map a signed value to (0, 1) via logistic function."""
    try:
        return 1.0 / (1.0 + math.exp(-x * scale))
    except OverflowError:
        return 0.0 if x < 0 else 1.0
