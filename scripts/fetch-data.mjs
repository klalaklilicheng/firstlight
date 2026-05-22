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
  SKY: 'sky',
  AAVE: 'aave',
  BNB: 'binancecoin',
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchStock(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status}`);
  const json = await res.json();
  const meta = json.chart.result[0].meta;
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  return {
    symbol,
    price: +price.toFixed(2),
    change_pct: prev ? +((price - prev) / prev * 100).toFixed(2) : 0,
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
    await new Promise(r => setTimeout(r, 300));
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
