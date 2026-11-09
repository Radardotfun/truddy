// ~/.truddy: watchlist + a small cache the shell prompt reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.TRUDDY_HOME || path.join(os.homedir(), '.truddy');
const CONFIG = path.join(HOME, 'config.json');
const CACHE = path.join(HOME, 'cache.json');
export const LOCK = path.join(HOME, 'refresh.lock');

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function write(file, data) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export const loadConfig = () => ({ watchlist: [], ...read(CONFIG, {}) });
export const saveConfig = (cfg) => write(CONFIG, cfg);

export const loadCache = () => ({ coins: {}, alerts: [], ...read(CACHE, {}) });
export const saveCache = (cache) => write(CACHE, cache);

export const keyOf = (t) => (t.kind === 'major' ? `cg:${t.cg.id}` : `${t.chainId}:${t.address}`);

// What we persist for a watched coin (enough to refresh without re-resolving).
export function entryFor(target) {
  return {
    key: keyOf(target),
    kind: target.kind,
    symbol: target.symbol,
    name: target.name,
    chainId: target.chainId,
    address: target.address,
    cg: target.cg,
    addedAt: Date.now(),
  };
}

// Rebuild a minimal target from a saved entry.
export function targetFromEntry(e) {
  return { kind: e.kind, query: e.symbol, chainId: e.chainId, address: e.address, symbol: e.symbol, name: e.name, cg: e.cg, copycats: 0, market: null };
}
