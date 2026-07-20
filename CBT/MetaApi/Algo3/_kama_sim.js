// Offline KAMA seeding sensitivity check.
// Reads a JSON dump of Tickmill 1m candles (from /api/metaapi/test-candles?debug=1)
// and computes p1 at the target bar under two KAMA seed policies:
//   variant 'zero': ama = 0             (current algo3 behavior)
//   variant 'src0': ama = s[0]          (Pine-Script canonical seed)
// Prints p1, p2, p3 for the target bar under both variants, plus the delta.

'use strict';
const fs = require('fs');

const RF_SAMPLING_PERIOD = 100;
const RF_MULT            = 3.0;

function pineEma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(0);
  if (n === 0) return out;
  const k = 2 / (period + 1);
  let val = values[0];
  out[0] = val;
  for (let i = 1; i < n; i++) {
    val = values[i] * k + val * (1 - k);
    out[i] = val;
  }
  return out;
}

function kama(s, len, variant) {
  const n = s.length;
  const out = new Array(n).fill(0);
  const fastend = 0.666;
  const slowend = 0.0645;
  const xvnoise = new Array(n).fill(0);
  for (let i = 1; i < n; i++) xvnoise[i] = Math.abs(s[i] - s[i - 1]);

  let noiseSum = 0;
  let ama = variant === 'src0' ? (s[0] || 0) : 0;
  for (let i = 0; i < n; i++) {
    if (i >= len) noiseSum -= xvnoise[i - len];
    noiseSum += xvnoise[i];
    let ratio = 0;
    if (i >= len && noiseSum > 0) {
      ratio = Math.abs(s[i] - s[i - len]) / noiseSum;
    }
    const smooth = Math.pow(ratio * (fastend - slowend) + slowend, 2);
    ama = ama + smooth * (s[i] - ama);
    out[i] = ama;
  }
  return out;
}

function computeP123(candles, variant) {
  const src = candles.map(c => c.close);
  const ohlc4 = candles.map(c => (c.open + c.high + c.low + c.close) / 4);
  const kamas = {};
  for (const p of [5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,100]) {
    kamas[p] = kama(ohlc4, p, variant);
  }
  const n = candles.length;
  const totalDistance = new Array(n);
  for (let i = 0; i < n; i++) {
    totalDistance[i] = (
      (kamas[5][i]  - kamas[10][i])  / kamas[10][i] +
      (kamas[10][i] - kamas[15][i])  / kamas[15][i] +
      (kamas[15][i] - kamas[20][i])  / kamas[20][i] +
      (kamas[20][i] - kamas[25][i])  / kamas[25][i] +
      (kamas[25][i] - kamas[30][i])  / kamas[30][i] +
      (kamas[30][i] - kamas[35][i])  / kamas[35][i] +
      (kamas[35][i] - kamas[40][i])  / kamas[40][i] +
      (kamas[40][i] - kamas[45][i])  / kamas[45][i] +
      (kamas[45][i] - kamas[50][i])  / kamas[50][i] +
      (kamas[50][i] - kamas[55][i])  / kamas[55][i] +
      (kamas[55][i] - kamas[60][i])  / kamas[60][i] +
      (kamas[60][i] - kamas[65][i])  / kamas[65][i] +
      (kamas[65][i] - kamas[70][i])  / kamas[70][i] +
      (kamas[70][i] - kamas[75][i])  / kamas[75][i] +
      (kamas[75][i] - kamas[80][i])  / kamas[80][i] +
      (kamas[80][i] - kamas[85][i])  / kamas[85][i] +
      (kamas[85][i] - kamas[90][i])  / kamas[90][i] +
      (kamas[90][i] - kamas[100][i]) / kamas[100][i]
    ) / 18;
  }
  const p1 = kama(src, 100, variant);
  const p2 = new Array(n);
  for (let i = 0; i < n; i++) p2[i] = p1[i] * (1 + totalDistance[i] * 10);
  const p3 = kama(p2, 10, variant);
  return { p1, p2, p3 };
}

const path = process.argv[2];
const targetTime = parseInt(process.argv[3], 10);
if (!path || !targetTime) {
  console.error('usage: node _kama_sim.js <candles.json> <targetTimeMs>');
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
const candles = (raw.candles || raw).slice().sort((a,b) => a.time - b.time);
const idx = candles.findIndex(c => c.time === targetTime);
if (idx < 0) {
  console.error(`target ${targetTime} not found; range [${candles[0].time}..${candles[candles.length-1].time}]`);
  process.exit(2);
}
console.log(`candles: ${candles.length}, target idx: ${idx} (${new Date(targetTime).toISOString()})`);
console.log(`target OHLC: O=${candles[idx].open} H=${candles[idx].high} L=${candles[idx].low} C=${candles[idx].close}`);

for (const variant of ['zero', 'src0']) {
  const r = computeP123(candles, variant);
  console.log(`\n[${variant}] p1=${r.p1[idx].toFixed(4)}  p2=${r.p2[idx].toFixed(4)}  p3=${r.p3[idx].toFixed(4)}`);
}
