// DexScreener: pairs, liquidity, txns, socials. Free, no key.
import { get } from '../http.js';

const BASE = 'https://api.dexscreener.com';

export const isEvmAddress = (s) => /^0x[a-fA-F0-9]{40}$/.test(s);
export const isSolAddress = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && !/^[a-z]+$/i.test(s);
export const isAddress = (s) => isEvmAddress(s) || isSolAddress(s);

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export async function pairsForToken(address) {
  const r = await get(`${BASE}/latest/dex/tokens/${address}`, { retries: 1 });
  if (!r.ok) return { ok: false, error: r.error || `dexscreener ${r.status}`, pairs: [] };
  const pairs = (r.data.pairs || []).filter((p) => same(p.baseToken?.address, address));
  return { ok: true, pairs };
}

export async function search(q) {
  const r = await get(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`, { retries: 1 });
  if (!r.ok) return { ok: false, error: r.error || `dexscreener ${r.status}`, pairs: [] };
  return { ok: true, pairs: r.data.pairs || [] };
}

// Group search hits by token, keeping those whose ticker/name matches the query.
export function groupByToken(pairs, q) {
  const groups = new Map();
  for (const p of pairs) {
    const t = p.baseToken;
    if (!t?.address) continue;
    const key = `${p.chainId}:${t.address.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { chainId: p.chainId, address: t.address, symbol: t.symbol, name: t.name, pairs: [] });
    groups.get(key).pairs.push(p);
  }
  const all = [...groups.values()].map((g) => ({ ...g, liquidity: g.pairs.reduce((s, p) => s + (p.liquidity?.usd || 0), 0) }));
  const ql = q.toLowerCase();
  const matches = all.filter((g) => g.symbol?.toLowerCase() === ql || g.name?.toLowerCase() === ql);
  return { all: all.sort((a, b) => b.liquidity - a.liquidity), matches: matches.sort((a, b) => b.liquidity - a.liquidity) };
}

// Volume-weighted median price: the price the market actually trades at.
function referencePrice(pairs) {
  const pts = pairs.filter((p) => +p.priceUsd > 0).map((p) => ({ price: +p.priceUsd, w: (p.volume?.h24 || 0) + (p.liquidity?.usd || 0) * 0.001 }));
  if (!pts.length) return null;
  pts.sort((a, b) => a.price - b.price);
  const total = pts.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of pts) {
    acc += p.w;
    if (acc >= total / 2) return p.price;
  }
  return pts[pts.length - 1].price;
}

// Drop broken/manipulated pools whose price is way off the traded price
// (e.g. a dead pool reporting $3M "liquidity" at 5000x the real price).
export function saneP(pairs) {
  const ref = referencePrice(pairs);
  if (!ref) return pairs;
  const ok = pairs.filter((p) => !(+p.priceUsd > 0) || Math.abs(+p.priceUsd / ref - 1) <= 0.25);
  return ok.length ? ok : pairs;
}

// Collapse every pool of one token into one market snapshot.
export function summarize(allPairs) {
  if (!allPairs?.length) return null;
  const pairs = saneP(allPairs);
  const sorted = [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const main = sorted[0];
  const sum = (f) => pairs.reduce((s, p) => s + (f(p) || 0), 0);
  const created = pairs.map((p) => p.pairCreatedAt).filter(Boolean);
  const withInfo = [...allPairs].find((p) => p.info && (p.info.socials?.length || p.info.websites?.length)) || allPairs.find((p) => p.info);
  const info = withInfo?.info || {};
  return {
    chainId: main.chainId,
    address: main.baseToken.address,
    symbol: main.baseToken.symbol,
    name: main.baseToken.name,
    dex: main.dexId,
    pairAddress: main.pairAddress,
    url: main.url,
    quote: main.quoteToken?.symbol,
    priceUsd: main.priceUsd ? +main.priceUsd : null,
    change: { m5: main.priceChange?.m5, h1: main.priceChange?.h1, h6: main.priceChange?.h6, h24: main.priceChange?.h24 },
    txns: main.txns || {},
    txnsAll: {
      m5: { buys: sum((p) => p.txns?.m5?.buys), sells: sum((p) => p.txns?.m5?.sells) },
      h1: { buys: sum((p) => p.txns?.h1?.buys), sells: sum((p) => p.txns?.h1?.sells) },
      h24: { buys: sum((p) => p.txns?.h24?.buys), sells: sum((p) => p.txns?.h24?.sells) },
    },
    volume24h: sum((p) => p.volume?.h24),
    volume1h: sum((p) => p.volume?.h1),
    liquidity: sum((p) => p.liquidity?.usd),
    mainLiquidity: main.liquidity?.usd || 0,
    marketCap: main.marketCap || main.fdv || null,
    fdv: main.fdv || null,
    pairCount: pairs.length,
    outliers: allPairs.length - pairs.length,
    // launchpad bonding curves (pump.fun & co) report no pool liquidity until they graduate
    bonding: !pairs.some((p) => p.liquidity && p.liquidity.usd != null),
    launchpad: !pairs.some((p) => p.liquidity && p.liquidity.usd != null) ? main.dexId : null,
    createdAt: created.length ? Math.min(...created) : null,
    image: info.imageUrl || null,
    websites: (info.websites || []).map((w) => w.url).filter(Boolean),
    socials: (info.socials || []).map((s) => ({ type: s.type, url: s.url })).filter((s) => s.url),
    labels: main.labels || [],
  };
}
