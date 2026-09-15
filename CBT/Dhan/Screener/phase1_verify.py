"""
Phase 1 deliverable — verify universe size and sample features.

Usage:
    python phase1_verify.py                  # run with cached data
    python phase1_verify.py --inspect        # print master CSV columns then exit
    python phase1_verify.py --refresh        # re-download master + OHLCV
    python phase1_verify.py --cache-stats    # show what's already cached
"""
from __future__ import annotations
import argparse
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

import config
from universe import fetch_instrument_master, build_universe, inspect_master
from data_cache import bootstrap_cache, load_ohlcv, get_cache_stats
from features import compute_features


def main():
    parser = argparse.ArgumentParser(description="Phase 1: verify universe + features")
    parser.add_argument("--inspect",     action="store_true",
                        help="Print instrument master columns and exit")
    parser.add_argument("--refresh",     action="store_true",
                        help="Re-download instrument master and all OHLCV data")
    parser.add_argument("--cache-stats", action="store_true",
                        help="Show cache coverage stats then exit")
    args = parser.parse_args()

    SEP = "=" * 60
    print("\n" + SEP)
    print("  NSE Opening-Range Scanner -- Phase 1 Verification")
    print(SEP)

    # Step 1: Instrument master
    print("\n[1/4] Fetching instrument master ...")
    master = fetch_instrument_master(force_refresh=args.refresh)
    print(f"      Instrument master: {len(master):,} rows, {len(master.columns)} columns")

    if args.inspect:
        inspect_master(master)
        print("\n→ Check the column names above, then verify the filters in universe.py.")
        sys.exit(0)

    # ── Step 2: Build universe ────────────────────────────────────────────────
    print("\n[2/4] Filtering universe …")
    universe = build_universe(master)
    print(f"      Eligible stocks (pre-price filter): {len(universe):,}")

    if universe.empty:
        print("\n  [!] Universe is empty.")
        print("  -> Run with --inspect to see actual column names, then fix universe.py.")
        print("  -> Also check VERIFY markers in universe.py for segment/series filter values.")
        sys.exit(1)

    print(f"\n  Sample (first 10 stocks):")
    print("  " + universe.head(10).to_string(index=False).replace("\n", "\n  "))

    if args.cache_stats:
        stats = get_cache_stats(universe)
        print(f"\n  Cache stats:")
        print(f"    Cached : {stats['cached']:,} / {stats['total']:,}")
        print(f"    Missing: {stats['missing']:,}")
        if stats["sample_cached"]:
            print(f"    Sample cached stocks: {[s['security_id'] for s in stats['sample_cached']]}")
        sys.exit(0)

    # ── Step 3: Bootstrap OHLCV ───────────────────────────────────────────────
    print(f"\n[3/4] Bootstrapping OHLCV cache "
          f"(MAX_INSTRUMENTS={config.MAX_INSTRUMENTS}, "
          f"history={config.HISTORY_DAYS_CAL} calendar days) ...")
    print("      Already-cached stocks will be skipped. First run may take several minutes.")

    results = bootstrap_cache(universe, force_refresh=args.refresh)
    ok   = sum(1 for v in results.values() if v > 0)
    fail = sum(1 for v in results.values() if v == 0)
    print(f"      Result: {ok} stocks cached, {fail} failed / no data")

    if ok == 0:
        print("\n  [!] No data downloaded. Check:")
        print("     1. DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN in .env")
        print("     2. VERIFY markers in data_cache.py (method name, param names, response shape)")
        print("     3. Run: python -c \"from dhanhq import DhanHQ; help(DhanHQ)\"")
        sys.exit(1)

    # ── Step 4: Features for 5 stocks ─────────────────────────────────────────
    print(f"\n[4/4] Computing features for 5 sample stocks …")

    sample_ids = universe["security_id"].tolist()[:5]
    any_ok = False

    for rank, sid in enumerate(sample_ids):
        sym_rows = universe.loc[universe["security_id"] == sid, "symbol"]
        sym = sym_rows.values[0] if len(sym_rows) else sid

        df = load_ohlcv(sid)
        if df is None or df.empty:
            print(f"\n  {sym} ({sid}): NO DATA — check data_cache.py VERIFY markers")
            continue

        df_feat = compute_features(df)
        last = df_feat.iloc[-1]
        any_ok = True

        print(f"\n  [{rank+1}] {sym} ({sid}) -- {len(df)} trading days cached")
        print(f"      Date        : {last.get('date', 'N/A')}")
        print(f"      Close       : {_fmt(last.get('close'))}")
        print(f"      Prev Close  : {_fmt(last.get('prev_close'))}")
        print(f"      Prev High   : {_fmt(last.get('prev_high'))}")
        print(f"      Prev Low    : {_fmt(last.get('prev_low'))}")
        print(f"      High 20d    : {_fmt(last.get('high_20d'))}")
        print(f"      Low  20d    : {_fmt(last.get('low_20d'))}")
        print(f"      High 52w    : {_fmt(last.get('high_52w'))}")
        print(f"      Low  52w    : {_fmt(last.get('low_52w'))}")
        print(f"      Vol 20d avg : {_fmt_vol(last.get('vol_20d_avg'))}")
        print(f"      Vol rel     : {_fmt_x(last.get('vol_rel'))}")
        print(f"      EMA9        : {_fmt(last.get('ema9'))}")
        print(f"      EMA20       : {_fmt(last.get('ema20'))}")
        print(f"      EMA9 > 20   : {last.get('ema9', 0) > last.get('ema20', 0)}")
        print(f"      ATR14       : {_fmt(last.get('atr14'))}")
        print(f"      Gap %       : {_fmt_pct(last.get('gap_pct'))}")

    print("\n" + SEP)
    if any_ok:
        print("  Phase 1 OK -- data layer verified.")
        print("  Next: review the numbers above, then proceed to Phase 2.")
        print("  If values look wrong, check VERIFY markers in universe.py + data_cache.py.")
    else:
        print("  Phase 1 FAIL -- no feature data generated. Review errors above.")
    print(SEP + "\n")


def _fmt(v) -> str:
    if v is None or (isinstance(v, float) and v != v):
        return "N/A"
    return f"{float(v):,.2f}"


def _fmt_pct(v) -> str:
    if v is None or (isinstance(v, float) and v != v):
        return "N/A"
    return f"{float(v):+.2f}%"


def _fmt_vol(v) -> str:
    if v is None or (isinstance(v, float) and v != v):
        return "N/A"
    return f"{float(v):,.0f}"


def _fmt_x(v) -> str:
    if v is None or (isinstance(v, float) and v != v):
        return "N/A"
    return f"{float(v):.2f}x"


if __name__ == "__main__":
    main()
