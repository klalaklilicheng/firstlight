import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const STOCKS = ['VOO','QQQ','QQQM','NVDA','TSLA','GOOG','RKLB','CRCL','PLTR','MSTR','GLD'];

const CRYPTO_MAP = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', HYPE: 'hyperliquid',
  ZEC: 'zcash', TAO: 'bittensor', SKY: 'maker', AAVE: 'aave', BNB: 'binancecoin',
};

const IPO_WATCHLIST = [
  { name: 'SpaceX', keywords: ['spacex'] },
  { name: 'Anthropic', keywords: ['anthropic'] },
  { name: 'OpenAI', keywords: ['openai'] },
  { name: 'Unitree', keywords: ['unitree', 'robotics ipo'] },
  { name: 'LandSpace', keywords: ['landspace', 'zhuque'] },
  { name: 'Galactic Energy', keywords: ['galactic energy'] },
  { name: 'iSpace', keywords: ['ispace china', 'interstellar glory'] },
  { name: 'BrainCo', keywords: ['brainco'] },
];

const FOMC_DATES = [
  '2025-01-29','2025-03-19','2025-05-07','2025-06-18',
  '2025-07-30','2025-09-17','2025-10-29','2025-12-10',
  '2026-01-28','2026-03-18','2026-04-29','2026-06-17',
  '2026-07-29','2026-09-16','2026-10-28','2026-12-09',
];

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const delay = ms => new Promise(r => setTimeout(r, ms));

async function finnhub(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://finnhub.io/api/v1${path}${sep}token=${FINNHUB_KEY}`);
  if (!res.ok) throw new Error(`Finnhub ${path}: ${res.status}`);
  await delay(1100);
  return res.json();
}

// --- Stock quotes ---
async function fetchStocks() {
  const stocks = [];
  for (const symbol of STOCKS) {
    try {
      const q = await finnhub(`/quote?symbol=${symbol}`);
      if (!q.c) throw new Error('no data');
      stocks.push({ symbol, price: +q.c.toFixed(2), change_pct: +q.dp.toFixed(2) });
    } catch (e) {
      console.error(`  ${symbol}: FAILED - ${e.message}`);
      stocks.push({ symbol, price: 0, change_pct: 0, error: true });
    }
  }
  return stocks;
}

// --- Crypto prices ---
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

// --- Earnings calendar + history ---
async function fetchEarnings() {
  const today = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

  let upcoming = {};
  try {
    const cal = await finnhub(`/calendar/earnings?from=${today}&to=${future}`);
    for (const e of cal.earningsCalendar || []) {
      if (STOCKS.includes(e.symbol) && !upcoming[e.symbol]) {
        upcoming[e.symbol] = { date: e.date, quarter: e.quarter, year: e.year,
          eps_estimate: e.epsEstimate, revenue_estimate: e.revenueEstimate };
      }
    }
  } catch (e) {
    console.error(`  Earnings calendar: ${e.message}`);
  }

  const earnings = {};
  for (const symbol of STOCKS) {
    try {
      const hist = await finnhub(`/stock/earnings?symbol=${symbol}&limit=4`);
      earnings[symbol] = {
        next: upcoming[symbol] || null,
        history: (hist || []).map(h => ({
          period: h.period, quarter: h.quarter, year: h.year,
          actual: h.actual, estimate: h.estimate,
          surprise_pct: h.surprisePercent,
        })),
      };
    } catch (e) {
      console.error(`  ${symbol} earnings: ${e.message}`);
      earnings[symbol] = { next: null, history: [] };
    }
  }
  return earnings;
}

// --- News (company + crypto + general) ---
async function fetchNews() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const news = [];

  for (const symbol of STOCKS) {
    try {
      const items = await finnhub(`/company-news?symbol=${symbol}&from=${weekAgo}&to=${today}`);
      for (const n of (items || []).slice(0, 3)) {
        news.push({ symbols: [symbol], headline: n.headline, summary: (n.summary || '').slice(0, 200),
          url: n.url, source: n.source, datetime: n.datetime });
      }
    } catch (e) {
      console.error(`  ${symbol} news: ${e.message}`);
    }
  }

  try {
    const crypto = await finnhub('/news?category=crypto');
    const cryptoSymbols = Object.keys(CRYPTO_MAP);
    for (const n of (crypto || []).slice(0, 20)) {
      const text = `${n.headline} ${n.summary}`.toLowerCase();
      const matched = cryptoSymbols.filter(s =>
        text.includes(s.toLowerCase()) || text.includes(CRYPTO_MAP[s]));
      if (matched.length) {
        news.push({ symbols: matched, headline: n.headline, summary: (n.summary || '').slice(0, 200),
          url: n.url, source: n.source, datetime: n.datetime });
      }
    }
  } catch (e) {
    console.error(`  Crypto news: ${e.message}`);
  }

  news.sort((a, b) => b.datetime - a.datetime);
  return news.slice(0, 30);
}

// --- IPO watch ---
async function fetchIPONews() {
  let allNews = [];
  try {
    const general = await finnhub('/news?category=general');
    allNews = general || [];
  } catch (e) {
    console.error(`  General news: ${e.message}`);
  }

  const ipo = [];
  for (const company of IPO_WATCHLIST) {
    const matched = allNews.filter(n => {
      const text = `${n.headline} ${n.summary}`.toLowerCase();
      return company.keywords.some(kw => text.includes(kw));
    }).slice(0, 3).map(n => ({
      headline: n.headline, url: n.url, datetime: n.datetime,
    }));
    ipo.push({ company: company.name, news: matched });
  }
  return ipo;
}

// --- FOMC ---
function buildFOMC() {
  const today = new Date().toISOString().slice(0, 10);
  const next = FOMC_DATES.find(d => d >= today);
  const daysUntil = next ? Math.ceil((new Date(next) - new Date(today)) / 86400000) : null;
  return {
    next: next ? { date: next, days_until: daysUntil } : null,
    schedule: FOMC_DATES,
  };
}

// --- Main ---
async function main() {
  if (!FINNHUB_KEY) { console.error('Missing FINNHUB_API_KEY'); process.exit(1); }

  console.log('Fetching stocks...');
  const stocks = await fetchStocks();
  stocks.forEach(s => console.log(`  ${s.symbol}: $${s.price} (${s.change_pct > 0 ? '+' : ''}${s.change_pct}%)`));

  console.log('Fetching crypto...');
  const crypto = await fetchCryptos();
  crypto.forEach(c => console.log(`  ${c.symbol}: $${c.price} (${c.change_pct > 0 ? '+' : ''}${c.change_pct}%)`));

  console.log('Fetching earnings...');
  const earnings = await fetchEarnings();

  console.log('Fetching news...');
  const news = await fetchNews();
  console.log(`  ${news.length} news items`);

  console.log('Fetching IPO watch...');
  const ipo_watch = await fetchIPONews();
  ipo_watch.forEach(i => console.log(`  ${i.company}: ${i.news.length} articles`));

  console.log('Building FOMC calendar...');
  const fomc = buildFOMC();
  console.log(`  Next: ${fomc.next?.date} (${fomc.next?.days_until} days)`);

  const result = { updated_at: new Date().toISOString(), stocks, crypto, earnings, news, ipo_watch, fomc };

  const dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'market.json'), JSON.stringify(result, null, 2));
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
