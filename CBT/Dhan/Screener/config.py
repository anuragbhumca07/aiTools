"""
Central configuration — loaded from .env.
All scoring weights are here as named constants so Phase 3 can tune from one place.
"""
import os
from dotenv import load_dotenv

load_dotenv()

# ── Dhan API credentials ──────────────────────────────────────────────────────
# Get from: Dhan account → API Access → Generate Token
DHAN_CLIENT_ID    = os.getenv("DHAN_CLIENT_ID",    "")
DHAN_ACCESS_TOKEN = os.getenv("DHAN_ACCESS_TOKEN", "")

# ── Universe filters ──────────────────────────────────────────────────────────
MIN_PRICE        = float(os.getenv("MIN_PRICE",        "50"))    # ₹ minimum stock price
MIN_ADTV_CR      = float(os.getenv("MIN_ADTV_CR",      "10"))    # min avg daily traded value (₹ Crore)
HISTORY_DAYS_CAL = int(os.getenv("HISTORY_DAYS_CAL",   "420"))   # calendar days of daily OHLCV to cache
MAX_INSTRUMENTS  = int(os.getenv("MAX_INSTRUMENTS",    "50"))    # 0 = full universe; use ≤100 for testing

# ── NIFTY index ───────────────────────────────────────────────────────────────
# VERIFY: Confirm the security_id and exchange segment for NIFTY 50 on Dhan.
# Indices may need a separate endpoint — check DhanHQ docs.
NIFTY_SECURITY_ID  = os.getenv("NIFTY_SECURITY_ID",  "13")
NIFTY_EXCHANGE_SEG = os.getenv("NIFTY_EXCHANGE_SEG", "IDX_I")   # VERIFY

# ── Scan cadence (IST) ────────────────────────────────────────────────────────
TIMEZONE   = os.getenv("TIMEZONE", "Asia/Kolkata")
OR_START   = "09:15"                                       # Opening range window start
OR_END     = "09:30"                                       # Opening range window end
SCAN_TIMES = ["09:20", "09:30", "09:45", "10:00"]         # early / primary / confirm / final

# ── Output ────────────────────────────────────────────────────────────────────
TOP_N = int(os.getenv("TOP_N", "5"))   # top N long + top N short

# ── Paths ─────────────────────────────────────────────────────────────────────
CACHE_DIR     = os.getenv("CACHE_DIR", "cache")
OHLCV_DIR     = os.path.join(CACHE_DIR, "ohlcv")
RESULTS_DIR   = os.path.join(CACHE_DIR, "results")

# ── API rate limiting ─────────────────────────────────────────────────────────
# VERIFY: Dhan's actual rate limits for historical data API calls.
# These are conservative placeholders — adjust after checking DhanHQ docs.
HIST_REQUEST_DELAY = float(os.getenv("HIST_REQUEST_DELAY", "0.35"))  # seconds between requests
HIST_MAX_RETRIES   = int(os.getenv("HIST_MAX_RETRIES",      "3"))

# ── Market-regime thresholds ──────────────────────────────────────────────────
# UNVALIDATED: will be tuned in Phase 3 based on backtest outcomes.
REGIME_BULL_THRESH  = float(os.getenv("REGIME_BULL_THRESH",  "0.5"))   # % above 20d EMA → bull
REGIME_BEAR_THRESH  = float(os.getenv("REGIME_BEAR_THRESH", "-0.5"))   # % below 20d EMA → bear

# ── Risk sizing ───────────────────────────────────────────────────────────────
ATR_RISK_MULTIPLIER = float(os.getenv("ATR_RISK_MULTIPLIER", "0.8"))   # Risk = 0.8 × ATR(14)

# ─────────────────────────────────────────────────────────────────────────────
# SCORING WEIGHTS  —  ALL VALUES BELOW ARE UNVALIDATED PLACEHOLDER GUESSES
#
# These are hand-picked starting values carried over from the design discussion.
# They have NO evidence behind them. Phase 3 backtesting will replace every one.
# Do NOT present scanner output as meaningful until Phase 3 results exist.
# Treat this entire block as "wiring" only.
# ─────────────────────────────────────────────────────────────────────────────
W_OPENING_RANGE_BREAKOUT = float(os.getenv("W_OPENING_RANGE_BREAKOUT", "20"))
W_RELATIVE_VOLUME        = float(os.getenv("W_RELATIVE_VOLUME",        "15"))
W_VWAP_POSITION          = float(os.getenv("W_VWAP_POSITION",          "10"))
W_MOMENTUM_5MIN          = float(os.getenv("W_MOMENTUM_5MIN",          "10"))
W_PREV_DAY_HL_BREAK      = float(os.getenv("W_PREV_DAY_HL_BREAK",      "10"))
W_EMA_STRUCTURE          = float(os.getenv("W_EMA_STRUCTURE",           "8"))
W_LEVEL_BREAKOUT         = float(os.getenv("W_LEVEL_BREAKOUT",          "8"))
W_RS_NIFTY               = float(os.getenv("W_RS_NIFTY",                "7"))
W_SECTOR_RS              = float(os.getenv("W_SECTOR_RS",               "5"))   # Phase 4 reserved
W_CANDLE_QUALITY         = float(os.getenv("W_CANDLE_QUALITY",          "4"))
W_GAP_QUALITY            = float(os.getenv("W_GAP_QUALITY",             "3"))

TOTAL_WEIGHT = (
    W_OPENING_RANGE_BREAKOUT + W_RELATIVE_VOLUME + W_VWAP_POSITION +
    W_MOMENTUM_5MIN + W_PREV_DAY_HL_BREAK + W_EMA_STRUCTURE +
    W_LEVEL_BREAKOUT + W_RS_NIFTY + W_SECTOR_RS + W_CANDLE_QUALITY + W_GAP_QUALITY
)  # intended = 100; assert in tests
