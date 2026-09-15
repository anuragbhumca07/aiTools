# NSE Opening-Range Breakout Scanner (Dhan API)

A Python intraday **breakout-detection and ranking** system for NSE equities.
It detects and ranks stocks breaking out around 9:30 AM IST. It does **not** and
**cannot** predict which breakouts will follow through.

---

## ⚠ Critical disclaimers — read before running

1. **All scoring weights are unvalidated placeholder guesses** until Phase 3 backtesting completes. The scanner output is decoration until then.
2. Run in **paper mode only** for the first 30–60 trading days. Record every signal vs actual outcome.
3. Do NOT use for real money until Phase 3 backtesting shows positive edge and you have personal paper-trading results.

---

## Build phases

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 1** | ✅ Built | Universe builder + OHLCV cache + daily features |
| **Phase 2** | 🔲 Scaffold | Live scoring engine (9:15–10:00 IST) |
| **Phase 2b** | 🔲 Scaffold | Multi-time re-scan cadence with signal tracking |
| **Phase 3** | 🔲 Scaffold | Point-in-time backtester — validates + tunes weights |
| **Phase 4** | 🔲 Future | Sector RS, order-book depth, news/catalyst scoring |

---

## Setup (Windows / PowerShell)

### 1. Python 3.11+
```powershell
python --version    # must be 3.11 or higher
```

### 2. Virtual environment
```powershell
cd CBT\Dhan\Screener
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 3. Credentials
```powershell
Copy-Item .env.example .env
notepad .env    # fill in DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN
```

Get your token from: **Dhan account → API Access → Generate Token**

---

## Phase 1 — verify data layer

```powershell
# Step 1: inspect the instrument master CSV columns
python phase1_verify.py --inspect

# Step 2: download universe + OHLCV (takes a few minutes first time)
python phase1_verify.py

# Force re-download everything
python phase1_verify.py --refresh

# Check OHLCV cache coverage
python phase1_verify.py --cache-stats
```

**Expected output:** universe size (NSE EQ stocks) and feature values for 5 stocks.  
**If universe is empty:** run `--inspect` to see actual CSV column names, then fix the filter in `universe.py`.

---

## Dashboard

```powershell
python dashboard.py
# Open: http://localhost:5000
```

The dashboard lets you:
- Configure scan parameters (min price, ADTV, TOP_N)
- Run a fresh scan with one click
- View TOP 5 LONG + TOP 5 SHORT with entry / SL / 1R / 2R levels
- Switch between 09:20 / 09:30 / 09:45 / 10:00 scan slots
- Monitor the log in real time

---

## VERIFY checklist

Before trusting any data, confirm these marked items (`# VERIFY:` in code):

| What | File & marker | How to confirm |
|---|---|---|
| Instrument master URL | `universe.py:18` | Still resolves: `images.dhan.co/api-data/api-scrip-master.csv` |
| `SEM_SEGMENT` column + value | `universe.py:60` | Run `--inspect`; look for the NSE equity segment label |
| `SEM_SERIES` column | `universe.py:70` | Run `--inspect`; confirm "EQ" is the correct series value |
| Security ID column name | `universe.py:87` | Run `--inspect`; find the numeric ID column |
| `historical_daily_data()` signature | `data_cache.py:55` | `python -c "from dhanhq import DhanHQ; help(DhanHQ.historical_daily_data)"` |
| API response shape | `data_cache.py:71` | Print `resp` from one real API call and inspect keys |
| NIFTY security ID | `.env` | Confirm the correct ID for NIFTY 50 index on Dhan |
| Dhan rate limits | `config.py` | Check DhanHQ API docs for historical data rate limits |
| WebSocket limits (Phase 2) | `scanner.py` | Confirm instrument count limit per connection |

---

## File structure

```
config.py           — all config + named weight constants
universe.py         — instrument master → filtered universe
data_cache.py       — historical OHLCV download → parquet cache
features.py         — point-in-time daily feature computation
phase1_verify.py    — Phase 1 deliverable: print universe + features
scorer.py           — Phase 2: 0–100 scoring engine (scaffold)
scanner.py          — Phase 2: live scan orchestrator (scaffold)
backtester.py       — Phase 3: point-in-time backtester (scaffold)
dashboard.py        — Flask dashboard server
web/                — HTML / CSS / JS dashboard UI
cache/              — local OHLCV parquet cache (gitignored)
.env.example        — copy to .env and fill in credentials
requirements.txt
```

---

## Scoring factors & weights (all UNVALIDATED)

| Factor | Placeholder weight | Phase 3 status |
|---|---|---|
| Opening-range breakout | 20 | Will be replaced |
| Relative volume (time-normalised) | 15 | Will be replaced |
| VWAP position | 10 | Will be replaced |
| 5-min momentum | 10 | Will be replaced |
| Prev-day High/Low breakout | 10 | Will be replaced |
| EMA structure (9 vs 20) | 8 | Will be replaced |
| 20d / 52w level breakout | 8 | Will be replaced |
| Relative strength vs NIFTY | 7 | Will be replaced |
| Sector RS (Phase 4) | 5 | Not implemented |
| Candle quality | 4 | Will be replaced |
| Gap quality | 3 | Will be replaced |
| **Total** | **100** | **All unvalidated** |

Phase 3 backtesting will measure forward outcomes (15m / 30m / 60m / EOD) and
replace every weight above with evidence-based values — or conclude there is no
edge and that the strategy needs rethinking.
