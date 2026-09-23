"""
Abstract broker interface — both AlpacaBroker and RobinhoodBroker implement this.

All methods raise BrokerError on failure.
"""
from __future__ import annotations
from abc import ABC, abstractmethod


class BrokerError(Exception):
    pass


class BrokerInterface(ABC):

    @abstractmethod
    def get_account(self) -> dict:
        """Return {'buying_power': float, 'equity': float, 'cash': float}"""

    @abstractmethod
    def get_positions(self) -> dict[str, dict]:
        """Return {symbol: {'qty': float, 'side': 'long'|'short', 'avg_entry': float}}"""

    @abstractmethod
    def get_latest_quote(self, symbol: str) -> dict:
        """Return {'bid': float, 'ask': float, 'price': float}"""

    @abstractmethod
    def get_bars(
        self,
        symbol: str,
        timeframe: str,
        start: str,
        end: str,
        limit: int = 1000,
    ) -> list[dict]:
        """
        Return list of OHLCV dicts:
          {'time': int (ms), 'open': float, 'high': float, 'low': float, 'close': float, 'volume': float}
        Oldest bar first.
        """

    @abstractmethod
    def get_bars_multi(
        self,
        symbols: list[str],
        timeframe: str,
        start: str,
        end: str,
        limit: int = 1000,
    ) -> dict[str, list[dict]]:
        """Batch bar fetch. Returns {symbol: [bars]}"""

    @abstractmethod
    def place_market_order(self, symbol: str, qty: int, side: str) -> dict:
        """
        side: 'buy' | 'sell'
        Returns {'order_id': str, 'status': str}
        """

    @abstractmethod
    def place_limit_order(
        self, symbol: str, qty: int, side: str, limit_price: float
    ) -> dict:
        """
        Marketable limit order (bid -/+ small slippage).
        Returns {'order_id': str, 'status': str}
        """

    @abstractmethod
    def cancel_order(self, order_id: str) -> bool:
        """Cancel an open order. Returns True if cancelled."""

    @abstractmethod
    def get_open_orders(self) -> list[dict]:
        """Return list of open orders: [{'order_id', 'symbol', 'side', 'qty', 'type'}]"""

    @abstractmethod
    def is_easy_to_borrow(self, symbol: str) -> bool:
        """True if the broker marks this symbol as easy-to-borrow (for shorts)."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Broker identifier string."""
