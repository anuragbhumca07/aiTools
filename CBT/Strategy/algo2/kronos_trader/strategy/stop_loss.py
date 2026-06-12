"""ATR-based stop loss — initial SL, trailing SL, and breakeven logic."""


class StopLossManager:
    def __init__(self, config: dict):
        self.method = config.get('method', 'atr')
        self.atr_mult_sl = config.get('atr_multiplier_sl', 1.5)
        self.atr_mult_trail = config.get('atr_multiplier_trailing', 2.0)
        self.trail_activation_r = config.get('trailing_activation_r', 1.0)
        self.breakeven_at_r = config.get('breakeven_at_r', 1.0)

    def initial_sl(self, entry: float, direction: str, atr: float,
                   swing_low: float = None, swing_high: float = None) -> float:
        if self.method == 'atr' or swing_low is None:
            dist = atr * self.atr_mult_sl
            return entry - dist if direction == 'long' else entry + dist
        if direction == 'long':
            return min(swing_low, entry - atr * self.atr_mult_sl)
        return max(swing_high, entry + atr * self.atr_mult_sl)

    def update_trailing(self, position: dict, candle: dict, atr: float) -> float:
        entry = position['entry']
        sl = position['stop_loss']
        direction = position['direction']
        initial_risk = abs(entry - position['initial_sl'])

        current_price = candle['close']
        unrealised_r = (current_price - entry) / initial_risk if direction == 'long' \
            else (entry - current_price) / initial_risk

        if unrealised_r < self.trail_activation_r:
            return sl  # Not yet activated

        trail_dist = atr * self.atr_mult_trail
        if direction == 'long':
            new_sl = candle['high'] - trail_dist
            return max(sl, new_sl)  # Only move in favorable direction
        else:
            new_sl = candle['low'] + trail_dist
            return min(sl, new_sl)

    def should_move_to_breakeven(self, position: dict, current_price: float) -> bool:
        entry = position['entry']
        initial_risk = abs(entry - position['initial_sl'])
        direction = position['direction']
        r_achieved = (current_price - entry) / initial_risk if direction == 'long' \
            else (entry - current_price) / initial_risk
        return r_achieved >= self.breakeven_at_r and not position.get('at_breakeven', False)
