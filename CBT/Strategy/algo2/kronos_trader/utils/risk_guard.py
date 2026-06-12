"""Circuit breakers — daily loss limit, max positions, volatility filter."""


class RiskGuard:
    def __init__(self, config: dict):
        self.max_daily_loss_pct = config.get('max_daily_loss_pct', 3.0) / 100
        self.max_open_positions = config.get('max_open_positions', 1)
        self._daily_start_capital = None
        self._triggered = False

    def reset_day(self, capital: float):
        self._daily_start_capital = capital
        self._triggered = False

    def check_daily_loss(self, current_capital: float) -> bool:
        if self._daily_start_capital is None or self._triggered:
            return not self._triggered
        loss_pct = (self._daily_start_capital - current_capital) / self._daily_start_capital
        if loss_pct >= self.max_daily_loss_pct:
            self._triggered = True
            return False
        return True

    def check_max_positions(self, open_count: int) -> bool:
        return open_count < self.max_open_positions

    def check_volatility(self, atr_pct: float, max_atr_pct: float = 5.0) -> bool:
        return atr_pct <= max_atr_pct

    def is_triggered(self) -> bool:
        return self._triggered
