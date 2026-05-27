'use strict';

const { generateSignal, checkExit, fetchCandlesHistorical } = require('./algo');

async function runBacktest(symbol, timeframe, months) {
  const allCandles = await fetchCandlesHistorical(symbol, timeframe, months);
  if (allCandles.length < 210) {
    throw new Error(`Need 210+ candles. Got ${allCandles.length}`);
  }

  const WINDOW = 250;
  let balance = 10000;
  const initialBalance = 10000;
  let pos = null, peakBal = balance, maxDD = 0;
  const trades = [];
  let wins = 0;
  const COOLDOWN_BARS     = 6;
  const RSI_COOLDOWN_BARS = 15; // RSI extreme exit zones stay "hot" for 2.5 days on 4h
  let lastPhase1ExitBar  = -COOLDOWN_BARS;
  let lastPhase1ExitSide = null;
  let lastRsiExitBar     = -RSI_COOLDOWN_BARS;
  let lastRsiExitSide    = null;

  for (let i = WINDOW; i < allCandles.length; i++) {
    const seg   = allCandles.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const price = allCandles[i].close;

    if (pos) {
      const ex = checkExit(pos, seg);
      if (ex.exit) {
        const reason0 = ex.reasons[0] || '';
        let exitPrice = price;
        if (reason0.startsWith('SL hit')) exitPrice = pos.stopLoss;
        else if (reason0.startsWith('TP hit')) exitPrice = pos.takeProfit;

        const pnl = pos.side === 'long'
          ? (exitPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - exitPrice) * pos.size;
        balance += pnl;
        if (pnl > 0) wins++;
        if (balance > peakBal) peakBal = balance;
        const dd = peakBal - balance;
        if (dd > maxDD) maxDD = dd;

        if (reason0.startsWith('SL hit (Phase 1)') || reason0.startsWith('SL hit (Phase 2)')) {
          lastPhase1ExitBar  = i;
          lastPhase1ExitSide = pos.side;
        }
        // RSI extreme exits mark a momentum-exhausted zone; use longer cooldown (15 bars = 2.5d on 4h)
        if ((reason0.includes('RSI overbought') && pos.side === 'long') ||
            (reason0.includes('RSI oversold')   && pos.side === 'short')) {
          lastRsiExitBar  = i;
          lastRsiExitSide = pos.side;
        }

        const dateStr = new Date(allCandles[i].time).toISOString().slice(0, 10);
        const tag = pnl < 0 ? ' *** LOSS ***' : '';
        console.log(`  pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} ph=${pos.phase} ${dateStr} ${pos.side.toUpperCase()} entry=${pos.entryPrice.toFixed(2)} exit=${exitPrice.toFixed(2)} reason: ${reason0}${tag}`);

        trades.push({ side: pos.side, entryPrice: pos.entryPrice, exitPrice, pnl, balance, reason: reason0, phase: pos.phase });
        pos = null;
      } else {
        const unreal = pos.side === 'long'
          ? (price - pos.entryPrice) * pos.size
          : (pos.entryPrice - price) * pos.size;
        if (unreal < (pos.mae || 0)) pos.mae = unreal;
      }
    }

    if (!pos) {
      const sig = generateSignal(seg);
      if (sig.signal === 'BUY' || sig.signal === 'SELL') {
        const newSide = sig.signal === 'BUY' ? 'long' : 'short';
        const inCooldown    = lastPhase1ExitSide === newSide && (i - lastPhase1ExitBar) < COOLDOWN_BARS;
        const inRsiCooldown = lastRsiExitSide    === newSide && (i - lastRsiExitBar)    < RSI_COOLDOWN_BARS;
        if (inCooldown || inRsiCooldown) continue;

        const { atr } = sig.indicators;
        const stopDist = Math.max(2.5 * atr, price * 0.0025);
        const riskAmt  = Math.min(balance * 0.015, 150);
        const size     = riskAmt / stopDist;
        pos = {
          side: newSide, entryPrice: price, size,
          stopLoss:   newSide === 'long' ? price - stopDist : price + stopDist,
          takeProfit: newSide === 'long' ? price + stopDist * 3 : price - stopDist * 3,
          entryTime:  allCandles[i].time,
          phase: 1, candlesHeld: 0, lastCandleTime: null, mae: 0,
        };
        const dateStr = new Date(allCandles[i].time).toISOString().slice(0, 10);
        console.log(`  ENTRY ${newSide.toUpperCase()} @ ${price.toFixed(2)} on ${dateStr}  score=B:${sig.buyScore} S:${sig.sellScore}`);
      }
    }
  }

  const total  = trades.length;
  const netPnl = balance - initialBalance;
  console.log(`\n  SUMMARY: WR=${total > 0 ? ((wins/total)*100).toFixed(1) : 0}% trades=${total} PnL=$${netPnl.toFixed(2)} maxDD=$${maxDD.toFixed(1)}`);
}

async function main() {
  const pairs = [
    ['BTCUSDT', '4h', 12],
    ['ETHUSDT', '4h', 12],
    ['SOLUSDT', '4h', 12],
    ['BTCUSDT', '4h', 6],
    ['ETHUSDT', '4h', 6],
    ['SOLUSDT', '4h', 6],
  ];
  for (const [sym, tf, mo] of pairs) {
    console.log(`\n=== ${sym} ${tf} ${mo}mo ===`);
    try { await runBacktest(sym, tf, mo); }
    catch (e) { console.log(`  ERROR: ${e.message}`); }
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(console.error);
