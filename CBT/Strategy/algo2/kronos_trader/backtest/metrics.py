"""Backtest performance metrics."""
import math
import pandas as pd
import numpy as np
from dataclasses import dataclass
from typing import List


@dataclass
class BacktestMetrics:
    total_trades: int
    winning_trades: int
    losing_trades: int
    win_rate: float
    profit_factor: float
    total_return_pct: float
    max_drawdown_pct: float
    sharpe_ratio: float
    sortino_ratio: float
    calmar_ratio: float
    avg_win_pct: float
    avg_loss_pct: float
    avg_rr_ratio: float
    best_trade_pct: float
    worst_trade_pct: float
    avg_hold_candles: float
    final_capital: float
    equity_curve: List[float]


def compute_metrics(trades: List[dict], initial_capital: float = 10000.0) -> BacktestMetrics:
    if not trades:
        return BacktestMetrics(
            total_trades=0, winning_trades=0, losing_trades=0,
            win_rate=0, profit_factor=0, total_return_pct=0,
            max_drawdown_pct=0, sharpe_ratio=0, sortino_ratio=0,
            calmar_ratio=0, avg_win_pct=0, avg_loss_pct=0, avg_rr_ratio=0,
            best_trade_pct=0, worst_trade_pct=0, avg_hold_candles=0,
            final_capital=initial_capital, equity_curve=[initial_capital]
        )

    pnls = [t['realised_pnl'] for t in trades]
    pnl_pcts = [t.get('pnl_pct', 0) for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]

    # Equity curve
    capital = initial_capital
    equity = [capital]
    for p in pnls:
        capital += p
        equity.append(round(capital, 2))

    # Drawdown
    peak = initial_capital
    max_dd = 0.0
    for e in equity:
        if e > peak:
            peak = e
        dd = (peak - e) / peak if peak > 0 else 0
        max_dd = max(max_dd, dd)

    # Sharpe (using per-trade returns)
    returns = np.array(pnl_pcts) / 100
    mean_r = returns.mean() if len(returns) > 0 else 0
    std_r = returns.std() if len(returns) > 1 else 1e-9
    sharpe = (mean_r / std_r * math.sqrt(252)) if std_r > 0 else 0

    # Sortino
    downside = returns[returns < 0]
    downside_std = downside.std() if len(downside) > 1 else 1e-9
    sortino = (mean_r / downside_std * math.sqrt(252)) if downside_std > 0 else 0

    profit_factor = abs(sum(wins)) / abs(sum(losses)) if losses and sum(losses) != 0 else 999.0

    total_return = (equity[-1] - initial_capital) / initial_capital * 100
    calmar = total_return / (max_dd * 100) if max_dd > 0 else 999.0

    avg_hold = np.mean([t.get('hold_candles', 1) for t in trades])

    return BacktestMetrics(
        total_trades=len(trades),
        winning_trades=len(wins),
        losing_trades=len(losses),
        win_rate=round(len(wins) / len(trades), 4),
        profit_factor=round(profit_factor, 4),
        total_return_pct=round(total_return, 4),
        max_drawdown_pct=round(max_dd * 100, 4),
        sharpe_ratio=round(sharpe, 4),
        sortino_ratio=round(sortino, 4),
        calmar_ratio=round(calmar, 4),
        avg_win_pct=round(np.mean([t.get('pnl_pct', 0) for t in trades if t['realised_pnl'] > 0]), 4) if wins else 0,
        avg_loss_pct=round(np.mean([t.get('pnl_pct', 0) for t in trades if t['realised_pnl'] <= 0]), 4) if losses else 0,
        avg_rr_ratio=round(abs(np.mean([t.get('pnl_pct', 0) for t in trades if t['realised_pnl'] > 0])) /
                           (abs(np.mean([t.get('pnl_pct', 0) for t in trades if t['realised_pnl'] <= 0])) + 1e-9), 4) if wins and losses else 0,
        best_trade_pct=round(max(pnl_pcts), 4) if pnl_pcts else 0,
        worst_trade_pct=round(min(pnl_pcts), 4) if pnl_pcts else 0,
        avg_hold_candles=round(avg_hold, 2),
        final_capital=round(equity[-1], 2),
        equity_curve=equity,
    )
