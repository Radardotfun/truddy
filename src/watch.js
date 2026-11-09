// Live dashboard (full-screen) and tail mode (log lines, for small panes / tmux splits).
import { resolve, collect, analyze, refreshMarket, xHandleFor, websiteFor } from './core.js';
import { security } from './sources/security.js';
import { xAccount, website } from './sources/social.js';
import { coinNews } from './sources/news.js';
import { newCoinState, seedPrices, onMarket, onX, onNews, onSecurity, onRisk, onSite } from './alerts.js';
import { loadConfig, saveConfig, loadCache, saveCache, keyOf, entryFor, targetFromEntry } from './store.js';
import { alertUser, setTitle, tabAlert } from './notify.js';
import { c, bold, fg, pad, width, truncate, spread, rule, spark, price, compact, pct, ago, clock, termWidth, termHeight, oneLine, gradient, Spinner } from './ui.js';
import { ICON } from './report.js';

const SEC = 1000;
const MIN = 60 * SEC;

const LEVEL_TAG = {
  critical: () => c.red(bold('CRIT')),
  warn: () => c.amber(bold('WARN')),
  info: () => c.sky('INFO'),
  good: () => c.mint(' OK '),
};
const SHORT_VERDICT = { low: 'low', caution: 'caution', high: 'high', danger: 'DANGER' };

export async function watch(queries, opts = {}) {
  const interval = Math.max(8, +opts.interval || 15) * SEC;
  const tail = !!opts.tail || !process.stdout.isTTY;
  const cfg = loadConfig();
  const sp = new Spinner('loading your coins').start();

  // ---- build the coin list
  let targets = [];
  try {
    if (queries.length) {
      for (const q of queries) {
        sp.set(`resolving ${q}`);
        const t = await resolve(q, opts);
        t.key = keyOf(t);
        if (!targets.some((x) => x.key === t.key)) targets.push(t);
      }
    } else {
      for (const e of cfg.watchlist) {
        sp.set(`refreshing $${e.symbol}`);
        const t = targetFromEntry(e);
        t.key = e.key;
        t.market = await refreshMarket(t);
        targets.push(t);
      }
    }
  } catch (err) {
    sp.stop();
    throw err;
  }
  if (!targets.length) {
    sp.stop();
    console.log(`\n  ${c.sub('Nothing to watch yet.')}  ${c.lime('truddy watch bonk')} ${c.mute('or')} ${c.lime('truddy add <coin>')}\n`);
    return;
  }

  const coins = targets.map((t) => newCoinState(t));
  const alerts = [];
  const saved = new Set(cfg.watchlist.map((e) => e.key));
  const ui = { focus: 0, nextAt: Date.now() + interval, status: '', quitting: false };

  const push = (list) => {
    for (const a of list) {
      alerts.unshift(a);
      alertUser(a, opts);
      if (tail) printAlert(a);
    }
    if (alerts.length > 200) alerts.length = 200;
    if (list.length) persist();
  };

  // ---- initial deep scan of every coin, in parallel
  sp.set(`scanning ${coins.map((s) => '$' + s.target.symbol).join(' ')}: contract · X · news`);
  await Promise.all(
    coins.map(async (st) => {
      const rep = await collect(st.target);
      seedPrices(st);
      onMarket(st, st.target.market);
      onSecurity(st, rep.security);
      onX(st, rep.x, { seed: true });
      onNews(st, rep.news, { seed: true });
      onSite(st, rep.site);
      st.risk = analyze({ ...rep, market: st.market });
      st.lastDeep = Date.now();
      st.lastX = Date.now();
      st.lastNews = Date.now();
      st.lastSite = Date.now();
    })
  );
  sp.stop();
  ui.nextAt = Date.now() + interval;

  for (const st of coins) {
    const v = st.risk.verdict;
    const top = st.risk.flags.find((f) => f.level === 'critical' || f.level === 'warn');
    push([{ id: 0, at: Date.now(), level: v.key === 'danger' || v.key === 'high' ? 'warn' : 'good', symbol: st.target.symbol, text: `Watching — risk ${st.risk.score} (${v.label.toLowerCase()})${top ? `. ${top.text}` : ''}` }]);
  }

  function persist() {
    try {
      const cache = loadCache();
      for (const st of coins) {
        const m = st.market || {};
        const lastCrit = alerts.find((a) => a.symbol === st.target.symbol && a.level === 'critical');
        cache.coins[st.target.key] = {
          symbol: st.target.symbol,
          price: m.priceUsd ?? null,
          h1: m.change?.h1 ?? null,
          h24: m.change?.h24 ?? null,
          liquidity: m.liquidity ?? null,
          risk: st.risk?.score ?? null,
          verdict: st.risk?.verdict?.key ?? null,
          xStatus: st.x?.status ?? null,
          followers: st.x?.user?.followers ?? null,
          alertAt: lastCrit?.at ?? cache.coins[st.target.key]?.alertAt ?? null,
          alertText: lastCrit?.text ?? cache.coins[st.target.key]?.alertText ?? null,
          updatedAt: Date.now(),
        };
      }
      cache.alerts = [...alerts.filter((a) => a.level === 'critical').slice(0, 20)];
      cache.updatedAt = Date.now();
      saveCache(cache);
    } catch {}
  }

  // ---- polling loops
  let busy = false;
  async function tick(force = false) {
    if (busy) return;
    busy = true;
    const now = Date.now();
    try {
      await Promise.all(
        coins.map(async (st) => {
          const t = st.target;
          const jobs = [];
          jobs.push(
            refreshMarket(t).then((m) => {
              if (m) {
                st.error = null;
                push(onMarket(st, m));
              } else st.error = 'market data unavailable';
            })
          );
          const handle = xHandleFor({ ...t, market: st.market || t.market });
          if (handle && (force || now - st.lastX > 90 * SEC)) {
            st.lastX = now;
            jobs.push(xAccount(handle).then((x) => push(onX(st, x))));
          }
          if (force || now - st.lastNews > 5 * MIN) {
            st.lastNews = now;
            jobs.push(coinNews({ name: t.name, symbol: t.symbol, major: t.kind === 'major', listed: !!t.cg }).then((n) => push(onNews(st, n))));
          }
          if (t.kind === 'token' && (force || now - st.lastDeep > 5 * MIN)) {
            st.lastDeep = now;
            jobs.push(security(t.chainId, t.address).then((s) => push(onSecurity(st, s))));
          }
          const url = websiteFor({ ...t, market: st.market || t.market });
          if (url && (force || now - st.lastSite > 10 * MIN)) {
            st.lastSite = now;
            jobs.push(website(url).then((s) => push(onSite(st, s))));
          }
          await Promise.all(jobs);
          push(onRisk(st, analyze({ target: t, market: st.market, security: st.security, x: st.x, site: st.site, news: st.news })));
        })
      );
      persist();
    } catch (err) {
      ui.status = c.red(`refresh failed: ${err.message}`);
    } finally {
      busy = false;
      ui.nextAt = Date.now() + interval;
      if (tail) printTicker();
      else render();
    }
  }

  // ---- tail mode -----------------------------------------------------------
  function printAlert(a) {
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
    console.log(`  ${c.mute(clock(a.at))}  ${LEVEL_TAG[a.level]()}  ${bold(c.text('$' + a.symbol))}  ${a.level === 'critical' ? c.red(a.text) : c.sub(a.text)}`);
  }
  function printTicker() {
    if (!process.stdout.isTTY) return;
    const parts = coins.map((st) => `${fg(st.risk?.verdict?.color || '#999999')(bold(st.target.symbol))} ${c.text(price(st.market?.priceUsd))} ${pct(st.market?.change?.h1)}`);
    process.stdout.write('\r\x1b[K  ' + gradient('◆') + ' ' + truncate(parts.join(c.mute('   ')), termWidth() - 6));
  }

  if (tail) {
    console.log(`\n  ${gradient('◆ truddy')} ${c.mute(`tailing ${coins.length} coin${coins.length > 1 ? 's' : ''} · every ${interval / SEC}s · ctrl+c to stop`)}\n`);
    for (const a of [...alerts].reverse()) printAlert(a);
    printTicker();
    const timer = setInterval(() => {
      if (!busy && Date.now() >= ui.nextAt) tick();
    }, SEC);
    const stop = () => {
      clearInterval(timer);
      tabAlert(false);
      process.stdout.write('\n');
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return new Promise(() => {});
  }

  // ---- full-screen dashboard ----------------------------------------------
  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[?25l');
  let lastFrame = '';

  function columns(W) {
    // [key, header, width, align, priority]  lower priority = dropped first
    const all = [
      ['sel', '', 2, 'left', 9],
      ['coin', 'COIN', 11, 'left', 9],
      ['price', 'PRICE', 13, 'right', 9],
      ['m5', '5M', 9, 'right', 3],
      ['h1', '1H', 9, 'right', 8],
      ['h24', '24H', 9, 'right', 7],
      ['liq', 'LIQUIDITY', 11, 'right', 5],
      ['mcap', 'MCAP', 10, 'right', 2],
      ['risk', 'RISK', 13, 'left', 9],
      ['x', 'X', 10, 'left', 6],
      ['trend', 'TREND', 14, 'left', 4],
    ].map(([key, h, w, align, pri], i) => ({ key, h, w, align, pri, i }));
    let cols = [...all];
    const total = () => cols.reduce((s, col) => s + col.w + 2, 2);
    while (total() > W && cols.length > 4) {
      const drop = cols.filter((col) => col.pri < 9).sort((a, b) => a.pri - b.pri)[0];
      if (!drop) break;
      cols = cols.filter((col) => col !== drop);
    }
    return cols.sort((a, b) => a.i - b.i);
  }

  function cell(st, key, focused) {
    const m = st.market || {};
    const risk = st.risk;
    switch (key) {
      case 'sel':
        return focused ? c.lime('›') : ' ';
      case 'coin':
        return focused ? bold(c.text(st.target.symbol)) : c.sub(st.target.symbol);
      case 'price':
        return m.dead ? c.red('dead') : c.text(price(m.priceUsd));
      case 'm5':
        return st.target.kind === 'major' ? c.mute('—') : pct(m.change?.m5);
      case 'h1':
        return pct(m.change?.h1);
      case 'h24':
        return pct(m.change?.h24);
      case 'liq':
        return st.target.kind === 'major' ? c.mute('CEX') : m.bonding ? c.amber('curve') : c.text(compact(m.liquidity));
      case 'mcap':
        return c.sub(compact(m.marketCap));
      case 'risk': {
        if (!risk) return c.mute('…');
        const col = fg(risk.verdict.color);
        return col('● ' + bold(String(risk.score).padStart(2))) + ' ' + col(SHORT_VERDICT[risk.verdict.key]);
      }
      case 'x': {
        const x = st.x;
        if (!x) return c.mute('—');
        if (x.status === 'gone' && st.xGoneStreak >= 2) return c.red(bold('✗ GONE'));
        if (x.status === 'alive') return c.mint('✓ ') + c.sub(compact(x.user?.followers, ''));
        return c.amber('? ') + c.mute('retry');
      }
      case 'trend':
        return spark(st.prices, 14);
    }
    return '';
  }

  function render() {
    if (ui.quitting) return;
    const W = termWidth();
    const H = termHeight();
    const inner = W - 4;
    const lines = [];
    const left = '  ' + gradient('◆ truddy') + c.mute(`   watching ${coins.length}`);
    const secs = Math.max(0, Math.round((ui.nextAt - Date.now()) / SEC));
    const right = (busy ? c.lime('refreshing') : c.mute(`next ${secs}s`)) + c.mute(`  ·  ${clock()}  `);
    lines.push('', spread(left, right, W), '');

    // table
    const cols = columns(inner);
    const row = (fn) => '  ' + cols.map((col) => pad(fn(col), col.w, col.align)).join('  ');
    lines.push(row((col) => c.mute(col.h)));
    coins.forEach((st, i) => lines.push(row((col) => cell(st, col.key, i === ui.focus))));
    lines.push('');

    // focus panel
    const st = coins[ui.focus];
    const panel = focusPanel(st, inner);

    // alerts get what's left
    const footer = ['', '  ' + c.mute('q quit   r refresh   ←/→ switch coin   s save to watchlist   ') + (ui.status || '')];
    const room = H - lines.length - panel.length - footer.length - 2;
    const shown = alerts.slice(0, Math.max(2, room));
    lines.push('  ' + rule(inner, 'ALERTS'));
    if (!shown.length) lines.push('  ' + c.mute('  all quiet. truddy is watching.'));
    for (const a of shown) {
      const head = `  ${c.mute(clock(a.at))}  ${LEVEL_TAG[a.level]()}  ${pad(bold(c.text('$' + a.symbol)), 9)} `;
      const body = a.level === 'critical' ? c.red(a.text) : a.level === 'warn' ? c.text(a.text) : c.sub(a.text);
      lines.push('  ' + truncate(head + body, inner));
    }
    lines.push('', ...panel, ...footer);

    const frame = lines.slice(0, H).map((l) => truncate(l, W) + '\x1b[K').join('\n');
    if (frame !== lastFrame) {
      out.write('\x1b[H' + frame + '\x1b[J');
      lastFrame = frame;
    }
    const tm = st.market || {};
    setTitle(`truddy · ${st.target.symbol} ${price(tm.priceUsd)} ${tm.change?.h1 != null ? (tm.change.h1 >= 0 ? '▲' : '▼') + Math.abs(tm.change.h1).toFixed(1) + '%' : ''}`);
  }

  function focusPanel(st, inner) {
    const L = [];
    const r = st.risk;
    const savedTag = saved.has(st.target.key) ? c.mint('saved') : c.mute('press s to save');
    L.push('  ' + rule(inner - width(savedTag) - 1, `$${st.target.symbol} · ${st.target.name}`) + ' ' + savedTag);
    if (r) {
      const col = fg(r.verdict.color);
      L.push('    ' + col(bold(r.verdict.label)) + c.mute(`  risk ${r.score}/100  `) + c.sub(r.verdict.blurb));
      for (const f of r.flags.filter((f) => f.level !== 'info').slice(0, 3)) L.push('    ' + ICON[f.level]() + ' ' + truncate(c.sub(f.text), inner - 6));
    }
    const x = st.x;
    if (x) {
      const status = x.status === 'alive' ? c.mint('live') : x.status === 'gone' ? c.red(bold('not found')) : c.amber('unknown');
      const t = (x.tweets || []).find((tw) => !tw.repost);
      const tw = t ? c.mute('  latest ') + c.sub(`“${oneLine(t.text).replace(/https?:\/\/t\.co\/\S+/g, '').trim() || '(media)'}”`) + c.mute(` ${ago(t.at)}`) : '';
      L.push('    ' + truncate(c.mute('X ') + c.sky('@' + x.handle) + ' ' + status + tw, inner - 4));
    }
    const n = st.news?.items?.[0];
    if (n) L.push('    ' + truncate(c.mute('News ') + (n.tone === 'bad' ? c.red('● ') : c.sub('● ')) + c.sub(n.title) + c.mute(`  ${n.source || ''} ${ago(n.at)}`), inner - 4));
    if (st.target.kind === 'token') L.push('    ' + c.mute(truncate(`${st.target.chainId} · ${st.target.address}`, inner - 4)));
    return L;
  }

  function cleanup() {
    ui.quitting = true;
    tabAlert(false);
    setTitle('');
    out.write('\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }

  function quit() {
    cleanup();
    const crit = alerts.filter((a) => a.level === 'critical');
    console.log(`\n  ${gradient('◆ truddy')} ${c.mute('stopped watching.')}${crit.length ? ' ' + c.red(`${crit.length} critical alert${crit.length > 1 ? 's' : ''} this session:`) : ''}`);
    for (const a of crit.slice(0, 5)) console.log(`    ${c.mute(clock(a.at))} ${bold('$' + a.symbol)} ${c.red(a.text)}`);
    console.log('');
    process.exit(0);
  }

  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
  out.on('resize', () => {
    lastFrame = '';
    out.write('\x1b[2J');
    render();
  });

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (k) => {
      if (k === 'q' || k === 'Q' || k === '\u0003' || k === '\u001b') return quit();
      if (k === 'r' || k === 'R') {
        ui.status = '';
        tabAlert(false);
        return tick(true);
      }
      if (k === '\u001b[C' || k === '\u001b[B' || k === '\t' || k === 'l' || k === 'j') ui.focus = (ui.focus + 1) % coins.length;
      if (k === '\u001b[D' || k === '\u001b[A' || k === 'h' || k === 'k') ui.focus = (ui.focus - 1 + coins.length) % coins.length;
      if (k === 's' || k === 'S') {
        const t = coins[ui.focus].target;
        const cfgNow = loadConfig();
        if (!cfgNow.watchlist.some((e) => e.key === t.key)) {
          cfgNow.watchlist.push(entryFor(t));
          saveConfig(cfgNow);
        }
        saved.add(t.key);
        ui.status = c.mint(`saved $${t.symbol} to your watchlist`);
      }
      render();
    });
  }

  render();
  setInterval(() => {
    if (!busy && Date.now() >= ui.nextAt) tick();
    else render();
  }, SEC);
  return new Promise(() => {});
}
