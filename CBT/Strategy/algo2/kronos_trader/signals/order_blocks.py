"""Order Block detection — bullish and bearish OBs with freshness filter."""
import pandas as pd
import numpy as np
from dataclasses import dataclass, field
from datetime import datetime
from typing import List


@dataclass
class OrderBlock:
    type: str          # 'bullish' | 'bearish'
    top: float
    bottom: float
    timestamp: datetime
    is_fresh: bool
    strength: float    # 0-1, based on displacement size
    candle_idx: int


class OrderBlockSignal:
    def __init__(self, config: dict):
        self.min_body_pct = config.get('min_body_pct', 0.60)
        self.freshness_candles = config.get('freshness_candles', 50)
        self.min_displacement_pct = config.get('min_displacement_pct', 0.30)

    def detect_blocks(self, df: pd.DataFrame) -> List[OrderBlock]:
        blocks: List[OrderBlock] = []
        n = len(df)
        if n < 5:
            return blocks

        for i in range(2, n - 2):
            candle = df.iloc[i]
            body = abs(candle['close'] - candle['open'])
            rng = candle['high'] - candle['low']
            if rng == 0:
                continue
            body_pct = body / rng

            # Measure displacement: max move in next 3 candles
            future = df.iloc[i + 1: min(i + 4, n)]
            if len(future) == 0:
                continue

            # Bullish OB: down-candle followed by strong up-displacement
            if candle['close'] < candle['open']:
                up_move = (future['high'].max() - candle['high']) / candle['high']
                if up_move >= self.min_displacement_pct / 100:
                    fresh = self._check_freshness(df, i, 'bullish', n)
                    blocks.append(OrderBlock(
                        type='bullish',
                        top=float(candle['high']),
                        bottom=float(candle['low']),
                        timestamp=candle['timestamp'],
                        is_fresh=fresh,
                        strength=min(1.0, up_move * 100 / self.min_displacement_pct),
                        candle_idx=i
                    ))

            # Bearish OB: up-candle followed by strong down-displacement
            elif candle['close'] > candle['open']:
                down_move = (candle['low'] - future['low'].min()) / candle['low']
                if down_move >= self.min_displacement_pct / 100:
                    fresh = self._check_freshness(df, i, 'bearish', n)
                    blocks.append(OrderBlock(
                        type='bearish',
                        top=float(candle['high']),
                        bottom=float(candle['low']),
                        timestamp=candle['timestamp'],
                        is_fresh=fresh,
                        strength=min(1.0, down_move * 100 / self.min_displacement_pct),
                        candle_idx=i
                    ))

        return blocks

    def _check_freshness(self, df: pd.DataFrame, ob_idx: int, ob_type: str, n: int) -> bool:
        start = ob_idx + 1
        end = min(n, ob_idx + self.freshness_candles + 1)
        ob_candle = df.iloc[ob_idx]

        for j in range(start, end):
            c = df.iloc[j]
            if ob_type == 'bullish' and c['close'] < ob_candle['low']:
                return False
            elif ob_type == 'bearish' and c['close'] > ob_candle['high']:
                return False
        return True

    def get_signal(self, df: pd.DataFrame) -> dict:
        blocks = self.detect_blocks(df)
        price = float(df['close'].iloc[-1])
        fresh_bullish = [b for b in blocks if b.type == 'bullish' and b.is_fresh]
        fresh_bearish = [b for b in blocks if b.type == 'bearish' and b.is_fresh]

        score = 0.0
        nearest_bullish = None
        nearest_bearish = None

        if fresh_bullish:
            # Score: price inside or near a bullish OB
            for ob in sorted(fresh_bullish, key=lambda x: abs(price - (x.top + x.bottom) / 2)):
                if ob.bottom <= price <= ob.top * 1.005:
                    score += 0.30 * ob.strength
                    nearest_bullish = {'top': ob.top, 'bottom': ob.bottom, 'strength': ob.strength}
                    break
            if nearest_bullish is None:
                nearest_bullish = {'top': fresh_bullish[-1].top, 'bottom': fresh_bullish[-1].bottom,
                                   'strength': fresh_bullish[-1].strength}

        if fresh_bearish:
            for ob in sorted(fresh_bearish, key=lambda x: abs(price - (x.top + x.bottom) / 2)):
                if ob.bottom * 0.995 <= price <= ob.top:
                    score -= 0.30 * ob.strength
                    nearest_bearish = {'top': ob.top, 'bottom': ob.bottom, 'strength': ob.strength}
                    break
            if nearest_bearish is None:
                nearest_bearish = {'top': fresh_bearish[-1].top, 'bottom': fresh_bearish[-1].bottom,
                                   'strength': fresh_bearish[-1].strength}

        return {
            'total_blocks': len(blocks),
            'fresh_bullish': len(fresh_bullish),
            'fresh_bearish': len(fresh_bearish),
            'nearest_bullish': nearest_bullish,
            'nearest_bearish': nearest_bearish,
            'score': round(max(-0.30, min(0.30, score)), 4),
        }
