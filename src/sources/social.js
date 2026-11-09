// X (Twitter) account liveness + latest posts via the public FxTwitter API, and website checks.
//
// FxTwitter quirks (measured): a real account intermittently returns 404 on both endpoints,
// while a non-existent account consistently returns a 302 on the v1 endpoint. So:
//   200 anywhere  -> alive
//   302 (x2)      -> gone (deleted / suspended / renamed)
//   anything else -> unknown (never alarm on it)
import { get } from '../http.js';

const FX = 'https://api.fxtwitter.com';
const RESERVED = new Set(['i', 'home', 'search', 'intent', 'share', 'hashtag', 'explore', 'communities', 'messages', 'settings', 'notifications', 'login', 'signup', 'tos', 'privacy', 'status']);

export function extractHandle(url) {
  if (!url) return null;
  const m = String(url).match(/(?:twitter|x)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?=$|[/?#])/i);
  if (!m) return null;
  const h = m[1];
  if (RESERVED.has(h.toLowerCase())) return null;
  return h;
}

export const isCommunityLink = (url) => /(?:twitter|x)\.com\/i\/communities\//i.test(url || '');

// Words that, in a project's own posts, usually precede people losing money.
const TWEET_DANGER = [
  [/\b(hacked|compromised)\b/i, 'says the account was hacked/compromised'],
  [/\b(do ?n[o']?t|never) (buy|click|connect|sign)\b/i, 'warns people not to buy/click'],
  [/\bmigrat(e|ing|ion)\b/i, 'talks about a migration'],
  [/\b(new|updated|real|official) (ca|contract|token address)\b/i, 'announces a new contract address'],
  [/\brelaunch(ing|ed)?\b/i, 'talks about a relaunch'],
  [/\b(claim|airdrop) (now|here|live)\b/i, 'pushes an airdrop claim link'],
  [/\b(exploit(ed)?|drain(ed|er)?|stolen)\b/i, 'mentions an exploit/drain'],
  [/\b(rug(ged|pull)?|scam(med)?)\b/i, 'mentions rug/scam'],
  [/\b(shutting down|winding down|stepping (away|down)|it'?s over|goodbye)\b/i, 'sounds like the team is leaving'],
];

export function tweetDanger(text) {
  for (const [re, why] of TWEET_DANGER) if (re.test(text || '')) return why;
  return null;
}

// The subset that should page you immediately.
export const SEVERE_TWEET = /\b(hacked|compromised|exploit(ed)?|drain(ed|er)?|stolen|(new|updated|real) (ca|contract))\b/i;

function mapUser(u) {
  if (!u) return null;
  return {
    handle: u.screen_name,
    name: u.name,
    id: u.id,
    followers: u.followers ?? null,
    following: u.following ?? null,
    posts: u.tweets ?? u.statuses ?? null,
    joined: u.joined ? Date.parse(u.joined) || null : null,
    description: u.description || '',
    verified: !!(u.verification?.verified || u.verified),
  };
}

function mapTweet(t) {
  return {
    id: t.id,
    url: t.url,
    text: t.text || '',
    at: t.created_timestamp ? t.created_timestamp * 1000 : Date.parse(t.created_at) || null,
    likes: t.likes ?? 0,
    reposts: t.reposts ?? 0,
    views: t.views ?? null,
    reply: !!t.replying_to,
    repost: !!t.reposted_by,
    danger: tweetDanger(t.text),
  };
}

export async function xAccount(handle, { attempts = 3 } = {}) {
  let user = null;
  let tweets = null;
  let redirects = 0;
  let sawError = false;

  for (let i = 0; i < attempts && !user; i++) {
    const r = await get(`${FX}/${encodeURIComponent(handle)}`, { redirect: 'manual', timeout: 9000 });
    if (r.ok && r.data?.user) user = mapUser(r.data.user);
    else if (r.status >= 300 && r.status < 400) redirects++;
    else sawError = true;
    if (redirects >= 2) break;
    if (!user && i < attempts - 1) await new Promise((res) => setTimeout(res, 400 + i * 300));
  }

  if (user || redirects < 2) {
    for (let i = 0; i < attempts && !tweets; i++) {
      const r = await get(`${FX}/2/profile/${encodeURIComponent(handle)}/statuses`, { timeout: 9000 });
      if (r.ok && Array.isArray(r.data?.results) && r.data.results.length) {
        tweets = r.data.results.map(mapTweet).sort((a, b) => (b.at || 0) - (a.at || 0));
        if (!user) user = mapUser(r.data.results.find((t) => t.author?.screen_name?.toLowerCase() === handle.toLowerCase())?.author);
      } else if (i < attempts - 1) await new Promise((res) => setTimeout(res, 400 + i * 300));
    }
  }

  if (user) return { handle: user.handle || handle, status: 'alive', user, tweets: tweets || [], checkedAt: Date.now() };
  if (redirects >= 2) return { handle, status: 'gone', user: null, tweets: [], checkedAt: Date.now() };
  return { handle, status: 'unknown', user: null, tweets: [], checkedAt: Date.now(), error: sawError ? 'x lookup failed' : null };
}

export async function website(url) {
  if (!url) return null;
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {}
  const r = await get(url, { json: false, timeout: 9000, ua: 'Mozilla/5.0 (compatible; truddy)' });
  // Any HTTP answer below 500 (incl. Cloudflare 403s) means the site is up.
  const up = r.status > 0 && r.status < 500 && r.status !== 404 && r.status !== 410;
  return { url, host, up, status: r.status, error: r.error, checkedAt: Date.now() };
}
