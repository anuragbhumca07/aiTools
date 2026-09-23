import config
from dhanhq import DhanContext, dhanhq as DhanHQ
ctx = DhanContext(config.DHAN_CLIENT_ID, config.DHAN_ACCESS_TOKEN)
dhan = DhanHQ(ctx)
for d in ["2026-09-18", "2026-09-21"]:
    r = dhan.intraday_minute_data(
        security_id="1333", exchange_segment="NSE_EQ",
        instrument_type="EQUITY", from_date=d, to_date=d, interval=5
    )
    data = r.get("data", {})
    ts = data.get("timestamp", data.get("startTime", [])) if isinstance(data, dict) else []
    closes = data.get("close", []) if isinstance(data, dict) else []
    last = closes[-1] if closes else "N/A"
    print(d, "| rows:", len(ts), "| last_close:", last, "| remarks:", r.get("remarks") or "")
