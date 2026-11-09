// Getting your attention without leaving the terminal: bell, tab title, Windows Terminal
// tab progress state, and (opt-in) a native desktop notification.
import { spawn } from 'node:child_process';

const env = process.env;
const write = (s) => process.stdout.isTTY && process.stdout.write(s);

export const bell = () => write('\x07');
export const setTitle = (t) => write(`\x1b]0;${t.replace(/[\x00-\x1f]/g, '')}\x07`);

// Windows Terminal + ConEmu understand OSC 9;4 (tab progress). State 2 = red "error" tab.
export function tabAlert(on) {
  if (!env.WT_SESSION && !env.ConEmuPID) return;
  write(on ? '\x1b]9;4;2;100\x07' : '\x1b]9;4;0;0\x07');
}

// iTerm2 / some others: OSC 9 notification.
function osc9(msg) {
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'ghostty') write(`\x1b]9;${msg.replace(/[\x00-\x1f]/g, ' ')}\x07`);
}

const quietSpawn = (cmd, args) => {
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch {}
};

export function desktop(title, body) {
  const t = String(title).slice(0, 80);
  const b = String(body).slice(0, 200);
  if (process.platform === 'win32') {
    const esc = (s) => s.replace(/'/g, "''").replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]);
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
      `$x = New-Object Windows.Data.Xml.Dom.XmlDocument`,
      `$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${esc(t)}</text><text>${esc(b)}</text></binding></visual></toast>')`,
      `$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'`,
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
    ].join('; ');
    quietSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps]);
  } else if (process.platform === 'darwin') {
    const q = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    quietSpawn('osascript', ['-e', `display notification "${q(b)}" with title "${q(t)}"`]);
  } else {
    quietSpawn('notify-send', ['-a', 'truddy', '-u', 'critical', t, b]);
  }
}

export function alertUser(alert, { notify = false } = {}) {
  if (alert.level !== 'critical' && alert.level !== 'warn') return;
  if (alert.level === 'critical') {
    bell();
    tabAlert(true);
    osc9(`truddy: ${alert.symbol} — ${alert.text}`);
  }
  if (notify && alert.level === 'critical') desktop(`truddy · $${alert.symbol}`, alert.text);
}
