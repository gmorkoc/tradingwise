import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getPositionData, getPriceCandles,
  LSRatioPoint, CoinSymbol, CandleDataPoint,
} from "../services/coinglass";
import "../styles/PositionFlows.css";

// ── Shared constants ──────────────────────────────────────────────────────────

const W = 900;

// ── Summary computation ───────────────────────────────────────────────────────

type Signal = "bullish" | "bearish" | "neutral";
interface PFSummary { signal: Signal; text: string }
type TFn = ReturnType<typeof useTranslation>["t"];

function buildPriceSummary(
  candles: CandleDataPoint[],
  supports: number[],
  resistances: number[],
  t: TFn,
): PFSummary {
  const recent = candles.slice(-90);
  const cur    = recent[recent.length - 1].close;
  const hi     = Math.max(...recent.map(c => c.high));

  const slice10  = recent.slice(-10);
  const trendUp  = slice10[slice10.length - 1].close > slice10[0].close;
  const trendPct = Math.abs((slice10[slice10.length - 1].close / slice10[0].close - 1) * 100).toFixed(1);
  const trendText = trendUp
    ? t("positions.summary.price.trendUp",   { pct: trendPct })
    : t("positions.summary.price.trendDown", { pct: trendPct });

  const s = supports[0];
  const r = resistances[0];
  const levelText = s && r
    ? t("positions.summary.price.consolidating", { support: Math.round(s).toLocaleString(), resistance: Math.round(r).toLocaleString() })
    : s ? t("positions.summary.price.aboveSupport",    { support: Math.round(s).toLocaleString() })
    : r ? t("positions.summary.price.belowResistance", { resistance: Math.round(r).toLocaleString() })
    : "";

  const dropPct = ((cur / hi - 1) * 100).toFixed(1);
  return {
    signal: trendUp ? "bullish" : "bearish",
    text:   `${trendText} ${levelText} ${dropPct}% from the recent high of ${Math.round(hi).toLocaleString()}.`.trim(),
  };
}

function buildRetailSummary(lastNet: number, data: number[], t: TFn): PFSummary {
  const recent = data.slice(-20);
  const trend  = recent[recent.length - 1] > recent[0] ? "rising" : "falling";
  const bias   = Math.abs(lastNet).toFixed(0);

  if (lastNet > 150)  return { signal: "bearish", text: t("positions.summary.retail.heavilyLong",  { bias, trend }) };
  if (lastNet > 30)   return { signal: "neutral",  text: t("positions.summary.retail.moderateLong", { bias, trend }) };
  if (lastNet > -30)  return { signal: "neutral",  text: t("positions.summary.retail.neutral",      { bias }) };
  if (lastNet > -150) return { signal: "bullish",  text: t("positions.summary.retail.moderateShort",{ bias, trend }) };
  return { signal: "bullish", text: t("positions.summary.retail.heavilyShort", { bias }) };
}

function buildSentimentSummary(lastPct: number, data: number[], t: TFn): PFSummary {
  const recent = data.slice(-20);
  const trend  = recent[recent.length - 1] > recent[0] ? "rising" : "declining";
  const pct    = lastPct.toFixed(1);

  if (lastPct > 65) return { signal: "bullish", text: t("positions.summary.sentiment.stronglyBullish", { pct, trend }) };
  if (lastPct > 55) return { signal: "bullish", text: t("positions.summary.sentiment.mildlyBullish",   { pct, trend }) };
  if (lastPct > 45) return { signal: "neutral", text: t("positions.summary.sentiment.neutral",         { pct, trend }) };
  if (lastPct > 35) return { signal: "bearish", text: t("positions.summary.sentiment.mildlyBearish",   { pct, trend }) };
  return { signal: "bearish", text: t("positions.summary.sentiment.stronglyBearish", { pct }) };
}

function buildSmartNetSummary(
  lastSmartNet: number,
  lastRetailNet: number,
  data: number[],
  t: TFn,
): PFSummary {
  const recent  = data.slice(-20);
  const trend   = recent[recent.length - 1] > recent[0] ? "rising" : "falling";
  const aligned = (lastSmartNet > 0) === (lastRetailNet > 0);
  const bias    = Math.abs(lastSmartNet).toFixed(0);
  const dir     = t(lastSmartNet > 0 ? "positions.summary.dir.netLong" : "positions.summary.dir.netShort");

  if (aligned && lastSmartNet > 100)  return { signal: "bullish", text: t("positions.summary.smartNet.alignedBullish",       { dir, bias, trend }) };
  if (aligned && lastSmartNet < -100) return { signal: "bearish", text: t("positions.summary.smartNet.alignedBearish",       { dir, bias, trend }) };
  if (!aligned && lastSmartNet > 0)   return { signal: "bullish", text: t("positions.summary.smartNet.divergingSmartBullish",{ dir, bias, trend }) };
  if (!aligned && lastSmartNet < 0)   return { signal: "bearish", text: t("positions.summary.smartNet.divergingSmartBearish",{ dir, bias, trend }) };
  return { signal: "neutral", text: t("positions.summary.smartNet.neutral", { bias, trend }) };
}

// ── Summary footer ────────────────────────────────────────────────────────────

function SummaryBar({ signal, text }: PFSummary) {
  const { t } = useTranslation();
  return (
    <div className="pf-summary">
      <span className={`pf-summary-badge pf-summary-badge--${signal}`}>
        {signal.toUpperCase()}
      </span>
      <span className="pf-summary-text">{text}</span>
      <span className="pf-summary-live">
        <span className="pf-summary-live-dot" />
        {t("positions.updatedHourly")}
      </span>
    </div>
  );
}

// ── Price chart ───────────────────────────────────────────────────────────────

const HP = 200; // price chart height (px = SVG units, 1:1)

function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  if (r < 1.5) return mag;
  if (r < 3.5) return 2 * mag;
  if (r < 7.5) return 5 * mag;
  return 10 * mag;
}

const fmtP = (v: number) => Math.round(v).toString();

function computeSR(candles: CandleDataPoint[]): { supports: number[]; resistances: number[] } {
  const LB = 5;
  const rawR: number[] = [];
  const rawS: number[] = [];

  for (let i = LB; i < candles.length - LB; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;
    if (candles.slice(i - LB, i).every(c => c.high <= hi) &&
        candles.slice(i + 1, i + LB + 1).every(c => c.high <= hi)) rawR.push(hi);
    if (candles.slice(i - LB, i).every(c => c.low >= lo) &&
        candles.slice(i + 1, i + LB + 1).every(c => c.low >= lo)) rawS.push(lo);
  }

  const cluster = (levels: number[]) => {
    if (!levels.length) return [];
    const sorted = [...levels].sort((a, b) => a - b);
    const groups: { avg: number; count: number; total: number }[] = [];
    for (const l of sorted) {
      const g = groups.find(g => Math.abs(g.avg - l) / g.avg < 0.015);
      if (g) { g.count++; g.total += l; g.avg = g.total / g.count; }
      else groups.push({ avg: l, count: 1, total: l });
    }
    return groups.sort((a, b) => b.count - a.count).slice(0, 5).map(g => g.avg);
  };

  const cur = candles[candles.length - 1].close;
  return {
    resistances: cluster(rawR).filter(r => r > cur).sort((a, b) => a - b).slice(0, 4),
    supports:    cluster(rawS).filter(s => s < cur).sort((a, b) => b - a).slice(0, 4),
  };
}

function PriceChart({ candles, coin }: { candles: CandleDataPoint[]; coin: string }) {
  const { t } = useTranslation();
  if (candles.length < 10) return null;
  // compute summary early so we can pass it down

  const recent  = candles.slice(-90);
  const dataMin = Math.min(...recent.map(c => c.low));
  const dataMax = Math.max(...recent.map(c => c.high));
  const pad     = (dataMax - dataMin) * 0.06;
  const yMin    = dataMin - pad;
  const yMax    = dataMax + pad;

  const toY  = (v: number) => HP - ((v - yMin) / (yMax - yMin)) * HP;
  const toXc = (i: number) => ((i + 0.5) / recent.length) * W; // wick center
  const toXb = (i: number) => (i / recent.length) * W;          // body left
  const barW  = Math.max(1, W / recent.length - 1);

  const cur  = recent[recent.length - 1].close;
  const curY = toY(cur);

  const { supports, resistances } = computeSR(recent);
  const summary = buildPriceSummary(recent, supports, resistances, t);

  // Only show S&R within the visible range
  const visS = supports.filter(v => v > yMin && v < yMax);
  const visR = resistances.filter(v => v > yMin && v < yMax);

  // Y-axis scale ticks
  const step  = niceStep((yMax - yMin) / 5);
  const first = Math.ceil(yMin / step) * step;
  const ticks: number[] = [];
  for (let v = first; v <= yMax; v += step) ticks.push(v);

  // Collect all right-column labels and resolve vertical collisions (min 14px gap)
  type LabelEntry = { origY: number; y: number; v: number; type: 'support' | 'resistance' | 'current' };
  const rawLabels: LabelEntry[] = [
    ...visS.map(v => ({ origY: toY(v), y: toY(v), v, type: 'support'    as const })),
    ...visR.map(v => ({ origY: toY(v), y: toY(v), v, type: 'resistance' as const })),
    { origY: curY, y: curY, v: cur, type: 'current' as const },
  ].sort((a, b) => a.y - b.y);

  for (let i = 1; i < rawLabels.length; i++) {
    if (rawLabels[i].y - rawLabels[i - 1].y < 14)
      rawLabels[i].y = rawLabels[i - 1].y + 14;
  }
  const labels = rawLabels;

  return (
    <div className="pf-panel pf-panel--price">
      <div className="pf-panel-header">
        <span className="pf-dot pf-dot--amber" />
        <span className="pf-panel-label">{coin.toUpperCase()} PRICE · 4h · Binance</span>
        <span className="pf-panel-val" style={{ color: "#f59e0b" }}>{fmtP(cur)}</span>
      </div>
      <div className="pf-chart-wrap">
        <div className="pf-chart-row">

          <svg
            viewBox={`0 0 ${W} ${HP}`}
            style={{ display: "block", flex: 1, minWidth: 0, height: HP }}
            preserveAspectRatio="none"
          >
            {/* Grid */}
            {ticks.map(v => (
              <line key={v} x1={0} y1={toY(v)} x2={W} y2={toY(v)}
                stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
            ))}

            {/* Support zones */}
            {visS.map(v => (
              <line key={`s${v}`} x1={0} y1={toY(v)} x2={W} y2={toY(v)}
                stroke="#22c55e" strokeWidth="1.2" strokeDasharray="5,3" opacity="0.55" />
            ))}

            {/* Resistance zones */}
            {visR.map(v => (
              <line key={`r${v}`} x1={0} y1={toY(v)} x2={W} y2={toY(v)}
                stroke="#ef4444" strokeWidth="1.2" strokeDasharray="5,3" opacity="0.55" />
            ))}

            {/* Candlesticks */}
            {recent.map((c, i) => {
              const isUp  = c.close >= c.open;
              const color = isUp ? "#22c55e" : "#ef4444";
              const bTop  = toY(Math.max(c.open, c.close));
              const bBot  = toY(Math.min(c.open, c.close));
              const bH    = Math.max(1, bBot - bTop);
              return (
                <g key={i}>
                  <line x1={toXc(i)} y1={toY(c.high)} x2={toXc(i)} y2={toY(c.low)}
                    stroke={color} strokeWidth="1" opacity="0.65" />
                  <rect x={toXb(i)} y={bTop} width={barW} height={bH}
                    fill={color} opacity="0.85" rx="0.3" />
                </g>
              );
            })}

            {/* Current price line */}
            <line x1={0} y1={curY} x2={W} y2={curY}
              stroke="#f59e0b" strokeWidth="1" strokeDasharray="5,3" opacity="0.85" />
          </svg>

          <div className="pf-y-axis pf-y-axis--price">
            {/* Scale ticks */}
            {ticks.map(v => (
              <span key={v} className="pf-ytick" style={{ top: toY(v) - 7 }}>
                {fmtP(v)}
              </span>
            ))}

            {/* S&R + current price pills */}
            {labels.map(({ v, y, type }) => {
              const bg = type === 'support' ? '#22c55e'
                       : type === 'resistance' ? '#ef4444'
                       : '#f59e0b';
              return (
                <span
                  key={`${type}${v}`}
                  className="pf-ytick pf-ytick--cur"
                  style={{ top: y - 7, background: bg }}
                >
                  {fmtP(v)}
                </span>
              );
            })}
          </div>
        </div>
      </div>
      <SummaryBar {...summary} />
    </div>
  );
}

// ── Indicator charts ──────────────────────────────────────────────────────────

const H = 110;

const fmtTick = (v: number) => {
  const abs  = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
};

function NetHistogram({ data, color }: {
  data: number[];
  color: "red-green" | "pink-red";
}) {
  if (!data.length) return <div className="pf-chart-empty" />;
  const barW   = W / data.length;          // no gap — bars touch
  const absMax = Math.max(...data.map(Math.abs), 0.001);
  const midY   = H / 2;

  const last  = data[data.length - 1];
  const currY = midY - (last / absMax) * (H / 2 - 2);
  const isPos = last >= 0;
  const curBg = color === "pink-red"
    ? (isPos ? "#ec4899" : "#ef4444")
    : (isPos ? "#22c55e" : "#ef4444");

  const posColor = color === "pink-red" ? "#ec4899" : "#22c55e";
  const negColor = "#ef4444";

  // Nice round ticks
  const rawStep = absMax / 2;
  const mag     = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step    = Math.ceil(rawStep / mag) * mag;
  const ticks: number[] = [0];
  for (let v = step; v < absMax * 1.05; v += step) { ticks.push(v); ticks.push(-v); }
  const uniqueTicks = [...new Set(ticks)].sort((a, b) => b - a);

  const toY = (v: number) => midY - (v / absMax) * (H / 2 - 2);

  return (
    <div className="pf-chart-row">
      <svg viewBox={`0 0 ${W} ${H}`} className="pf-chart-svg" preserveAspectRatio="none">
        {/* Thin midline */}
        <line x1="0" y1={midY} x2={W} y2={midY}
          stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />

        {data.map((v, i) => {
          const x   = (i / data.length) * W;
          const pct = Math.abs(v) / absMax;
          const h   = Math.max(pct * (H / 2 - 2), 1);
          const pos = v >= 0;
          const y   = pos ? midY - h : midY;
          return <rect key={i} x={x} y={y} width={barW} height={h} fill={pos ? posColor : negColor} />;
        })}

        {/* White dashed current-value line */}
        <line x1="0" y1={currY} x2={W} y2={currY}
          stroke="rgba(255,255,255,0.7)" strokeWidth="1" strokeDasharray="5,4" />
      </svg>

      <div className="pf-y-axis">
        {uniqueTicks.map(v => {
          const y = toY(v);
          if (y < 0 || y > H) return null;
          return (
            <span key={v} className="pf-ytick" style={{ top: y - 7 }}>
              {fmtTick(v)}
            </span>
          );
        })}
        <span
          className="pf-ytick pf-ytick--cur"
          style={{ top: Math.min(H - 16, Math.max(2, currY - 7)), background: curBg }}
        >
          {fmtTick(last)}
        </span>
      </div>
    </div>
  );
}

function SentimentArea({ data }: { data: number[] }) {
  if (data.length < 2) return <div className="pf-chart-empty" />;

  const toX = (i: number) => (i / (data.length - 1)) * W;
  const toY = (v: number) => H - (v / 100) * (H - 4) - 2;

  const linePts = data.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");
  const areaPath = [
    `M ${toX(0)},${H}`,
    ...data.map((v, i) => `L ${toX(i).toFixed(1)},${toY(v).toFixed(1)}`),
    `L ${toX(data.length - 1)},${H} Z`,
  ].join(" ");

  const lastVal = data[data.length - 1];
  const lastY   = toY(lastVal);
  const ticks   = [75, 50, 25];

  return (
    <div className="pf-chart-row">
      <svg viewBox={`0 0 ${W} ${H}`} className="pf-chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="pf-sent-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="rgba(236,72,153,0.45)" />
            <stop offset="100%" stopColor="rgba(236,72,153,0.02)" />
          </linearGradient>
        </defs>

        {ticks.map(v => (
          <line key={v} x1="0" y1={toY(v)} x2={W} y2={toY(v)}
            stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
        ))}

        <path d={areaPath} fill="url(#pf-sent-grad)" />
        <polyline points={linePts} fill="none" stroke="#ec4899" strokeWidth="1.8"
          strokeLinejoin="round" strokeLinecap="round" />
        <line x1="0" y1={lastY} x2={W} y2={lastY}
          stroke="#ec4899" strokeWidth="1" strokeDasharray="5,4" opacity="0.8" />
      </svg>

      <div className="pf-y-axis">
        {ticks.map(v => (
          <span key={v} className="pf-ytick" style={{ top: toY(v) - 7 }}>{v}.00</span>
        ))}
        <span
          className="pf-ytick pf-ytick--cur"
          style={{ top: Math.min(H - 16, Math.max(2, lastY - 7)), background: "#ec4899" }}
        >
          {lastVal.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

// ── Panel wrapper ─────────────────────────────────────────────────────────────

function Panel({
  dot, label, value, unit = "", summary, children,
}: {
  dot: "red" | "pink" | "green";
  label: string;
  value: number;
  unit?: string;
  summary: PFSummary;
  children: React.ReactNode;
}) {
  const fmt = (v: number) => {
    const abs  = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(2)}K`;
    return `${sign}${abs.toFixed(2)}`;
  };

  return (
    <div className="pf-panel">
      <div className="pf-panel-header">
        <span className={`pf-dot pf-dot--${dot}`} />
        <span className="pf-panel-label">{label}</span>
        <span className={`pf-panel-val ${value >= 0 ? "pos" : "neg"}`}>
          {value >= 0 ? "+" : ""}{fmt(value)}{unit}
        </span>
      </div>
      <div className="pf-chart-wrap">{children}</div>
      <SummaryBar {...summary} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  coin?: CoinSymbol | string;
}

export function PositionFlows({ coin = "BTC" }: Props) {
  const { t } = useTranslation();
  const [posData,  setPosData]  = useState<{ retail: LSRatioPoint[]; smartMoney: LSRatioPoint[] } | null>(null);
  const [candles,  setCandles]  = useState<CandleDataPoint[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    setError("");

    Promise.all([
      getPositionData(coin),
      getPriceCandles(coin, '4h', 120),
    ])
      .then(([pos, cdl]) => {
        if (dead) return;
        setPosData(pos);
        setCandles(cdl);
        setLoading(false);
      })
      .catch(err => {
        if (dead) return;
        setError(err?.message ?? "Failed to load");
        setLoading(false);
      });

    const id = setInterval(() => {
      Promise.all([getPositionData(coin), getPriceCandles(coin, '4h', 120)])
        .then(([pos, cdl]) => { if (!dead) { setPosData(pos); setCandles(cdl); } })
        .catch(() => {});
    }, 5 * 60_000);

    return () => { dead = true; clearInterval(id); };
  }, [coin, retryKey]);

  if (loading) {
    return (
      <div className="pf-wrap">
        <div className="pf-state"><div className="pf-spinner" />{t("positions.loading")}</div>
      </div>
    );
  }

  const noPos = !posData || (!posData.retail.length && !posData.smartMoney.length);

  if (error || noPos) {
    return (
      <div className="pf-wrap">
        <div className="pf-state pf-state--error">
          {error || t("positions.error")}
          {error && <button className="pf-retry" onClick={() => setRetryKey(k => k + 1)}>Retry</button>}
        </div>
      </div>
    );
  }

  const { retail, smartMoney } = posData!;

  const retailNet      = retail.map(d => (d.longRatio - d.shortRatio) * 1000);
  const smartNet       = smartMoney.map(d => (d.longRatio - d.shortRatio) * 1000);
  const smartSentiment = smartMoney.map(d => d.longRatio * 100);

  const lastRetailNet = retailNet[retailNet.length - 1] ?? 0;
  const lastSmartNet  = smartNet[smartNet.length - 1] ?? 0;
  const lastSentiment = smartSentiment[smartSentiment.length - 1] ?? 0;

  const retailSummary    = buildRetailSummary(lastRetailNet, retailNet, t);
  const sentimentSummary = buildSentimentSummary(lastSentiment, smartSentiment, t);
  const smartNetSummary  = buildSmartNetSummary(lastSmartNet, lastRetailNet, smartNet, t);

  return (
    <div className="pf-wrap">
      <div className="pf-header">
        <div>
          <h2 className="pf-title">{t("positions.title")}</h2>
          <div className="pf-subtitle">
            {t("positions.sub", { candles: retail.length ? ` · ${retail.length} candles` : "" })}
          </div>
        </div>
        <div className="pf-coin-badge">{String(coin).toUpperCase()}</div>
      </div>

      <PriceChart candles={candles} coin={String(coin)} />

      <Panel dot="red" label={t("positions.panels.retailNet")} value={lastRetailNet} summary={retailSummary}>
        <NetHistogram data={retailNet} color="red-green" />
      </Panel>

      <Panel dot="pink" label={t("positions.panels.smartSentiment")} value={lastSentiment} unit="%" summary={sentimentSummary}>
        <SentimentArea data={smartSentiment} />
      </Panel>

      <Panel dot="green" label={t("positions.panels.smartNet")} value={lastSmartNet} summary={smartNetSummary}>
        <NetHistogram data={smartNet} color="pink-red" />
      </Panel>
    </div>
  );
}
