import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const STOCKS = ['VOO','QQQ','QQQM','NVDA','TSLA','GOOG','RKLB','CRCL','PLTR','MSTR','GLD','LKNCY'];
const ETFS = new Set(['VOO','QQQ','QQQM','GLD']);
const EARNINGS_STOCKS = STOCKS.filter(s => !ETFS.has(s));

const CRYPTO_MAP = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', HYPE: 'hyperliquid',
  ZEC: 'zcash', TAO: 'bittensor', SKY: 'maker', AAVE: 'aave', BNB: 'binancecoin',
  NEAR: 'near', DOGE: 'dogecoin', SPACEX: 'spacex-prestocks-2',
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

// --- Portfolio news (headline-only matching for high relevance) ---
const PF_STOCKS = ['NVDA','GOOG','TSLA','CRCL','LKNCY'];
// Crypto: match ONLY in headline for precision. Use full names to avoid false positives.
const PF_CRYPTO_HEADLINE = {
  BTC:    ['bitcoin'],
  ETH:    ['ethereum'],
  SOL:    ['solana'],
  AAVE:   ['aave'],
  DOGE:   ['doge', 'dogecoin'],
  HYPE:   ['hyperliquid'],
  TAO:    ['bittensor'],
  NEAR:   ['near protocol', 'nearprotocol'],
  ZEC:    ['zcash'],
  SPACEX: ['spacex'],
};

async function fetchPortfolioNews() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const news = {};

  // Stock: Finnhub company-news (already company-specific, very relevant)
  for (const symbol of PF_STOCKS) {
    try {
      const items = await finnhub(`/company-news?symbol=${symbol}&from=${weekAgo}&to=${today}`);
      news[symbol] = (items || []).slice(0, 5).map(n => ({
        headline: n.headline, url: n.url, datetime: n.datetime, source: n.source || '',
      }));
      console.log(`  ${symbol}: ${news[symbol].length} news`);
    } catch (e) {
      console.error(`  ${symbol} news: ${e.message}`);
      news[symbol] = [];
    }
  }

  // Crypto: match keywords in HEADLINE ONLY (not summary) for high relevance
  const allNews = await fetchAllNews().catch(() => []);
  for (const [symbol, keywords] of Object.entries(PF_CRYPTO_HEADLINE)) {
    news[symbol] = allNews.filter(n => {
      const headline = (n.headline || '').toLowerCase();
      return keywords.some(kw => headline.includes(kw));
    }).slice(0, 5).map(n => ({
      headline: n.headline, url: n.url, datetime: n.datetime, source: n.source || '',
    }));
    console.log(`  ${symbol}: ${news[symbol].length} news`);
  }

  // Translate all headlines
  const allH = Object.values(news).flatMap(arr => arr.map(n => n.headline));
  if (allH.length) {
    console.log(`  Translating ${allH.length} portfolio news headlines...`);
    const zhH = await translateToZh(allH);
    let k = 0;
    for (const arr of Object.values(news)) for (const n of arr) n.headline = zhH[k++];
  }
  return news;
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
const FOMC_NOTES = {
  // 2025 — 过往会议总结
  '2025-01-29': { rate: '4.25–4.50%', type: 'hold', note: '维持利率不变。声明删除通胀"取得进展"措辞，强调需要更多数据确认通胀回落趋势。鲍威尔称不急于降息。' },
  '2025-03-19': { rate: '4.25–4.50%', type: 'hold', note: '维持利率不变。点阵图显示年内预期降息2次（较12月不变）。上调通胀预期至2.7%，下调GDP预期。关税不确定性成为焦点。' },
  '2025-05-07': { rate: '4.25–4.50%', type: 'hold', note: '维持利率不变。声明首次提到"关税对通胀的上行风险"。鲍威尔重申耐心等待，市场将首次降息预期推迟至9月。' },
  '2025-06-18': { rate: '4.25–4.50%', type: 'hold', note: '维持利率不变。点阵图中位数显示年内降息1次。经济预测上调失业率至4.4%，核心PCE维持2.6%。鲍威尔称政策"具有良好限制性"。' },
  '2025-07-30': { rate: '4.25–4.50%', type: 'hold', note: '维持利率不变。劳动力市场降温迹象明显，初请失业金攀升。声明新增"密切关注两面风险"。市场定价9月降息概率升至85%。' },
  '2025-09-17': { rate: '4.00–4.25%', type: 'cut', note: '降息25bp。自2024年12月以来首次降息。鲍威尔称通胀取得"实质性进展"，劳动力市场走弱需要政策应对。点阵图暗示年内再降1次。' },
  '2025-10-29': { rate: '4.00–4.25%', type: 'hold', note: '维持利率不变。大选前最后一次会议，措辞谨慎。经济数据喜忧参半：消费韧性但制造业持续收缩。' },
  '2025-12-10': { rate: '3.75–4.00%', type: 'cut', note: '降息25bp。2025年第二次降息。点阵图显示2026年预期降息2-3次。核心PCE回落至2.4%，经济"软着陆"叙事增强。' },
  // 2026 — 过往会议总结
  '2026-01-28': { rate: '3.75–4.00%', type: 'hold', note: '维持利率不变。新政府关税政策的不确定性升高，美元走强压制出口。鲍威尔强调需评估政策变化对经济的影响。' },
  '2026-03-18': { rate: '3.50–3.75%', type: 'cut', note: '降息25bp。劳动力市场进一步放缓，失业率升至4.5%。点阵图中位数显示年内再降2次。CPI同比降至2.3%。' },
  '2026-04-29': { rate: '3.50–3.75%', type: 'hold', note: '维持利率不变。一季度GDP增速放缓至1.2%，但消费数据超预期。鲍威尔称将"逐次会议评估"，市场预期6月暂停。' },
  // 2026 — 未来会议预期
  '2026-06-17': { rate: '3.50–3.75%?', type: 'preview', note: '预期维持不变。关注点阵图更新和经济预测修正。市场预期7月或9月可能降息，取决于二季度就业和通胀数据。' },
  '2026-07-29': { rate: '3.25–3.50%?', type: 'preview', note: '若6月就业数据走弱，可能降息25bp。关注消费信心和房地产市场变化。无新点阵图，需从声明措辞判断政策倾向。' },
  '2026-09-16': { rate: '3.25–3.50%?', type: 'preview', note: '下半年关键会议。更新点阵图和经济预测。若通胀持续回落至2%附近，可能加速降息节奏。中期选举前的政策窗口。' },
  '2026-10-28': { rate: 'TBD', type: 'preview', note: '中期选举前最后一次会议。历史上美联储倾向在选举前维持稳定。关注声明中对经济前景的措辞变化。' },
  '2026-12-09': { rate: 'TBD', type: 'preview', note: '年度最后一次会议。更新2027年利率路径预测。回顾全年政策效果，设定来年降息节奏预期。' },
};

function buildFOMC() {
  const today = new Date().toISOString().slice(0, 10);
  const next = FOMC_DATES.find(d => d >= today);
  const daysUntil = next ? Math.ceil((new Date(next) - new Date(today)) / 86400000) : null;
  return {
    next: next ? { date: next, days_until: daysUntil } : null,
    schedule: FOMC_DATES,
    notes: FOMC_NOTES,
  };
}

// --- Twitter (authenticated via cookies + GraphQL) ---
const TWITTER_HANDLES = ['cburniske', 'QwQiao', 'saylor', 'viktorfischer'];
const TW_AUTH = process.env.TWITTER_AUTH_TOKEN;
const TW_CT0 = process.env.TWITTER_CT0;
const TW_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
// Query IDs from x.com main bundle — may need updating if Twitter changes them
const QID_USER = 'IGgvgiOx4QZndDHuD3x9TQ';
const QID_TWEETS = 'PNd0vlufvrcIwrAnBYKE9g';

async function twitterApi(url) {
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${TW_BEARER}`,
      'Cookie': `auth_token=${TW_AUTH}; ct0=${TW_CT0}`,
      'x-csrf-token': TW_CT0,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  if (!res.ok) throw new Error(`Twitter API ${res.status}`);
  return res.json();
}

async function getUserId(handle) {
  const vars = JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true });
  const feat = JSON.stringify({ hidden_profile_subscriptions_enabled:true, responsive_web_graphql_exclude_directive_enabled:true, verified_phone_label_enabled:false, responsive_web_graphql_skip_user_profile_image_extensions_enabled:false, responsive_web_graphql_timeline_navigation_enabled:true });
  const data = await twitterApi(`https://x.com/i/api/graphql/${QID_USER}/UserByScreenName?variables=${encodeURIComponent(vars)}&features=${encodeURIComponent(feat)}`);
  return data?.data?.user?.result?.rest_id;
}

async function getUserTweets(userId, handle) {
  const vars = JSON.stringify({ userId, count: 20, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: true, withVoice: true, withV2Timeline: true });
  const feat = JSON.stringify({ rweb_tipjar_consumption_enabled:true, responsive_web_graphql_exclude_directive_enabled:true, verified_phone_label_enabled:false, creator_subscriptions_tweet_preview_api_enabled:true, responsive_web_graphql_timeline_navigation_enabled:true, responsive_web_graphql_skip_user_profile_image_extensions_enabled:false });
  const data = await twitterApi(`https://x.com/i/api/graphql/${QID_TWEETS}/UserTweets?variables=${encodeURIComponent(vars)}&features=${encodeURIComponent(feat)}`);

  const tweets = [];
  const result = data?.data?.user?.result || {};
  const timeline = result.timeline_v2?.timeline || result.timeline?.timeline || {};
  const instructions = timeline.instructions || [];
  for (const inst of instructions) {
    const entries = inst.entries || [];
    if (inst.entry) entries.push(inst.entry);
    for (const entry of entries) {
      const content = entry.content || {};
      // Direct tweet
      let tr = content.itemContent?.tweet_results?.result;
      if (tr) extractTweet(tr, handle, tweets);
      // Module items (e.g. conversation threads)
      for (const it of content.items || []) {
        tr = it.item?.itemContent?.tweet_results?.result;
        if (tr) extractTweet(tr, handle, tweets);
      }
    }
  }
  return tweets.sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 5);
}

function extractTweet(tr, handle, tweets) {
  if (tr.__typename === 'TweetWithVisibilityResults') tr = tr.tweet || {};
  const legacy = tr.legacy;
  if (!legacy?.full_text) return;
  if (legacy.retweeted_status_result) return; // skip retweets
  tweets.push({
    text: legacy.full_text,
    url: `https://x.com/${handle}/status/${legacy.id_str}`,
    time: legacy.created_at || '',
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
  });
}

async function fetchTweets() {
  if (!TW_AUTH || !TW_CT0) {
    console.error('  Missing TWITTER_AUTH_TOKEN or TWITTER_CT0');
    return {};
  }
  const result = {};
  for (const handle of TWITTER_HANDLES) {
    try {
      const userId = await getUserId(handle);
      if (!userId) throw new Error('user not found');
      await delay(500);
      const tweets = await getUserTweets(userId, handle);
      result[handle] = tweets;
      console.log(`  @${handle}: ${tweets.length} tweets, newest=${tweets[0]?.time || 'none'}`);
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

  console.log('Fetching portfolio news...');
  const portfolio_news = await fetchPortfolioNews();
  console.log(`  ${Object.values(portfolio_news).flat().length} total articles`);

  console.log('Fetching tweets...');
  const tweets = await fetchTweets();

  const result = { updated_at: new Date().toISOString(), stocks, crypto, earnings, news, ipo_watch, btc_score, fomc, tweets, portfolio_news };

  const dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'market.json'), JSON.stringify(result, null, 2));
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
