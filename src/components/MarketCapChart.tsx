// Desktop #trade "Market cap" view: the coin's market cap history (CoinGecko)
// as an area chart, shown in place of the price chart.
import { useEffect, useRef, useState } from "react";
import { createChart, ColorType, AreaSeries, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { getCoinGeckoId } from "../services/coinglass";

export type McapRange = "1" | "7" | "30" | "365" | "max";
type Range = McapRange;
export const MCAP_RANGES: { id: Range; label: string }[] = [
  { id: "1", label: "1D" },
  { id: "7", label: "7D" },
  { id: "30", label: "1M" },
  { id: "365", label: "1Y" },
  { id: "max", label: "All" },
];

export const fmtCap = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
};

export function MarketCapChart({ coin, theme, range, onStats }: {
  coin: string;
  theme: "dark" | "light";
  range: Range;
  /** Latest market cap and % change over the range (null while loading). */
  onStats?: (s: { last: number; chg: number | null } | null) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [points, setPoints] = useState<{ time: UTCTimestamp; value: number }[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setPoints(null);
    setError(false);
    (async () => {
      try {
        const id = await getCoinGeckoId(coin);
        if (!id) throw new Error("no id");
        const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${range}`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { market_caps?: [number, number][] };
        const seen = new Set<number>();
        const pts = (json.market_caps ?? [])
          .map(([ms, v]) => ({ time: Math.floor(ms / 1000) as UTCTimestamp, value: v }))
          .filter((p) => p.value > 0 && !seen.has(p.time) && (seen.add(p.time), true))
          .sort((a, b) => a.time - b.time);
        if (alive) setPoints(pts);
      } catch {
        if (alive) setError(true);
      }
    })();
    return () => { alive = false; };
  }, [coin, range]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !points || points.length === 0) return;
    const light = theme === "light";
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: light ? "#6b7280" : "#9ca3af",
        attributionLogo: false,
      },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: "transparent" } },
      rightPriceScale: { borderColor: "transparent" },
      timeScale: { borderColor: "transparent", timeVisible: range === "1" || range === "7" },
      localization: { priceFormatter: fmtCap },
      handleScroll: false,
      handleScale: false,
    });
    const up = points[points.length - 1].value >= points[0].value;
    const line = up ? "#16a34a" : "#dc2626";
    const series = chart.addSeries(AreaSeries, {
      lineColor: line,
      lineWidth: 2,
      topColor: up ? "rgba(22,163,74,0.22)" : "rgba(220,38,38,0.22)",
      bottomColor: up ? "rgba(22,163,74,0)" : "rgba(220,38,38,0)",
      priceLineVisible: false,
    });
    series.setData(points);
    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, [points, theme, range]);

  const last = points && points.length ? points[points.length - 1].value : null;
  const first = points && points.length ? points[0].value : null;
  const chg = last !== null && first ? ((last - first) / first) * 100 : null;
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  useEffect(() => {
    onStatsRef.current?.(last !== null ? { last, chg } : null);
  }, [last, chg]);

  return (
    <div className="mcap-chart">
      <div className="mcap-chart-box" ref={boxRef}>
        {!points && !error && <div className="cpt-loading"><span className="cpt-spin" /> Loading market cap…</div>}
        {error && <div className="cpt-empty"><strong>Market cap unavailable</strong><span>Couldn't load market cap history for {coin} right now.</span></div>}
      </div>
    </div>
  );
}
