"""Kraken public REST client — no auth required for OHLCV data."""
import requests
import pandas as pd
import time

KRAKEN_BASE = "https://api.kraken.com/0/public"

INTERVAL_MAP = {
    '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
    '1h': 60, '4h': 240, '1d': 1440, '1w': 10080
}


def _normalize_pair(symbol: str) -> str:
    s = symbol.upper().replace('BTC', 'XBT').replace('USDT', 'USD')
    return s


def get_ohlcv(symbol: str, timeframe: str = '1h', since: int = None, limit: int = 720) -> pd.DataFrame:
    pair = _normalize_pair(symbol)
    interval = INTERVAL_MAP.get(timeframe, 60)

    params = {'pair': pair, 'interval': interval}
    if since:
        params['since'] = since

    for attempt in range(3):
        try:
            resp = requests.get(f"{KRAKEN_BASE}/OHLC", params=params, timeout=15)
            resp.raise_for_status()
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)

    data = resp.json()
    if data.get('error'):
        raise ValueError(f"Kraken error: {data['error']}")

    result = data['result']
    pair_key = next(k for k in result if k != 'last')
    candles = result[pair_key]

    df = pd.DataFrame(candles, columns=[
        'timestamp', 'open', 'high', 'low', 'close', 'vwap', 'volume', 'count'
    ])
    df['timestamp'] = pd.to_datetime(df['timestamp'].astype(int), unit='s', utc=True)
    for col in ['open', 'high', 'low', 'close', 'vwap', 'volume']:
        df[col] = df[col].astype(float)

    df['amount'] = df['close'] * df['volume']
    df = df.sort_values('timestamp').reset_index(drop=True)

    if len(df) > limit:
        df = df.tail(limit).reset_index(drop=True)

    return df[['timestamp', 'open', 'high', 'low', 'close', 'volume', 'amount']]


def get_ticker(symbol: str) -> dict:
    pair = _normalize_pair(symbol)
    resp = requests.get(f"{KRAKEN_BASE}/Ticker", params={'pair': pair}, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    if data.get('error'):
        raise ValueError(f"Kraken error: {data['error']}")
    t = list(data['result'].values())[0]
    bid, ask, last = float(t['b'][0]), float(t['a'][0]), float(t['c'][0])
    return {
        'bid': bid,
        'ask': ask,
        'last': last,
        'spread_pct': (ask - bid) / last * 100 if last else 0
    }
