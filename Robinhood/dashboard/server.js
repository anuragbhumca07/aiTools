'use strict';

const express = require('express');
const path    = require('path');

const PORT = parseInt(process.env.PORT || '4000', 10);
const app  = express();

app.use(express.static(path.join(__dirname)));

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'robinhood-hub', port: PORT }));

app.get('/api/algos', (_, res) => res.json([
  { symbol: 'BTCUSDT',  name: 'Bitcoin',  ticker: 'BTC',  icon: '₿', port: 4001, color: '#f7931a' },
  { symbol: 'ETHUSDT',  name: 'Ethereum', ticker: 'ETH',  icon: 'Ξ', port: 4002, color: '#627eea' },
  { symbol: 'SOLUSDT',  name: 'Solana',   ticker: 'SOL',  icon: '◎', port: 4003, color: '#9945ff' },
  { symbol: 'DOGEUSDT', name: 'Dogecoin', ticker: 'DOGE', icon: 'Ð', port: 4004, color: '#c3a634' },
  { symbol: 'XRPUSDT',  name: 'XRP',      ticker: 'XRP',  icon: '◈', port: 4005, color: '#00aae4' },
  { symbol: 'ADAUSDT',  name: 'Cardano',  ticker: 'ADA',  icon: '✦', port: 4006, color: '#0033ad' },
]));

app.listen(PORT, () =>
  console.log(`Robinhood Hub Dashboard listening on http://localhost:${PORT}`)
);
