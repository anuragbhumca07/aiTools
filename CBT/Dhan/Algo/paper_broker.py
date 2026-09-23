"""
Paper-trading broker wrapper.

Wraps a real BrokerInterface (DhanBroker) so every read call — quotes, bars,
account, universe data — hits the real Dhan API exactly like live mode.
Only order placement is intercepted: instead of punching a real order, it
simulates an immediate fill at the current market price and tracks a local
cash ledger, so balance/equity/P&L move exactly as they would live.

Use case: Dhan API IP whitelist temporarily wrong/unavailable, but you still
want the full real-price trading experience without risking real orders.
"""
from __future__ import annotations
import logging
import time
from datetime import date, timedelta

from broker import BrokerInterface, BrokerError

logger = logging.getLogger(__name__)


class PaperBroker(BrokerInterface):
    is_paper = True

    def __init__(self, live_broker: BrokerInterface, starting_balance: float):
        self._live = live_broker
        self._balance = float(starting_balance)
        self._equity = float(starting_balance)
        self._positions: dict[str, dict] = {}
        self._order_seq = 0

    @property
    def name(self) -> str:
        return f"{self._live.name}-paper"

    # ── Account / positions — simulated ledger ──────────────────────────────────

    def get_account(self) -> dict:
        return {"buying_power": self._balance, "equity": self._equity, "cash": self._balance}

    def get_positions(self) -> dict[str, dict]:
        return {sid: dict(p) for sid, p in self._positions.items()}

    # ── Market data — pass straight through to the real broker ─────────────────

    def get_latest_quote(self, security_id: str) -> dict:
        return self._live.get_latest_quote(security_id)

    def get_bars(self, security_id: str, timeframe: str, start: str, end: str, limit: int = 1000) -> list[dict]:
        return self._live.get_bars(security_id, timeframe, start, end, limit)

    def get_bars_multi(self, security_ids: list[str], timeframe: str, start: str, end: str, limit: int = 1000) -> dict[str, list[dict]]:
        return self._live.get_bars_multi(security_ids, timeframe, start, end, limit)

    def is_easy_to_borrow(self, security_id: str) -> bool:
        return self._live.is_easy_to_borrow(security_id)

    # ── Orders — simulated fills, no real order sent ────────────────────────────

    def place_market_order(self, security_id: str, qty: int, side: str) -> dict:
        price = self._fill_price(security_id)
        return self._simulate_fill(security_id, qty, side, price)

    def _fill_price(self, security_id: str) -> float:
        """Best-effort current price for a paper fill — quote first, then last bar
        close. Never raises, so a flaky quote call can never block a close (an
        open position must always be closeable in paper mode, same as live)."""
        try:
            price = self._live.get_latest_quote(security_id)["price"]
            if price:
                return price
        except Exception as exc:
            logger.warning("paper fill: quote lookup failed for %s: %s — falling back to last bar", security_id, exc)

        try:
            today = date.today()
            start = (today - timedelta(days=5)).isoformat()
            bars = self._live.get_bars(security_id, "5", start, today.isoformat(), limit=50)
            if bars:
                return bars[-1]["close"]
        except Exception as exc:
            logger.warning("paper fill: bar fallback failed for %s: %s", security_id, exc)

        raise BrokerError(f"paper fill: no price available for {security_id} (quote and bar fallback both failed)")

    def place_limit_order(self, security_id: str, qty: int, side: str, limit_price: float) -> dict:
        return self._simulate_fill(security_id, qty, side, limit_price)

    def _simulate_fill(self, security_id: str, qty: int, side: str, price: float) -> dict:
        self._order_seq += 1
        order_id = f"paper_{int(time.time() * 1000)}_{self._order_seq}"

        pos = self._positions.get(security_id)
        if pos is None:
            # opening trade
            self._positions[security_id] = {
                "qty": qty,
                "side": "long" if side == "buy" else "short",
                "avg_entry": price,
                "symbol": security_id,
            }
        else:
            # closing trade (engine always closes the full qty in one order)
            pnl = (
                (price - pos["avg_entry"]) * pos["qty"]
                if pos["side"] == "long"
                else (pos["avg_entry"] - price) * pos["qty"]
            )
            self._balance += pnl
            self._equity += pnl
            del self._positions[security_id]

        logger.info("PAPER FILL %s qty=%s side=%s @ %.2f (order_id=%s)", security_id, qty, side, price, order_id)
        return {"order_id": order_id, "status": "filled"}

    def cancel_order(self, order_id: str) -> bool:
        return True  # no real resting orders exist in paper mode

    def get_open_orders(self) -> list[dict]:
        return []  # fills are always immediate in paper mode
