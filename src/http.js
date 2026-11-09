// fetch wrapper that never throws: always resolves { ok, status, data, error }.
import { VERSION } from './version.js';

const UA = `truddy/${VERSION} (+https://github.com/Radardotfun/truddy)`;

export async function get(url, { timeout = 10000, json = true, headers = {}, redirect = 'follow', retries = 0, ua = UA } = {}) {
  let last = { ok: false, status: 0, data: null, error: 'not attempted' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': ua, accept: json ? 'application/json' : '*/*', ...headers },
        redirect,
        signal: ctrl.signal,
      });
      let data = null;
      if (res.status >= 200 && res.status < 300) {
        const text = await res.text();
        if (json) {
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
        } else data = text;
      } else {
        // drain body so sockets get reused
        await res.arrayBuffer().catch(() => {});
      }
      last = { ok: res.ok && (!json || data !== null), status: res.status, data, error: null };
      // Retry only transient failures.
      if (last.ok || (res.status >= 300 && res.status < 500 && res.status !== 404 && res.status !== 429)) return last;
    } catch (err) {
      last = { ok: false, status: 0, data: null, error: err.name === 'AbortError' ? 'timeout' : err.cause?.code || err.message };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
  }
  return last;
}
