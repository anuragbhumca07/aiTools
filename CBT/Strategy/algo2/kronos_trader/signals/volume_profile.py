"""Volume Profile — POC, VAH, VAL, HVN/LVN."""
import pandas as pd
import numpy as np
from typing import List


class VolumeProfileSignal:
    def __init__(self, config: dict):
        self.lookback = config.get('lookback_candles', 200)
        self.value_area_pct = config.get('value_area_pct', 0.70)
        self.n_bins = 200

    def calculate(self, df: pd.DataFrame) -> dict:
        df = df.tail(self.lookback).copy()
        price_min = float(df['low'].min())
        price_max = float(df['high'].max())
        if price_max <= price_min:
            return self._empty(float(df['close'].iloc[-1]))

        bins = np.linspace(price_min, price_max, self.n_bins + 1)
        bin_centers = (bins[:-1] + bins[1:]) / 2
        vol_hist = np.zeros(self.n_bins)

        for _, row in df.iterrows():
            # Distribute candle volume uniformly across high-low range
            lo, hi, vol = row['low'], row['high'], row['volume']
            if hi == lo:
                idx = np.searchsorted(bins, lo, side='right') - 1
                idx = max(0, min(idx, self.n_bins - 1))
                vol_hist[idx] += vol
            else:
                lo_i = np.searchsorted(bins, lo, side='left')
                hi_i = np.searchsorted(bins, hi, side='right')
                lo_i = max(0, lo_i - 1)
                hi_i = min(self.n_bins, hi_i)
                count = hi_i - lo_i
                if count > 0:
                    vol_hist[lo_i:hi_i] += vol / count

        poc_idx = int(np.argmax(vol_hist))
        poc = float(bin_centers[poc_idx])

        # Value Area: expand from POC until 70% of volume captured
        total_vol = vol_hist.sum()
        target = total_vol * self.value_area_pct
        lo_i = hi_i = poc_idx
        captured = vol_hist[poc_idx]
        while captured < target and (lo_i > 0 or hi_i < self.n_bins - 1):
            lo_add = vol_hist[lo_i - 1] if lo_i > 0 else 0
            hi_add = vol_hist[hi_i + 1] if hi_i < self.n_bins - 1 else 0
            if lo_add >= hi_add and lo_i > 0:
                lo_i -= 1
                captured += lo_add
            elif hi_i < self.n_bins - 1:
                hi_i += 1
                captured += hi_add
            else:
                lo_i -= 1
                captured += lo_add

        vah = float(bin_centers[hi_i])
        val = float(bin_centers[lo_i])

        mean_vol = vol_hist.mean()
        hvn: List[float] = [float(bin_centers[i]) for i in range(self.n_bins) if vol_hist[i] > 1.5 * mean_vol]
        lvn: List[float] = [float(bin_centers[i]) for i in range(self.n_bins) if vol_hist[i] < 0.5 * mean_vol]

        price = float(df['close'].iloc[-1])
        if price > vah:
            zone = 'above_vah'
            score = 0.15
        elif price < val:
            zone = 'below_val'
            score = -0.15
        else:
            score = 0.05 if price > poc else -0.05
            zone = 'value_area'

        # Nearest support/resistance
        supports = sorted([p for p in hvn if p < price], reverse=True)
        resistances = sorted([p for p in hvn if p > price])

        return {
            'poc': round(poc, 2),
            'vah': round(vah, 2),
            'val': round(val, 2),
            'hvn': [round(p, 2) for p in hvn[:10]],
            'lvn': [round(p, 2) for p in lvn[:10]],
            'current_zone': zone,
            'nearest_support': round(supports[0], 2) if supports else round(val, 2),
            'nearest_resistance': round(resistances[0], 2) if resistances else round(vah, 2),
            'score': round(score, 4),
        }

    def _empty(self, price: float) -> dict:
        return {
            'poc': price, 'vah': price, 'val': price,
            'hvn': [], 'lvn': [], 'current_zone': 'value_area',
            'nearest_support': price, 'nearest_resistance': price, 'score': 0.0
        }
