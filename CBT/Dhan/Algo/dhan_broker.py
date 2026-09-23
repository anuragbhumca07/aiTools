"""
Dhan broker implementation.

Uses dhanhq SDK (DhanContext + dhanhq).
Credentials read from config (loaded from ../Screener/.env).

Key differences from Alpaca:
  - NSE equities identified by integer security_id, not ticker symbol
  - Intraday bars fetched one trading day at a time
  - All orders are INTRADAY (auto-squareoff by broker at 3:20 PM IST)
  - Shorting allowed for all NSE EQ stocks (CNC not needed for intraday)
"""
from __future__ import annotations
import logging
import time
from datetime import date, datetime, timedelta

import pytz

from broker import BrokerInterface, BrokerError
import config as cfg

logger = logging.getLogger(__name__)
IST = pytz.timezone("Asia/Kolkata")

try:
    from dhanhq import DhanContext, dhanhq as DhanHQ
    _DHAN_OK = True
except ImportError:
    DhanContext = DhanHQ = None
    _DHAN_OK = False
    logger.warning("dhanhq not installed. Run: pip install dhanhq")


def _require_sdk():
    if not _DHAN_OK:
        raise BrokerError("dhanhq SDK not installed — run: pip install dhanhq")


def _now_ist() -> datetime:
    return datetime.now(IST)


def _ist_date() -> date:
    return _now_ist().date()


def _is_weekend(d: date) -> bool:
    return d.weekday() >= 5


def _prev_n_trading_days(n: int) -> list[date]:
    """Return the last n weekdays (Mon-Fri) up to and including today."""
    days = []
    d = _ist_date()
    while len(days) < n:
        if not _is_weekend(d):
            days.append(d)
        d -= timedelta(days=1)
    days.reverse()
    return days


class DhanBroker(BrokerInterface):

    def __init__(self):
        _require_sdk()
        if not cfg.DHAN_CLIENT_ID or not cfg.DHAN_ACCESS_TOKEN:
            raise BrokerError("DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN not configured")
        ctx = DhanContext(cfg.DHAN_CLIENT_ID, cfg.DHAN_ACCESS_TOKEN)
        self._dhan = DhanHQ(ctx)
        self._etb_cache: dict[str, bool] = {}

    @property
    def name(self) -> str:
        return "dhan"

    # ── Account ───────────────────────────────────────────────────────────────

    def get_account(self) -> dict:
        try:
            resp = self._dhan.get_fund_limits()
            if resp.get("status") != "success":
                raise BrokerError(f"get_fund_limits failed: {resp.get('remarks')}")
            data = resp.get("data", {})
            # Dhan fund_limits fields (verify field names against SDK response)
            available = float(data.get("availabelBalance",
                              data.get("availableBalance",
                              data.get("net_available", 0))) or 0)
            total_equity = float(data.get("totalCollateral",
                                 data.get("totalBalance",
                                 data.get("equity", 0))) or available)
            return {
                "buying_power": available,
                "equity":       total_equity,
                "cash":         available,
            }
        except BrokerError:
            raise
        except Exception as exc:
            raise BrokerError(f"get_account error: {exc}") from exc

    # ── Positions ─────────────────────────────────────────────────────────────

    def get_positions(self) -> dict[str, dict]:
        try:
            resp = self._dhan.get_positions()
            if resp.get("status") != "success":
                raise BrokerError(f"get_positions failed: {resp.get('remarks')}")
            data = resp.get("data") or []
            result = {}
            for p in data:
                sid = str(p.get("securityId", p.get("security_id", "")))
                qty = float(p.get("netQty", p.get("buyQty", 0)) or 0)
                if qty == 0:
                    continue
                side = "long" if qty > 0 else "short"
                result[sid] = {
                    "qty":       abs(qty),
                    "side":      side,
                    "avg_entry": float(p.get("buyAvg", p.get("averagePrice", 0)) or 0),
                    "symbol":    str(p.get("tradingSymbol", p.get("symbol", sid))),
                }
            return result
        except BrokerError:
            raise
        except Exception as exc:
            raise BrokerError(f"get_positions error: {exc}") from exc

    # ── Quotes ────────────────────────────────────────────────────────────────

    def get_latest_quote(self, security_id: str) -> dict:
        try:
            int_id = int(security_id)
            resp = self._dhan.quote_data({DhanHQ.NSE: [int_id]})
            if resp.get("status") != "success":
                # Fall back to OHLC
                resp2 = self._dhan.ohlc_data({DhanHQ.NSE: [int_id]})
                data = resp2.get("data", {})
                seg  = data.get(DhanHQ.NSE, data)
                info = seg.get(str(int_id), seg.get(security_id, {}))
                price = float(info.get("last_price", info.get("close", 0)) or 0)
                return {"bid": price, "ask": price, "price": price}
            data = resp.get("data", {})
            seg  = data.get(DhanHQ.NSE, data)
            info = seg.get(str(int_id), seg.get(security_id, {}))
            ltp  = float(info.get("last_price", info.get("ltp", 0)) or 0)
            bid  = float(info.get("best_bid_price", ltp) or ltp)
            ask  = float(info.get("best_ask_price", ltp) or ltp)
            return {"bid": bid, "ask": ask, "price": ltp}
        except Exception as exc:
            raise BrokerError(f"get_latest_quote({security_id}) error: {exc}") from exc

    # ── Bars ──────────────────────────────────────────────────────────────────

    def get_bars(
        self,
        security_id: str,
        timeframe: str,
        start: str,
        end: str,
        limit: int = 1000,
    ) -> list[dict]:
        interval = int(timeframe) if str(timeframe).isdigit() else cfg.CANDLE_INTERVAL
        # Parse start/end as date strings or ISO datetimes
        start_date = _parse_date(start)
        end_date   = _parse_date(end)
        return self._fetch_intraday_range(security_id, start_date, end_date, interval)

    def get_bars_multi(
        self,
        security_ids: list[str],
        timeframe: str,
        start: str,
        end: str,
        limit: int = 1000,
    ) -> dict[str, list[dict]]:
        interval   = int(timeframe) if str(timeframe).isdigit() else cfg.CANDLE_INTERVAL
        start_date = _parse_date(start)
        end_date   = _parse_date(end)
        result: dict[str, list[dict]] = {}
        for sid in security_ids:
            try:
                bars = self._fetch_intraday_range(sid, start_date, end_date, interval)
                if bars:
                    result[sid] = bars
            except Exception as exc:
                logger.debug("get_bars_multi skip %s: %s", sid, exc)
            time.sleep(cfg.HIST_REQUEST_DELAY)
        return result

    def _fetch_intraday_range(
        self,
        security_id: str,
        start_date: date,
        end_date: date,
        interval: int,
    ) -> list[dict]:
        """Loop over trading days and collect 5-min OHLCV bars."""
        all_bars: list[dict] = []
        d = start_date
        while d <= end_date:
            if not _is_weekend(d):
                bars = self._fetch_one_day(security_id, d, interval)
                all_bars.extend(bars)
            d += timedelta(days=1)
        return all_bars

    def _fetch_one_day(self, security_id: str, trade_date: date, interval: int) -> list[dict]:
        date_str = trade_date.strftime("%Y-%m-%d")
        try:
            resp = self._dhan.intraday_minute_data(
                security_id=security_id,
                exchange_segment=DhanHQ.NSE,
                instrument_type="EQUITY",
                from_date=date_str,
                to_date=date_str,
                interval=interval,
            )
            if resp.get("status") != "success":
                return []
            raw = resp.get("data")
            if not raw:
                return []
            return _parse_intraday(raw)
        except Exception as exc:
            logger.debug("_fetch_one_day %s %s: %s", security_id, date_str, exc)
            return []

    # ── Orders ────────────────────────────────────────────────────────────────

    def place_market_order(self, security_id: str, qty: int, side: str) -> dict:
        dhan_side = "BUY" if side == "buy" else "SELL"
        try:
            resp = self._dhan.place_order(
                security_id=security_id,
                exchange_segment=DhanHQ.NSE,
                transaction_type=dhan_side,
                quantity=qty,
                order_type="MARKET",
                product_type="INTRADAY",
                price=0,
            )
            if resp.get("status") != "success":
                raise BrokerError(f"place_market_order failed: {resp.get('remarks')}")
            data = resp.get("data", {})
            order_id = str(data.get("orderId", data.get("order_id", "unknown")))
            return {"order_id": order_id, "status": "placed"}
        except BrokerError:
            raise
        except Exception as exc:
            raise BrokerError(f"place_market_order error: {exc}") from exc

    def place_limit_order(
        self, security_id: str, qty: int, side: str, limit_price: float
    ) -> dict:
        dhan_side = "BUY" if side == "buy" else "SELL"
        try:
            resp = self._dhan.place_order(
                security_id=security_id,
                exchange_segment=DhanHQ.NSE,
                transaction_type=dhan_side,
                quantity=qty,
                order_type="LIMIT",
                product_type="INTRADAY",
                price=round(limit_price, 2),
            )
            if resp.get("status") != "success":
                raise BrokerError(f"place_limit_order failed: {resp.get('remarks')}")
            data = resp.get("data", {})
            order_id = str(data.get("orderId", data.get("order_id", "unknown")))
            return {"order_id": order_id, "status": "placed"}
        except BrokerError:
            raise
        except Exception as exc:
            raise BrokerError(f"place_limit_order error: {exc}") from exc

    def cancel_order(self, order_id: str) -> bool:
        try:
            resp = self._dhan.cancel_order(order_id)
            return resp.get("status") == "success"
        except Exception as exc:
            logger.warning("cancel_order %s: %s", order_id, exc)
            return False

    def get_open_orders(self) -> list[dict]:
        try:
            resp = self._dhan.get_order_list()
            if resp.get("status") != "success":
                return []
            orders = resp.get("data") or []
            result = []
            for o in orders:
                status = str(o.get("orderStatus", o.get("status", ""))).upper()
                if status not in ("PENDING", "TRANSIT", "OPEN"):
                    continue
                result.append({
                    "order_id":   str(o.get("orderId", "")),
                    "security_id": str(o.get("securityId", "")),
                    "side":       str(o.get("transactionType", "")).lower(),
                    "qty":        int(o.get("quantity", 0)),
                    "type":       str(o.get("orderType", "MARKET")).lower(),
                })
            return result
        except Exception as exc:
            logger.warning("get_open_orders error: %s", exc)
            return []

    def is_easy_to_borrow(self, security_id: str) -> bool:
        return True  # All NSE EQ intraday shorts are allowed on Dhan


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_intraday(data: dict) -> list[dict]:
    """Parse Dhan column-oriented intraday response into OHLCV dicts."""
    if not isinstance(data, dict):
        return []
    ts_key = next((k for k in ("timestamp", "startTime") if k in data), None)
    if ts_key is None:
        return []
    timestamps = data[ts_key]
    opens   = data.get("open",   [])
    highs   = data.get("high",   [])
    lows    = data.get("low",    [])
    closes  = data.get("close",  [])
    volumes = data.get("volume", [])
    n = len(timestamps)
    bars = []
    for i in range(n):
        try:
            ts = timestamps[i]
            if isinstance(ts, float) or isinstance(ts, int):
                ts_ms = int(ts) * 1000
            else:
                # ISO string
                dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                ts_ms = int(dt.timestamp() * 1000)
            bars.append({
                "time":   ts_ms,
                "open":   float(opens[i])   if i < len(opens)   else 0.0,
                "high":   float(highs[i])   if i < len(highs)   else 0.0,
                "low":    float(lows[i])    if i < len(lows)    else 0.0,
                "close":  float(closes[i])  if i < len(closes)  else 0.0,
                "volume": float(volumes[i]) if i < len(volumes) else 0.0,
            })
        except Exception:
            continue
    return bars


def _parse_date(s: str) -> date:
    """Parse ISO date or datetime string to date."""
    s = s.strip()
    if "T" in s:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    return date.fromisoformat(s[:10])
