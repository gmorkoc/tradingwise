// Desktop top bar (design B, "Market pulse"): three small live chips beside
// the logo — Market cap (+24h change), BTC dominance, Fear & Greed (mini
// gauge). CoinGecko /global (shared cached fetch) + alternative.me.
import { useEffect, useState } from "react";
import { cgFetch, TTL } from "./GlobalMarkets";

type GlobalData = {
  data?: {
    total_market_cap?: { usd?: number };
    market_cap_percentage?: { btc?: number };
    market_cap_change_percentage_24h_usd?: number;
  };
};

const big = (n?: number) =>
  n == null ? "—" : n >= 1e12 ? `$${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`;

const fngLabel = (v: number) => (v < 25 ? "Extreme fear" : v < 45 ? "Fear" : v < 56 ? "Neutral" : v < 75 ? "Greed" : "Extreme greed");
const fngColor = (v: number) => (v < 25 ? "#dc2626" : v < 45 ? "#e5803a" : v < 56 ? "#a3a3a3" : v < 75 ? "#65a30d" : "#16a34a");

export function TopStatsStrip() {
  const [g, setG] = useState<GlobalData["data"] | null>(null);
  const [fng, setFng] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      cgFetch<GlobalData>("https://api.coingecko.com/api/v3/global", TTL.global)
        .then((r) => { if (alive && r?.data) setG(r.data); })
        .catch(() => {});
      fetch("https://api.alternative.me/fng/?limit=1&format=json")
        .then((r) => r.json())
        .then((j: { data?: { value?: string }[] }) => {
          const v = Number(j?.data?.[0]?.value);
          if (alive && Number.isFinite(v)) setFng(v);
        })
        .catch(() => {});
    };
    load();
    const id = window.setInterval(load, 120_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const chg = g?.market_cap_change_percentage_24h_usd;
  // Gauge arc: a half circle (length ≈ 44), filled to the F&G value.
  const arc = 44;
  return (
    <div className="tss" role="group" aria-label="Market pulse">
      <span className="tss-chip">
        <span className="tss-k">Market cap</span>
        <span className="tss-v">
          {big(g?.total_market_cap?.usd)}
          {chg != null && <em className={chg >= 0 ? "tss-up" : "tss-dn"}>{chg >= 0 ? "▲" : "▼"} {Math.abs(chg).toFixed(2)}%</em>}
        </span>
      </span>
      <span className="tss-chip">
        <span className="tss-k">BTC dominance</span>
        <span className="tss-v">{g?.market_cap_percentage?.btc != null ? `${g.market_cap_percentage.btc.toFixed(1)}%` : "—"}</span>
      </span>
      <span className="tss-chip tss-chip--fng">
        <svg width="34" height="20" viewBox="0 0 34 20" aria-hidden="true">
          <path d="M3 18a14 14 0 0 1 28 0" fill="none" stroke="var(--tss-track)" strokeWidth="4" strokeLinecap="round" />
          {fng != null && (
            <path
              d="M3 18a14 14 0 0 1 28 0"
              fill="none"
              stroke={fngColor(fng)}
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={`${((fng / 100) * arc).toFixed(1)} ${arc}`}
            />
          )}
        </svg>
        <span className="tss-col">
          <span className="tss-k">Fear &amp; Greed</span>
          <span className="tss-v">
            {fng != null ? <>{fng} <em style={{ color: fngColor(fng) }}>{fngLabel(fng)}</em></> : "—"}
          </span>
        </span>
      </span>
    </div>
  );
}
