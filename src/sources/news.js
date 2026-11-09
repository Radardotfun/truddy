// Headlines from public RSS: Google News search (per coin) + crypto desks (market-wide).
import { get } from '../http.js';

const FEEDS = [
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
];

const BAD = /\b(rug ?pull|rugged|scam|exploit(ed)?|hack(ed|er|s)?|drain(ed|er)?|delist(s|ed|ing)?|lawsuit|sued|sues|charges?d?|fraud|insider|ponzi|stolen|vulnerab\w*|attack(ed)?|arrest(ed)?|investigation|probe|suspend(s|ed)?|halt(s|ed)?|crash(es|ed)?|plunge[sd]?|collapse[sd]?|dump(s|ed|ing)?|liquidat\w*|bankrupt\w*|warning)\b/i;
const GOOD = /\b(list(s|ed|ing)|etf|partner(s|ship)?|surge[sd]?|rall(y|ies|ied)|soar(s|ed)?|all-time high|record high|ath|approv(al|es|ed)|integrat\w*|launch(es|ed)?|adopt\w*|upgrade[sd]?|breakout)\b/i;
const FLUFF = /price prediction|price analysis|price forecast|could reach|will .* reach|\bto the moon\b|presale|pre-sale|(top|best) (crypto|coins?|altcoins?|meme ?coins?)\b|next (pepe|shiba|bonk|doge|100x)|\b\d{2,}x\b|could (explode|soar|skyrocket)|crypto to buy|live price|price today|price,? chart|market cap (&|and) chart|cryptocurrency profile|\([A-Z0-9.]+[-/]USDT?\)/i;
const FLUFF_SOURCES = /^(openpr(\.com)?|techbullion|crypto daily|coincentral sponsored)$/i;

const decode = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();

const tag = (xml, t) => {
  const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i'));
  return m ? decode(m[1]) : '';
};

export function parseRss(xml, fallbackSource = '') {
  const items = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const it = m[0];
    let title = tag(it, 'title');
    let source = tag(it, 'source') || fallbackSource;
    // Google News appends " - Publisher" to titles
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const link = tag(it, 'link');
    const at = Date.parse(tag(it, 'pubDate')) || null;
    if (title) items.push(classify({ title, source, link, at }));
  }
  return items;
}

export function classify(item) {
  const fluff = FLUFF.test(item.title) || FLUFF_SOURCES.test(item.source || '');
  const tone = BAD.test(item.title) ? 'bad' : GOOD.test(item.title) ? 'good' : 'neutral';
  return { ...item, tone: fluff && tone !== 'bad' ? 'fluff' : tone };
}

function queryFor({ name, symbol, major }) {
  const nm = (name || '').trim();
  const sym = (symbol || '').trim();
  if (major) return `${nm} crypto when:3d`;
  // Memecoin names collide with real words ("cat", "dog"), so anchor on crypto context.
  if (nm && nm.toLowerCase() !== sym.toLowerCase() && nm.length > 2) return `"${nm}" (crypto OR token OR coin OR memecoin) when:7d`;
  return `"${sym}" (crypto OR token OR coin) when:7d`;
}

export async function coinNews(coin, { limit = 6 } = {}) {
  const q = queryFor(coin);
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await get(url, { json: false, timeout: 10000, ua: 'Mozilla/5.0 (compatible; truddy)' });
  if (!r.ok) return { ok: false, items: [] };
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const words = [coin.name, coin.symbol].filter((w) => w && w.length > 1).map((w) => new RegExp(`(^|[^\\w$])\\$?${esc(w)}($|[^\\w])`, 'i'));
  // Unlisted memecoins borrow real-world names ("World of Warcraft", "Cat"): demand crypto context.
  const sym = coin.symbol ? new RegExp(`\\$${esc(coin.symbol)}\\b`, 'i') : null;
  const CRYPTO = /\b(crypto|token|coin|memecoin|meme coin|solana|ethereum|base|bnb|pump\.?fun|blockchain|airdrop|dex|rug|onchain|on-chain|web3|degen|whale|holders?)\b/i;
  const items = parseRss(r.data)
    // keep headlines that actually mention the coin as a word
    .filter((i) => words.some((re) => re.test(i.title)))
    .filter((i) => coin.major || coin.listed || CRYPTO.test(i.title) || (sym && sym.test(i.title)))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  // de-dupe syndicated copies
  const seen = new Set();
  const out = [];
  for (const i of items) {
    const k = i.title.toLowerCase().slice(0, 60);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  // real reporting first, paid/prediction fluff last
  out.sort((a, b) => (a.tone === 'fluff') - (b.tone === 'fluff') || (b.at || 0) - (a.at || 0));
  return { ok: true, items: out.slice(0, limit) };
}

export async function marketNews({ limit = 12 } = {}) {
  const res = await Promise.all(FEEDS.map((f) => get(f.url, { json: false, timeout: 10000, ua: 'Mozilla/5.0 (compatible; truddy)' }).then((r) => (r.ok ? parseRss(r.data, f.name) : []))));
  const items = res.flat().sort((a, b) => (b.at || 0) - (a.at || 0));
  return { ok: items.length > 0, items: items.slice(0, limit) };
}
