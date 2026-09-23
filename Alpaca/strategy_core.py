"""
Broker-agnostic strategy logic — faithful Python port of Robinhood/algo/algo.js.

Exported:
  compute_indicators(candles)     → dict
  generate_signal(candles)        → dict  {signal, reason, buy_score, sell_score, indicators}
  check_exit(position, candles)   → dict  {exit, reasons, new_stop, new_phase, indicators}
  compute_stop_dist(atr, price)   → float
  compute_position_size(balance, stop_dist, price) → int (shares)

candles: list of dicts with keys: time (ms), open, high, low, close, volume
"""
from __future__ import annotations
import math
import config as cfg


# ── Indicator math ────────────────────────────────────────────────────────────

def _ema(values: list, period: int) -> list:
    result = [None] * len(values)
    if len(values) < period:
        return result
    k = 2 / (period + 1)
    val = sum(v for v in values[:period]) / period
    result[period - 1] = val
    for i in range(period, len(values)):
        if values[i] is not None:
            val = values[i] * k + val * (1 - k)
        result[i] = val
    return result


def _rsi(closes: list, period: int = 14) -> list:
    result = [None] * len(closes)
    if len(closes) <= period:
        return result
    ag = al = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d > 0: ag += d
        else:     al -= d
    ag /= period
    al /= period
    result[period] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        g = d if d > 0 else 0.0
        l = -d if d < 0 else 0.0
        ag = (ag * (period - 1) + g) / period
        al = (al * (period - 1) + l) / period
        result[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return result


def _macd(closes: list, fast: int = 12, slow: int = 26, signal_period: int = 9) -> list:
    ema_fast = _ema(closes, fast)
    ema_slow = _ema(closes, slow)
    macd_line = [
        ef - es if ef is not None and es is not None else None
        for ef, es in zip(ema_fast, ema_slow)
    ]
    first_valid = next((i for i, v in enumerate(macd_line) if v is not None), -1)
    empty = {"macd": None, "signal": None, "hist": None}
    if first_valid == -1 or len(closes) - first_valid < signal_period:
        return [dict(empty) for _ in closes]
    sig_ema = _ema([v for v in macd_line[first_valid:]], signal_period)
    result = []
    for i, m in enumerate(macd_line):
        if m is None:
            result.append(dict(empty))
        else:
            s = sig_ema[i - first_valid]
            result.append({"macd": m, "signal": s, "hist": m - s if s is not None else None})
    return result


def _atr(highs: list, lows: list, closes: list, period: int = 14) -> list:
    n = len(closes)
    result = [None] * n
    if n < period + 1:
        return result
    tr = [None]
    for i in range(1, n):
        tr.append(max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        ))
    s = sum(tr[1:period + 1])
    result[period] = s / period
    for i in range(period + 1, n):
        result[i] = (result[i - 1] * (period - 1) + tr[i]) / period
    return result


def _vol_ma(volumes: list, period: int = 20) -> list:
    result = [None] * len(volumes)
    for i in range(period - 1, len(volumes)):
        result[i] = sum(volumes[i - period + 1: i + 1]) / period
    return result


def _adx(highs: list, lows: list, closes: list, period: int = 14) -> list:
    n = len(closes)
    empty = {"adx": None, "di_plus": None, "di_minus": None}
    if n < period * 2 + 1:
        return [dict(empty) for _ in range(n)]

    tr    = [0.0] * n
    dm_p  = [0.0] * n
    dm_m  = [0.0] * n
    for i in range(1, n):
        tr[i] = max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1]))
        up = highs[i] - highs[i - 1]
        dn = lows[i - 1] - lows[i]
        dm_p[i] = up if up > dn and up > 0 else 0.0
        dm_m[i] = dn if dn > up and dn > 0 else 0.0

    s_tr = [0.0] * n
    s_dp = [0.0] * n
    s_dm = [0.0] * n
    for i in range(1, period + 1):
        s_tr[period] += tr[i]
        s_dp[period] += dm_p[i]
        s_dm[period] += dm_m[i]
    for i in range(period + 1, n):
        s_tr[i] = s_tr[i-1] - s_tr[i-1] / period + tr[i]
        s_dp[i] = s_dp[i-1] - s_dp[i-1] / period + dm_p[i]
        s_dm[i] = s_dm[i-1] - s_dm[i-1] / period + dm_m[i]

    di_p  = [None] * n
    di_m  = [None] * n
    dx    = [None] * n
    for i in range(period, n):
        if s_tr[i] == 0:
            continue
        di_p[i] = (s_dp[i] / s_tr[i]) * 100
        di_m[i] = (s_dm[i] / s_tr[i]) * 100
        denom = di_p[i] + di_m[i]
        if denom > 0:
            dx[i] = abs(di_p[i] - di_m[i]) / denom * 100

    adx_arr = [None] * n
    seed = period * 2 - 1
    if seed >= n:
        return [{"adx": adx_arr[i], "di_plus": di_p[i], "di_minus": di_m[i]} for i in range(n)]

    seed_sum = seed_cnt = 0
    for i in range(period, seed + 1):
        if dx[i] is not None:
            seed_sum += dx[i]
            seed_cnt += 1
    if seed_cnt == period:
        adx_arr[seed] = seed_sum / period
        for i in range(seed + 1, n):
            if dx[i] is not None and adx_arr[i - 1] is not None:
                adx_arr[i] = (adx_arr[i - 1] * (period - 1) + dx[i]) / period

    return [{"adx": adx_arr[i], "di_plus": di_p[i], "di_minus": di_m[i]} for i in range(n)]


# ── Core snapshot ─────────────────────────────────────────────────────────────

def compute_indicators(candles: list[dict]) -> dict:
    closes  = [c["close"]  for c in candles]
    highs   = [c["high"]   for c in candles]
    lows    = [c["low"]    for c in candles]
    volumes = [c["volume"] for c in candles]
    n = len(candles) - 1
    p3 = max(0, n - 3)

    ema21  = _ema(closes, 21)
    ema55  = _ema(closes, 55)
    ema200 = _ema(closes, 200)
    rsi14  = _rsi(closes, 14)
    macd   = _macd(closes)
    atr14  = _atr(highs, lows, closes, 14)
    vol_ma = _vol_ma(volumes, 20)
    adx    = _adx(highs, lows, closes, 14)

    # ATR 20-period SMA for volatility regime filter
    atr_window = [v for v in atr14[max(0, n - 19):n + 1] if v is not None]
    atr_ma20 = sum(atr_window) / len(atr_window) if len(atr_window) >= 5 else None

    # ADX slope over 3 bars
    adx_now  = adx[n]["adx"]  if adx[n]["adx"]  is not None else None
    adx_prev = adx[p3]["adx"] if adx[p3]["adx"] is not None else None
    adx_slope = (adx_now - adx_prev) if (adx_now is not None and adx_prev is not None) else None

    ema21_slope = (
        (ema21[n] - ema21[p3])
        if (ema21[n] is not None and ema21[p3] is not None) else None
    )

    bar = candles[n]
    candle_range = bar["high"] - bar["low"]
    candle_body_ratio = (
        (bar["close"] - bar["low"]) / candle_range if candle_range > 0 else 0.5
    )

    lookback = min(20, n)
    swing_high = max(c["high"] for c in candles[n - lookback: n + 1])
    swing_low  = min(c["low"]  for c in candles[n - lookback: n + 1])

    # Use last CLOSED bar volume (n-1); volumes[n] is the in-progress bar
    vol_idx  = max(0, n - 1)
    vol_ma_v = vol_ma[vol_idx]

    return {
        "price":            closes[n],
        "ema21":            ema21[n],
        "ema55":            ema55[n],
        "ema200":           ema200[n],
        "rsi":              rsi14[n],
        "macd_hist":        macd[n]["hist"],
        "macd_prev_hist":   macd[max(0, n-1)]["hist"],
        "macd_line":        macd[n]["macd"],
        "macd_signal":      macd[n]["signal"],
        "atr":              atr14[n],
        "atr_ma20":         atr_ma20,
        "adx_slope":        adx_slope,
        "ema21_slope":      ema21_slope,
        "candle_body_ratio": candle_body_ratio,
        "volume":           volumes[vol_idx],
        "volume_ma":        vol_ma_v,
        "adx":              adx[n]["adx"],
        "di_plus":          adx[n]["di_plus"],
        "di_minus":         adx[n]["di_minus"],
        "swing_high":       swing_high,
        "swing_low":        swing_low,
        "candle_time":      candles[n]["time"],
    }


# ── Signal ────────────────────────────────────────────────────────────────────

def generate_signal(candles: list[dict]) -> dict:
    if len(candles) < 201:
        return {
            "signal": "HOLD",
            "reason": [f"Need >= 201 bars, have {len(candles)}"],
            "buy_score": 0, "sell_score": 0, "indicators": {},
        }

    ind = compute_indicators(candles)
    price  = ind["price"]
    ema21  = ind["ema21"]
    ema55  = ind["ema55"]
    ema200 = ind["ema200"]
    rsi    = ind["rsi"]
    macd_hist = ind["macd_hist"]
    atr    = ind["atr"]
    atr_ma20 = ind["atr_ma20"]
    adx_slope = ind["adx_slope"]
    ema21_slope = ind["ema21_slope"]
    candle_body_ratio = ind["candle_body_ratio"]
    adx    = ind["adx"]
    di_plus  = ind["di_plus"]
    di_minus = ind["di_minus"]

    if any(v is None for v in [ema21, ema55, ema200, rsi, macd_hist, atr, adx]):
        return {"signal": "HOLD", "reason": ["Indicators not ready"], "buy_score": 0, "sell_score": 0, "indicators": ind}

    def fmt(v, d=2): return f"{v:.{d}f}" if v is not None else "n/a"
    di_spread    = abs(di_plus - di_minus)
    ema21_rising  = ema21_slope > 0 if ema21_slope is not None else False
    ema21_falling = ema21_slope < 0 if ema21_slope is not None else False

    buy_checks = [
        (di_plus > di_minus,       f"DI+({fmt(di_plus,1)}) > DI-({fmt(di_minus,1)})"),
        (ema21 > ema55,            f"EMA21({fmt(ema21)}) > EMA55({fmt(ema55)})"),
        (ema55 > ema200,           f"EMA55({fmt(ema55)}) > EMA200({fmt(ema200)})"),
        (ema21_rising,             f"EMA21 slope rising ({fmt(ema21_slope,1)})"),
        (cfg.RSI_BUY_LOW <= rsi <= cfg.RSI_BUY_HIGH, f"RSI({fmt(rsi,1)}) in [{cfg.RSI_BUY_LOW}-{cfg.RSI_BUY_HIGH}]"),
        (macd_hist > 0,            f"MACD hist > 0 ({fmt(macd_hist,4)})"),
        (candle_body_ratio >= 0.45, f"Candle close quality ({candle_body_ratio*100:.0f}% upper)"),
    ]
    sell_checks = [
        (di_minus > di_plus,       f"DI-({fmt(di_minus,1)}) > DI+({fmt(di_plus,1)})"),
        (ema21 < ema55,            "EMA21 < EMA55"),
        (ema55 < ema200,           "EMA55 < EMA200"),
        (ema21_falling,            f"EMA21 slope falling ({fmt(ema21_slope,1)})"),
        (cfg.RSI_SELL_LOW <= rsi <= cfg.RSI_SELL_HIGH, f"RSI({fmt(rsi,1)}) in [{cfg.RSI_SELL_LOW}-{cfg.RSI_SELL_HIGH}]"),
        (macd_hist < 0,            f"MACD hist < 0 ({fmt(macd_hist,4)})"),
        (candle_body_ratio <= 0.55, f"Candle close quality ({(1-candle_body_ratio)*100:.0f}% lower)"),
    ]

    buy_score  = sum(1 for ok, _ in buy_checks  if ok)
    sell_score = sum(1 for ok, _ in sell_checks if ok)
    buy_passed  = [lbl for ok, lbl in buy_checks  if ok]
    sell_passed = [lbl for ok, lbl in sell_checks if ok]
    buy_failed  = [lbl for ok, lbl in buy_checks  if not ok]
    sell_failed = [lbl for ok, lbl in sell_checks if not ok]

    # Hard gate 1 — ADX strength
    if adx < cfg.ADX_MIN:
        return {"signal": "HOLD", "reason": [f"ADX({fmt(adx,1)}) < {cfg.ADX_MIN} - weak trend"],
                "buy_score": buy_score, "sell_score": sell_score, "indicators": ind}

    # Hard gate 2 — DI spread
    if di_spread < cfg.DI_SPREAD_MIN:
        return {"signal": "HOLD", "reason": [f"DI spread({fmt(di_spread,1)}) < {cfg.DI_SPREAD_MIN} - weak conviction"],
                "buy_score": buy_score, "sell_score": sell_score, "indicators": ind}

    # Hard gate 3 — ADX rising
    if adx_slope is not None and adx_slope <= 0:
        return {"signal": "HOLD", "reason": [f"ADX slope ({fmt(adx_slope,2)}) <= 0 - trend fading"],
                "buy_score": buy_score, "sell_score": sell_score, "indicators": ind}

    # Hard gate 4 — ATR regime
    if atr_ma20 is not None and atr > atr_ma20 * cfg.ATR_REGIME_MULT:
        return {"signal": "HOLD",
                "reason": [f"ATR spike: {fmt(atr,3)} > {cfg.ATR_REGIME_MULT}x ATR_MA({fmt(atr_ma20,3)})"],
                "buy_score": buy_score, "sell_score": sell_score, "indicators": ind}

    # Hard gate 5 — price proximity to EMA21
    ema21_dist = abs(price - ema21)
    if ema21_dist > atr * cfg.PRICE_PROX_ATR:
        return {"signal": "HOLD",
                "reason": [f"|price-EMA21|({fmt(ema21_dist,3)}) > {cfg.PRICE_PROX_ATR}x ATR({fmt(atr*cfg.PRICE_PROX_ATR,3)})"],
                "buy_score": buy_score, "sell_score": sell_score, "indicators": ind}

    T = cfg.SIGNAL_THRESHOLD
    if buy_score >= T and buy_score > sell_score:
        return {"signal": "BUY",  "reason": buy_passed,  "buy_score": buy_score, "sell_score": sell_score, "indicators": ind}
    if sell_score >= T and sell_score > buy_score:
        return {"signal": "SELL", "reason": sell_passed, "buy_score": buy_score, "sell_score": sell_score, "indicators": ind}

    hold_reason = (
        [f"BUY score {buy_score}/7 - need {T} (missing: {', '.join(buy_failed)})"]
        if buy_score > sell_score else
        [f"SELL score {sell_score}/7 - need {T} (missing: {', '.join(sell_failed)})"]
    )
    return {"signal": "HOLD", "reason": hold_reason, "buy_score": buy_score, "sell_score": sell_score, "indicators": ind}


# ── Exit / trailing ───────────────────────────────────────────────────────────

def check_exit(position: dict, candles: list[dict]) -> dict:
    """
    position must contain:
      side, entry_price, stop_loss, take_profit, phase,
      candles_held, last_candle_time, mae (max adverse excursion)
    Returns updated position fields + exit decision.
    """
    ind = compute_indicators(candles)
    price = ind["price"]
    atr   = ind["atr"]
    rsi   = ind["rsi"]
    ema21 = ind["ema21"]
    ema55 = ind["ema55"]

    side        = position["side"]
    entry_price = position["entry_price"]
    stop_loss   = position["stop_loss"]
    take_profit = position["take_profit"]
    phase       = position["phase"]
    mae         = position.get("mae", 0.0)
    candles_held = position.get("candles_held", 0)
    last_candle_time = position.get("last_candle_time")

    profit = (price - entry_price) if side == "long" else (entry_price - price)

    # Track candles held (only increment on new bar)
    current_candle_time = ind["candle_time"]
    if current_candle_time != last_candle_time:
        candles_held += 1

    # Update max adverse excursion
    current_mae = min(mae, profit)

    # Phase-based SL ratchet
    new_phase = phase
    new_sl    = stop_loss

    if atr is not None:
        if side == "long":
            if phase < 4 and profit >= atr * cfg.PHASE4_ATR_THRESH:
                new_phase = 4
                new_sl    = price - atr * cfg.PHASE4_TRAIL_ATR
            elif phase < 3 and profit >= atr * cfg.PHASE3_ATR_THRESH:
                new_phase = 3
                new_sl    = entry_price + atr * cfg.PHASE3_SL_ATR
            elif phase < 2 and profit >= atr * cfg.PHASE2_ATR_THRESH:
                new_phase = 2
                new_sl    = entry_price + atr * cfg.PHASE2_BUFFER_ATR
            elif phase == 4:
                new_sl = max(new_sl, price - atr * cfg.PHASE4_TRAIL_ATR)
        else:  # short
            if phase < 4 and profit >= atr * cfg.PHASE4_ATR_THRESH:
                new_phase = 4
                new_sl    = price + atr * cfg.PHASE4_TRAIL_ATR
            elif phase < 3 and profit >= atr * cfg.PHASE3_ATR_THRESH:
                new_phase = 3
                new_sl    = entry_price - atr * cfg.PHASE3_SL_ATR
            elif phase < 2 and profit >= atr * cfg.PHASE2_ATR_THRESH:
                new_phase = 2
                new_sl    = entry_price - atr * cfg.PHASE2_BUFFER_ATR
            elif phase == 4:
                new_sl = min(new_sl, price + atr * cfg.PHASE4_TRAIL_ATR)

    # Update position state
    position["stop_loss"]        = new_sl
    position["phase"]            = new_phase
    position["candles_held"]     = candles_held
    position["last_candle_time"] = current_candle_time
    position["mae"]              = current_mae

    reasons = []
    fmt = lambda v: f"{v:.4f}"

    if side == "long":
        if price <= new_sl:
            reasons.append(f"SL hit (Phase {new_phase}): {fmt(price)} ≤ {fmt(new_sl)}")
        if price >= take_profit:
            reasons.append(f"TP hit: {fmt(price)} ≥ {fmt(take_profit)}")
        if rsi is not None and rsi > cfg.RSI_OB_EXIT:
            reasons.append(f"RSI overbought ({rsi:.1f} > {cfg.RSI_OB_EXIT})")
        if ema21 is not None and ema55 is not None and ema21 < ema55 and profit > 0:
            reasons.append("EMA trend reversed (bearish)")
    else:
        if price >= new_sl:
            reasons.append(f"SL hit (Phase {new_phase}): {fmt(price)} ≥ {fmt(new_sl)}")
        if price <= take_profit:
            reasons.append(f"TP hit: {fmt(price)} ≤ {fmt(take_profit)}")
        if rsi is not None and rsi < cfg.RSI_OS_EXIT:
            reasons.append(f"RSI oversold ({rsi:.1f} < {cfg.RSI_OS_EXIT})")
        if ema21 is not None and ema55 is not None and ema21 > ema55 and profit > 0:
            reasons.append("EMA trend reversed (bullish)")

    if candles_held >= cfg.TIME_STOP_BARS:
        reasons.append(f"Time stop: {candles_held} bars held")

    return {
        "exit":      len(reasons) > 0,
        "reasons":   reasons,
        "new_stop":  new_sl,
        "new_phase": new_phase,
        "indicators": ind,
    }


# ── Sizing helpers ────────────────────────────────────────────────────────────

def compute_stop_dist(atr: float, price: float) -> float:
    return max(cfg.STOP_ATR_MULT * atr, price * cfg.STOP_MIN_PCT)


def compute_position_size(balance: float, stop_dist: float, price: float) -> int:
    """
    Returns integer share count.
    Caps at:
      - Risk per trade = 1.5% of balance
      - Capital cap = $500 (price × qty ≤ CAPITAL_CAP_USD)
    Returns 0 if even 1 share is unaffordable.
    """
    if stop_dist <= 0 or price <= 0:
        return 0
    risk_usd       = balance * cfg.RISK_PER_TRADE_PCT
    qty_by_risk    = int(risk_usd / stop_dist)
    qty_by_capital = int(cfg.CAPITAL_CAP_USD / price)
    qty = min(qty_by_risk, qty_by_capital)
    return max(0, qty)
