// Tiny zero-dependency terminal UI kit: color, width-aware layout, formatting.
const env = process.env;

function detectLevel() {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  if (process.argv.includes('--no-color')) return 0;
  if (env.FORCE_COLOR === '0' || env.FORCE_COLOR === 'false') return 0;
  if (env.FORCE_COLOR) return 3;
  if (!process.stdout.isTTY) return 0;
  if (env.TERM === 'dumb') return 0;
  const ct = (env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 3;
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return 3;
  if (['iTerm.app', 'vscode', 'WezTerm', 'Hyper', 'ghostty', 'Tabby'].includes(env.TERM_PROGRAM)) return 3;
  if (process.platform === 'win32') return 3;
  return 2;
}

let level = detectLevel();
export const getColorLevel = () => level;
export const setColorLevel = (l) => { level = l; };

const hexToRgb = (h) => {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
function to256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}
const fgCode = (rgb) => (level >= 3 ? `38;2;${rgb.join(';')}` : `38;5;${to256(rgb)}`);
const bgCode = (rgb) => (level >= 3 ? `48;2;${rgb.join(';')}` : `48;5;${to256(rgb)}`);

export const fg = (hex) => {
  const rgb = hexToRgb(hex);
  return (s) => (level ? `\x1b[${fgCode(rgb)}m${s}\x1b[39m` : String(s));
};
export const bg = (hex) => {
  const rgb = hexToRgb(hex);
  return (s) => (level ? `\x1b[${bgCode(rgb)}m${s}\x1b[49m` : String(s));
};
const sgr = (open, close) => (s) => (level ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const italic = sgr(3, 23);
export const underline = sgr(4, 24);

export const theme = {
  lime: '#C6FF4D',
  violet: '#A78BFA',
  mint: '#5CFFB0',
  red: '#FF5C7A',
  amber: '#FFC857',
  orange: '#FF8A4C',
  sky: '#7DD3FC',
  text: '#E7E9EE',
  sub: '#A1A7B3',
  mute: '#5E6573',
  line: '#343A46',
};

export const c = Object.fromEntries(Object.entries(theme).map(([k, v]) => [k, fg(v)]));

export function gradient(text, from = theme.lime, to = theme.violet) {
  if (!level) return text;
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const chars = [...text];
  const n = Math.max(1, chars.length - 1);
  return (
    chars
      .map((ch, i) => {
        if (ch === ' ') return ch;
        const t = i / n;
        const rgb = a.map((v, k) => Math.round(v + (b[k] - v) * t));
        return `\x1b[${fgCode(rgb)}m${ch}`;
      })
      .join('') + '\x1b[39m'
  );
}

// ---------- width-aware string helpers ----------
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x01\x02]/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

function cpWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3) return 0;
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return 0; // skin tones
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function width(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += cpWidth(ch.codePointAt(0));
  return w;
}

// Truncate to a visible width, keeping ANSI sequences intact.
export function truncate(s, max, ellipsis = '…') {
  s = String(s);
  if (max <= 0) return '';
  if (width(s) <= max) return s;
  const target = max - width(ellipsis);
  let out = '';
  let w = 0;
  let hadAnsi = false;
  let i = 0;
  while (i < s.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(s);
    if (m && m.index === i) {
      out += m[0];
      hadAnsi = true;
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = cpWidth(cp);
    if (w + cw > target) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  ANSI_RE.lastIndex = 0;
  return out + ellipsis + (hadAnsi && level ? '\x1b[0m' : '');
}

export function pad(s, w, align = 'left') {
  s = String(s ?? '');
  const vw = width(s);
  if (vw > w) return truncate(s, w);
  const space = ' '.repeat(w - vw);
  if (align === 'right') return space + s;
  if (align === 'center') {
    const l = Math.floor((w - vw) / 2);
    return ' '.repeat(l) + s + ' '.repeat(w - vw - l);
  }
  return s + space;
}

export const termWidth = () => Math.max(40, process.stdout.columns || 100);
export const termHeight = () => Math.max(12, process.stdout.rows || 32);

// Single-line flatten (tweets/headlines often contain newlines).
export const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---------- number + time formatting ----------
const SUB = '₀₁₂₃₄₅₆₇₈₉';
const toSub = (n) => String(n).split('').map((d) => SUB[+d]).join('');

export function price(n) {
  if (n == null || !Number.isFinite(+n)) return '—';
  n = +n;
  if (n === 0) return '$0';
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 100) return '$' + n.toFixed(2);
  if (n >= 1) return '$' + n.toFixed(3);
  if (n >= 0.0001) return '$' + (+n.toPrecision(4)).toString();
  // 0.000002806 -> $0.0₅2806 (subscript = number of zeros after the decimal point)
  let e = Math.floor(Math.log10(n));
  let sig = Math.round(n / 10 ** (e - 3));
  if (sig >= 10000) {
    sig = Math.round(sig / 10);
    e += 1;
  }
  const digits = String(sig).replace(/0+$/, '') || '0';
  return `$0.0${toSub(-e - 1)}${digits}`;
}

export function compact(n, prefix = '$') {
  if (n == null || !Number.isFinite(+n)) return '—';
  n = +n;
  const abs = Math.abs(n);
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [v, u] of units) {
    if (abs >= v) {
      const x = n / v;
      const str = Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2);
      return prefix + str.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') + u;
    }
  }
  return prefix + (abs >= 100 ? n.toFixed(0) : n.toFixed(2).replace(/\.00$/, ''));
}

export function pct(n, { arrow = true, digits } = {}) {
  if (n == null || !Number.isFinite(+n)) return c.mute('—');
  n = +n;
  const abs = Math.abs(n);
  const d = digits ?? (abs >= 100 ? 0 : 1);
  const body = `${abs.toFixed(d)}%`;
  if (Math.abs(n) < 0.05) return c.sub(`${arrow ? '· ' : ''}${body}`);
  return n > 0 ? c.mint(`${arrow ? '▲ ' : '+'}${body}`) : c.red(`${arrow ? '▼ ' : '-'}${body}`);
}

export function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.round(s / (86400 * 30))}mo`;
  return `${(s / (86400 * 365)).toFixed(1).replace(/\.0$/, '')}y`;
}

export function duration(ms) {
  if (ms == null || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 365) {
    const y = Math.floor(d / 365);
    const mo = Math.floor((d % 365) / 30);
    return mo ? `${y}y ${mo}mo` : `${y}y`;
  }
  if (d >= 30) return `${Math.floor(d / 30)}mo ${d % 30}d`;
  if (d >= 1) return `${d}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${m % 60}m`;
  return `${Math.max(1, m)}m`;
}

export function clock(ts = Date.now()) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
}

// ---------- tiny visual primitives ----------
export function bar(frac, w = 10, color = c.lime, rest = c.line) {
  frac = Math.max(0, Math.min(1, frac || 0));
  const full = Math.round(frac * w);
  return color('█'.repeat(full)) + rest('░'.repeat(w - full));
}

const SPARK = '▁▂▃▄▅▆▇█';
export function spark(values, w = 12) {
  const v = values.filter((x) => Number.isFinite(x)).slice(-w);
  if (v.length < 2) return c.mute('·'.repeat(Math.min(w, 5)));
  const min = Math.min(...v);
  const max = Math.max(...v);
  const range = max - min || 1;
  const line = v.map((x) => SPARK[Math.round(((x - min) / range) * (SPARK.length - 1))]).join('');
  const up = v[v.length - 1] >= v[0];
  return (up ? c.mint : c.red)(line);
}

export function box(lines, { w = Math.min(termWidth() - 2, 86), color = c.line, padX = 2 } = {}) {
  const inner = w - 2;
  const top = color('╭' + '─'.repeat(inner) + '╮');
  const bot = color('╰' + '─'.repeat(inner) + '╯');
  const body = lines.map((l) => color('│') + ' '.repeat(padX) + pad(l, inner - padX * 2) + ' '.repeat(padX) + color('│'));
  return [top, ...body, bot].join('\n');
}

// Join a left and right string into a line of width w.
export function spread(left, right, w) {
  const gap = w - width(left) - width(right);
  if (gap < 1) return truncate(left, Math.max(0, w - width(right) - 1)) + ' ' + right;
  return left + ' '.repeat(gap) + right;
}

export function rule(w, label = '') {
  if (!label) return c.line('─'.repeat(w));
  const l = ` ${label} `;
  return c.line('──') + c.sub(bold(l)) + c.line('─'.repeat(Math.max(0, w - width(l) - 2)));
}

export const LOGO = ['▀█▀ █▀█ █ █ █▀▄ █▀▄ █▄█', ' █  █▀▄ █▄█ █▄▀ █▄▀  █ '];
export const logo = () => LOGO.map((l) => gradient(l)).join('\n');
export const mark = () => gradient('◆');

// ---------- spinner (stderr, so --json stays clean) ----------
export class Spinner {
  constructor(text = '') {
    this.text = text;
    this.i = 0;
    this.enabled = process.stderr.isTTY && level > 0;
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  }
  start() {
    if (!this.enabled) return this;
    process.stderr.write('\x1b[?25l');
    this.timer = setInterval(() => this.render(), 80);
    this.render();
    return this;
  }
  set(text) {
    this.text = text;
    return this;
  }
  render() {
    const f = this.frames[(this.i = (this.i + 1) % this.frames.length)];
    process.stderr.write('\r\x1b[K  ' + c.lime(f) + ' ' + c.sub(this.text));
  }
  stop() {
    if (!this.enabled) return;
    clearInterval(this.timer);
    process.stderr.write('\r\x1b[K\x1b[?25h');
  }
}
