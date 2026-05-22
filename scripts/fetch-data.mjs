import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const STOCKS = ['VOO','QQQ','QQQM','NVDA','TSLA','GOOG','RKLB','CRCL','PLTR','MSTR','GLD'];

const CRYPTO_MAP = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  HYPE: 'hyperliquid',
  ZEC: 'zcash',
  TAO: 'bittensor',
  SKY: 'maker',
  AAVE: 'aave',
  BNB: 'binancecoin',
};

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

async function fetchStock(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  const q = await res.json();
  if (!q.c) throw new Error('no data');
  return {
    symbol,
    price: +q.c.toFixed(2),
    change_pct: +q.dp.toFixed(2),
  };
}

async function fetchCryptos() {
  const ids = Object.values(CRYPTO_MAP).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const data = await res.json();
  return Object.entries(CRYPTO_MAP).map(([symbol, id]) => ({
    symbol,
    price: data[id]?.usd ?? 0,
    change_pct: +(data[id]?.usd_24h_change ?? 0).toFixed(2),
  }));
}

async function main() {
  if (!FINNHUB_KEY) {
    console.error('Missing FINNHUB_API_KEY env var');
    process.exit(1);
  }

  console.log('Fetching stock data...');
  const stocks = [];
  for (const symbol of STOCKS) {
    try {
      const d = await fetchStock(symbol);
      stocks.push(d);
      console.log(`  ${d.symbol}: $${d.price} (${d.change_pct > 0 ? '+' : ''}${d.change_pct}%)`);
    } catch (e) {
      console.error(`  ${symbol}: FAILED - ${e.message}`);
      stocks.push({ symbol, price: 0, change_pct: 0, error: true });
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('Fetching crypto data...');
  let crypto = [];
  try {
    crypto = await fetchCryptos();
    for (const c of crypto) {
      console.log(`  ${c.symbol}: $${c.price} (${c.change_pct > 0 ? '+' : ''}${c.change_pct}%)`);
    }
  } catch (e) {
    console.error(`  Crypto fetch failed: ${e.message}`);
  }

  const result = { updated_at: new Date().toISOString(), stocks, crypto };

  const dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'market.json'), JSON.stringify(result, null, 2));
  console.log('\nDone. Written to data/market.json');
}

main().catch(e => { console.error(e); process.exit(1); });
