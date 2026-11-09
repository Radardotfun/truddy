import { test } from 'node:test';
import assert from 'node:assert/strict';
import { price, compact, stripAnsi, width, truncate, setColorLevel } from '../src/ui.js';
import { extractHandle, tweetDanger } from '../src/sources/social.js';
import { saneP, summarize, isEvmAddress, isSolAddress } from '../src/sources/dex.js';
import { classify, parseRss } from '../src/sources/news.js';
import { newCoinState, onMarket, onX, onSecurity } from '../src/alerts.js';
import { analyze } from '../src/core.js';

setColorLevel(0);

test('price formatting', () => {
  assert.equal(price(0.000002806), '$0.0₅2806');
  assert.equal(price(0.1593), '$0.1593');
  assert.equal(price(74638), '$74,638');
  assert.equal(price(1.5), '$1.500');
  assert.equal(compact(1_070_000), '$1.07M');
  assert.equal(compact(246_000_000), '$246M');
  assert.equal(compact(9760), '$9.76K');
});

test('width + truncate are ANSI aware', () => {
  setColorLevel(3);
  const s = '\x1b[38;2;1;2;3mhello world\x1b[39m';
  assert.equal(width(s), 11);
  assert.equal(stripAnsi(truncate(s, 6)), 'hello…');
  setColorLevel(0);
});

test('extracts X handles, ignores non-profile links', () => {
  assert.equal(extractHandle('https://twitter.com/bonk_inu'), 'bonk_inu');
  assert.equal(extractHandle('https://x.com/dogwifcoin?s=21'), 'dogwifcoin');
  assert.equal(extractHandle('https://x.com/i/communities/1789'), null);
  assert.equal(extractHandle('https://x.com/search?q=pepe'), null);
});

test('flags scary posts', () => {
  assert.ok(tweetDanger('Our account was hacked, do not click any links'));
  assert.ok(tweetDanger('We are migrating to a new CA tomorrow'));
  assert.equal(tweetDanger('gm frens'), null);
});

test('address detection', () => {
  assert.ok(isEvmAddress('0x6982508145454ce325ddbe47a25d4ec3d2311933'));
  assert.ok(isSolAddress('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'));
  assert.ok(!isSolAddress('bonk'));
});

const pair = (price, liq, vol, extra = {}) => ({
  chainId: 'solana',
  dexId: 'orca',
  baseToken: { address: 'Mint111', symbol: 'TEST', name: 'Test' },
  quoteToken: { symbol: 'SOL' },
  priceUsd: String(price),
  liquidity: { usd: liq },
  volume: { h24: vol },
  priceChange: { h1: 1, h24: 2 },
  txns: { m5: { buys: 1, sells: 1 }, h1: { buys: 10, sells: 10 }, h24: { buys: 100, sells: 100 } },
  pairCreatedAt: Date.now() - 400 * 864e5,
  ...extra,
});

test('drops broken pools with absurd prices', () => {
  const pairs = [pair(0.01393, 3_465_651, 125), pair(0.0000028, 274_000, 166_000), pair(0.0000028, 240_000, 111_000)];
  assert.equal(saneP(pairs).length, 2);
  const m = summarize(pairs);
  assert.equal(m.priceUsd, 0.0000028);
  assert.equal(m.liquidity, 514_000);
  assert.equal(m.outliers, 1);
});

test('detects launchpad bonding curves', () => {
  const m = summarize([pair(0.00001, undefined, 5000, { dexId: 'pumpfun', liquidity: undefined })]);
  assert.equal(m.bonding, true);
  assert.equal(m.launchpad, 'pumpfun');
});

test('news classification', () => {
  assert.equal(classify({ title: 'Protocol drained in $20M exploit' }).tone, 'bad');
  assert.equal(classify({ title: 'Coinbase lists BONK' }).tone, 'good');
  assert.equal(classify({ title: 'BONK Price Prediction 2026: will it reach $1?' }).tone, 'fluff');
  const items = parseRss('<rss><item><title>Bonk rallies 20% - CoinDesk</title><source>CoinDesk</source><pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate></item></rss>');
  assert.equal(items[0].title, 'Bonk rallies 20%');
  assert.equal(items[0].source, 'CoinDesk');
});

const target = () => ({ kind: 'token', key: 'solana:Mint111', symbol: 'TEST', name: 'Test', chainId: 'solana', address: 'Mint111', cg: null, market: summarize([pair(0.0000028, 200_000, 50_000)]) });

test('alerts: liquidity pull', () => {
  const st = newCoinState(target());
  onMarket(st, st.market);
  const pulled = { ...st.market, liquidity: 40_000 };
  const alerts = onMarket(st, pulled);
  assert.ok(alerts.some((a) => a.level === 'critical' && /Liquidity pulled/.test(a.text)), JSON.stringify(alerts));
});

test('alerts: X account disappears (needs two misses, never on unknown)', () => {
  const st = newCoinState(target());
  const alive = { handle: 'test', status: 'alive', user: { followers: 1000 }, tweets: [] };
  onX(st, alive, { seed: true });
  assert.equal(onX(st, { handle: 'test', status: 'unknown', tweets: [] }).length, 0);
  assert.equal(onX(st, { handle: 'test', status: 'gone', tweets: [] }).length, 0);
  const a = onX(st, { handle: 'test', status: 'gone', tweets: [] });
  assert.equal(a.length, 1);
  assert.equal(a[0].level, 'critical');
  assert.match(a[0].text, /GONE/);
});

test('alerts: scary new post pages you', () => {
  const st = newCoinState(target());
  onX(st, { handle: 'test', status: 'alive', user: {}, tweets: [] }, { seed: true });
  const a = onX(st, { handle: 'test', status: 'alive', user: {}, tweets: [{ id: '1', text: 'we got hacked, new contract coming', at: Date.now() - 60e3, danger: tweetDanger('we got hacked, new contract coming') }] });
  assert.equal(a[0].level, 'critical');
});

test('alerts: contract turns malicious', () => {
  const st = newCoinState(target());
  onSecurity(st, { available: true, checks: [{ id: 'mint', status: 'good', label: 'Mint authority revoked' }] });
  const a = onSecurity(st, { available: true, checks: [{ id: 'mint', status: 'bad', label: 'Mint authority is LIVE' }] });
  assert.equal(a[0].level, 'critical');
});

test('risk: honeypot-ish token scores DANGER, clean listed coin scores low', () => {
  const t = target();
  const bad = analyze({
    target: { ...t, market: { ...t.market, createdAt: Date.now() - 30 * 60e3 } },
    market: { ...t.market, createdAt: Date.now() - 30 * 60e3 },
    security: { available: true, checks: [{ id: 'mint', status: 'bad', label: 'Mint live', weight: 35 }, { id: 'freeze', status: 'bad', label: 'Freeze live', weight: 35 }] },
    x: { handle: 'gone', status: 'gone' },
  });
  assert.equal(bad.verdict.key, 'danger');
  const good = analyze({
    target: { ...t, cg: { id: 'test', rank: 50 } },
    market: { ...t.market, socials: [{ type: 'twitter', url: 'https://x.com/test' }] },
    security: { available: true, checks: [{ id: 'mint', status: 'good', label: 'ok' }] },
    x: { handle: 'test', status: 'alive', user: { followers: 50000, joined: Date.now() - 900 * 864e5 }, tweets: [] },
  });
  assert.equal(good.verdict.key, 'low');
});
