"""
Config for the Dhan NSE intraday multi-stock EMA Ribbon Swing algo.
Reads from ../Screener/.env (where Dhan credentials already live).
All values overridable via environment variables.
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

# ── Load .env from Screener folder (credentials already there) ────────────────
_HERE       = Path(__file__).parent
_SCREENER   = _HERE.parent / "Screener"

try:
    from dotenv import load_dotenv
    _env_file = _SCREENER / ".env"
    if _env_file.exists():
        load_dotenv(_env_file)
    # also try local .env
    _local = _HERE / ".env"
    if _local.exists():
        load_dotenv(_local, override=True)
except ImportError:
    pass

# Add Screener to path so we can reuse data_cache, universe, etc.
if str(_SCREENER) not in sys.path:
    sys.path.insert(0, str(_SCREENER))

# ── Dhan credentials ──────────────────────────────────────────────────────────
DHAN_CLIENT_ID    = os.getenv("DHAN_CLIENT_ID",    "")
DHAN_ACCESS_TOKEN = os.getenv("DHAN_ACCESS_TOKEN", "")

# ── Broker ────────────────────────────────────────────────────────────────────
BROKER = "dhan"
MODE   = os.getenv("MODE", "live")    # Dhan has no sandbox — always live

# ── Strategy ──────────────────────────────────────────────────────────────────
ADX_MIN           = float(os.getenv("ADX_MIN",            "25"))
DI_SPREAD_MIN     = float(os.getenv("DI_SPREAD_MIN",      "15"))
ATR_REGIME_MULT   = float(os.getenv("ATR_REGIME_MULT",     "1.3"))
PRICE_PROX_ATR    = float(os.getenv("PRICE_PROX_ATR",      "1.5"))

SIGNAL_THRESHOLD  = int(os.getenv("SIGNAL_THRESHOLD", "6"))
RSI_BUY_LOW       = float(os.getenv("RSI_BUY_LOW",   "42"))

RSI_BUY_HIGH      = float(os.getenv("RSI_BUY_HIGH",  "72"))
RSI_SELL_LOW      = float(os.getenv("RSI_SELL_LOW",  "28"))
RSI_SELL_HIGH     = float(os.getenv("RSI_SELL_HIGH", "58"))
RSI_OB_EXIT       = float(os.getenv("RSI_OB_EXIT", "78"))
RSI_OS_EXIT       = float(os.getenv("RSI_OS_EXIT", "22"))
TIME_STOP_BARS    = int(os.getenv("TIME_STOP_BARS",    "60"))
RSI_COOLDOWN_BARS = int(os.getenv("RSI_COOLDOWN_BARS", "15"))

# ── ATR-phase trailing ────────────────────────────────────────────────────────
STOP_ATR_MULT     = float(os.getenv("STOP_ATR_MULT",    "2.5"))
STOP_MIN_PCT      = float(os.getenv("STOP_MIN_PCT",     "0.0025"))
TP_RR_RATIO       = float(os.getenv("TP_RR_RATIO",      "3.0"))
PHASE2_ATR_THRESH = float(os.getenv("PHASE2_ATR_THRESH", "1.0"))
PHASE3_ATR_THRESH = float(os.getenv("PHASE3_ATR_THRESH", "2.0"))
PHASE4_ATR_THRESH = float(os.getenv("PHASE4_ATR_THRESH", "4.0"))
PHASE2_BUFFER_ATR = float(os.getenv("PHASE2_BUFFER_ATR", "0.15"))
PHASE3_SL_ATR     = float(os.getenv("PHASE3_SL_ATR",    "1.5"))
PHASE4_TRAIL_ATR  = float(os.getenv("PHASE4_TRAIL_ATR", "2.0"))

# ── Risk management ───────────────────────────────────────────────────────────
RISK_PER_TRADE_PCT      = float(os.getenv("RISK_PER_TRADE_PCT",   "0.015"))  # 1.5%
CAPITAL_CAP_INR         = float(os.getenv("CAPITAL_CAP_INR",      "10000"))  # Rs 10,000 max per trade
MIN_MARGIN_INR          = float(os.getenv("MIN_MARGIN_INR",        "20000"))  # pause entries below this balance
PORTFOLIO_RISK_CAP_PCT  = float(os.getenv("PORTFOLIO_RISK_CAP_PCT", "0.06")) # 6% total open risk
MAX_CONCURRENT          = int(os.getenv("MAX_CONCURRENT",          "15"))
MIN_QTY                 = int(os.getenv("MIN_QTY",                  "1"))

# ── Screener / universe ───────────────────────────────────────────────────────
SCAN_TOP_N      = int(os.getenv("SCAN_TOP_N",   "50"))
MIN_PRICE       = float(os.getenv("MIN_PRICE",  "50"))    # Rs 50 min price
MIN_ADTV_CR     = float(os.getenv("MIN_ADTV_CR","10"))    # Rs 10 Crore ADTV
MAX_INSTRUMENTS = int(os.getenv("MAX_INSTRUMENTS","200"))  # universe size cap

# ── Timing (IST) ─────────────────────────────────────────────────────────────
TIMEZONE               = "Asia/Kolkata"
CANDLE_INTERVAL        = int(os.getenv("CANDLE_INTERVAL_MIN", "5"))  # minutes
CANDLE_HISTORY_DAYS    = int(os.getenv("CANDLE_HISTORY_DAYS", "6"))
EOD_STOP_ENTRIES_HM    = os.getenv("EOD_STOP_ENTRIES_HM",    "15:10")  # 3:10 PM IST
EOD_CLOSE_START_HM     = os.getenv("EOD_CLOSE_START_HM",     "15:20")  # 3:20 PM IST
EOD_MARKET_FALLBACK_HM = os.getenv("EOD_MARKET_FALLBACK_HM", "15:25")  # 3:25 PM IST

# ── Dhan API internals ────────────────────────────────────────────────────────
NIFTY_SECURITY_ID  = os.getenv("NIFTY_SECURITY_ID",  "13")
NIFTY_EXCHANGE_SEG = os.getenv("NIFTY_EXCHANGE_SEG", "IDX_I")
HIST_REQUEST_DELAY = float(os.getenv("HIST_REQUEST_DELAY", "0.4"))
HISTORY_DAYS_CAL   = int(os.getenv("HISTORY_DAYS_CAL",   "420"))  # for universe build
HIST_MAX_RETRIES   = int(os.getenv("HIST_MAX_RETRIES",    "3"))

# ── Cache ─────────────────────────────────────────────────────────────────────
# Default: local cache/ dir (writable on Railway). Reuses ../Screener/cache when
# both services run on the same machine (set CACHE_DIR env var to override).
_screener_cache = _SCREENER / "cache"
_default_cache  = str(_screener_cache) if _screener_cache.exists() else str(_HERE / "cache")
CACHE_DIR  = os.getenv("CACHE_DIR", _default_cache)
OHLCV_DIR  = os.path.join(CACHE_DIR, "ohlcv")

# ── Server ────────────────────────────────────────────────────────────────────
PORT = int(os.getenv("PORT", os.getenv("ALGO_PORT", "5051")))  # Railway uses PORT
