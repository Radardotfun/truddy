// Renders a full scan report.
import { c, bold, dim, fg, pad, width, truncate, spread, rule, bar, spark, box, price, compact, pct, ago, duration, termWidth, oneLine, mark } from './ui.js';

export const ICON = {
  bad: () => c.red('✗'),
  critical: () => c.red('✗'),
  warn: () => c.amber('!'),
  good: () => c.mint('✓'),
  info: () => c.sub('·'),
};

const CHAIN = { ethereum: 'Ethereum', bsc: 'BSC', solana: 'Solana', base: 'Base', arbitrum: 'Arbitrum', polygon: 'Polygon', avalanche: 'Avalanche', optimism: 'Optimism', sui: 'Sui', ton: 'TON', tron: 'Tron' };
export const chainName = (id) => CHAIN[id] || (id ? id[0].toUpperCase() + id.slice(1) : '');

export function riskBadge(risk, w = 12) {
  const col = fg(risk.verdict.color);
  return col(bold(`RISK ${String(risk.score).padStart(2, ' ')}`)) + ' ' + bar(risk.score / 100, w, col);
}

const kv = (k, v, kw = 12) => c.mute(pad(k, kw)) + v;

function twoCol(rows, W) {
  const half = Math.floor((W - 2) / 2);
  return rows.map(([a, b]) => '  ' + pad(a || '', half) + (b || ''));
}

function pressure(t) {
  const buys = t?.buys || 0;
  const sells = t?.sells || 0;
  const total = buys + sells;
  if (!total) return c.mute('no trades');
  return `${bar(buys / total, 10, c.mint, c.red)} ${c.mint(buys)}${c.mute(' buys ')}${c.red(sells)}${c.mute(' sells')}`;
}

export function renderReport(rep, { W = Math.min(termWidth() - 2, 88) } = {}) {
  const { target, market: m, security: sec, x, site, news, risk } = rep;
  const isMajor = target.kind === 'major';
  const out = [];
  const inner = W - 6;
  const vcol = fg(risk.verdict.color);

  // ---------- header card
  const sub = isMajor
    ? c.sub(`${target.name}`) + c.mute('  ·  ') + c.sub(`CoinGecko #${target.cg.rank}`)
    : c.sub(target.name) + c.mute('  ·  ') + c.sub(chainName(target.chainId)) + c.mute('  ·  ') + c.sub(m.dex || '');
  const changes = isMajor
    ? `${pct(m.change?.h1)} ${c.mute('1h')}   ${pct(m.change?.h24)} ${c.mute('24h')}   ${pct(m.change?.d7)} ${c.mute('7d')}`
    : `${pct(m.change?.h1)} ${c.mute('1h')}   ${pct(m.change?.h24)} ${c.mute('24h')}`;
  const header = [
    spread(bold(c.text('$' + target.symbol)) + '  ' + sub, riskBadge(risk), inner),
    spread(bold(c.text(price(m.priceUsd))) + '    ' + changes, vcol('● ') + bold(vcol(risk.verdict.label)), inner),
    isMajor ? c.mute(`native asset · data via CoinGecko`) : c.mute(target.address),
  ];
  out.push('', box(header, { w: W, color: c.line }));

  // ---------- verdict + top reasons
  out.push('', '  ' + vcol(bold(risk.verdict.label)) + c.mute('  —  ') + c.sub(risk.verdict.blurb));
  const reasons = risk.flags.filter((f) => f.level === 'critical' || f.level === 'warn').slice(0, 5);
  const goods = risk.flags.filter((f) => f.level === 'good').slice(0, 2);
  for (const f of [...reasons, ...goods]) out.push('    ' + ICON[f.level]() + ' ' + truncate(f.level === 'good' ? c.sub(f.text) : c.text(f.text), W - 8));

  // ---------- market
  out.push('', rule(W, 'MARKET'));
  if (isMajor) {
    out.push(
      ...twoCol(
        [
          [kv('Market cap', c.text(compact(m.marketCap))), kv('Volume 24h', c.text(compact(m.volume24h)))],
          [kv('24h range', c.text(`${price(m.low24h)} – ${price(m.high24h)}`)), kv('From ATH', m.athChange != null ? pct(m.athChange) : c.mute('—'))],
        ],
        W
      ),
      '  ' + kv('7d', spark(downsample(m.sparkline, Math.min(48, W - 18)), Math.min(48, W - 18)))
    );
  } else {
    const ratio = m.marketCap && !m.bonding ? m.liquidity / m.marketCap : null;
    const liq = m.bonding ? c.amber('bonding curve') + c.mute(`  ${m.launchpad}`) : c.text(compact(m.liquidity)) + (ratio != null ? c.mute(`  ${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}% of mcap`) : '');
    out.push(
      ...twoCol(
        [
          [kv('Liquidity', liq), kv('Market cap', c.text(compact(m.marketCap)))],
          [kv('Volume 24h', c.text(compact(m.volume24h))), kv('Age', c.text(m.createdAt ? duration(Date.now() - m.createdAt) : '—'))],
          [kv('Pools', c.text(m.pairCount) + c.mute(`  main on ${m.dex}`)), kv('Holders', c.text(holderCount(sec)))],
        ],
        W
      ),
      '  ' + kv('Moves', `${c.mute('5m')} ${pct(m.change?.m5)}   ${c.mute('1h')} ${pct(m.change?.h1)}   ${c.mute('6h')} ${pct(m.change?.h6)}   ${c.mute('24h')} ${pct(m.change?.h24)}`),
      '  ' + kv('Flow 1h', pressure(m.txnsAll?.h1)),
      '  ' + kv('Flow 24h', pressure(m.txnsAll?.h24))
    );
  }

  // ---------- contract
  if (!isMajor) {
    const src = sec?.available ? c.mute(`via ${sec.sources.join(' · ')}`) : '';
    out.push('', spread(rule(Math.max(10, W - width(src) - 1), 'CONTRACT'), src, W));
    if (!sec?.available) out.push('  ' + c.amber('!') + ' ' + c.sub(sec?.reason || 'not scanned'));
    else {
      const rank = { bad: 0, warn: 1, good: 2, info: 3 };
      // LP lock % only matters for young/unlisted tokens; on listed coins it's noise
      const checks = sec.checks
        .filter((ch) => ch.id !== 'holders' && !(ch.id === 'lp' && target.cg && ch.value < 50))
        .sort((a, b) => rank[a.status] - rank[b.status]);
      for (const ch of checks.slice(0, 12)) {
        const txt = ch.status === 'bad' ? c.red(ch.label) : ch.status === 'warn' ? c.text(ch.label) : c.sub(ch.label);
        out.push('  ' + ICON[ch.status]() + ' ' + truncate(txt, W - 6));
      }
    }
  }

  // ---------- socials
  out.push('', rule(W, 'SOCIALS'));
  if (x) {
    const status =
      x.status === 'alive' ? c.mint('● live') : x.status === 'gone' ? c.red(bold('● NOT FOUND')) + c.red(' deleted, suspended or renamed') : c.amber('● unknown') + c.mute(' (X lookup flaky, retry)');
    const u = x.user;
    const meta = u
      ? c.mute('  ') +
        c.sub(`${compact(u.followers, '')} followers`) +
        (u.joined ? c.mute(' · ') + c.sub(`joined ${new Date(u.joined).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`) : '')
      : '';
    out.push('  ' + kv('X', c.sky('@' + x.handle) + '  ' + status + meta, 7));
    const own = (x.tweets || []).filter((t) => !t.repost).slice(0, 2);
    for (const t of own) {
      const body = oneLine(t.text).replace(/https?:\/\/t\.co\/\S+/g, '').trim() || '(media)';
      const tail = c.mute(`  ${ago(t.at)}`);
      const icon = t.danger ? c.amber('!') : c.line('└');
      out.push('         ' + icon + ' ' + truncate((t.danger ? c.amber : c.sub)(`“${body}”`), W - 12 - width(tail)) + tail);
    }
  } else out.push('  ' + kv('X', rep.communityOnly ? c.amber('community link only') : c.mute('none linked'), 7));
  if (site) out.push('  ' + kv('Web', c.sky(site.host) + '  ' + (site.up ? c.mint('● up') : c.red(`● down`) + c.mute(` ${site.status || site.error || ''}`)), 7));
  const others = (m.socials || []).filter((s) => s.type !== 'twitter').map((s) => s.url.replace(/^https?:\/\/(www\.)?/, ''));
  if (target.cg?.telegram && !others.some((o) => o.includes('t.me'))) others.unshift(`t.me/${target.cg.telegram}`);
  if (others.length) out.push('  ' + kv('Links', truncate(others.slice(0, 3).map((o) => c.sub(o)).join(c.mute('  ·  ')), W - 11), 7));

  // ---------- news
  if (news) {
    out.push('', rule(W, 'NEWS'));
    if (!news.items.length) out.push('  ' + c.mute('No headlines about this coin in the past week.'));
    for (const n of news.items.slice(0, 5)) {
      const dot = n.tone === 'bad' ? c.red('●') : n.tone === 'good' ? c.mint('●') : n.tone === 'fluff' ? c.line('●') : c.sub('●');
      const tail = c.mute(`  ${n.source ? n.source + ' · ' : ''}${ago(n.at)}`);
      const title = n.tone === 'fluff' ? c.mute(n.title) : n.tone === 'bad' ? c.text(n.title) : c.sub(n.title);
      out.push('  ' + dot + ' ' + truncate(title, W - 6 - width(tail)) + tail);
    }
  }

  // ---------- footer
  // a CoinGecko-listed ticker always resolves to the same contract; DEX-only tickers can drift to copycats
  const cmd = target.cg && !/^(0x|[1-9A-HJ-NP-Za-km-z]{32})/.test(target.query) ? target.query.toLowerCase() : target.address;
  out.push('', rule(W), '  ' + mark() + ' ' + c.mute('watch it live ') + c.lime(`truddy watch ${truncate(cmd, 46)}`));
  if (m.url) out.push('    ' + c.mute(m.url));
  out.push('    ' + dim(c.mute('Signals, not financial advice. A clean scan cannot rule out a rug.')), '');
  return out.join('\n');
}

function holderCount(sec) {
  const h = sec?.checks?.find((ch) => ch.id === 'holders');
  return h ? compact(h.value, '') : '—';
}

function downsample(arr, n) {
  if (!arr?.length || arr.length <= n) return arr || [];
  const out = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}
export { downsample };
