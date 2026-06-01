import { useEffect, useState, useMemo } from "react";
import { coinglass } from "../services/coinglass";

type IV = "1h" | "4h" | "1day";

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Bucket { price: number; vol: number; buyVol: number; sellVol: number; }

const BUCKETS = 40;
const VA_PCT  = 0.70;

interface Props { coin: string; }

export function VolumeProfile({ coin }: Props) {
  const [interval, setInterval] = useState<IV>("1h");
  const [candles,  setCandles]  = useState<Candle[]>([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    setLoading(true);
    coinglass.getHistoricalCandles(interval, coin)
      .then(d => { setCandles(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [coin, interval]);

  const { buckets, poc, vah, val, maxVol, currentPrice } = useMemo(() => {
    if (candles.length === 0) return { buckets: [], poc: 0, vah: 0, val: 0, maxVol: 0, currentPrice: 0 };

    const lo = Math.min(...candles.map(c => c.low));
    const hi = Math.max(...candles.map(c => c.high));
    const sz = (hi - lo) / BUCKETS;
    const currentPrice = candles[candles.length - 1].close;

    const buckets: Bucket[] = Array.from({ length: BUCKETS }, (_, i) => ({
      price: lo + (i + 0.5) * sz, vol: 0, buyVol: 0, sellVol: 0,
    }));

    for (const c of candles) {
      const mid = (c.high + c.low) / 2;
      const idx = Math.min(BUCKETS - 1, Math.floor((mid - lo) / sz));
      const vol = c.volume ?? 0;
      buckets[idx].vol += vol;
      if (c.close >= c.open) buckets[idx].buyVol += vol;
      else                   buckets[idx].sellVol += vol;
    }

    const maxVol  = Math.max(...buckets.map(b => b.vol));
    const pocIdx  = buckets.reduce((bi, b, i) => b.vol > buckets[bi].vol ? i : bi, 0);
    const poc     = buckets[pocIdx].price;

    // Value Area: expand from POC until 70% of total volume is covered
    const totalVol = buckets.reduce((s, b) => s + b.vol, 0);
    const target   = totalVol * VA_PCT;
    let lo2 = pocIdx, hi2 = pocIdx, accum = buckets[pocIdx].vol;
    while (accum < target && (lo2 > 0 || hi2 < BUCKETS - 1)) {
      const dv = lo2 > 0            ? buckets[lo2 - 1].vol : 0;
      const uv = hi2 < BUCKETS - 1  ? buckets[hi2 + 1].vol : 0;
      if (dv >= uv && lo2 > 0)       { lo2--; accum += buckets[lo2].vol; }
      else if (hi2 < BUCKETS - 1)    { hi2++; accum += buckets[hi2].vol; }
      else break;
    }

    return { buckets, poc, vah: buckets[hi2].price, val: buckets[lo2].price, maxVol, currentPrice };
  }, [candles]);

  const fp = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fv = (n: number) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M`
                           : n >= 1_000     ? `${(n/1_000).toFixed(0)}K`
                           : n.toFixed(0);
  const bucketSize = buckets.length > 1 ? Math.abs(buckets[1].price - buckets[0].price) : 0;

  return (
    <div className="vp-root">
      <div className="vp-controls">
        <div className="vp-iv-tabs">
          {(["1h","4h","1day"] as IV[]).map(iv => (
            <button key={iv} className={`vp-tab${interval === iv ? " vp-tab--active" : ""}`} onClick={() => setInterval(iv)}>
              {iv === "1h" ? "1H" : iv === "4h" ? "4H" : "1D"}
            </button>
          ))}
        </div>
        <div className="vp-key-levels">
          <span className="vp-kl vp-vah" data-tip="Value Area High — upper boundary of the 70% volume zone">VAH <strong>${fp(vah)}</strong></span>
          <span className="vp-kl vp-poc" data-tip="Point of Control — price level with the highest traded volume">POC <strong>${fp(poc)}</strong></span>
          <span className="vp-kl vp-val" data-tip="Value Area Low — lower boundary of the 70% volume zone">VAL <strong>${fp(val)}</strong></span>
        </div>
      </div>

      {loading ? (
        <div className="vp-loading">Building volume profile...</div>
      ) : (
        <div className="vp-chart">
          <div className="vp-rows">
            {[...buckets].reverse().map((b, i) => {
              const isPoc     = bucketSize > 0 && Math.abs(b.price - poc) < bucketSize * 0.5;
              const isVA      = b.price >= val - bucketSize * 0.5 && b.price <= vah + bucketSize * 0.5;
              const isCurrent = currentPrice && bucketSize > 0 && Math.abs(b.price - currentPrice) < bucketSize * 0.5;
              const barW      = maxVol > 0 ? (b.vol / maxVol) * 100 : 0;
              const buyW      = b.vol > 0  ? (b.buyVol / b.vol) * barW : 0;

              return (
                <div key={i} className={`vp-row${isPoc ? " vp-row--poc" : isVA ? " vp-row--va" : ""}${isCurrent ? " vp-row--current" : ""}`}>
                  <span className="vp-row-price">${fp(b.price)}</span>
                  <div className="vp-bar-track">
                    <div className="vp-bar-buy"  style={{ width: `${buyW}%` }} />
                    <div className="vp-bar-sell" style={{ width: `${barW - buyW}%` }} />
                  </div>
                  <span className="vp-row-vol">{fv(b.vol)}</span>
                  {isPoc     && <span className="vp-label vp-label--poc">POC</span>}
                  {isVA && !isPoc && <span className="vp-label vp-label--va">VA</span>}
                  {isCurrent && <span className="vp-label vp-label--cur">▶</span>}
                </div>
              );
            })}
          </div>
          <div className="vp-legend">
            <span className="vp-leg-buy">■ Buy</span>
            <span className="vp-leg-sell">■ Sell</span>
            <span className="vp-leg-poc">― POC</span>
            <span className="vp-leg-va">░ Value Area (70%)</span>
          </div>
        </div>
      )}
    </div>
  );
}
