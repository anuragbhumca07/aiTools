"""
Alpaca REST v2 broker implementation.

Uses direct httpx calls (no SDK dependency).
Paper trading:  ALPACA_BASE_URL = https://paper-api.alpaca.markets
Live trading:   ALPACA_BASE_URL = https://api.alpaca.markets
Data API:       ALPACA_DATA_URL = https://data.alpaca.markets

Required env vars: ALPACA_KEY, ALPACA_SECRET
"""
from __future__ import annotations
import logging
import time
from datetime import datetime, timezone

import httpx

from broker import BrokerInterface, BrokerError
import config as cfg

logger = logging.getLogger(__name__)

_ALPACA_TF_MAP = {
    "1Min": "1Min", "5Min": "5Min", "15Min": "15Min",
    "30Min": "30Min", "1H": "1Hour", "1D": "1Day",
}


class AlpacaBroker(BrokerInterface):

    def __init__(self):
        if not cfg.ALPACA_KEY or not cfg.ALPACA_SECRET:
            raise BrokerError("ALPACA_KEY and ALPACA_SECRET must be set")
        self._headers = {
            "APCA-API-KEY-ID":     cfg.ALPACA_KEY,
            "APCA-API-SECRET-KEY": cfg.ALPACA_SECRET,
            "Accept":              "application/json",
        }
        self._base = cfg.ALPACA_BASE_URL.rstrip("/")
        self._data = cfg.ALPACA_DATA_URL.rstrip("/")
        self._etb_cache: dict[str, tuple[bool, float]] = {}  # symbol → (etb, expiry_ts)

    # ── Internal ──────────────────────────────────────────────────────────────

    def _trade(self, method: str, path: str, **kwargs) -> dict:
        url = f"{self._base}{path}"
        resp = httpx.request(method, url, headers=self._headers, timeout=15, **kwargs)
        if resp.status_code >= 400:
            raise BrokerError(f"Alpaca {method} {path} → {resp.status_code}: {resp.text}")
        return resp.json() if resp.text else {}

    def _data_get(self, path: str, params: dict | None = None) -> dict:
        url = f"{self._data}{path}"
        resp = httpx.get(url, headers=self._headers, params=params, timeout=20)
        if resp.status_code >= 400:
            raise BrokerError(f"Alpaca data GET {path} → {resp.status_code}: {resp.text}")
        return resp.json()

    # ── BrokerInterface impl ──────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "alpaca"

    def get_account(self) -> dict:
        data = self._trade("GET", "/v2/account")
        return {
            "buying_power": float(data.get("buying_power", 0)),
            "equity":       float(data.get("equity", 0)),
            "cash":         float(data.get("cash", 0)),
        }

    def get_positions(self) -> dict[str, dict]:
        rows = self._trade("GET", "/v2/positions")
        out: dict[str, dict] = {}
        for p in rows:
            sym = p["symbol"]
            out[sym] = {
                "qty":       abs(float(p["qty"])),
                "side":      "long" if float(p["qty"]) > 0 else "short",
                "avg_entry": float(p["avg_entry_price"]),
                "market_value": float(p.get("market_value", 0)),
                "unrealized_pnl": float(p.get("unrealized_pl", 0)),
            }
        return out

    def get_latest_quote(self, symbol: str) -> dict:
        data = self._data_get(f"/v2/stocks/{symbol}/quotes/latest")
        q = data.get("quote", {})
        bid = float(q.get("bp", 0))
        ask = float(q.get("ap", 0))
        return {"bid": bid, "ask": ask, "price": (bid + ask) / 2 if bid and ask else 0.0}

    def get_bars(
        self,
        symbol: str,
        timeframe: str,
        start: str,
        end: str,
        limit: int = 1000,
    ) -> list[dict]:
        tf = _ALPACA_TF_MAP.get(timeframe, timeframe)
        params = {"timeframe": tf, "start": start, "end": end, "limit": limit, "sort": "asc"}
        all_bars: list[dict] = []
        page_token = None
        while True:
            if page_token:
                params["page_token"] = page_token
            data = self._data_get(f"/v2/stocks/{symbol}/bars", params)
            bars = data.get("bars") or []
            for b in bars:
                all_bars.append({
                    "time":   int(datetime.fromisoformat(b["t"].replace("Z", "+00:00")).timestamp() * 1000),
                    "open":   float(b["o"]),
                    "high":   float(b["h"]),
                    "low":    float(b["l"]),
                    "close":  float(b["c"]),
                    "volume": float(b["v"]),
                })
            page_token = data.get("next_page_token")
            if not page_token:
                break
        return all_bars

    def get_bars_multi(
        self,
        symbols: list[str],
        timeframe: str,
        start: str,
        end: str,
        limit: int = 1000,
    ) -> dict[str, list[dict]]:
        tf = _ALPACA_TF_MAP.get(timeframe, timeframe)
        params = {
            "symbols":   ",".join(symbols),
            "timeframe": tf,
            "start":     start,
            "end":       end,
            "limit":     limit,
            "sort":      "asc",
        }
        all_bars: dict[str, list[dict]] = {s: [] for s in symbols}
        page_token = None
        while True:
            if page_token:
                params["page_token"] = page_token
            data = self._data_get("/v2/stocks/bars", params)
            bars_map = data.get("bars") or {}
            for sym, bars in bars_map.items():
                for b in bars:
                    all_bars.setdefault(sym, []).append({
                        "time":   int(datetime.fromisoformat(b["t"].replace("Z", "+00:00")).timestamp() * 1000),
                        "open":   float(b["o"]),
                        "high":   float(b["h"]),
                        "low":    float(b["l"]),
                        "close":  float(b["c"]),
                        "volume": float(b["v"]),
                    })
            page_token = data.get("next_page_token")
            if not page_token:
                break
        return all_bars

    def place_market_order(self, symbol: str, qty: int, side: str) -> dict:
        body = {
            "symbol":         symbol,
            "qty":            str(qty),
            "side":           side,
            "type":           "market",
            "time_in_force":  "day",
        }
        logger.info("Alpaca market order: %s %d %s", side, qty, symbol)
        data = self._trade("POST", "/v2/orders", json=body)
        return {"order_id": data.get("id", ""), "status": data.get("status", "")}

    def place_limit_order(
        self, symbol: str, qty: int, side: str, limit_price: float
    ) -> dict:
        body = {
            "symbol":        symbol,
            "qty":           str(qty),
            "side":          side,
            "type":          "limit",
            "limit_price":   f"{limit_price:.4f}",
            "time_in_force": "day",
        }
        logger.info("Alpaca limit order: %s %d %s @ %.4f", side, qty, symbol, limit_price)
        data = self._trade("POST", "/v2/orders", json=body)
        return {"order_id": data.get("id", ""), "status": data.get("status", "")}

    def cancel_order(self, order_id: str) -> bool:
        try:
            self._trade("DELETE", f"/v2/orders/{order_id}")
            return True
        except BrokerError as e:
            logger.warning("Cancel order %s failed: %s", order_id, e)
            return False

    def get_open_orders(self) -> list[dict]:
        rows = self._trade("GET", "/v2/orders", params={"status": "open"})
        return [
            {
                "order_id": r["id"],
                "symbol":   r["symbol"],
                "side":     r["side"],
                "qty":      float(r.get("qty") or 0),
                "type":     r["type"],
            }
            for r in rows
        ]

    def is_easy_to_borrow(self, symbol: str) -> bool:
        now = time.time()
        if symbol in self._etb_cache:
            etb, expiry = self._etb_cache[symbol]
            if now < expiry:
                return etb
        try:
            data = self._trade("GET", f"/v2/assets/{symbol}")
            etb = bool(data.get("easy_to_borrow", False))
            shortable = bool(data.get("shortable", False))
            result = etb and shortable
        except BrokerError:
            result = False
        self._etb_cache[symbol] = (result, now + 300)  # cache 5 min
        return result
