// Turns successive snapshots of a coin into alerts. Pure-ish: mutates only the coin state.
import { compact, oneLine } from './ui.js';
import { SEVERE_TWEET } from './sources/social.js';

let seq = 0;
const MIN = 60e3;

export function newCoinState(target) {
  return {
    target,
    market: target.market || null,
    start: null,
    prices: [],
    security: null,
    risk: null,
    x: null,
    xEverAlive: false,
    xGoneStreak: 0,
    tweetsSeen: new Set(),
    news: null,
    newsSeen: new Set(),
    site: null,
    once: new Set(),
    cooldown: {},
    lastAlert: null,
    error: null,
  };
}

function make(st, level, text, extra = {}) {
  const a = { id: ++seq, at: Date.now(), level, symbol: st.target.symbol, key: st.target.key, text, ...extra };
  st.lastAlert = a;
  return a;
}

function cool(st, key, ms) {
  const now = Date.now();
  if (st.cooldown[key] && now - st.cooldown[key] < ms) return false;
  st.cooldown[key] = now;
  return true;
}

function once(st, key) {
  if (st.once.has(key)) return false;
  st.once.add(key);
  return true;
}

// Seed a price history so sparklines aren't empty on frame one.
export function seedPrices(st) {
  const m = st.market;
  if (!m?.priceUsd) return;
  if (m.sparkline?.length) {
    st.prices = m.sparkline.slice(-24);
  } else {
    const p = m.priceUsd;
    const back = (chg) => (chg != null && chg > -100 ? p / (1 + chg / 100) : null);
    st.prices = [back(m.change?.h24), back(m.change?.h6), back(m.change?.h1), back(m.change?.m5), p].filter((v) => v != null);
  }
}

export function onMarket(st, next) {
  const out = [];
  const prev = st.market;
  if (!next) return out;
  st.market = next;
  if (next.priceUsd) {
    st.prices.push(next.priceUsd);
    if (st.prices.length > 64) st.prices.shift();
  }
  if (!st.start) {
    st.start = { liq: next.liquidity, price: next.priceUsd, at: Date.now() };
    return out;
  }
  const major = st.target.kind === 'major';

  if (!major) {
    if (next.dead && once(st, 'dead')) out.push(make(st, 'critical', 'All pools are gone — liquidity removed'));
    if (prev?.liquidity > 5000 && next.liquidity < prev.liquidity * 0.7 && cool(st, 'liq', 10 * MIN)) {
      const drop = (1 - next.liquidity / prev.liquidity) * 100;
      out.push(make(st, 'critical', `Liquidity pulled −${drop.toFixed(0)}% (${compact(prev.liquidity)} → ${compact(next.liquidity)})`));
    } else if (st.start.liq > 5000 && next.liquidity < st.start.liq * 0.5 && once(st, 'liqHalf')) {
      out.push(make(st, 'critical', `Liquidity down ${((1 - next.liquidity / st.start.liq) * 100).toFixed(0)}% since you started watching`));
    }
    const m5 = next.txnsAll?.m5 || {};
    if (m5.sells >= 20 && m5.sells >= (m5.buys || 0) * 3 && cool(st, 'sells', 10 * MIN))
      out.push(make(st, 'warn', `Sell wall: ${m5.sells} sells vs ${m5.buys} buys in 5m`));
  }

  if (prev?.priceUsd && next.priceUsd) {
    const chg = (next.priceUsd / prev.priceUsd - 1) * 100;
    const dumpAt = major ? -3 : -15;
    const pumpAt = major ? 4 : 30;
    if (chg <= dumpAt && cool(st, 'dump', 5 * MIN)) out.push(make(st, major ? 'warn' : 'critical', `Price ${chg.toFixed(1)}% since last check`));
    else if (chg >= pumpAt && cool(st, 'pump', 10 * MIN)) out.push(make(st, 'info', `Price +${chg.toFixed(1)}% since last check — careful chasing`));
  }
  const h1 = next.change?.h1;
  if (h1 != null && h1 <= (major ? -5 : -30) && cool(st, 'h1', 30 * MIN)) out.push(make(st, 'warn', `Down ${h1.toFixed(1)}% in the last hour`));
  return out;
}

export function onX(st, x, { seed = false } = {}) {
  const out = [];
  if (!x) return out;
  const prev = st.x;
  const handle = x.handle;
  if (x.status === 'gone') {
    st.xGoneStreak++;
    // keep the last good profile around for display
    st.x = { ...x, user: prev?.user || null, tweets: prev?.tweets || [] };
    if (st.xEverAlive && st.xGoneStreak >= 2 && once(st, 'xgone'))
      out.push(make(st, 'critical', `X account @${handle} is GONE — deleted, suspended or renamed`));
    return out;
  }
  if (x.status === 'unknown') {
    if (!prev) st.x = x;
    return out; // never alarm on a flaky lookup
  }
  // alive
  if (st.once.has('xgone')) {
    st.once.delete('xgone');
    out.push(make(st, 'info', `X account @${handle} is back online`));
  }
  st.xGoneStreak = 0;
  st.xEverAlive = true;
  if (prev?.user?.followers && x.user?.followers && x.user.followers < prev.user.followers * 0.9 && cool(st, 'followers', 60 * MIN))
    out.push(make(st, 'warn', `X followers dropped ${compact(prev.user.followers, '')} → ${compact(x.user.followers, '')}`));
  for (const t of [...(x.tweets || [])].reverse()) {
    if (st.tweetsSeen.has(t.id)) continue;
    st.tweetsSeen.add(t.id);
    if (seed || t.repost) continue;
    if (t.at && Date.now() - t.at > 6 * 3600e3) continue; // old/pinned posts surfacing late
    const body = oneLine(t.text).replace(/https?:\/\/t\.co\/\S+/g, '').trim() || '(media)';
    if (t.danger) out.push(make(st, SEVERE_TWEET.test(t.text) ? 'critical' : 'warn', `@${handle} ${t.danger}: “${body}”`, { url: t.url }));
    else out.push(make(st, 'info', `New post from @${handle}: “${body}”`, { url: t.url }));
  }
  // the timeline endpoint is flaky: keep the last good posts if this lookup returned none
  st.x = x.tweets?.length ? x : { ...x, tweets: prev?.tweets || [] };
  return out;
}

export function onNews(st, news, { seed = false } = {}) {
  const out = [];
  if (!news?.ok) return out;
  for (const n of [...news.items].reverse()) {
    const k = n.title.toLowerCase().slice(0, 60);
    if (st.newsSeen.has(k)) continue;
    st.newsSeen.add(k);
    if (seed || n.tone === 'fluff') continue;
    out.push(make(st, n.tone === 'bad' ? 'warn' : 'info', `News: ${n.title}${n.source ? ` — ${n.source}` : ''}`, { url: n.link }));
  }
  st.news = news;
  return out;
}

export function onSecurity(st, sec) {
  const out = [];
  if (!sec?.available) return out;
  const before = new Set((st.security?.checks || []).filter((c) => c.status === 'bad').map((c) => c.id));
  if (st.security?.available) {
    for (const ch of sec.checks) if (ch.status === 'bad' && !before.has(ch.id)) out.push(make(st, 'critical', `Contract changed: ${ch.label}`));
  }
  st.security = sec;
  return out;
}

export function onRisk(st, risk) {
  const out = [];
  if (st.risk && risk.score - st.risk.score >= 15 && cool(st, 'risk', 15 * MIN))
    out.push(make(st, 'warn', `Risk score jumped ${st.risk.score} → ${risk.score} (${risk.verdict.label.toLowerCase()})`));
  st.risk = risk;
  return out;
}

export function onSite(st, site) {
  const out = [];
  if (!site) return out;
  if (st.site?.up && !site.up && once(st, 'sitedown')) out.push(make(st, 'warn', `Website ${site.host} went down`));
  if (site.up) st.once.delete('sitedown');
  st.site = site;
  return out;
}
