"""ATR-based position sizer."""


class PositionSizer:
    def __init__(self, config: dict):
        self.risk_pct = config.get('risk_per_trade_pct', 1.0) / 100
        self.min_size = 0.0001

    def calculate(self, capital: float, entry: float, stop_loss: float) -> float:
        risk_usd = capital * self.risk_pct
        sl_distance = abs(entry - stop_loss)
        if sl_distance < 1e-9:
            return self.min_size
        size = risk_usd / sl_distance
        return max(self.min_size, round(size, 6))
