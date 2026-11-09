// Shell prompt integration: a tiny segment that reads the cache instantly and refreshes
// itself in the background, so truddy rides along in every terminal you open.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, LOCK, loadConfig, loadCache, saveCache, targetFromEntry } from './store.js';
import { refreshMarket, xHandleFor } from './core.js';
import { xAccount } from './sources/social.js';
import { setColorLevel, fg, c, bold, theme, gradient } from './ui.js';
import { VERDICTS } from './core.js';

const STALE = 45e3;
const BIN = fileURLToPath(new URL('../bin/truddy.js', import.meta.url));

function lockFresh() {
  try {
    return Date.now() - fs.statSync(LOCK).mtimeMs < 90e3;
  } catch {
    return false;
  }
}

function kickRefresh() {
  if (lockFresh()) return;
  try {
    const p = spawn(process.execPath, [BIN, 'refresh'], { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

export function promptSegment({ shell = 'ansi', max = 3 } = {}) {
  const plain = shell === 'plain' || (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '');
  setColorLevel(plain ? 0 : process.env.COLORTERM === 'truecolor' || process.env.WT_SESSION || process.platform === 'win32' ? 3 : 2);
  const cfg = loadConfig();
  if (!cfg.watchlist.length) return '';
  const cache = loadCache();
  const now = Date.now();
  if (cfg.watchlist.some((e) => !cache.coins[e.key] || now - (cache.coins[e.key].updatedAt || 0) > STALE)) kickRefresh();

  const parts = cfg.watchlist.slice(0, max).map((e) => {
    const s = cache.coins[e.key];
    if (!s) return c.mute(e.symbol + ' …');
    const vcol = fg(VERDICTS.find((v) => v.key === s.verdict)?.color || theme.sub);
    const ch = s.h1;
    const move = ch == null ? '' : ch >= 0 ? c.mint(`▲${Math.abs(ch).toFixed(1)}%`) : c.red(`▼${Math.abs(ch).toFixed(1)}%`);
    const hot = s.alertAt && now - s.alertAt < 30 * 60e3;
    const gone = s.xStatus === 'gone' && (s.xGone || 0) >= 2;
    return vcol(bold(e.symbol)) + (move ? ' ' + move : '') + (hot || gone ? ' ' + c.red(bold('!')) : '');
  });
  let seg = gradient('◆') + ' ' + parts.join(c.mute(' · '));
  if (shell === 'zsh') seg = seg.replace(/%/g, '%%').replace(/\x1b\[[0-9;]*m/g, '%{$&%}');
  if (shell === 'bash') seg = seg.replace(/\x1b\[[0-9;]*m/g, '\x01$&\x02');
  return seg;
}

// Background refresher used by the prompt (and safe to run by hand / from cron).
export async function refresh() {
  if (lockFresh()) return;
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    const cfg = loadConfig();
    const cache = loadCache();
    const now = Date.now();
    await Promise.all(
      cfg.watchlist.map(async (e) => {
        const t = targetFromEntry(e);
        const prev = cache.coins[e.key] || {};
        const m = await refreshMarket(t);
        if (!m) return;
        const next = { ...prev, symbol: e.symbol, price: m.priceUsd ?? null, h1: m.change?.h1 ?? null, h24: m.change?.h24 ?? null, liquidity: m.liquidity ?? null, updatedAt: now };
        const flag = (text) => {
          next.alertAt = now;
          next.alertText = text;
          cache.alerts = [{ at: now, level: 'critical', symbol: e.symbol, text }, ...(cache.alerts || [])].slice(0, 20);
        };
        if (t.kind === 'token') {
          if (prev.liquidity > 5000 && m.liquidity < prev.liquidity * 0.7) flag(`Liquidity pulled −${((1 - m.liquidity / prev.liquidity) * 100).toFixed(0)}%`);
          if (prev.price && m.priceUsd && m.priceUsd / prev.price - 1 <= -0.2) flag(`Price ${((m.priceUsd / prev.price - 1) * 100).toFixed(0)}% since last check`);
        }
        if (!prev.xCheckedAt || now - prev.xCheckedAt > 5 * 60e3) {
          const handle = xHandleFor({ ...t, market: m });
          if (handle) {
            const x = await xAccount(handle, { attempts: 2 });
            next.xCheckedAt = now;
            if (x.status === 'alive') {
              next.xStatus = 'alive';
              next.xEverAlive = true;
              next.xGone = 0;
              next.followers = x.user?.followers ?? prev.followers;
            } else if (x.status === 'gone') {
              next.xGone = (prev.xGone || 0) + 1;
              next.xStatus = 'gone';
              if (prev.xEverAlive && next.xGone === 2) flag(`X account @${handle} is gone`);
            }
          }
        }
        cache.coins[e.key] = next;
      })
    );
    cache.updatedAt = Date.now();
    saveCache(cache);
  } finally {
    try {
      fs.unlinkSync(LOCK);
    } catch {}
  }
}

export function initScript(shell) {
  switch (shell) {
    case 'bash':
      return `# truddy: coin ticker in your prompt
__truddy_prompt() { local s; s="$(truddy prompt --shell bash 2>/dev/null)"; [ -n "$s" ] && printf '%s ' "$s"; }
case "$PS1" in *__truddy_prompt*) ;; *) PS1='$(__truddy_prompt)'"$PS1" ;; esac`;
    case 'zsh':
      return `# truddy: coin ticker in your right prompt
setopt PROMPT_SUBST
__truddy_prompt() { truddy prompt --shell zsh 2>/dev/null }
[[ "$RPROMPT" == *__truddy_prompt* ]] || RPROMPT='$(__truddy_prompt)'"$RPROMPT"`;
    case 'fish':
      return `# truddy: coin ticker in your right prompt
if not functions -q __truddy_orig_right_prompt; and functions -q fish_right_prompt
  functions -c fish_right_prompt __truddy_orig_right_prompt
end
function fish_right_prompt
  truddy prompt --shell fish 2>/dev/null
  functions -q __truddy_orig_right_prompt; and __truddy_orig_right_prompt
end`;
    case 'powershell':
    case 'pwsh':
      return `# truddy: coin ticker in your prompt
if (-not $global:__truddyOrigPrompt) { $global:__truddyOrigPrompt = $function:prompt }
function global:prompt {
  $enc = [Console]::OutputEncoding
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $t = (& truddy prompt --shell pwsh 2>$null) -join '' } catch { $t = '' } finally { [Console]::OutputEncoding = $enc }
  $p = & $global:__truddyOrigPrompt
  if ($t) { "$t $p" } else { $p }
}`;
    default:
      return null;
  }
}

export function detectShell() {
  const env = process.env;
  if (env.PSModulePath && process.platform === 'win32' && !env.SHELL) return 'powershell';
  const sh = (env.SHELL || '').split(/[\\/]/).pop();
  if (['bash', 'zsh', 'fish'].includes(sh)) return sh;
  if (env.PSModulePath) return 'powershell';
  return 'bash';
}

export function installHint(shell) {
  switch (shell) {
    case 'bash':
      return { file: '~/.bashrc', line: 'eval "$(truddy init bash)"' };
    case 'zsh':
      return { file: '~/.zshrc', line: 'eval "$(truddy init zsh)"' };
    case 'fish':
      return { file: '~/.config/fish/config.fish', line: 'truddy init fish | source' };
    default:
      return { file: '$PROFILE', line: '(& truddy init powershell) -join "`n" | Invoke-Expression' };
  }
}
