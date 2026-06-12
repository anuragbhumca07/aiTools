"""Anchored VWAP with ±1σ and ±2σ bands."""
import pandas as pd
import numpy as np


class VWAPSignal:
    def __init__(self, config: dict):
        self.anchor = config.get('anchor', 'session')
        self.band_mults = config.get('bands', [1.0, 2.0])

    def calculate(self, df: pd.DataFrame) -> dict:
        df = df.copy()
        df['tp'] = (df['high'] + df['low'] + df['close']) / 3.0
        df['tp_vol'] = df['tp'] * df['volume']

        if self.anchor == 'session':
            df['date'] = df['timestamp'].dt.date
            df['cum_vol'] = df.groupby('date')['volume'].cumsum()
            df['cum_tpvol'] = df.groupby('date')['tp_vol'].cumsum()
        else:
            df['cum_vol'] = df['volume'].cumsum()
            df['cum_tpvol'] = df['tp_vol'].cumsum()

        df['vwap'] = df['cum_tpvol'] / df['cum_vol'].replace(0, np.nan)
        df['dev'] = df['tp'] - df['vwap']

        if self.anchor == 'session':
            df['std'] = df.groupby('date')['dev'].transform(
                lambda x: x.expanding().std().fillna(0)
            )
        else:
            df['std'] = df['dev'].expanding().std().fillna(0)

        vwap = float(df['vwap'].iloc[-1])
        std = float(df['std'].iloc[-1])
        price = float(df['close'].iloc[-1])

        bands = {}
        for m in self.band_mults:
            bands[f'upper_{m}'] = round(vwap + m * std, 2)
            bands[f'lower_{m}'] = round(vwap - m * std, 2)

        if price > vwap:
            position = 'above_vwap'
            # Extra bullish if near lower band (bouncing)
            lower1 = bands.get('lower_1.0', vwap - std)
            proximity = max(0, 1 - (price - lower1) / (vwap - lower1 + 1e-9))
            score = 0.15 + 0.10 * proximity
        else:
            position = 'below_vwap'
            upper1 = bands.get('upper_1.0', vwap + std)
            proximity = max(0, 1 - (upper1 - price) / (upper1 - vwap + 1e-9))
            score = -(0.15 + 0.10 * proximity)

        return {
            'vwap': round(vwap, 2),
            'std': round(std, 2),
            'position': position,
            'bands': bands,
            'score': round(score, 4),
            'price': price,
        }
