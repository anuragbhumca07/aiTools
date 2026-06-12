"""Entry gate — Kronos + composite signal gating."""
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class EntryDecision:
    action: str          # 'enter_long' | 'enter_short' | 'wait'
    confidence: float    # 0–1
    suggested_sl: float
    suggested_tp: float
    reasons: List[str]


class EntryFilter:
    def __init__(self, config: dict, sl_manager, risk_guard=None):
        self.cfg = config
        self.sl_manager = sl_manager
        self.risk_guard = risk_guard

    def should_enter(
        self,
        kronos: Optional[dict],
        composite,
        current_price: float,
        atr: float,
        ticker: Optional[dict] = None,
    ) -> EntryDecision:
        wait = EntryDecision('wait', 0.0, 0.0, 0.0, [])

        # Risk guard
        if self.risk_guard and not self.risk_guard.check_max_positions(0):
            wait.reasons.append('Max positions reached')
            return wait

        min_score = self.cfg.get('min_composite_score', 0.50)
        rr_min = self.cfg.get('reward_ratio_min', 1.5)
        spread_max = self.cfg.get('max_spread_pct', 0.10)

        # Spread check
        if ticker and ticker.get('spread_pct', 0) > spread_max:
            wait.reasons.append(f"Spread {ticker['spread_pct']:.3f}% > max {spread_max}%")
            return wait

        direction = composite.direction
        score = composite.score

        if direction == 'neutral' or score < min_score:
            wait.reasons.append(f"Score {score:.2f} below threshold {min_score}")
            return wait

        # Kronos gate (optional — skipped if model disabled)
        if kronos and self.cfg.get('require_kronos_confirmation', False):
            if direction == 'long' and kronos.get('bullish_prob', 0.5) < self.cfg.get('bullish_threshold', 0.62):
                wait.reasons.append(f"Kronos bullish_prob {kronos['bullish_prob']:.2f} below threshold")
                return wait
            elif direction == 'short' and kronos.get('bearish_prob', 0.5) < self.cfg.get('bearish_threshold', 0.38):
                wait.reasons.append(f"Kronos bearish_prob {kronos['bearish_prob']:.2f} below threshold")
                return wait

        # Compute SL and TP
        if direction == 'long':
            sl = self.sl_manager.initial_sl(current_price, 'long', atr)
            sl_dist = current_price - sl
            tp = current_price + sl_dist * rr_min
            action = 'enter_long'
        else:
            sl = self.sl_manager.initial_sl(current_price, 'short', atr)
            sl_dist = sl - current_price
            tp = current_price - sl_dist * rr_min
            action = 'enter_short'

        if sl_dist <= 0:
            wait.reasons.append('Invalid SL distance')
            return wait

        confidence = score
        if kronos:
            kp = kronos.get('bullish_prob', 0.5) if direction == 'long' else kronos.get('bearish_prob', 0.5)
            confidence = (confidence + kp) / 2

        return EntryDecision(
            action=action,
            confidence=round(confidence, 4),
            suggested_sl=round(sl, 2),
            suggested_tp=round(tp, 2),
            reasons=composite.reasons,
        )
