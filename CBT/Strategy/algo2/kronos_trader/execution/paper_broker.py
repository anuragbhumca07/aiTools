"""Paper broker — simulated fills with P&L tracking, persisted to JSON."""
import json
import os
import uuid
from datetime import datetime, timezone
from typing import List, Optional


PAPER_STATE_FILE = os.path.join(os.path.dirname(__file__), '..', '..', 'paper_state.json')


class PaperBroker:
    def __init__(self, initial_capital: float = 10000.0, slippage_pct: float = 0.01,
                 commission_pct: float = 0.026):
        self.initial_capital = initial_capital
        self.slippage = slippage_pct / 100
        self.commission = commission_pct / 100
        self._load_state()

    def _load_state(self):
        if os.path.exists(PAPER_STATE_FILE):
            try:
                with open(PAPER_STATE_FILE) as f:
                    state = json.load(f)
                self.capital = state.get('capital', self.initial_capital)
                self.open_positions = state.get('open_positions', [])
                self.trade_history = state.get('trade_history', [])
                return
            except Exception:
                pass
        self.capital = self.initial_capital
        self.open_positions = []
        self.trade_history = []

    def _save_state(self):
        state = {
            'capital': self.capital,
            'open_positions': self.open_positions,
            'trade_history': self.trade_history,
        }
        try:
            os.makedirs(os.path.dirname(PAPER_STATE_FILE), exist_ok=True)
            with open(PAPER_STATE_FILE, 'w') as f:
                json.dump(state, f, default=str)
        except Exception:
            pass

    def open_position(self, action: str, entry_price: float, size: float,
                      sl: float, tp: float, confidence: float) -> dict:
        direction = 'long' if action == 'enter_long' else 'short'
        # Apply slippage
        fill = entry_price * (1 + self.slippage) if direction == 'long' else entry_price * (1 - self.slippage)
        fee = fill * size * self.commission
        trade = {
            'id': str(uuid.uuid4())[:8],
            'direction': direction,
            'entry': round(fill, 2),
            'size': size,
            'stop_loss': sl,
            'take_profit': tp,
            'initial_sl': sl,
            'at_breakeven': False,
            'confidence': confidence,
            'fee': round(fee, 4),
            'open_time': datetime.now(timezone.utc).isoformat(),
            'unrealised_pnl': 0.0,
            'highest_price': fill,
            'lowest_price': fill,
        }
        self.open_positions.append(trade)
        self._save_state()
        return trade

    def update_position(self, trade: dict, candle: dict, new_sl: float) -> dict:
        trade['stop_loss'] = round(new_sl, 2)
        price = candle['close']
        if trade['direction'] == 'long':
            trade['unrealised_pnl'] = round((price - trade['entry']) * trade['size'], 4)
            trade['highest_price'] = max(trade.get('highest_price', price), candle['high'])
        else:
            trade['unrealised_pnl'] = round((trade['entry'] - price) * trade['size'], 4)
            trade['lowest_price'] = min(trade.get('lowest_price', price), candle['low'])
        return trade

    def close_position(self, trade: dict, close_price: float, reason: str) -> dict:
        direction = trade['direction']
        fill = close_price * (1 - self.slippage) if direction == 'long' else close_price * (1 + self.slippage)
        fee = fill * trade['size'] * self.commission
        if direction == 'long':
            pnl = (fill - trade['entry']) * trade['size'] - trade['fee'] - fee
        else:
            pnl = (trade['entry'] - fill) * trade['size'] - trade['fee'] - fee

        closed = {
            **trade,
            'exit': round(fill, 2),
            'close_time': datetime.now(timezone.utc).isoformat(),
            'realised_pnl': round(pnl, 4),
            'pnl_pct': round(pnl / (trade['entry'] * trade['size']) * 100, 4),
            'close_reason': reason,
            'exit_fee': round(fee, 4),
        }
        self.capital += pnl
        self.capital = round(self.capital, 4)
        self.open_positions = [p for p in self.open_positions if p['id'] != trade['id']]
        self.trade_history.append(closed)
        self._save_state()
        return closed

    def get_equity(self) -> float:
        unrealised = sum(p.get('unrealised_pnl', 0) for p in self.open_positions)
        return round(self.capital + unrealised, 4)

    def get_open_positions(self) -> List[dict]:
        return self.open_positions

    def get_trade_history(self) -> List[dict]:
        return self.trade_history

    def reset(self):
        self.capital = self.initial_capital
        self.open_positions = []
        self.trade_history = []
        self._save_state()
