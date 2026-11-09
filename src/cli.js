import { VERSION } from './version.js';
import { scan, resolve, collect, analyze, xHandleFor, VERDICTS, TruddyError } from './core.js';
import { renderReport, chainName } from './report.js';
import { watch } from './watch.js';
import { marketNews, coinNews } from './sources/news.js';
import { xAccount } from './sources/social.js';
import { loadConfig, saveConfig, loadCache, saveCache, keyOf, entryFor } from './store.js';
import { promptSegment, refresh, initScript, detectShell, installHint } from './prompt.js';
import { c, bold, fg, logo, gradient, mark, rule, pad, truncate, spread, price, pct, compact, ago, termWidth, oneLine, Spinner, width } from './ui.js';

const COMMANDS = new Set(['scan', 'watch', 'news', 'x', 'add', 'rm', 'remove', 'list', 'ls', 'prompt', 'init', 'refresh', 'help', 'version']);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const key = k.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (v !== undefined) flags[key] = v;
      else if (['interval', 'chain', 'shell', 'max'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('-')) flags[key] = argv[++i];
      else flags[key] = true;
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      for (const ch of a.slice(1)) flags[{ h: 'help', v: 'version', j: 'json', t: 'tail', n: 'notify', i: 'interval', c: 'chain' }[ch] || ch] = true;
      if ((a === '-i' || a === '-c') && argv[i + 1]) flags[a === '-i' ? 'interval' : 'chain'] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

function help() {
  const cmd = (name, desc) => '    ' + c.lime(pad(name, 26)) + c.sub(desc);
  console.log(`
${logo()
  .split('\n')
  .map((l) => '  ' + l)
  .join('\n')}

  ${c.text('your trading buddy.')} ${c.sub('lives in your terminal, watches your coins,')}
  ${c.sub('and yells when something smells like a rug.')}  ${c.mute('v' + VERSION)}

  ${c.mute('USAGE')}
${cmd('truddy <coin>', 'full safety scan (ticker, name or contract)')}
${cmd('truddy watch [coins…]', 'live dashboard + alerts (defaults to watchlist)')}
${cmd('truddy watch <coin> --tail', 'log-style alerts for small panes / tmux')}
${cmd('truddy x <coin|@handle>', 'is the X account alive? latest posts')}
${cmd('truddy news [coin]', 'headlines for a coin, or the whole market')}
${cmd('truddy add <coin>', 'add to watchlist (shows in your prompt)')}
${cmd('truddy rm <coin>', 'remove from watchlist')}
${cmd('truddy list', 'your watchlist at a glance')}
${cmd('truddy init [shell]', 'put truddy in your shell prompt')}

  ${c.mute('FLAGS')}
${cmd('--chain <id>', 'solana, ethereum, base, bsc, arbitrum…')}
${cmd('--interval <sec>', 'watch refresh rate (default 15)')}
${cmd('--notify', 'desktop notification on critical alerts')}
${cmd('--json', 'machine-readable scan output')}

  ${c.mute('EXAMPLES')}
    ${c.mute('$')} ${c.text('truddy bonk')}
    ${c.mute('$')} ${c.text('truddy watch wif pepe --notify')}
    ${c.mute('$')} ${c.text('truddy 0x6982508145454ce325ddbe47a25d4ec3d2311933')}

  ${c.mute('Signals, not financial advice. Free public data: DexScreener, CoinGecko, RugCheck, GoPlus, FxTwitter, Google News.')}
`);
}

async function cmdScan(q, flags) {
  if (!q) throw new TruddyError('Usage: truddy scan <ticker | name | contract address>');
  const sp = flags.json ? null : new Spinner(`sniffing ${q}`).start();
  try {
    const rep = await scan(q, { chain: flags.chain, news: !flags.noNews }, (s) => sp?.set(s));
    sp?.stop();
    if (flags.json) {
      const { target, ...rest } = rep;
      console.log(JSON.stringify({ query: q, coin: { kind: target.kind, symbol: target.symbol, name: target.name, chain: target.chainId, address: target.address, coingecko: target.cg, copycats: target.copycats }, ...rest, risk: { score: rep.risk.score, verdict: rep.risk.verdict.key, label: rep.risk.verdict.label, flags: rep.risk.flags } }, null, 2));
      return;
    }
    console.log(renderReport(rep));
  } finally {
    sp?.stop();
  }
}

async function cmdNews(q, flags) {
  const W = Math.min(termWidth() - 2, 96);
  const sp = new Spinner(q ? `reading news on ${q}` : 'reading the market').start();
  let title;
  let res;
  try {
    if (q) {
      const t = await resolve(q, flags);
      title = `$${t.symbol} · ${t.name}`;
      res = await coinNews({ name: t.name, symbol: t.symbol, major: t.kind === 'major', listed: !!t.cg }, { limit: 12 });
    } else {
      title = 'market';
      res = await marketNews({ limit: 14 });
    }
  } finally {
    sp.stop();
  }
  console.log('\n  ' + gradient('◆ truddy') + c.mute(' news · ') + c.text(title) + '\n');
  if (!res.items.length) console.log('  ' + c.mute('No headlines right now.'));
  for (const n of res.items) {
    const dot = n.tone === 'bad' ? c.red('●') : n.tone === 'good' ? c.mint('●') : n.tone === 'fluff' ? c.line('●') : c.sub('●');
    const tail = c.mute(`  ${n.source || ''} · ${ago(n.at)}`);
    const t = n.tone === 'fluff' ? c.mute(n.title) : n.tone === 'bad' ? c.text(n.title) : c.sub(n.title);
    console.log('  ' + dot + ' ' + truncate(t, W - 6 - width(tail)) + tail);
  }
  console.log('\n  ' + c.mute('● ') + c.red('●') + c.mute(' red flag words   ') + c.mint('●') + c.mute(' positive   ') + c.line('●') + c.mute(' price-prediction fluff') + '\n');
}

async function cmdX(q, flags) {
  if (!q) throw new TruddyError('Usage: truddy x <coin | @handle>');
  const W = Math.min(termWidth() - 2, 96);
  const sp = new Spinner(`checking X for ${q}`).start();
  let handle;
  let x;
  try {
    if (q.startsWith('@')) handle = q.slice(1);
    else {
      const t = await resolve(q, flags);
      handle = xHandleFor(t);
      if (!handle) {
        sp.stop();
        console.log(`\n  ${c.amber('!')} ${c.text(`$${t.symbol} has no X account linked on DexScreener or CoinGecko.`)} ${c.mute('That alone is a yellow flag.')}\n`);
        return;
      }
    }
    x = await xAccount(handle, { attempts: 4 });
  } finally {
    sp.stop();
  }
  console.log('');
  if (x.status === 'gone') {
    console.log(`  ${c.red(bold('✗ @' + handle + ' NOT FOUND'))}  ${c.sub('the account is deleted, suspended or was renamed.')}`);
    console.log(`  ${c.mute('When a project account vanishes, treat it as a rug signal until proven otherwise.')}\n`);
    return;
  }
  if (x.status === 'unknown') {
    console.log(`  ${c.amber('? @' + handle)}  ${c.sub('X lookup did not answer cleanly. Try again in a few seconds.')}\n`);
    return;
  }
  const u = x.user;
  console.log(
    `  ${c.sky(bold('@' + u.handle))} ${c.sub(u.name || '')}  ${c.mint('● live')}  ${c.mute(`${compact(u.followers, '')} followers · ${compact(u.posts, '')} posts${u.joined ? ' · joined ' + new Date(u.joined).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ''}`)}`
  );
  if (u.description) console.log('  ' + truncate(c.mute(oneLine(u.description)), W - 4));
  console.log('\n' + rule(W, 'LATEST POSTS'));
  const own = x.tweets.filter((t) => !t.repost).slice(0, 8);
  if (!own.length) console.log('  ' + c.mute('No recent posts visible.'));
  for (const t of own) {
    const body = oneLine(t.text).replace(/https?:\/\/t\.co\/\S+/g, '').trim() || '(media)';
    const meta = c.mute(`  ♥ ${compact(t.likes, '')}  ↻ ${compact(t.reposts, '')}`);
    const icon = t.danger ? c.amber('!') : t.reply ? c.mute('↳') : c.sub('●');
    console.log('  ' + c.mute(pad(ago(t.at), 4)) + ' ' + icon + ' ' + truncate(t.danger ? c.amber(body) : c.text(body), W - 10 - width(meta)) + meta);
    if (t.danger) console.log('         ' + c.amber(`↑ ${t.danger}`));
  }
  console.log('');
}

async function cmdAdd(qs, flags) {
  if (!qs.length) throw new TruddyError('Usage: truddy add <coin> [more coins…]');
  const cfg = loadConfig();
  const cache = loadCache();
  for (const q of qs) {
    const sp = new Spinner(`scanning ${q}`).start();
    let rep;
    try {
      const target = await resolve(q, flags);
      rep = await collect(target, { news: false });
      rep.risk = analyze(rep);
    } finally {
      sp.stop();
    }
    const t = rep.target;
    const key = keyOf(t);
    if (!cfg.watchlist.some((e) => e.key === key)) cfg.watchlist.push(entryFor(t));
    cache.coins[key] = {
      ...(cache.coins[key] || {}),
      symbol: t.symbol,
      price: rep.market?.priceUsd ?? null,
      h1: rep.market?.change?.h1 ?? null,
      h24: rep.market?.change?.h24 ?? null,
      liquidity: rep.market?.liquidity ?? null,
      risk: rep.risk.score,
      verdict: rep.risk.verdict.key,
      xStatus: rep.x?.status ?? null,
      xEverAlive: rep.x?.status === 'alive',
      xCheckedAt: Date.now(),
      followers: rep.x?.user?.followers ?? null,
      updatedAt: Date.now(),
    };
    const col = fg(rep.risk.verdict.color);
    console.log(`  ${c.mint('✓')} ${c.text('added')} ${bold('$' + t.symbol)} ${c.mute(t.kind === 'major' ? 'CoinGecko' : chainName(t.chainId))}  ${col('● ' + rep.risk.score + ' ' + rep.risk.verdict.label.toLowerCase())}`);
  }
  saveConfig(cfg);
  saveCache(cache);
  console.log(`\n  ${c.mute('watch them live:')} ${c.lime('truddy watch')}   ${c.mute('in your prompt:')} ${c.lime('truddy init')}\n`);
}

function cmdRm(qs) {
  if (!qs.length) throw new TruddyError('Usage: truddy rm <symbol | address>');
  const cfg = loadConfig();
  const before = cfg.watchlist.length;
  const hit = (e, q) => [e.symbol, e.address, e.key, e.cg?.id].filter(Boolean).some((v) => v.toLowerCase() === q.toLowerCase().replace(/^\$/, ''));
  cfg.watchlist = cfg.watchlist.filter((e) => !qs.some((q) => hit(e, q)));
  saveConfig(cfg);
  const n = before - cfg.watchlist.length;
  console.log(n ? `  ${c.mint('✓')} removed ${n} coin${n > 1 ? 's' : ''}` : `  ${c.amber('!')} nothing in your watchlist matched ${qs.join(', ')}`);
}

function cmdList() {
  const cfg = loadConfig();
  const cache = loadCache();
  if (!cfg.watchlist.length) {
    console.log(`\n  ${c.sub('Your watchlist is empty.')} ${c.lime('truddy add bonk')}\n`);
    return;
  }
  console.log('\n  ' + gradient('◆ truddy') + c.mute(' watchlist') + '\n');
  console.log('  ' + c.mute(pad('COIN', 10) + pad('CHAIN', 11) + pad('PRICE', 14, 'right') + pad('1H', 10, 'right') + pad('RISK', 12, 'right') + pad('X', 10, 'right') + pad('UPDATED', 10, 'right')));
  for (const e of cfg.watchlist) {
    const s = cache.coins[e.key] || {};
    const vcol = s.verdict ? fg(VERDICTS.find((v) => v.key === s.verdict).color) : c.mute;
    const x = s.xStatus === 'alive' ? c.mint('✓ ' + compact(s.followers, '')) : s.xStatus === 'gone' ? c.red('✗ gone') : c.mute('—');
    console.log(
      '  ' +
        bold(pad(c.text(e.symbol), 10)) +
        pad(c.sub(e.kind === 'major' ? 'native' : chainName(e.chainId)), 11) +
        pad(c.text(price(s.price)), 14, 'right') +
        pad(pct(s.h1), 10, 'right') +
        pad(s.risk != null ? vcol('● ' + s.risk) : c.mute('—'), 12, 'right') +
        pad(x, 10, 'right') +
        pad(c.mute(s.updatedAt ? ago(s.updatedAt) : '—'), 10, 'right')
    );
  }
  console.log('');
}

function cmdInit(shellArg) {
  const shell = (shellArg || '').toLowerCase();
  const script = shell ? initScript(shell) : null;
  if (script && !process.stdout.isTTY) {
    // being eval'd by a shell
    process.stdout.write(script + '\n');
    return;
  }
  if (script) {
    console.log(script);
    return;
  }
  const sh = detectShell();
  const { file, line } = installHint(sh);
  console.log(`
  ${gradient('◆ truddy')} ${c.text('in every terminal you open')}

  ${c.sub('Add this line to')} ${c.text(file)}${c.sub(':')}

    ${c.lime(line)}

  ${c.sub('Then open a new terminal. Your watchlist rides along in the prompt:')}
    ${gradient('◆')} ${fg('#5CFFB0')(bold('BONK'))} ${c.mint('▲2.8%')} ${c.mute('·')} ${fg('#FFC857')(bold('WIF'))} ${c.red('▼4.1%')} ${c.red(bold('!'))}   ${c.mute('← ! = critical alert in the last 30m')}

  ${c.mute('Other shells:')} ${c.sub('truddy init bash | zsh | fish | powershell')}
  ${c.mute('Starship:')} ${c.sub('[custom.truddy] command = "truddy prompt --shell plain"  when = true')}
`);
}

export async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  if (flags.version) return console.log(VERSION);
  let [cmd, ...rest] = pos;
  if (flags.help || cmd === 'help') return help();
  if (!cmd) {
    const cfg = loadConfig();
    if (cfg.watchlist.length && process.stdout.isTTY) return watch([], flags);
    return help();
  }
  if (!COMMANDS.has(cmd)) {
    rest = pos;
    cmd = 'scan';
  }
  try {
    switch (cmd) {
      case 'scan':
        for (const q of rest.length ? rest : [undefined]) await cmdScan(q, flags);
        return;
      case 'watch':
        return await watch(rest, flags);
      case 'news':
        return await cmdNews(rest[0], flags);
      case 'x':
        return await cmdX(rest[0], flags);
      case 'add':
        return await cmdAdd(rest, flags);
      case 'rm':
      case 'remove':
        return cmdRm(rest);
      case 'list':
      case 'ls':
        return cmdList();
      case 'prompt': {
        const s = promptSegment({ shell: flags.shell || 'ansi', max: +flags.max || 3 });
        if (s) process.stdout.write(s);
        return;
      }
      case 'refresh':
        return await refresh();
      case 'init':
        return cmdInit(rest[0] || (typeof flags.shell === 'string' ? flags.shell : ''));
      case 'version':
        return console.log(VERSION);
    }
  } catch (err) {
    if (err instanceof TruddyError) {
      console.error(`\n  ${c.amber('!')} ${c.text(err.message)}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
