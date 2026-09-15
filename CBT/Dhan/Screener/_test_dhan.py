"""Test Dhan API with new subscription. Run: python _test_dhan.py"""
import os, json
from dotenv import load_dotenv
load_dotenv()

from dhanhq import DhanContext, dhanhq

ctx  = DhanContext(os.getenv("DHAN_CLIENT_ID"), os.getenv("DHAN_ACCESS_TOKEN"))
dhan = dhanhq(ctx)

print("=== Test 1: Daily OHLCV for RELIANCE (security_id=1333) ===")
resp = dhan.historical_daily_data(
    security_id="1333",
    exchange_segment=dhanhq.NSE,
    instrument_type="EQUITY",
    from_date="2026-08-01",
    to_date="2026-09-10",
    expiry_code=0,
)
status = resp.get("status")
data   = resp.get("data")
print(f"Status : {status}")
print(f"Remarks: {resp.get('remarks')}")
if status == "success" and data:
    print(f"Data type: {type(data)}")
    if isinstance(data, dict):
        print(f"Keys: {list(data.keys())}")
        for k, v in data.items():
            sample = v[:3] if isinstance(v, list) else v
            print(f"  {k}: {sample}")
    elif isinstance(data, list):
        print(f"Rows: {len(data)}, sample: {data[:2]}")
    print("DHAN HISTORICAL DATA: OK")
else:
    print("DHAN HISTORICAL DATA: FAILED")

print()
print("=== Test 2: Intraday 5-min for RELIANCE ===")
resp2 = dhan.intraday_minute_data(
    security_id="1333",
    exchange_segment=dhanhq.NSE,
    instrument_type="EQUITY",
    from_date="2026-09-12",
    to_date="2026-09-12",
    interval=5,
)
status2 = resp2.get("status")
data2   = resp2.get("data")
print(f"Status : {status2}")
if status2 == "success" and data2:
    if isinstance(data2, dict):
        print(f"Keys: {list(data2.keys())}")
        for k,v in data2.items():
            print(f"  {k}: {(v[:3] if isinstance(v,list) else v)}")
    print("INTRADAY DATA: OK")
else:
    print(f"INTRADAY DATA: FAILED — {resp2.get('remarks')}")

print()
print("=== Test 3: Market quote (live LTP) ===")
try:
    resp3 = dhan.market_quote({"NSE_EQ": [1333]})
    print(f"Status: {resp3.get('status')}")
    data3 = resp3.get("data", {})
    print(f"Quote data type: {type(data3)}")
    if data3:
        print(f"Sample: {json.dumps(data3, default=str)[:400]}")
    print("LIVE QUOTE: OK")
except AttributeError:
    # Try alternative method name
    try:
        resp3 = dhan.get_market_quote(["1333"], "NSE_EQ")
        print("get_market_quote:", resp3)
    except Exception as e:
        print(f"Quote method not found: {e}")
except Exception as e:
    print(f"Quote error: {e}")
