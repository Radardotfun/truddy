// Resolve a query to a coin, collect every signal, and score the risk.
import * as dex from './sources/dex.js';
import * as gecko from './sources/gecko.js';
import { security } from './sources/security.js';
import { xAccount, extractHandle, isCommunityLink, website } from './sources/social.js';
import { coinNews } from './sources/news.js';
import { compact, duration, ago, theme } from './ui.js';

export class TruddyError extends Error {}

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------- resolve
export async function resolve(query, { chain } = {}) {
  const q = String(query || '').trim().replace(/^\$/, '');
  if (!q) throw new TruddyError('Give me a ticker, name or contract address.');

  if (dex.isAddress(q)) return resolveAddress(q, { chain });

  const [ds, hit] = await Promise.all([dex.search(q), gecko.searchCoin(q)]);
  const groups = dex.groupByToken(ds.pairs || [], q);
  const sameTicker = groups.matches.filter((g) => !chain || g.chainId === chain);

  // 1) CoinGecko-listed coin: trust its contract, not whatever copycat has the ticker.
  if (hit && hit.market_cap_rank && hit.market_cap_rank <= 600) {
    const detail = await gecko.coinDetail(hit.id);
    if (detail) {
      const cg = { id: detail.id, rank: detail.rank, twitter: detail.twitter, websites: detail.websites, telegram: detail.telegram };
      let platforms = detail.platforms.filter((p) => !chain || p.chainId === chain);
      // prefer the platform where the token actually trades the most
      const liqOf = (p) => groups.all.find((g) => g.address.toLowerCase() === p.address.toLowerCase())?.liquidity || 0;
      platforms = platforms.sort((a, b) => liqOf(b) - liqOf(a));
      for (const p of platforms.slice(0, 3)) {
        const r = await dex.pairsForToken(p.address);
        const market = dex.summarize(r.pairs);
        if (market) {
          const copycats = sameTicker.filter((g) => g.address.toLowerCase() !== market.address.toLowerCase()).length;
          return { kind: 'token', query: q, chainId: market.chainId, address: market.address, symbol: detail.symbol || market.symbol, name: detail.name || market.name, cg, copycats, market };
        }
      }
      if (!detail.platforms.length || !chain) {
        return { kind: 'major', query: q, chainId: null, address: null, symbol: detail.symbol, name: detail.name, cg, copycats: 0, market: detail.market };
      }
    }
  }

  // 2) DEX-only token: most liquid token with this exact ticker/name.
  const pick = sameTicker[0] || groups.all.find((g) => (!chain || g.chainId === chain) && (g.symbol?.toLowerCase().includes(q.toLowerCase()) || g.name?.toLowerCase().includes(q.toLowerCase())));
  if (!pick) {
    if (!ds.ok && !hit) throw new TruddyError('Could not reach DexScreener or CoinGecko. Check your connection and try again.');
    throw new TruddyError(`No coin found for "${q}". Try the contract address.`);
  }
  const full = await dex.pairsForToken(pick.address);
  const market = dex.summarize(full.pairs.length ? full.pairs : pick.pairs);
  return {
    kind: 'token',
    query: q,
    chainId: market.chainId,
    address: market.address,
    symbol: market.symbol,
    name: market.name,
    cg: null,
    copycats: Math.max(0, sameTicker.length - 1),
    market,
  };
}

async function resolveAddress(addr, { chain } = {}) {
  let r = await dex.pairsForToken(addr);
  let pairs = r.pairs.filter((p) => !chain || p.chainId === chain);
  if (!pairs.length) {
    // maybe they pasted a pair/pool address
    const s = await dex.search(addr);
    const pool = s.pairs.find((p) => p.pairAddress?.toLowerCase() === addr.toLowerCase());
    if (pool) {
      r = await dex.pairsForToken(pool.baseToken.address);
      pairs = r.pairs;
    }
  }
  if (!pairs.length) {
    if (!r.ok) throw new TruddyError('Could not reach DexScreener. Check your connection and try again.');
    throw new TruddyError('No DEX pools found for that address (not launched, or already dead).');
  }
  const market = dex.summarize(pairs);
  return { kind: 'token', query: addr, chainId: market.chainId, address: market.address, symbol: market.symbol, name: market.name, cg: null, copycats: 0, market };
}

// ---------------------------------------------------------------- collect
export function xHandleFor(target) {
  const fromDex = (target.market?.socials || []).map((s) => extractHandle(s.url)).find(Boolean);
  return target.cg?.twitter || fromDex || null;
}

export function websiteFor(target) {
  const sites = [...(target.market?.websites || []), ...(target.cg?.websites || [])].filter((u) => /^https?:\/\//i.test(u));
  return sites[0] || null;
}

// Refresh the market block for an already-resolved target.
export async function refreshMarket(target) {
  if (target.kind === 'major') {
    const m = await gecko.markets([target.cg.id]);
    return m[target.cg.id] || null;
  }
  const r = await dex.pairsForToken(target.address);
  return r.ok ? dex.summarize(r.pairs) || { ...target.market, liquidity: 0, mainLiquidity: 0, dead: true } : null;
}

export async function collect(target, { news = true, x = true, site = true, sec = true } = {}) {
  const handle = xHandleFor(target);
  const url = websiteFor(target);
  const [securityRes, xRes, siteRes, newsRes] = await Promise.all([
    sec && target.kind === 'token' ? security(target.chainId, target.address) : null,
    x && handle ? xAccount(handle) : null,
    site && url ? website(url) : null,
    news ? coinNews({ name: target.name, symbol: target.symbol, major: target.kind === 'major', listed: !!target.cg }) : null,
  ]);
  const communityOnly = !handle && (target.market?.socials || []).some((s) => isCommunityLink(s.url));
  return { target, market: target.market, security: securityRes, x: xRes, site: siteRes, news: newsRes, communityOnly, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------- analyze
export const VERDICTS = [
  { max: 19, key: 'low', label: 'LOW RISK SIGNALS', color: theme.mint, blurb: 'Few red flags found. Still DYOR.' },
  { max: 44, key: 'caution', label: 'CAUTION', color: theme.amber, blurb: 'Some red flags. Double-check before you touch it.' },
  { max: 69, key: 'high', label: 'HIGH RISK', color: theme.orange, blurb: 'Multiple red flags. This is how people get rugged.' },
  { max: 100, key: 'danger', label: 'DANGER', color: theme.red, blurb: 'Severe red flags, consistent with a rug or honeypot.' },
];
export const verdictFor = (score) => VERDICTS.find((v) => score <= v.max);

const fmtPct = (x) => `${x > 0 ? '+' : ''}${(+x).toFixed(Math.abs(x) >= 100 ? 0 : 1)}%`;

export function analyze(rep) {
  const flags = [];
  let score = 0;
  const add = (level, text, pts = 0) => {
    flags.push({ level, text });
    score += pts;
  };
  const { target, security: sec, x, site, news } = rep;
  const m = rep.market;
  const isMajor = target.kind === 'major';
  const listed = !!target.cg;
  const now = Date.now();

  // contract
  if (!isMajor) {
    if (sec?.available) {
      for (const ch of sec.checks) {
        if (ch.status === 'bad') add('critical', ch.label, ch.weight ?? 25);
        else if (ch.status === 'warn') add('warn', ch.label, ch.weight ?? 6);
        else if (ch.weight && ch.weight < 0) add('good', ch.label, ch.weight);
      }
    } else if (sec) add('info', `Contract scan unavailable: ${sec.reason}`, 8);
  }

  // market
  if (m && !isMajor) {
    const age = m.createdAt ? now - m.createdAt : null;
    if (age != null) {
      if (age < HOUR) add('warn', `Brand new: first pool opened ${duration(age)} ago`, 22);
      else if (age < DAY) add('warn', `Young token: only ${duration(age)} old`, 12);
      else if (age < 7 * DAY) add('info', `Under a week old (${duration(age)})`, 4);
      else if (age > 180 * DAY) score -= 5;
    }
    if (m.bonding && !m.dead) add('warn', `Still on the ${m.launchpad} bonding curve — not graduated to a real pool yet`, 8);
    else if (m.dead || m.liquidity < 1000) add('critical', `Liquidity is basically gone (${compact(m.liquidity)})`, 45);
    else if (!m.bonding && m.liquidity < 10000) add('warn', `Very thin liquidity (${compact(m.liquidity)})`, 15);
    else if (!m.bonding && !listed && m.marketCap > 50000 && m.liquidity / m.marketCap < 0.03)
      add('warn', `Liquidity is only ${((m.liquidity / m.marketCap) * 100).toFixed(1)}% of market cap`, 10);

    const h1 = m.txnsAll?.h1 || {};
    if (h1.sells >= 30 && h1.sells >= (h1.buys || 0) * 2.5) add('warn', `Heavy selling: ${h1.sells} sells vs ${h1.buys} buys in the last hour`, 10);

    const c = m.change || {};
    if (c.h1 <= -50 || c.h24 <= -80) add('critical', `Price collapsing: ${fmtPct(c.h1 ?? 0)} 1h, ${fmtPct(c.h24 ?? 0)} 24h`, 25);
    else if (c.h1 <= -25) add('warn', `Dumping: ${fmtPct(c.h1)} in the last hour`, 12);
    if (c.h1 >= 100) add('warn', `Parabolic: ${fmtPct(c.h1)} in 1h. Pumps this fast usually retrace`, 6);
    if (!m.bonding && m.volume24h && m.liquidity > 0 && m.volume24h / m.liquidity > 50) add('warn', `Volume is ${Math.round(m.volume24h / m.liquidity)}× liquidity — likely bot/wash trading`, 8);
    if (!listed && !(m.socials || []).length && !(m.websites || []).length) add('warn', 'No website or socials listed anywhere', 12);
  }
  if (m && isMajor) {
    if (m.change?.h24 <= -10) add('warn', `Big daily move: ${fmtPct(m.change.h24)} in 24h`, 8);
  }

  if (listed && isMajor) add('good', `CoinGecko rank #${target.cg.rank}`);
  else if (listed) add('good', `Contract matches the CoinGecko listing (rank #${target.cg.rank})`, -8);
  if (target.copycats > 0) add('info', `${target.copycats} other token${target.copycats > 1 ? 's' : ''} on DEXes use the $${target.symbol} ticker — verify the address`);

  // X account
  if (x?.status === 'gone') add('critical', `X account @${x.handle} not found — deleted, suspended or renamed`, 35);
  else if (x?.status === 'alive') {
    const u = x.user || {};
    if (u.joined && now - u.joined < 30 * DAY) add('warn', `X account is only ${duration(now - u.joined)} old`, 10);
    if (!isMajor && u.followers != null && u.followers < 500) add('info', `Tiny X following (${u.followers})`, 4);
    const own = (x.tweets || []).filter((t) => !t.repost);
    const danger = own.find((t) => t.danger && t.at && now - t.at < 7 * DAY);
    if (danger) add('warn', `Recent X post ${danger.danger}`, 15);
    const last = own[0]?.at;
    if (!isMajor && last && now - last > 30 * DAY) add('warn', `X has been silent for ${ago(last)}`, 6);
  } else if (!x && !isMajor && !listed) add('warn', rep.communityOnly ? 'Only an X community link, no project account' : 'No X account linked', 6);

  if (site && !site.up) add('warn', `Website ${site.host} is down (${site.status || site.error || 'no answer'})`, 8);

  const badNews = (news?.items || []).filter((i) => i.tone === 'bad' && i.at && now - i.at < 3 * DAY);
  if (badNews.length) add('warn', `${badNews.length} negative headline${badNews.length > 1 ? 's' : ''} in the last 3 days`, 8);

  score = Math.max(0, Math.min(100, Math.round(score)));
  const order = { critical: 0, warn: 1, info: 2, good: 3 };
  flags.sort((a, b) => order[a.level] - order[b.level]);
  return { score, verdict: verdictFor(score), flags };
}

export async function scan(query, opts = {}, onStep = () => {}) {
  onStep(`resolving ${query}`);
  const target = await resolve(query, opts);
  onStep(`scanning ${target.symbol}: contract · X · news`);
  const rep = await collect(target, opts);
  rep.risk = analyze(rep);
  return rep;
}
