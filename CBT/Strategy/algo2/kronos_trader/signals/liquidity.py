"""Liquidity level detection — equal highs/lows and sweep events."""
import pandas as pd
import numpy as np
from typing import List, Optional


class LiquiditySignal:
    def __init__(self, config: dict):
        self.swing_lookback = config.get('swing_lookback', 20)
        self.sweep_threshold_pct = config.get('sweep_threshold_pct', 0.05) / 100

    def detect(self, df: pd.DataFrame) -> dict:
        n = len(df)
        if n < self.swing_lookback * 2:
            return {
                'buy_side_liquidity': [], 'sell_side_liquidity': [],
                'recent_sweep': None, 'sweep_candles_ago': None, 'score': 0.0
            }

        lb = self.swing_lookback
        swing_highs: List[float] = []
        swing_lows: List[float] = []

        for i in range(lb, n - lb):
            high = df['high'].iloc[i]
            low = df['low'].iloc[i]
            if high == df['high'].iloc[i - lb: i + lb + 1].max():
                swing_highs.append(high)
            if low == df['low'].iloc[i - lb: i + lb + 1].min():
                swing_lows.append(low)

        # Equal highs (BSL) = within sweep_threshold_pct of each other
        bsl = self._find_equal_levels(swing_highs)
        ssl = self._find_equal_levels(swing_lows)

        # Detect recent sweeps in the last 10 candles
        recent = df.tail(10)
        recent_sweep = None
        sweep_candles_ago = None

        for i, (_, candle) in enumerate(recent.iterrows()):
            for level in bsl:
                # BSL sweep: wick above level but close below
                if candle['high'] > level * (1 + self.sweep_threshold_pct) and candle['close'] < level:
                    recent_sweep = 'BSL_swept'
                    sweep_candles_ago = 9 - i
                    break
            if recent_sweep:
                break
            for level in ssl:
                # SSL sweep: wick below level but close above
                if candle['low'] < level * (1 - self.sweep_threshold_pct) and candle['close'] > level:
                    recent_sweep = 'SSL_swept'
                    sweep_candles_ago = 9 - i
                    break
            if recent_sweep:
                break

        # Score: recent sweep is high conviction entry
        score = 0.0
        if recent_sweep == 'SSL_swept' and sweep_candles_ago is not None and sweep_candles_ago <= 5:
            # SSL sweep = smart money grabbed sell-side, likely bullish reversal
            score = 0.25 * (1 - sweep_candles_ago / 10)
        elif recent_sweep == 'BSL_swept' and sweep_candles_ago is not None and sweep_candles_ago <= 5:
            score = -0.25 * (1 - sweep_candles_ago / 10)

        return {
            'buy_side_liquidity': [round(p, 2) for p in sorted(bsl)[-5:]],
            'sell_side_liquidity': [round(p, 2) for p in sorted(ssl)[:5]],
            'recent_sweep': recent_sweep,
            'sweep_candles_ago': sweep_candles_ago,
            'score': round(score, 4),
        }

    def _find_equal_levels(self, levels: List[float]) -> List[float]:
        if not levels:
            return []
        equal = []
        visited = [False] * len(levels)
        for i in range(len(levels)):
            if visited[i]:
                continue
            for j in range(i + 1, len(levels)):
                if abs(levels[i] - levels[j]) / (levels[i] + 1e-9) < self.sweep_threshold_pct:
                    equal.append((levels[i] + levels[j]) / 2)
                    visited[j] = True
                    break
        return equal
