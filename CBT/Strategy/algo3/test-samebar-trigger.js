'use strict';
// Test: prove that when the flag candle itself closes above p2/p3 (long) or
// below p2/p3 (short), generateSignal fires BUY/SELL on that same bar with
// `sameBarFlag: true` in the entryHint.
//
// Uses REAL Kraken data (BTC 1h, 3 months) so RF and KAMA are realistic.
// Walks the history looking for the first bar where a same-bar flag+trigger
// could fire (flag freshly formed + close outside cloud on same bar) and
// asserts that generateSignal picks it up.

const { generateSignal, computeSeries, fetchCandlesHistorical, WARMUP_BARS } = require('./algo');

function findSameBarLongCandidates(series, candles) {
  const hits = [];
  for (let i = WARMUP_BARS + 5; i < candles.length; i++) {
    const c = candles[i];
    const bz = series.buyZone[i];
    if (!bz) continue;
    // Flag would form only if flag wasn't already alive last bar (i.e. this is FIRST buyZone bar OR low is first to touch cloud since prev clear).
    // Cheap proxy: cloud-touching bar right after a non-buyZone bar.
    if (series.buyZone[i - 1]) continue;
    if (c.low > series.cloudTop[i]) continue;
    if (c.close <= series.p2[i]) continue;
    if (c.close <= series.p3[i]) continue;
    hits.push(i);
  }
  return hits;
}
function findSameBarShortCandidates(series, candles) {
  const hits = [];
  for (let i = WARMUP_BARS + 5; i < candles.length; i++) {
    const c = candles[i];
    const sz = series.sellZone[i];
    if (!sz) continue;
    if (series.sellZone[i - 1]) continue;
    if (c.high < series.cloudBot[i]) continue;
    if (c.close >= series.p2[i]) continue;
    if (c.close >= series.p3[i]) continue;
    hits.push(i);
  }
  return hits;
}

async function main() {
  console.log('Fetching 3 months of BTCUSDT 1h from Kraken (this takes ~5s)…');
  const candles = await fetchCandlesHistorical('BTCUSDT', '1h', 3);
  console.log(`Got ${candles.length} candles.`);
  const series = computeSeries(candles);

  const longHits  = findSameBarLongCandidates(series, candles);
  const shortHits = findSameBarShortCandidates(series, candles);
  console.log(`Found ${longHits.length} candidate LONG same-bar flag+trigger bars, ${shortHits.length} SHORT.`);

  let checked = 0, samebarFired = 0;
  const details = [];

  function assertAt(iBar, expectedSide) {
    // Replay by feeding the full series up to iBar to generateSignal, starting
    // with empty flag state on the immediately preceding zone-flip so the flag
    // hasn't been "carried" from earlier. Simpler: just start with empty state
    // on bar iBar-1 (previous bar was NOT in the same zone by construction),
    // so at iBar the flag is created from scratch.
    const seg = candles.slice(0, iBar + 1);
    const sig = generateSignal(seg, {});
    checked++;
    const ok = sig.entryHint && sig.entryHint.sameBarFlag === true
              && sig.entryHint.side === expectedSide;
    if (ok) samebarFired++;
    details.push({ i: iBar, side: expectedSide, signal: sig.signal, sameBarFlag: sig.entryHint && sig.entryHint.sameBarFlag });
    return ok;
  }

  // Check up to 5 of each side to keep output short.
  for (const i of longHits.slice(0, 5))  assertAt(i, 'long');
  for (const i of shortHits.slice(0, 5)) assertAt(i, 'short');

  console.log(`\nChecked ${checked} candidates, ${samebarFired} confirmed same-bar flag+trigger.`);
  details.forEach(d => console.log(`  bar #${d.i}  side=${d.side}  signal=${d.signal}  sameBarFlag=${d.sameBarFlag}`));

  const pass = checked > 0 && samebarFired === checked;
  console.log(pass ? '\n✓ PASS — all same-bar candidates fired correctly'
                   : '\n✗ FAIL — some candidates did not fire (see details above)');
  process.exit(pass ? 0 : (checked === 0 ? 0 : 1));
}

main().catch(err => { console.error(err); process.exit(1); });
