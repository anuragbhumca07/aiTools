"""
Broker-agnostic strategy logic — faithful Python port of Robinhood/algo/algo.js.
Identical to Alpaca version except sizing uses CAPITAL_CAP_INR (rupees).

candles: list of dicts {time (ms), open, high, low, close, volume}
"""
from __future__ import annotations
import config as cfg


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
    ag /= period; al /= period
    result[period] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        g = d if d > 0 else 0.0
        l = -d if d < 0 else 0.0
        ag = (ag * (period - 1) + g) / period
        al = (al * (period - 1) + l) / period
        result[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return result


def _macd(closes: list, fast: int = 12, slow: int = 26, sig_p: int = 9) -> list:
    ema_fast = _ema(closes, fast)
    ema_slow = _ema(closes, slow)
    macd_line = [ef - es if ef is not None and es is not None else None
                 for ef, es in zip(ema_fast, ema_slow)]
    first = next((i for i, v in enumerate(macd_line) if v is not None), -1)
    empty = {"macd": None, "signal": None, "hist": None}
    if first == -1 or len(closes) - first < sig_p:
        return [dict(empty) for _ in closes]
    sig_ema = _ema([v for v in macd_line[first:]], sig_p)
    result = []
    for i, m in enumerate(macd_line):
        if m is None:
            result.append(dict(empty))
        else:
            s = sig_ema[i - first]
            result.append({"macd": m, "signal": s, "hist": m - s if s is not None else None})
    return result


def _atr(highs: list, lows: list, closes: list, period: int = 14) -> list:
    n = len(closes)
    result = [None] * n
    if n < period + 1:
        return result
    tr = [None]
    for i in range(1, n):
        tr.append(max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1])))
    s = sum(tr[1:period + 1])
    result[period] = s / period
    for i in range(period + 1, n):
        result[i] = (result[i-1] * (period - 1) + tr[i]) / period
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
    tr = [0.0]*n; dm_p = [0.0]*n; dm_m = [0.0]*n
    for i in range(1, n):
        tr[i] = max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1]))
        up = highs[i]-highs[i-1]; dn = lows[i-1]-lows[i]
        dm_p[i] = up if up > dn and up > 0 else 0.0
        dm_m[i] = dn if dn > up and dn > 0 else 0.0
    s_tr = [0.0]*n; s_dp = [0.0]*n; s_dm = [0.0]*n
    for i in range(1, period+1):
        s_tr[period] += tr[i]; s_dp[period] += dm_p[i]; s_dm[period] += dm_m[i]
    for i in range(period+1, n):
        s_tr[i] = s_tr[i-1] - s_tr[i-1]/period + tr[i]
        s_dp[i] = s_dp[i-1] - s_dp[i-1]/period + dm_p[i]
        s_dm[i] = s_dm[i-1] - s_dm[i-1]/period + dm_m[i]
    di_p = [None]*n; di_m = [None]*n; dx = [None]*n
    for i in range(period, n):
        if s_tr[i] == 0: continue
        di_p[i] = (s_dp[i]/s_tr[i])*100; di_m[i] = (s_dm[i]/s_tr[i])*100
        denom = di_p[i]+di_m[i]
        if denom > 0: dx[i] = abs(di_p[i]-di_m[i])/denom*100
    adx_arr = [None]*n
    seed = period*2-1
    if seed >= n:
        return [{"adx": adx_arr[i], "di_plus": di_p[i], "di_minus": di_m[i]} for i in range(n)]
    ss = sc = 0
    for i in range(period, seed+1):
        if dx[i] is not None: ss += dx[i]; sc += 1
    if sc == period:
        adx_arr[seed] = ss/period
        for i in range(seed+1, n):
            if dx[i] is not None and adx_arr[i-1] is not None:
                adx_arr[i] = (adx_arr[i-1]*(period-1)+dx[i])/period
    return [{"adx": adx_arr[i], "di_plus": di_p[i], "di_minus": di_m[i]} for i in range(n)]


def compute_indicators(candles: list[dict]) -> dict:
    closes  = [c["close"]  for c in candles]
    highs   = [c["high"]   for c in candles]
    lows    = [c["low"]    for c in candles]
    volumes = [c["volume"] for c in candles]
    n = len(candles) - 1
    p3 = max(0, n - 3)

    ema21 = _ema(closes, 21); ema55 = _ema(closes, 55); ema200 = _ema(closes, 200)
    rsi14 = _rsi(closes, 14); macd = _macd(closes)
    atr14 = _atr(highs, lows, closes, 14)
    vol_ma = _vol_ma(volumes, 20)
    adx = _adx(highs, lows, closes, 14)

    atr_window = [v for v in atr14[max(0, n-19):n+1] if v is not None]
    atr_ma20 = sum(atr_window)/len(atr_window) if len(atr_window) >= 5 else None
    adx_now  = adx[n]["adx"]  or None
    adx_prev = adx[p3]["adx"] or None
    adx_slope = (adx_now - adx_prev) if (adx_now and adx_prev) else None
    ema21_slope = (ema21[n] - ema21[p3]) if (ema21[n] and ema21[p3]) else None

    bar = candles[n]
    cr = bar["high"] - bar["low"]
    cbr = (bar["close"] - bar["low"]) / cr if cr > 0 else 0.5
    lb = min(20, n)
    vol_idx = max(0, n-1)
    return {
        "price": closes[n], "ema21": ema21[n], "ema55": ema55[n], "ema200": ema200[n],
        "rsi": rsi14[n], "macd_hist": macd[n]["hist"], "macd_prev_hist": macd[max(0,n-1)]["hist"],
        "macd_line": macd[n]["macd"], "macd_signal": macd[n]["signal"],
        "atr": atr14[n], "atr_ma20": atr_ma20, "adx_slope": adx_slope, "ema21_slope": ema21_slope,
        "candle_body_ratio": cbr, "volume": volumes[vol_idx], "volume_ma": vol_ma[vol_idx],
        "adx": adx[n]["adx"], "di_plus": adx[n]["di_plus"], "di_minus": adx[n]["di_minus"],
        "swing_high": max(c["high"] for c in candles[n-lb:n+1]),
        "swing_low":  min(c["low"]  for c in candles[n-lb:n+1]),
        "candle_time": candles[n]["time"],
    }


def generate_signal(candles: list[dict]) -> dict:
    if len(candles) < 201:
        return {"signal": "HOLD", "reason": [f"Need >= 201 bars, have {len(candles)}"],
                "buy_score": 0, "sell_score": 0, "indicators": {}}

    ind = compute_indicators(candles)
    price = ind["price"]; ema21 = ind["ema21"]; ema55 = ind["ema55"]; ema200 = ind["ema200"]
    rsi = ind["rsi"]; macd_hist = ind["macd_hist"]; atr = ind["atr"]; atr_ma20 = ind["atr_ma20"]
    adx_slope = ind["adx_slope"]; ema21_slope = ind["ema21_slope"]
    cbr = ind["candle_body_ratio"]; adx = ind["adx"]; dip = ind["di_plus"]; dim = ind["di_minus"]

    if any(v is None for v in [ema21, ema55, ema200, rsi, macd_hist, atr, adx]):
        return {"signal": "HOLD", "reason": ["Indicators not ready"], "buy_score": 0, "sell_score": 0, "indicators": ind}

    f = lambda v, d=2: f"{v:.{d}f}" if v is not None else "n/a"
    dis = abs(dip - dim)
    er = ema21_slope > 0 if ema21_slope is not None else False
    ef = ema21_slope < 0 if ema21_slope is not None else False

    bc = [
        (dip > dim,      f"DI+({f(dip,1)}) > DI-({f(dim,1)})"),
        (ema21 > ema55,  f"EMA21({f(ema21)}) > EMA55({f(ema55)})"),
        (ema55 > ema200, f"EMA55({f(ema55)}) > EMA200({f(ema200)})"),
        (er,             f"EMA21 slope rising ({f(ema21_slope,1)})"),
        (cfg.RSI_BUY_LOW <= rsi <= cfg.RSI_BUY_HIGH, f"RSI({f(rsi,1)}) in [{cfg.RSI_BUY_LOW}-{cfg.RSI_BUY_HIGH}]"),
        (macd_hist > 0,  f"MACD hist > 0 ({f(macd_hist,4)})"),
        (cbr >= 0.45,    f"Candle quality ({cbr*100:.0f}% upper)"),
    ]
    sc_ = [
        (dim > dip,      f"DI-({f(dim,1)}) > DI+({f(dip,1)})"),
        (ema21 < ema55,  "EMA21 < EMA55"),
        (ema55 < ema200, "EMA55 < EMA200"),
        (ef,             f"EMA21 slope falling ({f(ema21_slope,1)})"),
        (cfg.RSI_SELL_LOW <= rsi <= cfg.RSI_SELL_HIGH, f"RSI({f(rsi,1)}) in [{cfg.RSI_SELL_LOW}-{cfg.RSI_SELL_HIGH}]"),
        (macd_hist < 0,  f"MACD hist < 0 ({f(macd_hist,4)})"),
        (cbr <= 0.55,    f"Candle quality ({(1-cbr)*100:.0f}% lower)"),
    ]

    bs = sum(1 for ok, _ in bc if ok);   ss = sum(1 for ok, _ in sc_ if ok)
    bp = [l for ok, l in bc if ok];      sp = [l for ok, l in sc_ if ok]
    bf = [l for ok, l in bc if not ok];  sf = [l for ok, l in sc_ if not ok]

    if adx < cfg.ADX_MIN:
        return {"signal": "HOLD", "reason": [f"ADX({f(adx,1)}) < {cfg.ADX_MIN} - weak trend"], "buy_score": bs, "sell_score": ss, "indicators": ind}
    if dis < cfg.DI_SPREAD_MIN:
        return {"signal": "HOLD", "reason": [f"DI spread({f(dis,1)}) < {cfg.DI_SPREAD_MIN} - weak conviction"], "buy_score": bs, "sell_score": ss, "indicators": ind}
    if adx_slope is not None and adx_slope <= 0:
        return {"signal": "HOLD", "reason": [f"ADX slope ({f(adx_slope,2)}) <= 0 - trend fading"], "buy_score": bs, "sell_score": ss, "indicators": ind}
    if atr_ma20 is not None and atr > atr_ma20 * cfg.ATR_REGIME_MULT:
        return {"signal": "HOLD", "reason": [f"ATR spike: {f(atr,3)} > {cfg.ATR_REGIME_MULT}x ATR_MA({f(atr_ma20,3)})"], "buy_score": bs, "sell_score": ss, "indicators": ind}
    d21 = abs(price - ema21)
    if d21 > atr * cfg.PRICE_PROX_ATR:
        return {"signal": "HOLD", "reason": [f"|price-EMA21|({f(d21,3)}) > {cfg.PRICE_PROX_ATR}x ATR({f(atr*cfg.PRICE_PROX_ATR,3)})"], "buy_score": bs, "sell_score": ss, "indicators": ind}

    T = cfg.SIGNAL_THRESHOLD
    if bs >= T and bs > ss:
        return {"signal": "BUY",  "reason": bp, "buy_score": bs, "sell_score": ss, "indicators": ind}
    if ss >= T and ss > bs:
        return {"signal": "SELL", "reason": sp, "buy_score": bs, "sell_score": ss, "indicators": ind}

    hr = ([f"BUY score {bs}/7 - need {T} (missing: {', '.join(bf)})"] if bs > ss
          else [f"SELL score {ss}/7 - need {T} (missing: {', '.join(sf)})"])
    return {"signal": "HOLD", "reason": hr, "buy_score": bs, "sell_score": ss, "indicators": ind}


def check_exit(position: dict, candles: list[dict]) -> dict:
    ind = compute_indicators(candles)
    price = ind["price"]; atr = ind["atr"]; rsi = ind["rsi"]
    ema21 = ind["ema21"]; ema55 = ind["ema55"]
    side = position["side"]; entry = position["entry_price"]
    sl = position["stop_loss"]; tp = position["take_profit"]
    phase = position["phase"]; mae = position.get("mae", 0.0)
    held = position.get("candles_held", 0)
    last_t = position.get("last_candle_time")

    profit = (price - entry) if side == "long" else (entry - price)
    cur_t = ind["candle_time"]
    if cur_t != last_t: held += 1
    cur_mae = min(mae, profit)

    # Floor ATR so thin/flat-candle stocks can't shrink phase thresholds and
    # trail distance to near-zero (see ATR_MIN_PCT).
    if atr is not None:
        atr = max(atr, price * cfg.ATR_MIN_PCT)

    nph = phase; nsl = sl
    if atr is not None:
        if side == "long":
            if phase < 4 and profit >= atr * cfg.PHASE4_ATR_THRESH:
                nph = 4; nsl = price - atr * cfg.PHASE4_TRAIL_ATR
            elif phase < 3 and profit >= atr * cfg.PHASE3_ATR_THRESH:
                nph = 3; nsl = entry + atr * cfg.PHASE3_SL_ATR
            elif phase < 2 and profit >= atr * cfg.PHASE2_ATR_THRESH:
                nph = 2; nsl = entry + atr * cfg.PHASE2_BUFFER_ATR
            elif phase == 4:
                nsl = max(nsl, price - atr * cfg.PHASE4_TRAIL_ATR)
        else:
            if phase < 4 and profit >= atr * cfg.PHASE4_ATR_THRESH:
                nph = 4; nsl = price + atr * cfg.PHASE4_TRAIL_ATR
            elif phase < 3 and profit >= atr * cfg.PHASE3_ATR_THRESH:
                nph = 3; nsl = entry - atr * cfg.PHASE3_SL_ATR
            elif phase < 2 and profit >= atr * cfg.PHASE2_ATR_THRESH:
                nph = 2; nsl = entry - atr * cfg.PHASE2_BUFFER_ATR
            elif phase == 4:
                nsl = min(nsl, price + atr * cfg.PHASE4_TRAIL_ATR)

    position.update({"stop_loss": nsl, "phase": nph, "candles_held": held, "last_candle_time": cur_t, "mae": cur_mae})

    reasons = []
    if side == "long":
        if price <= nsl: reasons.append(f"SL hit (P{nph}): {price:.2f} <= {nsl:.2f}")
        if price >= tp:  reasons.append(f"TP hit: {price:.2f} >= {tp:.2f}")
        if rsi and rsi > cfg.RSI_OB_EXIT: reasons.append(f"RSI overbought ({rsi:.1f})")
        if ema21 and ema55 and ema21 < ema55 and profit > 0: reasons.append("EMA reversed (bearish)")
    else:
        if price >= nsl: reasons.append(f"SL hit (P{nph}): {price:.2f} >= {nsl:.2f}")
        if price <= tp:  reasons.append(f"TP hit: {price:.2f} <= {tp:.2f}")
        if rsi and rsi < cfg.RSI_OS_EXIT: reasons.append(f"RSI oversold ({rsi:.1f})")
        if ema21 and ema55 and ema21 > ema55 and profit > 0: reasons.append("EMA reversed (bullish)")
    if held >= cfg.TIME_STOP_BARS: reasons.append(f"Time stop: {held} bars")

    return {"exit": len(reasons) > 0, "reasons": reasons, "new_stop": nsl, "new_phase": nph, "indicators": ind}


def compute_stop_dist(atr: float, price: float) -> float:
    return max(cfg.STOP_ATR_MULT * atr, price * cfg.STOP_MIN_PCT)


def compute_position_size(balance: float, stop_dist: float, price: float) -> int:
    if stop_dist <= 0 or price <= 0:
        return 0
    risk_inr      = balance * cfg.RISK_PER_TRADE_PCT
    qty_by_risk   = int(risk_inr / stop_dist)
    qty_by_cap    = int(cfg.CAPITAL_CAP_INR / price)
    return max(0, min(qty_by_risk, qty_by_cap))
