# Alpaca Intraday Multi-Stock Algo

EMA Ribbon Swing strategy (port of Robinhood/algo) applied to a screened universe of US equities. Trades on 5-minute bars during regular market hours (9:30–4:00 PM ET).

## Quickstart

```bash
cd Alpaca
pip install -r requirements.txt
cp .env.example .env
# Edit .env — set ALPACA_KEY and ALPACA_SECRET (paper account)
python server.py
# Open http://localhost:5100
```

## Config (`.env`)

| Variable | Default | Description |
|---|---|---|
| `BROKER` | `alpaca` | `alpaca` or `robinhood` |
| `MODE` | `paper` | `paper` or `live` |
| `ALPACA_KEY` | — | Alpaca API key ID |
| `ALPACA_SECRET` | — | Alpaca API secret key |
| `SCAN_TOP_N` | 20 | Screener candidates per run |
| `MAX_CONCURRENT` | 15 | Max simultaneous positions |
| `CAPITAL_CAP_USD` | 500 | Max position value in USD |
| `PORTFOLIO_RISK_CAP_PCT` | 0.06 | Max total open risk (6%) |
| `RISK_PER_TRADE_PCT` | 0.015 | Risk per trade (1.5% of equity) |

## Strategy

**Timeframe**: 5-minute bars  
**Universe**: curated ~80 liquid US equities ranked by RVOL/gap/ATR at startup

**Hard gates (all must pass)**:
1. ADX ≥ 25
2. |DI+−DI−| ≥ 15
3. ADX slope > 0 (trend strengthening)
4. ATR ≤ 1.3×ATR_MA20 (no volatility spikes)
5. |price−EMA21| ≤ 1.5×ATR (no chasing)

**Scored conditions (6 / 7 required)**:
1. DI direction confirms side
2. EMA21 vs EMA55
3. EMA55 vs EMA200
4. EMA21 slope direction
5. RSI [42–72] (BUY) / [28–58] (SELL)
6. MACD hist direction
7. Candle close quality

**Stop-loss**: `max(2.5×ATR, 0.25%)`  
**TP**: `SL × 3` (reference; ATR trail may exit first)

**ATR-phase trailing**:
- Phase 1: initial SL
- Phase 2 (profit ≥ 1×ATR): SL → breakeven + 0.15×ATR
- Phase 3 (profit ≥ 2×ATR): SL → entry + 1.5×ATR
- Phase 4 (profit ≥ 4×ATR): SL → price − 2×ATR, ratchets up

**EOD**: Stop entries 3:15 PM ET → Marketable limits 3:30 PM ET → Market fallback 3:40 PM ET

**SHORT**: Alpaca only, easy_to_borrow must be True

## Architecture

```
config.py          — all constants
strategy_core.py   — pure Python port of algo.js (no broker dependency)
broker.py          — abstract BrokerInterface
alpaca_broker.py   — Alpaca REST v2 implementation
screener.py        — pre-market RVOL/gap/ATR ranker
engine.py          — multi-position trading loop
server.py          — FastAPI + WebSocket backend
web/               — dashboard UI
```
