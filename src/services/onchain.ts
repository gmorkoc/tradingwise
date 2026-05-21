export interface OnChainData {
  hashrateGHs: number;
  transactions: number;
  minerRevenueUSD: number;
  difficulty: number;
  btcMinedToday: number;
  transferVolumeUSD: number;
  marketCapUSD: number;
}

export async function fetchOnChainData(): Promise<OnChainData | null> {
  try {
    const res = await fetch("https://api.blockchain.info/stats?cors=true");
    if (!res.ok) return null;
    const d = await res.json();
    return {
      hashrateGHs:      d.hash_rate ?? 0,
      transactions:     d.n_tx ?? 0,
      minerRevenueUSD:  d.miners_revenue_usd ?? 0,
      difficulty:       d.difficulty ?? 0,
      btcMinedToday:    (d.n_btc_mined ?? 0) / 1e8,
      transferVolumeUSD: d.estimated_transaction_volume_usd ?? 0,
      marketCapUSD:     d.market_cap_usd ?? 0,
    };
  } catch {
    return null;
  }
}

export function fmtHashrate(ghps: number): string {
  const ehs = ghps / 1e9;
  if (ehs >= 1)    return `${ehs.toFixed(1)} EH/s`;
  const phs = ghps / 1e6;
  if (phs >= 1)    return `${phs.toFixed(1)} PH/s`;
  const ths = ghps / 1e3;
  if (ths >= 1)    return `${ths.toFixed(1)} TH/s`;
  return `${ghps.toFixed(0)} GH/s`;
}

export function fmtDifficulty(d: number): string {
  if (d >= 1e12) return `${(d / 1e12).toFixed(2)} T`;
  if (d >= 1e9)  return `${(d / 1e9).toFixed(2)} B`;
  return d.toLocaleString();
}
