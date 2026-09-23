"""Quick smoke test for strategy_core indicator pipeline."""
import sys, random, time
sys.path.insert(0, ".")

from strategy_core import compute_indicators, generate_signal, compute_stop_dist, compute_position_size

random.seed(42)
price = 100.0
candles = []
for i in range(250):
    o = price
    h = o + random.uniform(0, 2)
    l = o - random.uniform(0, 2)
    c = random.uniform(l, h)
    v = random.uniform(100_000, 500_000)
    candles.append({"time": int(time.time()*1000) + i*300_000,
                    "open": o, "high": h, "low": l, "close": c, "volume": v})
    price = c

ind = compute_indicators(candles)
keys = ["price", "ema21", "ema55", "ema200", "rsi", "atr", "atr_ma20", "adx", "di_plus", "di_minus", "adx_slope", "ema21_slope"]
for k in keys:
    v = ind.get(k)
    print(f"  {k:20s} = {round(v, 4) if isinstance(v, float) else v}")

sig = generate_signal(candles)
print()
print(f"  Signal: {sig['signal']}  buy={sig['buy_score']}  sell={sig['sell_score']}")
print(f"  Reason: {sig['reason'][0] if sig['reason'] else '--'}")

atr  = ind["atr"]
p    = ind["price"]
stop = compute_stop_dist(atr, p)
qty  = compute_position_size(10_000, stop, p)
print()
print(f"  stop_dist = {stop:.4f}")
print(f"  qty       = {qty}  (capital = ${p * qty:.2f} / $500 cap)")
print()
print("strategy_core smoke test PASSED")
