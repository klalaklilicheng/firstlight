import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const STOCKS = ['VOO','QQQ','QQQM','NVDA','TSLA','GOOG','RKLB','CRCL','PLTR','MSTR','GLD'];
const ETFS = new Set(['VOO','QQQ','QQQM','GLD']);
const EARNINGS_STOCKS = STOCKS.filter(s => !ETFS.has(s));

const CRYPTO_MAP = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', HYPE: 'hyperliquid',
  ZEC: 'zcash', TAO: 'bittensor', SKY: 'maker', AAVE: 'aave', BNB: 'binancecoin',
};

const IPO_WATCHLIST = [
  { name: 'SpaceX', zh: 'SpaceX', keywords: ['spacex'] },
  { name: 'Anthropic', zh: 'Anthropic', keywords: ['anthropic'] },
  { name: 'OpenAI', zh: 'OpenAI', keywords: ['openai'] },
  { name: 'Unitree', zh: '宇树科技', keywords: ['unitree', 'robotics ipo'] },
  { name: 'LandSpace', zh: '蓝箭航天', keywords: ['landspace', 'zhuque'] },
  { name: 'Galactic Energy', zh: '星河动力', keywords: ['galactic energy'] },
  { name: 'iSpace', zh: '星际荣耀', keywords: ['ispace china', 'interstellar glory'] },
  { name: 'BrainCo', zh: '强脑科技', keywords: ['brainco'] },
];

const FOMC_DATES = [
  '2025-01-29','2025-03-19','2025-05-07','2025-06-18',
  '2025-07-30','2025-09-17','2025-10-29','2025-12-10',
  '2026-01-28','2026-03-18','2026-04-29','2026-06-17',
  '2026-07-29','2026-09-16','2026-10-28','2026-12-09',
];

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const delay = ms => new Promise(r => setTimeout(r, ms));

// --- Translation (Google Translate free endpoint, runs server-side in Actions) ---
async function translateToZh(texts) {
  if (!texts.length) return texts;
  const results = [...texts];
  for (let i = 0; i < texts.length; i += 5) {
    const batch = texts.slice(i, i + 5).map(t => (t || '').slice(0, 300));
    try {
      const q = batch.join('\n||\n');
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(q)}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const full = data[0].map(s => s[0]).join('');
      const parts = full.split(/\n?\|\|\n?/);
      if (parts.length === batch.length) {
        parts.forEach((p, j) => { results[i + j] = p.trim() || results[i + j]; });
      }
    } catch { /* keep original on failure */ }
    await delay(300);
  }
  return results;
}

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

// --- Earnings calendar + history (individual stocks only, no ETFs) ---
function estimateNext(history) {
  if (!history.length) return null;
  const h = history[0];
  const p = new Date(h.period);
  p.setMonth(p.getMonth() + 3);
  const report = new Date(p); report.setDate(report.getDate() + 50);
  const nq = h.quarter % 4 + 1;
  const ny = nq === 1 ? h.year + 1 : h.year;
  return { date: report.toISOString().slice(0, 10), quarter: nq, year: ny, is_estimate: true };
}

function genComment(history) {
  if (!history.length) return '';
  const beats = history.filter(h => (h.surprise_pct ?? 0) > 0).length;
  const latest = history[0];
  const sp = latest.surprise_pct;
  let c = '';
  if (beats === history.length && history.length >= 3) c = `连续${beats}季超预期`;
  else if (beats === 0 && history.length >= 2) c = `连续${history.length}季不及预期`;
  else c = sp > 0 ? '上季超预期' : sp < 0 ? '上季不及预期' : '上季持平';
  if (sp != null) c += ` (${sp > 0 ? '+' : ''}${sp.toFixed(1)}%)`;
  return c;
}

async function fetchEarnings() {
  const today = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

  let upcoming = {};
  try {
    const cal = await finnhub(`/calendar/earnings?from=${today}&to=${future}`);
    for (const e of cal.earningsCalendar || []) {
      if (EARNINGS_STOCKS.includes(e.symbol) && !upcoming[e.symbol]) {
        upcoming[e.symbol] = { date: e.date, quarter: e.quarter, year: e.year,
          eps_estimate: e.epsEstimate, revenue_estimate: e.revenueEstimate };
      }
    }
  } catch (e) {
    console.error(`  Earnings calendar: ${e.message}`);
  }

  const earnings = {};
  for (const symbol of EARNINGS_STOCKS) {
    try {
      const hist = await finnhub(`/stock/earnings?symbol=${symbol}&limit=4`);
      const history = (hist || []).map(h => ({
        period: h.period, quarter: h.quarter, year: h.year,
        actual: h.actual, estimate: h.estimate,
        surprise_pct: h.surprisePercent,
      }));
      earnings[symbol] = {
        next: upcoming[symbol] || estimateNext(history),
        history,
        comment: genComment(history),
      };
    } catch (e) {
      console.error(`  ${symbol} earnings: ${e.message}`);
      earnings[symbol] = { next: null, history: [], comment: '' };
    }
  }
  return earnings;
}

// --- Market news (Finnhub general + crypto) ---
let _newsCache = null;
async function fetchAllNews() {
  if (_newsCache) return _newsCache;
  const general = await finnhub('/news?category=general').catch(() => []);
  const crypto = await finnhub('/news?category=crypto').catch(() => []);
  _newsCache = [...(general || []), ...(crypto || [])]
    .filter(n => !n.url?.includes('news.google.com'))
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
  return _newsCache;
}

async function fetchMarketNews() {
  try {
    const all = await fetchAllNews();
    const items = all.slice(0, 30).map(n => ({
      headline: n.headline,
      summary: n.summary || '',
      source: n.source || '',
      url: n.url || '',
      datetime: n.datetime || 0,
      category: n.category || '',
      related: n.related || '',
    }));
    // Translate headlines and summaries to Chinese
    console.log('  Translating headlines...');
    const zhH = await translateToZh(items.map(n => n.headline));
    console.log('  Translating summaries...');
    const zhS = await translateToZh(items.map(n => n.summary));
    items.forEach((n, i) => { n.headline = zhH[i]; n.summary = zhS[i]; });
    return items;
  } catch (e) {
    console.error(`  Market news: ${e.message}`);
    return [];
  }
}

// --- IPO watch (reuses shared news cache) ---
async function fetchIPONews() {
  const allNews = await fetchAllNews().catch(() => []);
  const ipo = [];
  for (const company of IPO_WATCHLIST) {
    const matched = allNews.filter(n => {
      const text = `${n.headline} ${n.summary}`.toLowerCase();
      return company.keywords.some(kw => text.includes(kw));
    }).slice(0, 3).map(n => ({
      headline: n.headline, url: n.url, datetime: n.datetime,
    }));
    ipo.push({ company: company.zh, news: matched });
  }
  // Translate matched IPO news headlines
  const allH = ipo.flatMap(i => i.news.map(n => n.headline));
  if (allH.length) {
    const zhH = await translateToZh(allH);
    let k = 0;
    for (const i of ipo) for (const n of i.news) n.headline = zhH[k++];
  }
  return ipo;
}

// --- BTC cycle score ---
async function fetchBTCScore() {
  try {
    const res = await fetch('https://brief.day1global.xyz/api/btc-score');
    if (!res.ok) throw new Error(`${res.status}`);
    const d = await res.json();
    return {
      score: d.score, level: d.level, suggestion: d.suggestion,
      daily_score: d.dailyScore, weekly_score: d.weeklyScore,
      btc_price: d.btcPrice, fear_greed: d.fearGreed,
      indicators: (d.indicators || []).map(i => ({
        name: i.name, value: i.value, score: i.score, weight: i.weight, group: i.group,
      })),
    };
  } catch (e) {
    console.error(`  BTC score: ${e.message}`);
    return null;
  }
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

// --- Twitter (server-side fetch via syndication API) ---
const TWITTER_HANDLES = ['cburniske', 'QwQiao', 'saylor', 'viktorfischer'];

async function fetchTweets() {
  const result = {};
  for (const handle of TWITTER_HANDLES) {
    try {
      const res = await fetch(
        `https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}?showReplies=false`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
      if (!match) throw new Error('no __NEXT_DATA__');
      const data = JSON.parse(match[1]);
      const entries = data?.props?.pageProps?.timeline?.entries || [];
      const tweets = entries
        .filter(e => e.type === 'tweet' && e.content?.tweet)
        .map(e => {
          const t = e.content.tweet;
          return {
            text: t.text || t.full_text || '',
            url: `https://x.com/${handle}/status/${t.id_str}`,
            time: t.created_at || '',
            likes: t.favorite_count || 0,
            retweets: t.retweet_count || 0,
          };
        })
        .sort((a, b) => new Date(b.time) - new Date(a.time))
        .slice(0, 5);
      result[handle] = tweets;
      console.log(`  @${handle}: ${tweets.length} tweets`);
    } catch (e) {
      console.error(`  @${handle}: FAILED - ${e.message}`);
      result[handle] = [];
    }
    await delay(1000);
  }
  return result;
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

  console.log('Fetching market news...');
  const news = await fetchMarketNews();
  console.log(`  ${news.length} articles`);

  console.log('Fetching IPO watch...');
  const ipo_watch = await fetchIPONews();
  ipo_watch.forEach(i => console.log(`  ${i.company}: ${i.news.length} articles`));

  console.log('Fetching BTC cycle score...');
  const btc_score = await fetchBTCScore();
  if (btc_score) console.log(`  Score: ${btc_score.score} (${btc_score.level})`);

  console.log('Building FOMC calendar...');
  const fomc = buildFOMC();
  console.log(`  Next: ${fomc.next?.date} (${fomc.next?.days_until} days)`);

  console.log('Fetching tweets...');
  const tweets = await fetchTweets();

  const result = { updated_at: new Date().toISOString(), stocks, crypto, earnings, news, ipo_watch, btc_score, fomc, tweets };

  const dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'market.json'), JSON.stringify(result, null, 2));
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
