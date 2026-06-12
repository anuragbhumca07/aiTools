"""Composite signal aggregator — combines VWAP, VP, OB, Liquidity into a single score."""
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class CompositeSignal:
    direction: str        # 'long' | 'short' | 'neutral'
    score: float          # 0.0–1.0 conviction
    raw_score: float      # -1.0–1.0 directional
    components: dict
    reasons: List[str]


DEFAULT_WEIGHTS = {
    'vwap': 0.25,
    'volume_profile': 0.20,
    'order_blocks': 0.30,
    'liquidity': 0.25,
}


class SignalAggregator:
    def __init__(self, weights: Optional[dict] = None):
        self.weights = weights or DEFAULT_WEIGHTS

    def aggregate(
        self,
        vwap: dict,
        volume_profile: dict,
        order_blocks: dict,
        liquidity: dict,
        current_price: float,
        kronos_boost: float = 0.0,  # -0.2 to +0.2 from Kronos
    ) -> CompositeSignal:

        scores = {
            'vwap': vwap.get('score', 0.0),
            'volume_profile': volume_profile.get('score', 0.0),
            'order_blocks': order_blocks.get('score', 0.0),
            'liquidity': liquidity.get('score', 0.0),
        }

        # Weighted sum (each already -0.25 to +0.25 range)
        raw = sum(scores[k] * (self.weights[k] / 0.25) for k in scores) + kronos_boost
        raw = max(-1.0, min(1.0, raw))

        # Normalise to 0-1 conviction
        conviction = abs(raw)

        if raw >= 0.15:
            direction = 'long'
        elif raw <= -0.15:
            direction = 'short'
        else:
            direction = 'neutral'

        reasons = self._build_reasons(vwap, volume_profile, order_blocks, liquidity)

        return CompositeSignal(
            direction=direction,
            score=round(conviction, 4),
            raw_score=round(raw, 4),
            components={k: round(v, 4) for k, v in scores.items()},
            reasons=reasons,
        )

    def _build_reasons(self, vwap, vp, ob, liq) -> List[str]:
        reasons = []
        pos = vwap.get('position', '')
        if pos == 'above_vwap':
            reasons.append('Price above VWAP (bullish bias)')
        elif pos == 'below_vwap':
            reasons.append('Price below VWAP (bearish bias)')

        zone = vp.get('current_zone', '')
        if zone == 'above_vah':
            reasons.append('Price above Value Area High (breakout zone)')
        elif zone == 'below_val':
            reasons.append('Price below Value Area Low (breakdown zone)')
        else:
            reasons.append(f"Price in Value Area (POC: {vp.get('poc', 0):.0f})")

        if ob.get('nearest_bullish'):
            reasons.append(f"Fresh bullish OB at {ob['nearest_bullish']['bottom']:.0f}–{ob['nearest_bullish']['top']:.0f}")
        if ob.get('nearest_bearish'):
            reasons.append(f"Fresh bearish OB at {ob['nearest_bearish']['bottom']:.0f}–{ob['nearest_bearish']['top']:.0f}")

        sweep = liq.get('recent_sweep')
        if sweep == 'SSL_swept':
            reasons.append(f"SSL swept {liq.get('sweep_candles_ago', '?')} candle(s) ago → bullish reversal signal")
        elif sweep == 'BSL_swept':
            reasons.append(f"BSL swept {liq.get('sweep_candles_ago', '?')} candle(s) ago → bearish reversal signal")

        return reasons
