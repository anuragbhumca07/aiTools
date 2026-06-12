"""Event-driven backtest engine — no lookahead bias."""
import pandas as pd
import numpy as np
from typing import List, Optional
from signals.vwap import VWAPSignal
from signals.volume_profile import VolumeProfileSignal
from signals.order_blocks import OrderBlockSignal
from signals.liquidity import LiquiditySignal
from signals.signal_aggregator import SignalAggregator
from strategy.entry_filter import EntryFilter
from strategy.position_sizer import PositionSizer
from strategy.stop_loss import StopLossManager
from utils.risk_guard import RiskGuard
from data.data_manager import DataManager
from backtest.metrics import compute_metrics, BacktestMetrics

MIN_CANDLES = 50  # minimum history to compute signals


class BacktestEngine:
    def __init__(self, config: dict):
        self.cfg = config
        risk_cfg = config.get('risk', {})
        sl_cfg = config.get('stop_loss', {})
        entry_cfg = config.get('entry', {})
        sig_cfg = config.get('signals', {})

        self.vwap = VWAPSignal(sig_cfg.get('vwap', {}))
        self.vp = VolumeProfileSignal(sig_cfg.get('volume_profile', {}))
        self.ob = OrderBlockSignal(sig_cfg.get('order_blocks', {}))
        self.liq = LiquiditySignal(sig_cfg.get('liquidity', {}))
        self.agg = SignalAggregator()
        self.sl_mgr = StopLossManager(sl_cfg)
        self.sizer = PositionSizer(risk_cfg)
        self.risk_guard = RiskGuard(risk_cfg)
        entry_cfg['reward_ratio_min'] = config.get('risk', {}).get('reward_ratio_min', 1.5)
        self.entry_filter = EntryFilter(entry_cfg, self.sl_mgr, self.risk_guard)

        bt_cfg = config.get('backtest', {})
        self.initial_capital = bt_cfg.get('initial_capital', 10000.0)
        self.commission = bt_cfg.get('commission_pct', 0.026) / 100
        self.slippage = bt_cfg.get('slippage_pct', 0.01) / 100

    def run(self, df: pd.DataFrame) -> dict:
        df = df.reset_index(drop=True)
        capital = self.initial_capital
        self.risk_guard.reset_day(capital)
        open_pos: Optional[dict] = None
        trades: List[dict] = []

        for i in range(MIN_CANDLES, len(df)):
            hist = df.iloc[:i]
            candle = df.iloc[i]
            price = float(candle['close'])

            # ATR
            atr_series = DataManager.compute_atr(hist, 14)
            atr = float(atr_series.iloc[-1]) if not atr_series.empty else price * 0.005

            # Check open position
            if open_pos:
                # Stop loss hit
                if open_pos['direction'] == 'long' and candle['low'] <= open_pos['stop_loss']:
                    exit_price = min(open_pos['stop_loss'], float(candle['open']))
                    trades.append(self._close(open_pos, exit_price, 'stop_loss', i))
                    capital += trades[-1]['realised_pnl']
                    open_pos = None
                    continue
                elif open_pos['direction'] == 'short' and candle['high'] >= open_pos['stop_loss']:
                    exit_price = max(open_pos['stop_loss'], float(candle['open']))
                    trades.append(self._close(open_pos, exit_price, 'stop_loss', i))
                    capital += trades[-1]['realised_pnl']
                    open_pos = None
                    continue

                # Take profit hit
                if open_pos['direction'] == 'long' and candle['high'] >= open_pos['take_profit']:
                    trades.append(self._close(open_pos, open_pos['take_profit'], 'take_profit', i))
                    capital += trades[-1]['realised_pnl']
                    open_pos = None
                    continue
                elif open_pos['direction'] == 'short' and candle['low'] <= open_pos['take_profit']:
                    trades.append(self._close(open_pos, open_pos['take_profit'], 'take_profit', i))
                    capital += trades[-1]['realised_pnl']
                    open_pos = None
                    continue

                # Update trailing SL
                new_sl = self.sl_mgr.update_trailing(open_pos, candle.to_dict(), atr)
                open_pos['stop_loss'] = new_sl

                # Breakeven
                if self.sl_mgr.should_move_to_breakeven(open_pos, price):
                    be_sl = open_pos['entry'] + 0.1 * atr if open_pos['direction'] == 'long' \
                        else open_pos['entry'] - 0.1 * atr
                    if open_pos['direction'] == 'long':
                        open_pos['stop_loss'] = max(open_pos['stop_loss'], be_sl)
                    else:
                        open_pos['stop_loss'] = min(open_pos['stop_loss'], be_sl)
                    open_pos['at_breakeven'] = True
                continue

            # No open position — look for entry
            if not self.risk_guard.check_daily_loss(capital):
                continue

            try:
                vwap_sig = self.vwap.calculate(hist)
                vp_sig = self.vp.calculate(hist)
                ob_sig = self.ob.get_signal(hist)
                liq_sig = self.liq.detect(hist)
            except Exception:
                continue

            composite = self.agg.aggregate(vwap_sig, vp_sig, ob_sig, liq_sig, price)
            decision = self.entry_filter.should_enter(None, composite, price, atr)

            if decision.action == 'wait':
                continue

            size = self.sizer.calculate(capital, price, decision.suggested_sl)
            direction = 'long' if decision.action == 'enter_long' else 'short'
            fill = price * (1 + self.slippage) if direction == 'long' else price * (1 - self.slippage)
            fee = fill * size * self.commission

            open_pos = {
                'id': f'bt_{i}',
                'direction': direction,
                'entry': round(fill, 2),
                'size': size,
                'stop_loss': decision.suggested_sl,
                'initial_sl': decision.suggested_sl,
                'take_profit': decision.suggested_tp,
                'at_breakeven': False,
                'open_candle': i,
                'fee': fee,
            }

        # Close any remaining position at end
        if open_pos:
            final_price = float(df.iloc[-1]['close'])
            trades.append(self._close(open_pos, final_price, 'end_of_data', len(df) - 1))
            capital += trades[-1]['realised_pnl']

        metrics = compute_metrics(trades, self.initial_capital)
        return {
            'metrics': metrics.__dict__,
            'trades': trades[-50:],  # last 50 trades for the UI
            'candles_tested': len(df) - MIN_CANDLES,
        }

    def _close(self, pos: dict, exit_price: float, reason: str, candle_idx: int) -> dict:
        direction = pos['direction']
        fill = exit_price * (1 - self.slippage) if direction == 'long' else exit_price * (1 + self.slippage)
        fee = fill * pos['size'] * self.commission
        pnl = (fill - pos['entry']) * pos['size'] - pos['fee'] - fee \
            if direction == 'long' \
            else (pos['entry'] - fill) * pos['size'] - pos['fee'] - fee
        pnl_pct = pnl / (pos['entry'] * pos['size']) * 100 if pos['entry'] * pos['size'] > 0 else 0
        hold = candle_idx - pos.get('open_candle', candle_idx)
        return {
            **pos,
            'exit': round(fill, 2),
            'realised_pnl': round(pnl, 4),
            'pnl_pct': round(pnl_pct, 4),
            'close_reason': reason,
            'hold_candles': hold,
        }
