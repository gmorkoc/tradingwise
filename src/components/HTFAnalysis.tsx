import { useState, useEffect, useRef, useMemo } from "react";
import { createChart, IChartApi, LineSeries, LineData, Time } from "lightweight-charts";
import { coinglass, CandleDataPoint, CoinSymbol } from "../services/coinglass";
import { openaiHTF, HTFAIResponse, getTabInsight, TabInsightInput } from "../services/openai";
import { useAIQuota } from "../hooks/useAIQuota";
import { AIQuotaWall } from "./AIQuotaWall";
import { MonthlyReturns } from "./MonthlyReturns";
import "../styles/HTFAnalysis.css";

interface Props {
  coin?: CoinSymbol;
  currentPrice?: number;
  onOpenAuth?: () => void;
  onOpenUpgrade?: () => void;
}

// ── Constants ────────────────────────────────────────────────────────────────
const HALVINGS = [
  { ts: 1353628800 }, { ts: 1468022400 },
  { ts: 1589155200 }, { ts: 1713571200 },
];
const LAST_HALVING_TS = 1713571200;
const WEEK_SEC = 7 * 24 * 3600;

type SectionId = "monthly" | "ma200" | "cycle" | "pi" | "fib" | "scenario" | "ai";

const SECTIONS: { id: SectionId; title: string; sub: string; d: string | string[] }[] = [
  {
    id: "monthly", title: "Monthly Returns", sub: "Full history heatmap",
    d: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"],
  },
  {
    id: "ma200", title: "200W MA", sub: "Moving average bands",
    d: ["M3 3v18h18", "M7 16l4-4 4 4 5-5"],
  },
  {
    id: "cycle", title: "Cycle Compare", sub: "2020 vs 2024 aligned",
    d: "M17 2l4 4-4 4M3 11v-1a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 01-4 4H3",
  },
  {
    id: "pi", title: "Pi Cycle Top", sub: "Cycle top indicator",
    d: "M22 12h-4l-3 9L9 3l-3 9H2",
  },
  {
    id: "fib", title: "Fibonacci", sub: "Key support & resistance",
    d: ["M3 6h18", "M3 10h14", "M3 14h18", "M3 18h10"],
  },
  {
    id: "scenario", title: "Scenarios", sub: "Bull · Base · Bear paths",
    d: ["M3 12h3l3-9 4 18 3-9h6"],
  },
  {
    id: "ai", title: "AI Outlook", sub: "GPT-4o macro analysis",
    d: [
      "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
      "M20 3v4M22 5h-4",
    ],
  },
];

function SectionIcon({ d }: { d: string | string[] }) {
  const paths = Array.isArray(d) ? d : [d];
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {paths.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

// ── Math helpers ─────────────────────────────────────────────────────────────
function calcSMA(data: CandleDataPoint[], period: number): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  for (let i = period - 1; i < data.length; i++) {
    const avg = data.slice(i - period + 1, i + 1).reduce((s, c) => s + c.close, 0) / period;
    out.push({ time: data[i].time, value: avg });
  }
  return out;
}

interface FibLevel { label: string; price: number; color: string; lineStyle: number }
function computeFibLevels(low: number, high: number): FibLevel[] {
  const range = high - low;
  return [
    { label: "0 — Cycle Low",        ratio: 0,     color: "#ef4444", lineStyle: 2 },
    { label: "0.236",                ratio: 0.236, color: "#f97316", lineStyle: 0 },
    { label: "0.382",                ratio: 0.382, color: "#eab308", lineStyle: 0 },
    { label: "0.5 — Mid Range",      ratio: 0.5,   color: "#94a3b8", lineStyle: 0 },
    { label: "0.618 — Golden Ratio", ratio: 0.618, color: "#22c55e", lineStyle: 2 },
    { label: "0.786",                ratio: 0.786, color: "#3b82f6", lineStyle: 0 },
    { label: "1.0 — ATH",            ratio: 1.0,   color: "#a78bfa", lineStyle: 2 },
    { label: "1.618 — Extension",    ratio: 1.618, color: "#f59e0b", lineStyle: 1 },
    { label: "2.618 — Extension",    ratio: 2.618, color: "#ec4899", lineStyle: 1 },
  ].map(r => ({
    label: r.label,
    price: r.ratio <= 1 ? low + range * r.ratio : high + range * (r.ratio - 1),
    color: r.color,
    lineStyle: r.lineStyle,
  }));
}

interface ScenarioPath { label: string; color: string; target: number; timeline: string; description: string; path: LineData[] }
function computeScenarios(price: number, ath: number, cycleLow: number, lastTs: number): ScenarioPath[] {
  const FORWARD = 52;
  const bullTarget = Math.max(ath * 1.8, price * 2.5);
  const baseTarget = price * 1.35;
  const bearTarget = Math.max(cycleLow + (ath - cycleLow) * 0.4, price * 0.52);
  function path(target: number, shape: "bull" | "base" | "bear"): LineData[] {
    return Array.from({ length: FORWARD + 1 }, (_, w) => {
      const pct = w / FORWARD;
      const factor =
        shape === "bull"  ? (pct < 0.6 ? Math.sin((pct / 0.6) * Math.PI / 2) * 0.92 : 0.92 + (pct - 0.6) / 0.4 * 0.08) :
        shape === "base"  ? 1 - Math.pow(1 - pct, 2.2) :
        pct < 0.45 ? Math.pow(pct / 0.45, 0.65) : 1;
      return { time: (lastTs + w * WEEK_SEC) as Time, value: +(price + (target - price) * factor).toFixed(2) };
    });
  }
  return [
    { label: "Bull", color: "#22c55e", target: bullTarget, timeline: "12–18 months",
      description: `New ATH scenario. Institutional inflows and ETF demand drive price past ${fmtK(ath)}. Target: ${fmtK(bullTarget)}.`, path: path(bullTarget, "bull") },
    { label: "Base", color: "#3b82f6", target: baseTarget, timeline: "6–12 months",
      description: `Steady accumulation with periodic corrections. No major macro catalyst needed. Target: ${fmtK(baseTarget)}.`, path: path(baseTarget, "base") },
    { label: "Bear", color: "#ef4444", target: bearTarget, timeline: "3–6 months",
      description: `Distribution or macro shock triggers a major retracement toward Fibonacci support. Target: ${fmtK(bearTarget)}.`, path: path(bearTarget, "bear") },
  ];
}

function fmtK(n: number): string {
  return n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "K" : "$" + n.toFixed(0);
}
function fmtPrice(n: number): string {
  return n >= 1000 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "$" + n.toFixed(2);
}

function mkChart(el: HTMLDivElement, height: number, timeVisible = true) {
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  return createChart(el, {
    width: el.clientWidth, height,
    layout: { background: { color: "transparent" }, textColor: isDark ? "#94a3b8" : "#64748b" },
    grid: {
      vertLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)" },
      horzLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)" },
    },
    rightPriceScale: { borderColor: "transparent" },
    timeScale: { borderColor: "transparent", timeVisible },
  });
}

function useChart(ref: React.RefObject<HTMLDivElement | null>, build: (el: HTMLDivElement) => IChartApi, deps: unknown[]) {
  useEffect(() => {
    if (!ref.current) return;
    const chart = build(ref.current);
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => { if (ref.current) chart.applyOptions({ width: ref.current.clientWidth }); });
    ro.observe(ref.current);
    return () => { ro.disconnect(); chart.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

const PHASE_COLOR: Record<string, string> = {
  "Early Accumulation": "#22c55e", "Mid Expansion": "#3b82f6",
  "Late Expansion": "#f59e0b", "Distribution": "#ef4444",
  "Bear Market": "#dc2626", "Recovery": "#10b981",
};
const ACTION_CLS: Record<string, string> = {
  buy: "htf-action--buy", accumulate: "htf-action--buy",
  hold: "htf-action--hold", watch: "htf-action--hold", sell: "htf-action--sell",
};

// ── Explainer block ───────────────────────────────────────────────────────────

function ExplainerBlock({ how, now }: { how: string; now: string }) {
  return (
    <div className="htf-explainer">
      <div className="htf-explainer-col">
        <div className="htf-explainer-label">How it works</div>
        <p className="htf-explainer-text">{how}</p>
      </div>
      <div className="htf-explainer-col htf-explainer-col--now">
        <div className="htf-explainer-label">Current reading</div>
        <p className="htf-explainer-text">{now}</p>
      </div>
    </div>
  );
}

// ── Current-reading text generators ──────────────────────────────────────────

function ma200NowText(ratio: number | null, ma200: number | null, wksSince: number, ratio2020: number | null): string {
  if (!ratio || !ma200) return "Insufficient data to compute ratio.";
  const comp = ratio2020 != null
    ? ` At the same week in the 2020 cycle (week ${wksSince}), the ratio was ${ratio2020.toFixed(2)}×.`
    : "";
  if (ratio < 1)
    return `Price is trading below the 200W MA (${fmtPrice(ma200)}) — an extreme buy zone seen only at cycle lows. Every prior occurrence was followed by a full recovery to new highs.${comp}`;
  if (ratio < 1.5)
    return `At ${ratio.toFixed(2)}× the 200W MA (${fmtPrice(ma200)}), Bitcoin is in the early-bull range. There is significant room before the historically elevated zone above 3×.${comp}`;
  if (ratio < 2.5)
    return `At ${ratio.toFixed(2)}× the 200W MA (${fmtPrice(ma200)}), Bitcoin is in healthy mid-bull expansion territory. Both the 2017 and 2021 tops occurred above 3×.${comp}`;
  if (ratio < 3.5)
    return `At ${ratio.toFixed(2)}× the 200W MA (${fmtPrice(ma200)}), Bitcoin is approaching the historically elevated zone. Prior tops occurred near or above 3× — monitor for distribution signals.${comp}`;
  return `At ${ratio.toFixed(2)}× the 200W MA (${fmtPrice(ma200)}), Bitcoin is in the historically stretched zone. Both prior cycle tops were followed by 70–85% drawdowns from this territory.${comp}`;
}

function cycleNowText(wksSince: number, cy2020Gain: number | null, cy2024Gain: number | null): string {
  if (cy2020Gain == null || cy2024Gain == null)
    return `Week ${wksSince} post-halving — comparing the current 2024 cycle against the 2020 cycle at the same point in time.`;
  const diff = cy2024Gain - cy2020Gain;
  const rel = Math.abs(diff) < 15 ? "closely tracking" : diff > 0 ? "outperforming" : "trailing";
  const diffStr = Math.abs(diff) >= 10 ? ` by ${Math.abs(diff).toFixed(0)} percentage points` : "";
  return `Week ${wksSince} post-halving: the 2024 cycle has gained ${cy2024Gain.toFixed(0)}% from its halving price ($${fmtK(0).replace("$0","").trim()}). At this same week, the 2020 cycle was up ${cy2020Gain.toFixed(0)}%. The current cycle is ${rel} the 2020 analogue${diffStr}.`;
}

function piNowText(piGap: number, piNear: boolean, wksSince: number): string {
  if (piNear && piGap > 0)
    return `⚠ Warning: the 16W SMA is only ${Math.abs(piGap).toFixed(1)}% above the 2×50W SMA — the lines are converging. Historically, a cross has fired within days of cycle tops (Dec 2017, Apr 2021, Nov 2021). Watch closely.`;
  if (piNear)
    return `The lines are converging with a gap of only ${Math.abs(piGap).toFixed(1)}%. No cross yet, but the proximity warrants attention at week ${wksSince} in the cycle.`;
  if (piGap > 0)
    return `The 16W SMA is ${piGap.toFixed(1)}% above the 2×50W SMA at week ${wksSince}. The lines are diverging — no imminent top signal. This indicator typically fires in the late-expansion or distribution phase.`;
  return `The 16W SMA is ${Math.abs(piGap).toFixed(1)}% below the 2×50W SMA at week ${wksSince}. No Pi Cycle Top signal — lines are clearly separated. The indicator is inactive and a cross is not imminent.`;
}

function fibNowText(fibLevels: FibLevel[], currentPrice: number): string {
  const sorted = [...fibLevels].sort((a, b) => a.price - b.price);
  const above = sorted.filter(f => f.price > currentPrice);
  const below = sorted.filter(f => f.price <= currentPrice);
  const nearestRes = above[0];
  const nearestSup = below[below.length - 1];
  const athLevel = fibLevels.find(f => f.label.includes("ATH") || f.label.includes("1.0"));
  const ext1618  = fibLevels.find(f => f.label.includes("1.618"));
  const ext2618  = fibLevels.find(f => f.label.includes("2.618"));
  const aboveATH = athLevel && currentPrice > athLevel.price;

  let text = "";
  if (nearestSup) text += `Current support: ${nearestSup.label} at ${fmtPrice(nearestSup.price)}. `;
  if (nearestRes) text += `Next resistance: ${nearestRes.label} at ${fmtPrice(nearestRes.price)}. `;
  if (aboveATH) {
    text += `Price is above the ATH — in extension territory. The 1.618 (${ext1618 ? fmtPrice(ext1618.price) : "—"}) and 2.618 (${ext2618 ? fmtPrice(ext2618.price) : "—"}) levels are the primary cycle-top target zones in prior Bitcoin bull markets.`;
  } else if (athLevel) {
    const pctToATH = ((athLevel.price - currentPrice) / currentPrice * 100).toFixed(1);
    text += `Price is ${pctToATH}% below the ATH (${fmtPrice(athLevel.price)}). A confirmed break above opens extension targets at 1.618 (${ext1618 ? fmtPrice(ext1618.price) : "—"}) and 2.618 (${ext2618 ? fmtPrice(ext2618.price) : "—"}).`;
  }
  return text.trim();
}

function scenarioNowText(wksSince: number, phase: string): string {
  const ctx: Record<string, string> = {
    "Early Accumulation": "Historical analogues show the strongest price appreciation leg typically begins 6–18 months post-halving. The base case projects steady gains before the main expansion phase.",
    "Mid Expansion": "Mid-expansion is Bitcoin's historically strongest phase. Analogues from 2020–2021 and 2016–2017 show sharp momentum moves interspersed with 20–40% corrections before the final leg.",
    "Late Expansion": "Late expansion is marked by increasing volatility and the start of distribution. Prior cycles peaked in this window — the gap between the Bull and Bear targets is widest here.",
    "Distribution": "Prior cycles topped in the distribution phase and then entered 18–24 month bear markets. The Bear path reflects what prior drops looked like in magnitude and pace.",
    "Bear Market": "Bear markets typically last 12–18 months from the peak. Accumulation zones near the 200W MA and 0.618 Fibonacci level have historically been generational entry points.",
    "Recovery": "Recovery phases transition to early accumulation — lower volatility, rising volume, and the first signs of renewed demand before the next halving sets up a new cycle.",
  };
  return `Week ${wksSince} post-halving — ${phase} phase. ${ctx[phase] ?? "Paths are modeled on current momentum and historical analogues."}`;
}

function monthlyNowText(wksSince: number, phase: string): string {
  const ctx: Record<string, string> = {
    "Early Accumulation": "Q4 and Q1 in post-halving years have historically been Bitcoin's strongest quarters. October through March tends to concentrate the largest monthly gains — compare those columns to 2020 and 2016 for confirmation.",
    "Mid Expansion": "Mid-cycle years show strong green clusters in Q3–Q4. Look for the current year's October–December columns matching the same period in 2020 and 2016 as the historical template.",
    "Late Expansion": "Late-cycle monthly returns become erratic — alternating between sharp gains and sudden red months. High monthly volatility with declining volume on green months is a distribution signal.",
    "Distribution": "Distribution phases show a shift from green-dominated to red-dominated columns. Isolated green months appear as relief rallies against a bearish backdrop — compare to 2021 Q3–Q4.",
    "Bear Market": "Bear markets show persistent red. Watch January and October historically — they have the highest frequency of cycle-bottom reversals or the start of recovery months.",
    "Recovery": "Recovery phases see the first clusters of consistent monthly greens returning. Low-volume base building accelerates as the next halving approaches — compare to 2019 and 2015.",
  };
  const monthsSince = Math.round(wksSince / 4.33);
  return `${monthsSince} months into the current post-halving cycle (${phase} phase). ${ctx[phase] ?? ""}`;
}

// ── AI Take footer (shared by all non-AI tabs) ───────────────────────────────

function TabAITake({ text, loading }: { text?: string; loading: boolean }) {
  if (!loading && !text) return null;
  return (
    <div className="htf-tab-ai-take">
      <div className="htf-tab-ai-header">
        <div className="htf-tab-ai-label">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
          </svg>
          AI Take
        </div>
        <span className="htf-ai-badge" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
          </svg>
          AI Powered
        </span>
      </div>
      {loading ? (
        <div className="htf-tab-ai-loading">
          <span className="htf-tab-ai-dot" /><span className="htf-tab-ai-dot" /><span className="htf-tab-ai-dot" />
        </div>
      ) : (
        <p className="htf-tab-ai-text">{text}</p>
      )}
    </div>
  );
}

// ── Section panels ────────────────────────────────────────────────────────────

function PanelMA200({
  candles, ratio, ma200, wksSince, ratio2020, aiText, aiLoading,
}: {
  candles: CandleDataPoint[];
  ratio: number | null; ma200: number | null; wksSince: number; ratio2020: number | null;
  aiText?: string; aiLoading: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, el => {
    const chart = mkChart(el, 340, true);
    const price = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 2, title: "Price" });
    const ma200s = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 2, lineStyle: 2, title: "200W MA" });
    const ma50   = chart.addSeries(LineSeries, { color: "#22c55e", lineWidth: 1, lineStyle: 1, title: "50W MA" });
    price.setData(candles.map(c => ({ time: c.time as Time, value: c.close })));
    ma200s.setData(calcSMA(candles, 200).map(m => ({ time: m.time as Time, value: m.value })));
    ma50.setData(calcSMA(candles, 50).map(m => ({ time: m.time as Time, value: m.value })));
    return chart;
  }, [candles]);
  return (
    <div className="htf-panel-inner">
      <ExplainerBlock
        how="The 200-Week Moving Average is Bitcoin's most-watched long-term support. Price has never closed a full week below this level without eventually recovering to new all-time highs. Touching or trading below the 200W MA has been a generational buy zone in every prior cycle; trading above 3× has preceded every major top."
        now={ma200NowText(ratio, ma200, wksSince, ratio2020)}
      />
      <TabAITake text={aiText} loading={aiLoading} />
      <div className="htf-legend">
        <span className="htf-dot" style={{ background: "#3b82f6" }} />Price
        <span className="htf-dot" style={{ background: "#f59e0b" }} />200W MA
        <span className="htf-dot" style={{ background: "#22c55e" }} />50W MA
      </div>
      <div ref={ref} className="htf-chart" />
    </div>
  );
}

function PanelCycle({
  candles, wksSince, cy2020Gain, cy2024Gain, aiText, aiLoading,
}: {
  candles: CandleDataPoint[];
  wksSince: number; cy2020Gain: number | null; cy2024Gain: number | null;
  aiText?: string; aiLoading: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, el => {
    const chart = mkChart(el, 340, false);
    const baseTs = LAST_HALVING_TS;
    const h3ts = HALVINGS[2].ts;
    let b2020 = 0, b2024 = 0;
    for (const c of candles) {
      if (Math.abs(c.time - h3ts) < WEEK_SEC * 3 && !b2020) b2020 = c.close;
      if (Math.abs(c.time - baseTs) < WEEK_SEC * 3 && !b2024) b2024 = c.close;
    }
    if (!b2020) b2020 = candles[0]?.close ?? 1;
    if (!b2024) b2024 = candles[0]?.close ?? 1;
    const dedup = (arr: LineData[]) => {
      const map = new Map<number, number>();
      arr.forEach(d => map.set(d.time as number, d.value as number));
      return Array.from(map.entries()).sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t as Time, value: v }));
    };
    const cy20: LineData[] = [], cy24: LineData[] = [];
    for (const c of candles) {
      if (c.time >= h3ts && b2020) {
        const w = Math.floor((c.time - h3ts) / WEEK_SEC);
        if (w >= 0 && w <= 156) cy20.push({ time: (baseTs + w * WEEK_SEC) as Time, value: +(c.close / b2020 * 100).toFixed(2) });
      }
      if (c.time >= baseTs && b2024) cy24.push({ time: c.time as Time, value: +(c.close / b2024 * 100).toFixed(2) });
    }
    if (cy20.length > 0) { const s = chart.addSeries(LineSeries, { color: "#8b5cf6", lineWidth: 2, title: "2020" }); s.setData(dedup(cy20)); }
    if (cy24.length > 0) { const s = chart.addSeries(LineSeries, { color: "#22c55e", lineWidth: 2, title: "2024" }); s.setData(dedup(cy24)); }
    return chart;
  }, [candles]);
  return (
    <div className="htf-panel-inner">
      <ExplainerBlock
        how="Both the 2020 and 2024 cycles are normalized to 100% at their respective halving dates, then plotted week-by-week on the same axis. This removes absolute price noise and reveals the structural shape of each cycle — whether the current one is running hot, cold, or in line with the prior bull market."
        now={cycleNowText(wksSince, cy2020Gain, cy2024Gain)}
      />
      <div className="htf-legend">
        <span className="htf-dot" style={{ background: "#8b5cf6" }} />2020 Cycle
        <span className="htf-dot" style={{ background: "#22c55e" }} />2024 Cycle
      </div>
      <TabAITake text={aiText} loading={aiLoading} />
      <p className="htf-note">Both cycles indexed to 100% at their halving date. X-axis: weeks from halving. Y-axis: % gain from halving price.</p>
      <div ref={ref} className="htf-chart" />
    </div>
  );
}

function PanelPiCycle({
  candles, piGap, piNear, wksSince, aiText, aiLoading,
}: {
  candles: CandleDataPoint[]; piGap: number; piNear: boolean; wksSince: number;
  aiText?: string; aiLoading: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, el => {
    const chart = mkChart(el, 340, true);
    const pLine  = chart.addSeries(LineSeries, { color: "rgba(59,130,246,0.3)", lineWidth: 1, title: "Price" });
    const s16    = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 2, title: "16W SMA" });
    const dbl50  = chart.addSeries(LineSeries, { color: "#ef4444", lineWidth: 2, lineStyle: 1, title: "2×50W SMA" });
    pLine.setData(candles.map(c => ({ time: c.time as Time, value: c.close })));
    s16.setData(calcSMA(candles, 16).map(m => ({ time: m.time as Time, value: m.value })));
    dbl50.setData(calcSMA(candles, 50).map(m => ({ time: m.time as Time, value: m.value * 2 })));
    return chart;
  }, [candles]);
  return (
    <div className="htf-panel-inner">
      <ExplainerBlock
        how="The Pi Cycle Top tracks two moving averages — the 111-day SMA (≈16-week) and twice the 350-day SMA (≈2×50-week). When the faster line crosses above the slower, it has marked the cycle top within days in every prior Bitcoin bull run: December 2017, April 2021, and November 2021."
        now={piNowText(piGap, piNear, wksSince)}
      />
      <div className="htf-legend">
        <span className="htf-dot" style={{ background: "#f59e0b" }} />16W SMA (≈111DMA)
        <span className="htf-dot" style={{ background: "#ef4444" }} />2×50W SMA (≈2×350DMA)
      </div>
      <TabAITake text={aiText} loading={aiLoading} />
      <div className={`htf-pi-status${piNear ? " htf-pi-status--warn" : ""}`}>
        16W SMA is <strong>{piGap > 0 ? "above" : "below"}</strong> 2×50W SMA by {Math.abs(piGap).toFixed(1)}%
        {piNear && " — ⚠ Lines converging, watch closely"}
      </div>
      <div ref={ref} className="htf-chart" />
    </div>
  );
}

function PanelFib({
  candles, fibLevels, currentPrice, wksSince, phase, aiText, aiLoading,
}: {
  candles: CandleDataPoint[]; fibLevels: FibLevel[]; currentPrice: number;
  wksSince: number; phase: string;
  aiText?: string; aiLoading: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, el => {
    const chart = mkChart(el, 300, true);
    const visible = candles.slice(-104);
    if (visible.length === 0) return chart;
    const startT = visible[0].time as Time;
    const endT   = visible[visible.length - 1].time as Time;
    const pLine  = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 2, title: "Price" });
    pLine.setData(visible.map(c => ({ time: c.time as Time, value: c.close })));
    for (const fib of fibLevels) {
      const s = chart.addSeries(LineSeries, {
        color: fib.color, lineWidth: 1, lineStyle: fib.lineStyle,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      });
      s.setData([{ time: startT, value: fib.price }, { time: endT, value: fib.price }]);
    }
    return chart;
  }, [candles, fibLevels]);

  void wksSince; void phase;

  return (
    <div className="htf-panel-inner">
      <ExplainerBlock
        how="Fibonacci retracement and extension levels are measured from the current cycle low to the all-time high. The 0.618 Golden Ratio and 0.786 levels are the most critical retracement supports on corrections. The 1.618 and 2.618 extensions above the ATH are the primary cycle-top target zones in prior Bitcoin bull markets."
        now={fibNowText(fibLevels, currentPrice)}
      />
      <TabAITake text={aiText} loading={aiLoading} />
      <div className="htf-fib-grid">
        {fibLevels.map(f => {
          const isNear = Math.abs(currentPrice - f.price) / f.price < 0.025;
          return (
            <div key={f.label} className={`htf-fib-row${isNear ? " htf-fib-row--near" : ""}`}>
              <span className="htf-fib-dot" style={{ background: f.color }} />
              <span className="htf-fib-label">{f.label}</span>
              <span className="htf-fib-price">{fmtPrice(f.price)}</span>
              {isNear && <span className="htf-fib-here">← price near here</span>}
            </div>
          );
        })}
      </div>
      <div ref={ref} className="htf-chart htf-chart--fib" />
    </div>
  );
}

function PanelScenario({
  candles, scenarios, wksSince, phase, aiText, aiLoading,
}: {
  candles: CandleDataPoint[]; scenarios: ScenarioPath[]; wksSince: number; phase: string;
  aiText?: string; aiLoading: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, el => {
    const chart = mkChart(el, 320, true);
    const hist = candles.slice(-26);
    if (hist.length > 0) {
      const h = chart.addSeries(LineSeries, { color: "#94a3b8", lineWidth: 2, title: "Price" });
      h.setData(hist.map(c => ({ time: c.time as Time, value: c.close })));
    }
    for (const sc of scenarios) {
      const s = chart.addSeries(LineSeries, { color: sc.color, lineWidth: 2, lineStyle: 1, title: sc.label });
      s.setData(sc.path);
    }
    return chart;
  }, [candles, scenarios]);
  return (
    <div className="htf-panel-inner">
      <ExplainerBlock
        how="Three forward price paths are projected from the current cycle week: Bull (new ATH driven by institutional demand and ETF flows), Base (steady accumulation without a major macro catalyst), and Bear (macro shock or distribution retracement to Fibonacci support). Paths are shaped by historical cycle analogues and current Fibonacci targets."
        now={scenarioNowText(wksSince, phase)}
      />
      <div className="htf-legend">
        <span className="htf-dot" style={{ background: "#94a3b8" }} />Historical (26W)
        <span className="htf-dot" style={{ background: "#22c55e" }} />Bull
        <span className="htf-dot" style={{ background: "#3b82f6" }} />Base
        <span className="htf-dot" style={{ background: "#ef4444" }} />Bear
      </div>
      <TabAITake text={aiText} loading={aiLoading} />
      <div ref={ref} className="htf-chart" />
      <div className="htf-scenario-cards">
        {scenarios.map(sc => (
          <div className="htf-sc" key={sc.label} style={{ "--sc-color": sc.color } as React.CSSProperties}>
            <div className="htf-sc-hd">
              <span className="htf-sc-label">{sc.label} Case</span>
              <span className="htf-sc-target">{fmtK(sc.target)}</span>
            </div>
            <span className="htf-sc-timeline">{sc.timeline}</span>
            <p className="htf-sc-desc">{sc.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function PanelAI({
  aiResult, aiLoading, aiError, exceeded, used, limit,
  onGetAI, onOpenAuth, onOpenUpgrade,
}: {
  aiResult: HTFAIResponse | null; aiLoading: boolean; aiError: string;
  exceeded: boolean; used: number; limit: number;
  onGetAI: () => void; onOpenAuth: () => void; onOpenUpgrade: () => void;
}) {
  return (
    <div className="htf-panel-inner">
      {exceeded ? (
        <AIQuotaWall used={used} limit={limit} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />
      ) : !aiResult ? (
        <div className="htf-ai-cta">
          <p className="htf-ai-cta-text">
            AI-powered cycle analysis — cycle phase, 6-month and 12-month outlooks, key levels, and an actionable long-term take, powered by GPT-4o.
          </p>
          <button className="htf-ai-btn" onClick={onGetAI} disabled={aiLoading}>
            {aiLoading ? <><span className="htf-btn-spin" />Analysing…</> : "Get AI Outlook"}
          </button>
          {aiError && <p className="htf-ai-error">{aiError}</p>}
        </div>
      ) : (
        <div className="htf-ai-body">
          <div className="htf-ai-badges">
            {aiResult.cyclePhase && (
              <span className="htf-phase-badge" style={{ color: PHASE_COLOR[aiResult.cyclePhase] ?? "#94a3b8", borderColor: PHASE_COLOR[aiResult.cyclePhase] ?? "#94a3b8" }}>
                {aiResult.cyclePhase}
              </span>
            )}
            {aiResult.trend && <span className={`htf-trend-badge htf-trend-badge--${aiResult.trend}`}>{aiResult.trend.toUpperCase()}</span>}
            {aiResult.ourTakeAction && (
              <span className={`htf-action-badge ${ACTION_CLS[aiResult.ourTakeAction] ?? ""}`}>
                {aiResult.ourTakeAction.charAt(0).toUpperCase() + aiResult.ourTakeAction.slice(1)}
              </span>
            )}
          </div>
          {[["6-Month Outlook", aiResult.outlook6m], ["12-Month Outlook", aiResult.outlook12m], ["Key Levels", aiResult.keyLevels]].filter(([, v]) => v).map(([label, val]) => (
            <div className="htf-ai-sec" key={label as string}>
              <div className="htf-ai-sec-label">{label as string}</div>
              <p>{val}</p>
            </div>
          ))}
          {aiResult.ourTake && (
            <div className="htf-ai-sec htf-our-take">
              <div className="htf-ai-sec-label">Our Take</div>
              <p>{aiResult.ourTake}</p>
            </div>
          )}
          <button className="htf-refresh-btn" onClick={onGetAI} disabled={aiLoading}>
            {aiLoading ? "Refreshing…" : "Refresh Analysis"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export const HTFAnalysis: React.FC<Props> = ({
  coin = "BTC", currentPrice: propPrice = 0,
  onOpenAuth = () => {}, onOpenUpgrade = () => {},
}) => {
  const { exceeded, used, limit, consume } = useAIQuota();
  const [candles, setCandles]   = useState<CandleDataPoint[]>([]);
  const [loading, setLoading]   = useState(true);
  const [active, setActive]     = useState<SectionId>("monthly");
  const [aiResult, setAiResult] = useState<HTFAIResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError]   = useState("");
  const [tabInsights, setTabInsights] = useState<Partial<Record<SectionId, string>>>({});
  const [tabInsightLoading, setTabInsightLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    coinglass.getHTFCandles(coin).then(d => { setCandles(d); setLoading(false); }).catch(() => setLoading(false));
  }, [coin]);

  const stats = useMemo(() => {
    if (candles.length === 0) return null;
    const price = propPrice || candles[candles.length - 1].close;
    const ath = Math.max(...candles.map(c => c.high));
    const cycleLow = Math.min(...candles.map(c => c.low));
    const ma200arr = calcSMA(candles, 200);
    const ma200 = ma200arr.length > 0 ? ma200arr[ma200arr.length - 1].value : null;
    const ratio = ma200 ? price / ma200 : null;
    const drawdown = ath > 0 ? ((price - ath) / ath) * 100 : 0;
    const wksSince = Math.floor((Date.now() / 1000 - LAST_HALVING_TS) / WEEK_SEC);
    const rc = candles.slice(-4).map(c => c.close);
    const recentTrend = rc.length >= 2 ? (rc[rc.length - 1] > rc[0] ? "bullish" : rc[rc.length - 1] < rc[0] ? "bearish" : "neutral") : "neutral";
    const phase = wksSince < 52 ? "Early Accumulation" : wksSince < 104 ? "Mid Expansion" : wksSince < 130 ? "Late Expansion" : wksSince < 160 ? "Distribution" : "Bear Market";
    const lastTs = candles[candles.length - 1].time;
    const sma16 = calcSMA(candles, 16);
    const sma50 = calcSMA(candles, 50);
    const last16 = sma16[sma16.length - 1]?.value ?? 0;
    const last50x2 = (sma50[sma50.length - 1]?.value ?? 0) * 2;
    const piGap = last50x2 > 0 ? (last16 / last50x2 - 1) * 100 : 0;
    return { price, ath, cycleLow, ma200, ratio, drawdown, wksSince, recentTrend, phase, lastTs, piGap, piNear: Math.abs(piGap) < 12 };
  }, [candles, propPrice]);

  // Cycle-to-cycle comparison stats
  const cycleComparison = useMemo(() => {
    if (!candles.length || !stats) return null;
    const h3ts = HALVINGS[2].ts;
    const h4ts = LAST_HALVING_TS;
    let b2020Price = 0, b2024Price = 0, idx2020 = -1;
    for (let i = 0; i < candles.length; i++) {
      if (!b2020Price && Math.abs(candles[i].time - h3ts) < WEEK_SEC * 3) { b2020Price = candles[i].close; idx2020 = i; }
      if (!b2024Price && Math.abs(candles[i].time - h4ts) < WEEK_SEC * 3) { b2024Price = candles[i].close; }
    }
    const idx2020Now = idx2020 >= 0 ? idx2020 + stats.wksSince : -1;
    const cy2020PriceAtNow = (idx2020Now >= 0 && idx2020Now < candles.length) ? candles[idx2020Now].close : null;
    const cy2020GainPct = cy2020PriceAtNow && b2020Price > 0 ? (cy2020PriceAtNow / b2020Price - 1) * 100 : null;
    const cy2024GainPct = b2024Price > 0 ? (stats.price / b2024Price - 1) * 100 : null;
    // 200W MA ratio at equivalent 2020 week
    const ma200at2020 = idx2020Now >= 200
      ? candles.slice(idx2020Now - 199, idx2020Now + 1).reduce((s, c) => s + c.close, 0) / 200
      : null;
    const ratio2020 = ma200at2020 && cy2020PriceAtNow ? cy2020PriceAtNow / ma200at2020 : null;
    return { cy2020GainPct, cy2024GainPct, ratio2020 };
  }, [candles, stats]);

  const fibLevels = useMemo(() => stats ? computeFibLevels(stats.cycleLow, stats.ath) : [], [stats]);
  const scenarios = useMemo(() => stats ? computeScenarios(stats.price, stats.ath, stats.cycleLow, stats.lastTs) : [], [stats]);

  // Auto-fetch per-tab AI insight when tab switches
  useEffect(() => {
    if (active === "ai" || !stats || exceeded) return;
    if (tabInsights[active] !== undefined) return;
    if (!consume()) return;
    const input: TabInsightInput = {
      tab: active, coin,
      currentPrice: stats.price, weeksSinceHalving: stats.wksSince,
      ma200w: stats.ma200, priceToMA200wRatio: stats.ratio,
      allTimeHigh: stats.ath, cycleLow: stats.cycleLow,
      drawdownFromATH: stats.drawdown, recentWeeklyTrend: stats.recentTrend,
      piGap: stats.piGap,
    };
    setTabInsightLoading(true);
    getTabInsight(input).then(res => {
      if (res.success && res.text) setTabInsights(prev => ({ ...prev, [active]: res.text! }));
      setTabInsightLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stats]);

  const handleAI = async () => {
    if (!stats || !consume()) return;
    setAiLoading(true); setAiError("");
    const res = await openaiHTF.getHTFAnalysis({
      coin, currentPrice: stats.price, weeksSinceHalving: stats.wksSince,
      ma200w: stats.ma200, priceToMA200wRatio: stats.ratio,
      allTimeHigh: stats.ath, cycleLow: stats.cycleLow,
      drawdownFromATH: stats.drawdown,
      recentWeeklyTrend: stats.recentTrend as "bullish" | "bearish" | "neutral",
    });
    setAiLoading(false);
    if (res.success) setAiResult(res); else setAiError(res.error || "Analysis failed");
  };

  if (loading) {
    return (
      <div className="htf-loading">
        <div className="htf-spinner" />
        <span>Loading weekly candle data…</span>
      </div>
    );
  }

  return (
    <div className="htf-wrap">

      {/* ── Header + stats ── */}
      <div className="htf-header">
        <div>
          <h2 className="htf-title">Long-Term Analysis</h2>
          <span className="htf-sub">HTF · Weekly · Cycle Tracking · {coin}/USD</span>
        </div>
        {stats && (
          <span className="htf-phase-pill" style={{ color: PHASE_COLOR[stats.phase] ?? "#94a3b8", borderColor: PHASE_COLOR[stats.phase] ?? "#94a3b8" }}>
            {stats.phase}
          </span>
        )}
      </div>

      {stats && (
        <div className="htf-inline-stats">
          {([
            ["Price", fmtPrice(stats.price), ""],
            ["ATH", fmtPrice(stats.ath), ""],
            ["Drawdown", stats.drawdown.toFixed(1) + "%", stats.drawdown < -30 ? "red" : stats.drawdown < -10 ? "yellow" : "green"],
            ["200W MA", stats.ma200 ? fmtPrice(stats.ma200) : "—", ""],
            ["Price / 200W MA", stats.ratio ? stats.ratio.toFixed(2) + "×" : "—", stats.ratio && stats.ratio > 3 ? "red" : stats.ratio && stats.ratio > 1.5 ? "yellow" : "green"],
            ["Post-Halving", stats.wksSince + "w", ""],
            ["Cycle Low", fmtPrice(stats.cycleLow), ""],
            ["Trend", stats.recentTrend.charAt(0).toUpperCase() + stats.recentTrend.slice(1), stats.recentTrend],
          ] as [string, string, string][]).map(([label, val, cls], i, arr) => (
            <span className="htf-inline-item" key={label}>
              <span className="htf-inline-label">{label}</span>
              {" "}
              <span className={`htf-inline-val htf-col--${cls || "default"}`}>{val}</span>
              {i < arr.length - 1 && <span className="htf-inline-dot">·</span>}
            </span>
          ))}
        </div>
      )}

      {/* ── Thumbnail grid ── */}
      <div className="htf-thumbs">
        {SECTIONS.map(s => (
          <button
            key={s.id}
            className={`htf-thumb${active === s.id ? " htf-thumb--active" : ""}`}
            onClick={() => setActive(s.id)}
          >
            <span className="htf-thumb-icon"><SectionIcon d={s.d} /></span>
            <span className="htf-thumb-title">{s.title}</span>
            <span className="htf-thumb-sub">{s.sub}</span>
          </button>
        ))}
      </div>

      {/* ── Active panel ── */}
      <div key={active} className="htf-panel">
        <div className="htf-panel-hd">
          <span className="htf-panel-title">{SECTIONS.find(s => s.id === active)?.title}</span>
          {active === "ai" && <span className="htf-ai-badge">GPT-4o</span>}
        </div>

        {active === "monthly" && stats && (
          <div className="htf-panel-inner">
            <ExplainerBlock
              how="Each cell shows Bitcoin's percentage return for that calendar month. Rows are years, columns are months. Deeper green = larger gain, deeper red = larger loss. This heatmap reveals seasonal patterns — which months have historically been strong or weak across multiple market cycles."
              now={monthlyNowText(stats.wksSince, stats.phase)}
            />
            <TabAITake text={tabInsights.monthly} loading={tabInsightLoading && active === "monthly"} />
            <MonthlyReturns coin={coin} />
          </div>
        )}
        {active === "monthly" && !stats && (
          <div className="htf-panel-inner">
            <MonthlyReturns coin={coin} />
          </div>
        )}
        {active === "ma200" && stats && (
          <PanelMA200
            candles={candles}
            ratio={stats.ratio}
            ma200={stats.ma200}
            wksSince={stats.wksSince}
            ratio2020={cycleComparison?.ratio2020 ?? null}
            aiText={tabInsights.ma200}
            aiLoading={tabInsightLoading && active === "ma200"}
          />
        )}
        {active === "cycle" && stats && (
          <PanelCycle
            candles={candles}
            wksSince={stats.wksSince}
            cy2020Gain={cycleComparison?.cy2020GainPct ?? null}
            cy2024Gain={cycleComparison?.cy2024GainPct ?? null}
            aiText={tabInsights.cycle}
            aiLoading={tabInsightLoading && active === "cycle"}
          />
        )}
        {active === "pi" && stats && (
          <PanelPiCycle
            candles={candles}
            piGap={stats.piGap}
            piNear={stats.piNear}
            wksSince={stats.wksSince}
            aiText={tabInsights.pi}
            aiLoading={tabInsightLoading && active === "pi"}
          />
        )}
        {active === "fib" && stats && (
          <PanelFib
            candles={candles}
            fibLevels={fibLevels}
            currentPrice={stats.price}
            wksSince={stats.wksSince}
            phase={stats.phase}
            aiText={tabInsights.fib}
            aiLoading={tabInsightLoading && active === "fib"}
          />
        )}
        {active === "scenario" && stats && (
          <PanelScenario
            candles={candles}
            scenarios={scenarios}
            wksSince={stats.wksSince}
            phase={stats.phase}
            aiText={tabInsights.scenario}
            aiLoading={tabInsightLoading && active === "scenario"}
          />
        )}
        {active === "ai" && (
          <PanelAI
            aiResult={aiResult} aiLoading={aiLoading} aiError={aiError}
            exceeded={exceeded} used={used} limit={limit}
            onGetAI={handleAI} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade}
          />
        )}
      </div>
    </div>
  );
};
