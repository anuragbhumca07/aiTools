"""
All configuration for the Alpaca / Robinhood multi-stock intraday trading system.
Override any value via environment variable of the same name.
"""
from __future__ import annotations
import os
from pathlib import Path

# Load .env if present (before reading os.getenv below)
try:
    from dotenv import load_dotenv
    _env_file = Path(__file__).parent / ".env"
    if _env_file.exists():
        load_dotenv(_env_file)
except ImportError:
    pass

def _env(key: str, default) -> str:
    return os.getenv(key, str(default))

def _float(key: str, default: float) -> float:
    return float(os.getenv(key, str(default)))

def _int(key: str, default: int) -> int:
    return int(os.getenv(key, str(default)))

# ── Broker ────────────────────────────────────────────────────────────────────
BROKER          = _env("BROKER", "alpaca")           # alpaca | robinhood
MODE            = _env("MODE",   "paper")            # paper  | live
ALPACA_KEY      = _env("ALPACA_KEY",    "")
ALPACA_SECRET   = _env("ALPACA_SECRET", "")
# paper uses paper-api subdomain; live uses api
ALPACA_BASE_URL = _env("ALPACA_BASE_URL",
                       "https://paper-api.alpaca.markets" if MODE == "paper"
                       else "https://api.alpaca.markets")
ALPACA_DATA_URL = _env("ALPACA_DATA_URL", "https://data.alpaca.markets")

RH_CLIENT_ID    = _env("RH_CLIENT_ID",  "")
RH_PRIVATE_KEY  = _env("RH_PRIVATE_KEY", "")   # Ed25519 PEM private key string

# ── Strategy ──────────────────────────────────────────────────────────────────
# Hard gates (ALL must pass)
ADX_MIN           = _float("ADX_MIN",            25.0)
DI_SPREAD_MIN     = _float("DI_SPREAD_MIN",      15.0)
ATR_REGIME_MULT   = _float("ATR_REGIME_MULT",     1.3)
PRICE_PROX_ATR    = _float("PRICE_PROX_ATR",      1.5)  # |price - EMA21| ≤ 1.5×ATR

# Scored conditions — need SIGNAL_THRESHOLD / 7
SIGNAL_THRESHOLD  = _int("SIGNAL_THRESHOLD", 6)
RSI_BUY_LOW       = _float("RSI_BUY_LOW",   42.0)
RSI_BUY_HIGH      = _float("RSI_BUY_HIGH",  72.0)
RSI_SELL_LOW      = _float("RSI_SELL_LOW",  28.0)
RSI_SELL_HIGH     = _float("RSI_SELL_HIGH", 58.0)

# Exit extras
RSI_OB_EXIT       = _float("RSI_OB_EXIT", 78.0)   # overbought exit for long
RSI_OS_EXIT       = _float("RSI_OS_EXIT", 22.0)   # oversold exit for short
TIME_STOP_BARS    = _int("TIME_STOP_BARS", 60)     # max candles in trade
RSI_COOLDOWN_BARS = _int("RSI_COOLDOWN_BARS", 15)  # bars to wait after RSI exit before re-entry

# ── ATR-phase trailing ────────────────────────────────────────────────────────
STOP_ATR_MULT     = _float("STOP_ATR_MULT",    2.5)   # SL distance = max(2.5×ATR, STOP_MIN_PCT)
STOP_MIN_PCT      = _float("STOP_MIN_PCT",     0.0025) # 0.25% minimum SL
TP_RR_RATIO       = _float("TP_RR_RATIO",      3.0)    # reference TP = SL × 3 (trail may exit first)
PHASE2_ATR_THRESH = _float("PHASE2_ATR_THRESH", 1.0)   # profit ≥ 1×ATR → move SL to breakeven
PHASE3_ATR_THRESH = _float("PHASE3_ATR_THRESH", 2.0)   # profit ≥ 2×ATR → SL to entry + 1.5×ATR
PHASE4_ATR_THRESH = _float("PHASE4_ATR_THRESH", 4.0)   # profit ≥ 4×ATR → SL ratchets at price - 2×ATR
PHASE2_BUFFER_ATR = _float("PHASE2_BUFFER_ATR", 0.15)  # breakeven + 0.15×ATR to lock small profit
PHASE3_SL_ATR     = _float("PHASE3_SL_ATR",    1.5)    # SL at entry + 1.5×ATR in phase 3
PHASE4_TRAIL_ATR  = _float("PHASE4_TRAIL_ATR", 2.0)    # Phase 4 trail distance

# ── Risk management ───────────────────────────────────────────────────────────
RISK_PER_TRADE_PCT      = _float("RISK_PER_TRADE_PCT",   0.015)  # 1.5% of balance per trade
CAPITAL_CAP_USD         = _float("CAPITAL_CAP_USD",      500.0)  # max position value in USD
PORTFOLIO_RISK_CAP_PCT  = _float("PORTFOLIO_RISK_CAP_PCT", 0.06) # max total open risk = 6%
MAX_CONCURRENT          = _int("MAX_CONCURRENT",          15)    # max simultaneous positions
MIN_QTY                 = _int("MIN_QTY",                  1)    # minimum tradeable qty

# ── Screener ──────────────────────────────────────────────────────────────────
SCAN_TOP_N        = _int("SCAN_TOP_N",   20)      # top N candidates per run
MIN_PRICE         = _float("MIN_PRICE",  10.0)    # exclude sub-$10 stocks
MIN_AVG_VOL       = _int("MIN_AVG_VOL",  500_000) # minimum 20-day avg daily volume

# ── Timing (Eastern Time) ─────────────────────────────────────────────────────
MARKET_TZ              = "America/New_York"
CANDLE_INTERVAL        = _env("CANDLE_INTERVAL", "5Min")
CANDLE_HISTORY_DAYS    = _int("CANDLE_HISTORY_DAYS", 6)   # days of history to load (for EMA200)
EOD_STOP_ENTRIES_HM    = _env("EOD_STOP_ENTRIES_HM",    "15:15")  # stop new entries at 3:15 PM ET
EOD_CLOSE_START_HM     = _env("EOD_CLOSE_START_HM",     "15:30")  # begin closing at 3:30 PM ET
EOD_MARKET_FALLBACK_HM = _env("EOD_MARKET_FALLBACK_HM", "15:40")  # market orders at 3:40 PM ET

# ── Server ────────────────────────────────────────────────────────────────────
PORT = _int("PORT", 5100)

# ── Universe — curated set of liquid intraday US stocks ──────────────────────
SEED_UNIVERSE: list[str] = [
    # Mega-cap tech
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA",
    # High-vol tech / semis
    "AMD", "INTC", "QCOM", "MU", "AVGO", "AMAT", "SMCI",
    # High-momentum growth
    "PLTR", "SOFI", "HOOD", "COIN", "MARA", "RIOT", "CLSK",
    # Financial
    "JPM", "GS", "MS", "BAC", "WFC", "C",
    # Energy
    "XOM", "CVX", "SLB", "OXY",
    # EV / disruption
    "RIVN", "LCID", "NIO", "XPEV",
    # Consumer / retail
    "WMT", "COST", "HD", "TGT",
    # Healthcare
    "UNH", "ABBV", "LLY", "PFE", "MRNA",
    # ETFs (high volume)
    "SPY", "QQQ", "IWM", "GLD",
    # Leveraged ETFs (extreme RVOL on trend days)
    "TQQQ", "SQQQ", "UPRO", "SPXU", "SOXL", "SOXS",
    # Media / streaming
    "NFLX", "DIS", "SNAP", "RBLX",
    # Travel / airlines
    "UAL", "DAL", "AAL", "NCLH",
    # Other high-momentum
    "AFRM", "DKNG", "MELI", "SHOP",
    # Industrial
    "BA", "GE", "CAT",
]
