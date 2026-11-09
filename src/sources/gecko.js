// CoinGecko: maps a ticker to the *listed* contract (so copycat tokens don't fool us),
// and covers majors like BTC/ETH that have no single DEX pool.
import { get } from '../http.js';

const BASE = 'https://api.coingecko.com/api/v3';

// CoinGecko platform id -> DexScreener chain id
export const PLATFORM_TO_DEX = {
  solana: 'solana',
  ethereum: 'ethereum',
  'binance-smart-chain': 'bsc',
  base: 'base',
  'arbitrum-one': 'arbitrum',
  'polygon-pos': 'polygon',
  avalanche: 'avalanche',
  'optimistic-ethereum': 'optimism',
  fantom: 'fantom',
  cronos: 'cronos',
  linea: 'linea',
  blast: 'blast',
  sui: 'sui',
  'the-open-network': 'ton',
  tron: 'tron',
  abstract: 'abstract',
  sonic: 'sonic',
  'hyperevm': 'hyperevm',
};

export async function searchCoin(q) {
  const r = await get(`${BASE}/search?query=${encodeURIComponent(q)}`, { timeout: 8000 });
  if (!r.ok) return null;
  const ql = q.toLowerCase();
  const coins = (r.data.coins || []).filter((x) => x.market_cap_rank);
  // exact ticker or exact name, best-ranked first
  const hit = coins
    .filter((x) => x.symbol?.toLowerCase() === ql || x.name?.toLowerCase() === ql || x.id === ql)
    .sort((a, b) => a.market_cap_rank - b.market_cap_rank)[0];
  return hit || null;
}

export async function coinDetail(id) {
  const r = await get(
    `${BASE}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=true`,
    { timeout: 10000, retries: 1 }
  );
  if (!r.ok) return null;
  const d = r.data;
  const md = d.market_data || {};
  const platforms = Object.entries(d.platforms || {})
    .filter(([k, v]) => k && v)
    .map(([k, v]) => ({ platform: k, chainId: PLATFORM_TO_DEX[k] || k, address: v }));
  const twitter = d.links?.twitter_screen_name || null;
  return {
    id: d.id,
    symbol: (d.symbol || '').toUpperCase(),
    name: d.name,
    rank: d.market_cap_rank,
    platforms,
    twitter,
    websites: (d.links?.homepage || []).filter(Boolean),
    telegram: d.links?.telegram_channel_identifier || null,
    market: marketFrom(md),
    categories: d.categories || [],
  };
}

function marketFrom(md) {
  return {
    priceUsd: md.current_price?.usd ?? null,
    change: {
      h1: md.price_change_percentage_1h_in_currency?.usd ?? null,
      h24: md.price_change_percentage_24h ?? null,
      d7: md.price_change_percentage_7d ?? null,
    },
    marketCap: md.market_cap?.usd ?? null,
    volume24h: md.total_volume?.usd ?? null,
    high24h: md.high_24h?.usd ?? null,
    low24h: md.low_24h?.usd ?? null,
    ath: md.ath?.usd ?? null,
    athChange: md.ath_change_percentage?.usd ?? null,
    sparkline: md.sparkline_7d?.price || [],
  };
}

// Lightweight refresh for watch mode.
export async function markets(ids) {
  const r = await get(
    `${BASE}/coins/markets?vs_currency=usd&ids=${ids.map(encodeURIComponent).join(',')}&sparkline=true&price_change_percentage=1h,24h,7d`,
    { timeout: 10000, retries: 1 }
  );
  if (!r.ok || !Array.isArray(r.data)) return {};
  const out = {};
  for (const m of r.data) {
    out[m.id] = {
      priceUsd: m.current_price,
      change: {
        h1: m.price_change_percentage_1h_in_currency,
        h24: m.price_change_percentage_24h_in_currency ?? m.price_change_percentage_24h,
        d7: m.price_change_percentage_7d_in_currency,
      },
      marketCap: m.market_cap,
      volume24h: m.total_volume,
      high24h: m.high_24h,
      low24h: m.low_24h,
      ath: m.ath,
      athChange: m.ath_change_percentage,
      sparkline: m.sparkline_in_7d?.price || [],
    };
  }
  return out;
}
