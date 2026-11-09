// Contract security: RugCheck (Solana) + GoPlus (Solana & EVM). Free, no key.
// Every check is normalised to { id, status: good|warn|bad|info, label, detail?, weight }.
import { get } from '../http.js';

export const GOPLUS_EVM = {
  ethereum: '1',
  bsc: '56',
  polygon: '137',
  arbitrum: '42161',
  base: '8453',
  avalanche: '43114',
  optimism: '10',
  fantom: '250',
  cronos: '25',
  linea: '59144',
  blast: '81457',
  scroll: '534352',
  zksync: '324',
  mantle: '5000',
};

export const supportedChains = () => ['solana', ...Object.keys(GOPLUS_EVM)];

const DEAD = /^0x0{40}$|^0x0{36}dead$|^0x000000000000000000000000000000000000dead$/i;
const isOn = (v) => v === '1' || v === 1 || v === true;
const n = (v) => (v === '' || v == null ? null : +v);
const pctStr = (f) => `${(f * 100).toFixed(f * 100 >= 10 ? 0 : 1)}%`;

export async function security(chainId, address) {
  if (chainId === 'solana') return solana(address);
  if (GOPLUS_EVM[chainId]) return evm(GOPLUS_EVM[chainId], address);
  return { available: false, reason: `no free scanner covers ${chainId} yet`, checks: [] };
}

async function solana(mint) {
  const [rc, gp] = await Promise.all([
    get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { timeout: 12000, retries: 1 }),
    get(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`, { timeout: 12000, retries: 1 }),
  ]);
  const g = gp.ok ? Object.values(gp.data?.result || {})[0] : null;
  const r = rc.ok ? rc.data : null;
  if (!g && !r) return { available: false, reason: 'scanners did not respond', checks: [] };

  const checks = [];
  const sources = [];
  if (r) sources.push('RugCheck');
  if (g) sources.push('GoPlus');

  if (g) {
    const flag = (key) => (g[key] ? isOn(g[key].status) : null);
    const mint_ = flag('mintable');
    if (mint_ !== null)
      checks.push(mint_ ? { id: 'mint', status: 'bad', label: 'Mint authority is LIVE — supply can be inflated', weight: 35 } : { id: 'mint', status: 'good', label: 'Mint authority revoked' });
    const freeze = flag('freezable');
    if (freeze !== null)
      checks.push(freeze ? { id: 'freeze', status: 'bad', label: 'Freeze authority is LIVE — your tokens can be frozen', weight: 35 } : { id: 'freeze', status: 'good', label: 'Freeze authority revoked' });
    if (flag('balance_mutable_authority')) checks.push({ id: 'balance', status: 'bad', label: 'An authority can change wallet balances', weight: 40 });
    if (flag('closable')) checks.push({ id: 'closable', status: 'warn', label: 'Token accounts are closable by an authority', weight: 10 });
    if (isOn(g.non_transferable)) checks.push({ id: 'nontransfer', status: 'bad', label: 'Token is non-transferable', weight: 40 });
    if (g.transfer_hook?.length) checks.push({ id: 'hook', status: 'warn', label: 'Has a transfer hook (custom code on every transfer)', weight: 12 });
    const fee = g.transfer_fee && (g.transfer_fee.fee_rate ?? g.transfer_fee.current_fee_rate);
    if (fee && +fee > 0) checks.push({ id: 'tax', status: +fee >= 1000 ? 'bad' : 'warn', label: `Transfer fee ${(+fee / 100).toFixed(1)}%`, weight: +fee >= 1000 ? 25 : 10 });
    if (flag('metadata_mutable')) checks.push({ id: 'meta', status: 'warn', label: 'Metadata is mutable (name/logo can change)', weight: 3 });
    if (Array.isArray(g.holders) && g.holders.length) {
      const top10 = g.holders.slice(0, 10).reduce((s, h) => s + (+h.percent || 0), 0);
      checks.push({ id: 'top10', status: top10 > 0.6 ? 'warn' : 'info', label: `Top 10 wallets hold ${pctStr(top10)} (incl. pools)`, weight: top10 > 0.6 ? 8 : 0, value: top10 });
    }
    if (g.holder_count) checks.push({ id: 'holders', status: 'info', label: `${(+g.holder_count).toLocaleString('en-US')} holders`, value: +g.holder_count });
  }

  if (r) {
    if (r.rugged) checks.push({ id: 'rugged', status: 'bad', label: 'RugCheck marks this token as RUGGED', weight: 60 });
    for (const risk of r.risks || []) {
      const name = risk.name || '';
      // GoPlus already covers these with precise on-chain flags
      if (g && /mint authority|freeze authority|mutable metadata/i.test(name)) continue;
      const lvl = risk.level === 'danger' ? 'bad' : risk.level === 'warn' ? 'warn' : 'info';
      const weight = lvl === 'bad' ? 18 : lvl === 'warn' ? 7 : 0;
      checks.push({ id: 'rc:' + name.toLowerCase().replace(/\W+/g, '-'), status: lvl, label: name + (risk.value ? ` (${risk.value})` : ''), detail: risk.description, weight });
    }
    if (typeof r.lpLockedPct === 'number') {
      const lp = r.lpLockedPct;
      checks.push({ id: 'lp', status: lp >= 90 ? 'good' : lp >= 50 ? 'info' : 'info', label: `LP locked/burned: ${lp.toFixed(lp >= 10 ? 0 : 1)}%`, value: lp });
    }
  }

  return {
    available: true,
    sources,
    checks,
    rugged: !!r?.rugged,
    rugcheckScore: r?.score_normalised ?? null,
  };
}

async function evm(chainNum, address) {
  const r = await get(`https://api.gopluslabs.io/api/v1/token_security/${chainNum}?contract_addresses=${address}`, { timeout: 12000, retries: 1 });
  const g = r.ok ? r.data?.result?.[address.toLowerCase()] || Object.values(r.data?.result || {})[0] : null;
  if (!g) return { available: false, reason: 'GoPlus has no data for this contract yet', checks: [] };
  const checks = [];
  const add = (cond, check) => cond && checks.push(check);

  add(isOn(g.is_honeypot), { id: 'honeypot', status: 'bad', label: 'HONEYPOT — buyers may not be able to sell', weight: 70 });
  add(isOn(g.cannot_sell_all), { id: 'sellall', status: 'bad', label: 'Holders cannot sell their full balance', weight: 35 });
  add(isOn(g.cannot_buy), { id: 'cantbuy', status: 'warn', label: 'Buying is restricted', weight: 10 });
  add(g.is_open_source === '0', { id: 'source', status: 'bad', label: 'Contract source is NOT verified', weight: 30 });
  add(isOn(g.honeypot_with_same_creator), { id: 'serial', status: 'bad', label: 'Creator has deployed honeypots before', weight: 40 });
  add(isOn(g.owner_change_balance), { id: 'balance', status: 'bad', label: 'Owner can change wallet balances', weight: 40 });
  add(isOn(g.hidden_owner), { id: 'hidden', status: 'bad', label: 'Has a hidden owner', weight: 30 });
  add(isOn(g.can_take_back_ownership), { id: 'reclaim', status: 'bad', label: 'Ownership can be reclaimed after "renounce"', weight: 30 });
  add(isOn(g.selfdestruct), { id: 'selfdestruct', status: 'bad', label: 'Contract can self-destruct', weight: 30 });
  add(isOn(g.personal_slippage_modifiable), { id: 'pertax', status: 'bad', label: 'Owner can set a custom tax per wallet', weight: 30 });

  const buy = n(g.buy_tax);
  const sell = n(g.sell_tax);
  if (buy != null || sell != null) {
    const worst = Math.max(buy || 0, sell || 0);
    checks.push({
      id: 'tax',
      status: worst >= 0.1 ? 'bad' : worst > 0.03 ? 'warn' : 'good',
      label: `Tax: buy ${pctStr(buy || 0)} / sell ${pctStr(sell || 0)}`,
      weight: worst >= 0.2 ? 35 : worst >= 0.1 ? 20 : worst > 0.03 ? 8 : 0,
    });
  }
  add(isOn(g.slippage_modifiable), { id: 'taxmod', status: 'warn', label: 'Tax can be changed by the owner', weight: 10 });

  const owner = g.owner_address || '';
  const renounced = !owner || DEAD.test(owner);
  if (isOn(g.is_mintable))
    checks.push(renounced ? { id: 'mint', status: 'warn', label: 'Mint function exists (owner renounced)', weight: 5 } : { id: 'mint', status: 'bad', label: 'Owner can mint new tokens', weight: 30 });
  else checks.push({ id: 'mint', status: 'good', label: 'No mint function' });
  checks.push(renounced ? { id: 'owner', status: 'good', label: 'Ownership renounced' } : { id: 'owner', status: 'info', label: `Owned by ${owner.slice(0, 6)}…${owner.slice(-4)}` });

  add(isOn(g.is_proxy), { id: 'proxy', status: 'warn', label: 'Upgradeable proxy — code can change later', weight: 10 });
  add(isOn(g.is_blacklisted), { id: 'blacklist', status: 'warn', label: 'Has a blacklist function', weight: 4 });
  add(isOn(g.transfer_pausable), { id: 'pause', status: 'warn', label: 'Trading can be paused', weight: 5 });
  add(isOn(g.trading_cooldown), { id: 'cooldown', status: 'warn', label: 'Trading cooldown enabled', weight: 5 });
  add(isOn(g.external_call), { id: 'external', status: 'warn', label: 'Calls external contracts', weight: 5 });

  const creatorPct = n(g.creator_percent);
  if (creatorPct != null && creatorPct > 0.05) checks.push({ id: 'creator', status: 'warn', label: `Creator still holds ${pctStr(creatorPct)}`, weight: 10 });

  const lp = (g.lp_holders || []).reduce((s, h) => s + ((isOn(h.is_locked) || DEAD.test(h.address || '')) ? +h.percent || 0 : 0), 0);
  if (g.lp_holders?.length) checks.push({ id: 'lp', status: lp >= 0.9 ? 'good' : 'info', label: `LP locked/burned: ${pctStr(lp)}`, value: lp * 100 });

  if (Array.isArray(g.holders) && g.holders.length) {
    const top10 = g.holders.filter((h) => !isOn(h.is_contract) && !isOn(h.is_locked)).slice(0, 10).reduce((s, h) => s + (+h.percent || 0), 0);
    checks.push({ id: 'top10', status: top10 > 0.5 ? 'warn' : 'info', label: `Top 10 wallets hold ${pctStr(top10)}`, weight: top10 > 0.5 ? 10 : 0, value: top10 });
  }
  if (g.holder_count) checks.push({ id: 'holders', status: 'info', label: `${(+g.holder_count).toLocaleString('en-US')} holders`, value: +g.holder_count });
  if (isOn(g.is_in_cex?.listed)) checks.push({ id: 'cex', status: 'good', label: `Listed on ${(g.is_in_cex.cex_list || []).slice(0, 3).join(', ') || 'a CEX'}`, weight: -10 });

  return { available: true, sources: ['GoPlus'], checks, rugged: false };
}
