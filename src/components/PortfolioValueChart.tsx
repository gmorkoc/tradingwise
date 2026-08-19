import { useEffect, useRef, useState } from "react";
import {
  getPortfolioValueSeries,
  VALUE_PERIODS,
  type Holding,
  type ValuePeriod,
  type ValuePoint,
} from "../services/portfolioHistory";
import "../styles/PortfolioValueChart.css";

const PERIOD_LABEL: Record<ValuePeriod, string> = {
  "1H": "1H", "1D": "1D", "1W": "1W", "1M": "1M", "1Y": "1Y", "ALL": "All",
};

function buildAreaPath(series: ValuePoint[], w: number, h: number): { line: string; area: string } {
  const values = series.map(p => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = series.map((p, i) => {
    const x = (i / (series.length - 1)) * w;
    const y = h - ((p.value - min) / range) * (h - 6) - 3;
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return { line, area };
}

interface Props {
  holdings: Holding[];
  formatCurrency: (value: number) => string;
}

export function PortfolioValueChart({ holdings, formatCurrency }: Props) {
  const [period, setPeriod] = useState<ValuePeriod>("1D");
  const [series, setSeries] = useState<ValuePoint[]>([]);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef<Map<string, ValuePoint[]>>(new Map());

  const holdingsKey = holdings.filter(h => h.amount > 0).map(h => `${h.symbol}:${h.amount}`).join(",");

  useEffect(() => {
    cacheRef.current = new Map();
  }, [holdingsKey]);

  useEffect(() => {
    if (!holdingsKey) { setSeries([]); return; }
    const cacheKey = `${period}|${holdingsKey}`;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) { setSeries(cached); return; }

    let cancelled = false;
    setLoading(true);
    const activeHoldings = holdings.filter(h => h.amount > 0);
    getPortfolioValueSeries(activeHoldings, period).then((result) => {
      if (cancelled) return;
      cacheRef.current.set(cacheKey, result);
      setSeries(result);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, holdingsKey]);

  const hasSeries = series.length >= 2;
  const first = hasSeries ? series[0].value : 0;
  const last = hasSeries ? series[series.length - 1].value : 0;
  const changeAbs = last - first;
  const changePct = first !== 0 ? (changeAbs / first) * 100 : 0;
  const isUp = changeAbs >= 0;

  const W = 600, H = 140;
  const { line, area } = hasSeries ? buildAreaPath(series, W, H) : { line: "", area: "" };
  const gradientId = `pvc-grad-${isUp ? "up" : "down"}`;

  if (!holdingsKey) return null;

  return (
    <div className="pvc">
      <div className="pvc-header">
        {hasSeries ? (
          <span className={`pvc-change ${isUp ? "positive" : "negative"}`}>
            <span className="pvc-change-arrow">{isUp ? "↗" : "↘"}</span>
            {formatCurrency(Math.abs(changeAbs))}
            <span className="pvc-change-pct">({Math.abs(changePct).toFixed(2)}%)</span>
          </span>
        ) : (
          <span className="pvc-change pvc-change--empty">
            {loading ? "Loading…" : "No history available"}
          </span>
        )}
        <span className="pvc-period-label">{PERIOD_LABEL[period]}</span>
      </div>

      <div className="pvc-chart-wrap">
        {hasSeries && (
          <svg className="pvc-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={isUp ? "var(--color-success)" : "var(--color-danger)"} stopOpacity="0.35" />
                <stop offset="100%" stopColor={isUp ? "var(--color-success)" : "var(--color-danger)"} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${gradientId})`} stroke="none" />
            <path
              d={line}
              fill="none"
              stroke={isUp ? "var(--color-success)" : "var(--color-danger)"}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
        )}
        {!hasSeries && <div className="pvc-chart-empty" />}
      </div>

      <div className="pvc-tabs">
        {VALUE_PERIODS.map((p) => (
          <button
            key={p}
            className={`pvc-tab${p === period ? " pvc-tab--active" : ""}`}
            onClick={() => setPeriod(p)}
          >
            {PERIOD_LABEL[p]}
          </button>
        ))}
      </div>
    </div>
  );
}
