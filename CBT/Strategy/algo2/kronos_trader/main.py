"""Kronos Trader CLI — outputs JSON for Node.js server integration."""
import sys
import os
# Ensure the kronos_trader package root is always on sys.path,
# regardless of how Python was invoked (subprocess with full path).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import json
import argparse
import traceback

# Resolve config relative to this file
_DIR = os.path.dirname(os.path.abspath(__file__))

def _load_config(path: str = None) -> dict:
    import yaml
    cfg_path = path or os.path.join(_DIR, 'config.yaml')
    with open(cfg_path) as f:
        return yaml.safe_load(f)


def cmd_signals(args) -> dict:
    cfg = _load_config()
    sym = args.symbol or cfg['asset']['symbol']
    tf = args.timeframe or cfg['asset']['timeframe']

    from data.kraken_rest import get_ohlcv, get_ticker
    from data.data_manager import DataManager
    from signals.vwap import VWAPSignal
    from signals.volume_profile import VolumeProfileSignal
    from signals.order_blocks import OrderBlockSignal
    from signals.liquidity import LiquiditySignal
    from signals.signal_aggregator import SignalAggregator
    from kronos.forecaster import KronosForecaster

    df = get_ohlcv(sym, tf, limit=500)
    ticker = get_ticker(sym)
    atr = DataManager.compute_atr(df, 14).iloc[-1]

    vwap = VWAPSignal(cfg['signals']['vwap']).calculate(df)
    vp = VolumeProfileSignal(cfg['signals']['volume_profile']).calculate(df)
    ob = OrderBlockSignal(cfg['signals']['order_blocks']).get_signal(df)
    liq = LiquiditySignal(cfg['signals']['liquidity']).detect(df)
    composite = SignalAggregator().aggregate(vwap, vp, ob, liq, ticker['last'])
    forecast = KronosForecaster(cfg.get('kronos', {})).forecast(df)

    return {
        'status': 'ok',
        'symbol': sym,
        'timeframe': tf,
        'market': {
            'price': ticker['last'],
            'bid': ticker['bid'],
            'ask': ticker['ask'],
            'spread_pct': round(ticker['spread_pct'], 4),
            'atr': round(float(atr), 2),
        },
        'kronos': {
            'bullish_prob': forecast.bullish_prob,
            'bearish_prob': forecast.bearish_prob,
            'volatility_expansion_prob': forecast.volatility_expansion_prob,
            'confidence': forecast.confidence,
            'source': forecast.source,
        },
        'signals': {
            'vwap': vwap,
            'volume_profile': {k: v for k, v in vp.items() if k not in ('hvn', 'lvn')},
            'order_blocks': ob,
            'liquidity': liq,
        },
        'composite': {
            'direction': composite.direction,
            'score': composite.score,
            'raw_score': composite.raw_score,
            'components': composite.components,
            'reasons': composite.reasons,
        },
    }


def cmd_backtest(args) -> dict:
    cfg = _load_config()
    sym = args.symbol or cfg['asset']['symbol']
    tf = args.timeframe or cfg['asset'].get('timeframe', '1h')
    days = args.days or cfg['backtest'].get('days', 30)
    capital = args.capital or cfg['backtest'].get('initial_capital', 10000)
    cfg['backtest']['initial_capital'] = float(capital)

    from data.kraken_rest import get_ohlcv
    from backtest.engine import BacktestEngine

    # Fetch data: Kraken returns max 720 candles per call
    # For 1h: 720 candles = 30 days; for 4h: 720 candles = 120 days
    df = get_ohlcv(sym, tf, limit=720)

    # Trim to requested days
    intervals_per_day = {'1m': 1440, '5m': 288, '15m': 96, '30m': 48, '1h': 24, '4h': 6, '1d': 1}
    candles_needed = days * intervals_per_day.get(tf, 24)
    if len(df) > candles_needed:
        df = df.tail(candles_needed).reset_index(drop=True)

    engine = BacktestEngine(cfg)
    result = engine.run(df)

    metrics = result['metrics']
    # Convert non-serialisable types
    metrics['equity_curve'] = [float(x) for x in metrics.get('equity_curve', [])]

    return {
        'status': 'ok',
        'symbol': sym,
        'timeframe': tf,
        'days': days,
        'candles_tested': result['candles_tested'],
        'metrics': metrics,
        'trades': result['trades'],
    }


def cmd_status(args) -> dict:
    import os
    paper_file = os.path.join(_DIR, '..', 'paper_state.json')
    state = {'capital': 10000, 'open_positions': [], 'trade_history': []}
    if os.path.exists(paper_file):
        try:
            import json as _json
            with open(paper_file) as f:
                state = _json.load(f)
        except Exception:
            pass
    return {
        'status': 'ok',
        'mode': 'paper',
        'capital': state.get('capital', 10000),
        'open_positions': state.get('open_positions', []),
        'trades_total': len(state.get('trade_history', [])),
    }


def main():
    parser = argparse.ArgumentParser(description='Kronos Trader CLI')
    sub = parser.add_subparsers(dest='cmd')

    p_sig = sub.add_parser('signals')
    p_sig.add_argument('--symbol', default=None)
    p_sig.add_argument('--timeframe', default=None)

    p_bt = sub.add_parser('backtest')
    p_bt.add_argument('--symbol', default=None)
    p_bt.add_argument('--timeframe', default=None)
    p_bt.add_argument('--days', type=int, default=None)
    p_bt.add_argument('--capital', type=float, default=None)

    p_st = sub.add_parser('status')

    args = parser.parse_args()

    try:
        if args.cmd == 'signals':
            result = cmd_signals(args)
        elif args.cmd == 'backtest':
            result = cmd_backtest(args)
        elif args.cmd == 'status':
            result = cmd_status(args)
        else:
            parser.print_help()
            sys.exit(1)
        print(json.dumps(result, default=str))
    except Exception as e:
        print(json.dumps({'status': 'error', 'message': str(e), 'trace': traceback.format_exc()}))
        sys.exit(1)


if __name__ == '__main__':
    main()
