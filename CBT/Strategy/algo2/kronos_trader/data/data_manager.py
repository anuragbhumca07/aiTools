"""Unified data interface — fetches historical OHLCV from Kraken."""
import pandas as pd
import numpy as np
from datetime import datetime, timedelta, timezone
from .kraken_rest import get_ohlcv, get_ticker


class DataManager:
    def __init__(self, symbol: str = 'XBTUSD', timeframe: str = '1h'):
        self.symbol = symbol
        self.timeframe = timeframe
        self._cache: pd.DataFrame | None = None
        self._cache_time: datetime | None = None
        self._cache_ttl = 60  # seconds

    def get_candles(self, n: int = 500, force_refresh: bool = False) -> pd.DataFrame:
        now = datetime.now(timezone.utc)
        stale = (
            self._cache is None
            or self._cache_time is None
            or (now - self._cache_time).total_seconds() > self._cache_ttl
        )
        if stale or force_refresh:
            df = get_ohlcv(self.symbol, self.timeframe, limit=720)
            self._cache = df
            self._cache_time = now

        df = self._cache
        if len(df) > n:
            df = df.tail(n).reset_index(drop=True)
        return df.copy()

    def get_ticker(self) -> dict:
        return get_ticker(self.symbol)

    @staticmethod
    def compute_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
        high, low, close = df['high'], df['low'], df['close']
        prev_close = close.shift(1)
        tr = pd.concat([
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs()
        ], axis=1).max(axis=1)
        return tr.ewm(span=period, adjust=False).mean()
