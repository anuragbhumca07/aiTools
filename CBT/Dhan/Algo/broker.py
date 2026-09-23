"""
Abstract broker interface — DhanBroker implements this.
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
        """Return {security_id: {'qty': float, 'side': 'long'|'short', 'avg_entry': float, 'symbol': str}}"""

    @abstractmethod
    def get_latest_quote(self, security_id: str) -> dict:
        """Return {'bid': float, 'ask': float, 'price': float}"""

    @abstractmethod
    def get_bars(
        self,
        security_id: str,
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
        security_ids: list[str],
        timeframe: str,
        start: str,
        end: str,
        limit: int = 1000,
    ) -> dict[str, list[dict]]:
        """Batch bar fetch. Returns {security_id: [bars]}"""

    @abstractmethod
    def place_market_order(self, security_id: str, qty: int, side: str) -> dict:
        """
        side: 'buy' | 'sell'
        Returns {'order_id': str, 'status': str}
        """

    @abstractmethod
    def place_limit_order(
        self, security_id: str, qty: int, side: str, limit_price: float
    ) -> dict:
        """
        Marketable limit order.
        Returns {'order_id': str, 'status': str}
        """

    @abstractmethod
    def cancel_order(self, order_id: str) -> bool:
        """Cancel an open order. Returns True if cancelled."""

    @abstractmethod
    def get_open_orders(self) -> list[dict]:
        """Return list of open orders: [{'order_id', 'security_id', 'side', 'qty', 'type'}]"""

    @abstractmethod
    def is_easy_to_borrow(self, security_id: str) -> bool:
        """True if intraday shorting is allowed (always True for NSE equities on Dhan)."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Broker identifier string."""
