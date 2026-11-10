import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { createChart, IChartApi, LineSeries, LineData, Time } from "lightweight-charts";
import { coinglass, CandleDataPoint, CoinSymbol } from "../services/coinglass";
import { openaiHTF, HTFAIResponse, getTabInsight, TabInsightInput } from "../services/openai";
import { useAIQuota } from "../hooks/useAIQuota";
import { AIQuotaWall } from "./AIQuotaWall";
import { MonthlyReturns } from "./MonthlyReturns";
import { ETFInflows } from "./ETFInflows";
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

type SectionId = "monthly" | "ma200" | "cycle" | "pi" | "fib" | "scenario" | "etf" | "ai";

const SECTIONS: { id: SectionId; d: string | string[] }[] = [
  {
    id: "monthly",
    d: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"],
  },
  {
    id: "ma200",
    d: ["M3 3v18h18", "M7 16l4-4 4 4 5-5"],
  },
  {
    id: "cycle",
    d: "M17 2l4 4-4 4M3 11v-1a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 01-4 4H3",
  },
  {
    id: "pi",
    d: "M22 12h-4l-3 9L9 3l-3 9H2",
  },
  {
    id: "fib",
    d: ["M3 6h18", "M3 10h14", "M3 14h18", "M3 18h10"],
  },
  {
    id: "scenario",
    d: ["M3 12h3l3-9 4 18 3-9h6"],
  },
  {
    id: "etf",
    d: ["M12 2v20", "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"],
  },
  {
    id: "ai",
    d: [
      "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
      "M20 3v4M22 5h-4",
    ],
  },
];

const PHASE_KEY_MAP: Record<string, string> = {
  "Early Accumulation": "earlyAccumulation",
  "Mid Expansion": "midExpansion",
  "Late Expansion": "lateExpansion",
  "Distribution": "distribution",
  "Bear Market": "bearMarket",
  "Recovery": "recovery",
};

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
// Retracements are measured DOWN from the all-time high (how far a pullback
// from the top has gone): 0.618 = ATH − 61.8% of the low→ATH range. They
// used to be measured up from the cycle low, which put every label on its
// mirror level (e.g. "0.618 Golden Ratio" sat on the real 0.382). The
// extensions project the whole low→ATH leg above the ATH (low + range × r).
function computeFibLevels(low: number, high: number): FibLevel[] {
  const range = high - low;
  const retr = (r: number) => high - range * r;
  const ext = (r: number) => low + range * r;
  return [
    { label: "1.0 — Cycle Low",      price: low,         color: "#ef4444", lineStyle: 2 },
    { label: "0.786",                price: retr(0.786), color: "#3b82f6", lineStyle: 0 },
    { label: "0.618 — Golden Ratio", price: retr(0.618), color: "#22c55e", lineStyle: 2 },
    { label: "0.5 — Mid Range",      price: retr(0.5),   color: "#94a3b8", lineStyle: 0 },
    { label: "0.382",                price: retr(0.382), color: "#eab308", lineStyle: 0 },
    { label: "0.236",                price: retr(0.236), color: "#f97316", lineStyle: 0 },
    { label: "0 — ATH",              price: high,        color: "#a78bfa", lineStyle: 2 },
    { label: "1.618 — Extension",    price: ext(1.618),  color: "#f59e0b", lineStyle: 1 },
    { label: "2.618 — Extension",    price: ext(2.618),  color: "#ec4899", lineStyle: 1 },
  ];
}

interface ScenarioPath { label: string; color: string; target: number; timeline: string; description: string; path: LineData[] }
function computeScenarios(price: number, ath: number, cycleLow: number, lastTs: number): ScenarioPath[] {
  const FORWARD = 52;
  // Targets come from the same Fibonacci map as the Fibonacci tab (they
  // used to be arbitrary multipliers, and the "Fibonacci support" bear case
  // used a 0.4 ratio that isn't a Fibonacci level):
  //   Bull = 1.618 extension of the cycle-low → ATH move (cycle-top zone)
  //   Bear = 0.618 retracement from the ATH (the Golden Ratio support)
  //   Base = a steady +35% from here (no level needed — a drift scenario)
  // If price is already beyond a level, fall back to a sensible next one.
  const range = ath - cycleLow;
  const ext1618 = cycleLow + range * 1.618;
  const retr618 = ath - range * 0.618;
  const retr786 = ath - range * 0.786;
  const bullTarget = price < ext1618 ? ext1618 : cycleLow + range * 2.618;
  const baseTarget = price * 1.35;
  const bearTarget = price > retr618 ? retr618 : retr786;
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
      description: `New ATH: price breaks ${fmtK(ath)} and runs to the ${price < ext1618 ? "1.618" : "2.618"} Fibonacci extension, ${fmtK(bullTarget)} — a commonly watched cycle-top target zone. Illustrative path, not a forecast.`, path: path(bullTarget, "bull") },
    { label: "Base", color: "#3b82f6", target: baseTarget, timeline: "6–12 months",
      description: `Steady accumulation with periodic pullbacks: about +35% from here, to ${fmtK(baseTarget)}. Illustrative path, not a forecast.`, path: path(baseTarget, "base") },
    { label: "Bear", color: "#ef4444", target: bearTarget, timeline: "3–6 months",
      description: `A macro shock or more selling takes price to the ${price > retr618 ? "0.618 (Golden Ratio)" : "0.786"} Fibonacci support at ${fmtK(bearTarget)}. Illustrative path, not a forecast.`, path: path(bearTarget, "bear") },
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
  const { t } = useTranslation();
  return (
    <div className="htf-explainer">
      <div className="htf-explainer-col">
        <div className="htf-explainer-label">{t("htf.explainer.howItWorks")}</div>
        <p className="htf-explainer-text">{how}</p>
      </div>
      <div className="htf-explainer-col htf-explainer-col--now">
        <div className="htf-explainer-label">{t("htf.explainer.currentReading")}</div>
        <p className="htf-explainer-text">{now}</p>
      </div>
    </div>
  );
}

// ── Current-reading text generators ──────────────────────────────────────────

type TFunction = ReturnType<typeof useTranslation>["t"];

function ma200NowText(ratio: number | null, ma200: number | null, wksSince: number, ratio2020: number | null, t: TFunction): string {
  if (!ratio || !ma200) return t("htf.explainer.noData");
  const comp = ratio2020 != null
    ? t("htf.explainer.ma200.comp", { wks: wksSince, r2020: ratio2020.toFixed(2) })
    : "";
  if (ratio < 1)   return t("htf.explainer.ma200.below",      { ma200: fmtPrice(ma200), comp });
  if (ratio < 1.5) return t("htf.explainer.ma200.earlyBull",  { ratio: ratio.toFixed(2), ma200: fmtPrice(ma200), comp });
  if (ratio < 2.5) return t("htf.explainer.ma200.midBull",    { ratio: ratio.toFixed(2), ma200: fmtPrice(ma200), comp });
  if (ratio < 3.5) return t("htf.explainer.ma200.approaching",{ ratio: ratio.toFixed(2), ma200: fmtPrice(ma200), comp });
  return t("htf.explainer.ma200.stretched", { ratio: ratio.toFixed(2), ma200: fmtPrice(ma200), comp });
}

function cycleNowText(wksSince: number, cy2020Gain: number | null, cy2024Gain: number | null, t: TFunction): string {
  if (cy2020Gain == null || cy2024Gain == null)
    return t("htf.explainer.cycle.noData", { wks: wksSince });
  const diff = cy2024Gain - cy2020Gain;
  const absDiff = Math.abs(diff).toFixed(0);
  if (Math.abs(diff) < 15)
    return t("htf.explainer.cycle.tracking",      { wks: wksSince, gain24: cy2024Gain.toFixed(0), gain20: cy2020Gain.toFixed(0) });
  if (diff > 0)
    return t("htf.explainer.cycle.outperforming", { wks: wksSince, gain24: cy2024Gain.toFixed(0), gain20: cy2020Gain.toFixed(0), diff: absDiff });
  return t("htf.explainer.cycle.trailing",        { wks: wksSince, gain24: cy2024Gain.toFixed(0), gain20: cy2020Gain.toFixed(0), diff: absDiff });
}

function piNowText(piGap: number, piNear: boolean, wksSince: number, t: TFunction): string {
  if (piNear && piGap > 0) return t("htf.explainer.pi.warning",    { gap: Math.abs(piGap).toFixed(1) });
  if (piNear)               return t("htf.explainer.pi.converging", { gap: Math.abs(piGap).toFixed(1), wks: wksSince });
  if (piGap > 0)            return t("htf.explainer.pi.above",      { gap: piGap.toFixed(1), wks: wksSince });
  return t("htf.explainer.pi.below", { gap: Math.abs(piGap).toFixed(1), wks: wksSince });
}

function fibNowText(fibLevels: FibLevel[], currentPrice: number, t: TFunction): string {
  const sorted = [...fibLevels].sort((a, b) => a.price - b.price);
  const above = sorted.filter(f => f.price > currentPrice);
  const below = sorted.filter(f => f.price <= currentPrice);
  const nearestRes = above[0];
  const nearestSup = below[below.length - 1];
  const athLevel = fibLevels.find(f => f.label.includes("ATH"));
  const ext1618  = fibLevels.find(f => f.label.includes("1.618"));
  const ext2618  = fibLevels.find(f => f.label.includes("2.618"));
  const aboveATH = athLevel && currentPrice > athLevel.price;

  let text = "";
  if (nearestSup) text += t("htf.explainer.fib.support",    { label: nearestSup.label, price: fmtPrice(nearestSup.price) });
  if (nearestRes) text += t("htf.explainer.fib.resistance",  { label: nearestRes.label, price: fmtPrice(nearestRes.price) });
  if (aboveATH) {
    text += t("htf.explainer.fib.aboveATH", { ext1618: ext1618 ? fmtPrice(ext1618.price) : "—", ext2618: ext2618 ? fmtPrice(ext2618.price) : "—" });
  } else if (athLevel) {
    // % below = drop from the ATH (matches the header's Drawdown); the old
    // number was the % gain needed to get back, mislabeled as "below".
    const pctBelow = ((athLevel.price - currentPrice) / athLevel.price * 100).toFixed(1);
    const pctBack  = ((athLevel.price - currentPrice) / currentPrice * 100).toFixed(1);
    text += t("htf.explainer.fib.belowATH", { pct: pctBelow, back: pctBack, ath: fmtPrice(athLevel.price), ext1618: ext1618 ? fmtPrice(ext1618.price) : "—", ext2618: ext2618 ? fmtPrice(ext2618.price) : "—" });
  }
  return text.trim();
}

function scenarioNowText(wksSince: number, phase: string, t: TFunction): string {
  const phaseKey = PHASE_KEY_MAP[phase];
  const phaseText = phaseKey ? t(`htf.explainer.scenario.${phaseKey}`) : "";
  const translatedPhase = phaseKey ? t(`htf.phase.${phaseKey}`) : phase;
  return t("htf.explainer.scenario.prefix", { wks: wksSince, phase: translatedPhase }) + phaseText;
}

function monthlyNowText(wksSince: number, phase: string, t: TFunction): string {
  const monthsSince = Math.round(wksSince / 4.33);
  const phaseKey = PHASE_KEY_MAP[phase];
  if (!phaseKey) return "";
  return t(`htf.explainer.monthly.${phaseKey}`, { months: monthsSince });
}

// ── AI Take footer (shared by all non-AI tabs) ───────────────────────────────

function TabAITake({ text, loading }: { text?: string; loading: boolean }) {
  const { t } = useTranslation();
  if (!loading && !text) return null;
  return (
    <div className="htf-tab-ai-take">
      <div className="htf-tab-ai-header">
        <div className="htf-tab-ai-label">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
          </svg>
          {t("htf.tabAI.label")}
        </div>
        <span className="htf-ai-badge" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
          </svg>
          {t("htf.tabAI.badge")}
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
  const { t } = useTranslation();
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
        how={t("htf.explainer.ma200.how")}
        now={ma200NowText(ratio, ma200, wksSince, ratio2020, t)}
      />
      <TabAITake text={aiText} loading={aiLoading} />
      <div className="htf-legend">
        <span className="htf-dot" style={{ background: "#3b82f6" }} />{t("htf.legend.price")}
        <span className="htf-dot" style={{ background: "#f59e0b" }} />{t("htf.legend.ma200w")}
        <span className="htf-dot" style={{ background: "#22c55e" }} />{t("htf.legend.ma50w")}
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
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useChart(ref, el => {
    const chart = mkChart(el, 340, false);
    const baseTs = LAST_HALVING_TS;
    const h3ts = HALVINGS[2].ts;
    // Week that contains each halving. No fallback to the first candle: if a
    // halving isn't in the data, that cycle's line is simply not drawn
    // (the old fallback drew a fake "2020" line from the Nov 2021 top).
    let b2020 = 0, b2024 = 0, w2020 = 0, w2024 = 0;   // close + start time of the halving week
    for (const c of candles) {
      if (!b2020 && c.time <= h3ts && h3ts < c.time + WEEK_SEC) { b2020 = c.close; w2020 = c.time; }
      if (!b2024 && c.time <= baseTs && baseTs < c.time + WEEK_SEC) { b2024 = c.close; w2024 = c.time; }
    }
    const dedup = (arr: LineData[]) => {
      const map = new Map<number, number>();
      arr.forEach(d => map.set(d.time as number, d.value as number));
      return Array.from(map.entries()).sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t as Time, value: v }));
    };
    const cy20: LineData[] = [], cy24: LineData[] = [];
    // Both lines start at 100% on their halving week; the 2020 line is laid
    // onto the 2024 timeline week-for-week.
    for (const c of candles) {
      if (b2020 && c.time >= w2020) {
        const w = Math.round((c.time - w2020) / WEEK_SEC);
        if (w <= 156 && w2024) cy20.push({ time: (w2024 + w * WEEK_SEC) as Time, value: +(c.close / b2020 * 100).toFixed(2) });
      }
      if (b2024 && c.time >= w2024) cy24.push({ time: c.time as Time, value: +(c.close / b2024 * 100).toFixed(2) });
    }
    if (cy20.length > 0) { const s = chart.addSeries(LineSeries, { color: "#8b5cf6", lineWidth: 2, title: "2020" }); s.setData(dedup(cy20)); }
    if (cy24.length > 0) { const s = chart.addSeries(LineSeries, { color: "#22c55e", lineWidth: 2, title: "2024" }); s.setData(dedup(cy24)); }
    return chart;
  }, [candles]);
  return (
    <div className="htf-panel-inner">
      <ExplainerBlock
        how={t("htf.explainer.cycle.how")}
        now={cycleNowText(wksSince, cy2020Gain, cy2024Gain, t)}
      />
      <div className="htf-legend">
        <span className="htf-dot" style={{ background: "#8b5cf6" }} />{t("htf.legend.cycle2020")}
        <span className="htf-dot" style={{ background: "#22c55e" }} />{t("htf.legend.cycle2024")}
      </div>
      <TabAITake text={aiText} loading={aiLoading} />
      <p className="htf-note">{t("htf.notes.cycle")}</p>
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
  const { t } = useTranslation();
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
        how={t("htf.explainer.pi.how")}
        now={piNowText(piGap, piNear, wksSince, t)}
      />
      <div className="htf-legend">
        <span className="htf-dot" style={{ background: "#f59e0b" }} />{t("htf.legend.sma16w")}
        <span className="htf-dot" style={{ background: "#ef4444" }} />{t("htf.legend.dbl50w")}
      </div>
      <TabAITake text={aiText} loading={aiLoading} />
      <div className={`htf-pi-status${piNear ? " htf-pi-status--warn" : ""}`}>
        {t(piGap > 0 ? "htf.piStatus.above" : "htf.piStatus.below", { gap: Math.abs(piGap).toFixed(1) })}
        {piNear && t("htf.piStatus.converging")}
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
  const { t } = useTranslation();
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
        how={t("htf.explainer.fib.how")}
        now={fibNowText(fibLevels, currentPrice, t)}
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
              {isNear && <span className="htf-fib-here">{t("htf.fib.nearLabel")}</span>}
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
  const { t } = useTranslation();
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
        how={t("htf.explainer.scenario.how")}
        now={scenarioNowText(wksSince, phase, t)}
      />
      <div className="htf-legend">
        <span className="htf-dot" style={{ background: "#94a3b8" }} />{t("htf.legend.historical26w")}
        <span className="htf-dot" style={{ background: "#22c55e" }} />{t("htf.legend.bull")}
        <span className="htf-dot" style={{ background: "#3b82f6" }} />{t("htf.legend.base")}
        <span className="htf-dot" style={{ background: "#ef4444" }} />{t("htf.legend.bear")}
      </div>
      <TabAITake text={aiText} loading={aiLoading} />
      <div ref={ref} className="htf-chart" />
      <div className="htf-scenario-cards">
        {scenarios.map(sc => {
          const scKey = sc.label.toLowerCase() as "bull" | "base" | "bear";
          return (
            <div className="htf-sc" key={sc.label} style={{ "--sc-color": sc.color } as React.CSSProperties}>
              <div className="htf-sc-hd">
                <span className="htf-sc-label">{t(`htf.scenario.${scKey}`)}</span>
                <span className="htf-sc-target">{fmtK(sc.target)}</span>
              </div>
              <span className="htf-sc-timeline">{sc.timeline}</span>
              <p className="htf-sc-desc">{sc.description}</p>
            </div>
          );
        })}
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
  const { t } = useTranslation();
  return (
    <div className="htf-panel-inner">
      {exceeded ? (
        <AIQuotaWall used={used} limit={limit} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />
      ) : !aiResult ? (
        <div className="htf-ai-cta">
          <p className="htf-ai-cta-text">{t("htf.ai.ctaText")}</p>
          <button className="htf-ai-btn" onClick={onGetAI} disabled={aiLoading}>
            {aiLoading ? <><span className="htf-btn-spin" />{t("htf.ai.analysing")}</> : t("htf.ai.getOutlook")}
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
          {([
            [t("htf.ai.outlook6m"), aiResult.outlook6m],
            [t("htf.ai.outlook12m"), aiResult.outlook12m],
            [t("htf.ai.keyLevels"), aiResult.keyLevels],
          ] as [string, string | undefined][]).filter(([, v]) => v).map(([label, val]) => (
            <div className="htf-ai-sec" key={label}>
              <div className="htf-ai-sec-label">{label}</div>
              <p>{val}</p>
            </div>
          ))}
          {aiResult.ourTake && (
            <div className="htf-ai-sec htf-our-take">
              <div className="htf-ai-sec-label">{t("htf.ai.ourTake")}</div>
              <p>{aiResult.ourTake}</p>
            </div>
          )}
          <button className="htf-refresh-btn" onClick={onGetAI} disabled={aiLoading}>
            {aiLoading ? t("htf.ai.refreshing") : t("htf.ai.refreshBtn")}
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
  const { t } = useTranslation();
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
    // This cycle's low = the bear-market bottom before the latest halving:
    // lowest low in the 104 weeks leading into it (Nov 2022 $15,476 for the
    // 2024 halving; Dec 2018 for 2020). Not the all-history minimum.
    const preHalving = candles.filter(c => c.time >= LAST_HALVING_TS - 104 * WEEK_SEC && c.time < LAST_HALVING_TS);
    const cycleLow = Math.min(...(preHalving.length ? preHalving : candles).map(c => c.low));
    const ma200arr = calcSMA(candles, 200);
    const ma200 = ma200arr.length > 0 ? ma200arr[ma200arr.length - 1].value : null;
    const ratio = ma200 ? price / ma200 : null;
    const drawdown = ath > 0 ? ((price - ath) / ath) * 100 : 0;
    const wksSince = Math.floor((Date.now() / 1000 - LAST_HALVING_TS) / WEEK_SEC);
    const rc = candles.slice(-4).map(c => c.close);
    const recentTrend = rc.length >= 2 ? (rc[rc.length - 1] > rc[0] ? "bullish" : rc[rc.length - 1] < rc[0] ? "bearish" : "neutral") : "neutral";
    // Phase by cycle timing, matched to history: in the 2016 and 2020 cycles
    // the top came ~75–78 weeks after the halving (this cycle's ATH: week
    // 76) and the bear-market bottom ~127–131 weeks after it. The old map
    // called weeks 104–130 "Late Expansion" and 130–160 "Distribution".
    const phase = wksSince < 26 ? "Early Accumulation"
      : wksSince < 60 ? "Mid Expansion"
      : wksSince < 80 ? "Late Expansion"
      : wksSince < 92 ? "Distribution"
      : wksSince < 130 ? "Bear Market"
      : "Recovery";
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
    // The weekly candle that CONTAINS each halving (the old "within 3 weeks"
    // match could pick a candle up to 3 weeks early).
    let b2020Price = 0, b2024Price = 0, idx2020 = -1;
    for (let i = 0; i < candles.length; i++) {
      const t0 = candles[i].time;
      if (!b2020Price && t0 <= h3ts && h3ts < t0 + WEEK_SEC) { b2020Price = candles[i].close; idx2020 = i; }
      if (!b2024Price && t0 <= h4ts && h4ts < t0 + WEEK_SEC) { b2024Price = candles[i].close; }
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
    if (active === "ai" || active === "etf" || !stats || exceeded) return;
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
        <span>{t("htf.loading")}</span>
      </div>
    );
  }

  return (
    <div className="htf-wrap">

      {/* ── Header + stats ── */}
      <div className="htf-header">
        <div>
          <h2 className="htf-title">{t("htf.title")}</h2>
          <span className="htf-sub">{t("htf.sub", { coin })}</span>
        </div>
        {stats && (
          <span className="htf-phase-pill" style={{ color: PHASE_COLOR[stats.phase] ?? "#94a3b8", borderColor: PHASE_COLOR[stats.phase] ?? "#94a3b8" }}>
            {PHASE_KEY_MAP[stats.phase] ? t(`htf.phase.${PHASE_KEY_MAP[stats.phase]}`) : stats.phase}
          </span>
        )}
      </div>

      {stats && (
        <div className="htf-inline-stats">
          {([
            [t("htf.stats.price"),      fmtPrice(stats.price), ""],
            [t("htf.stats.ath"),        fmtPrice(stats.ath), ""],
            [t("htf.stats.drawdown"),   stats.drawdown.toFixed(1) + "%", stats.drawdown < -30 ? "red" : stats.drawdown < -10 ? "yellow" : "green"],
            [t("htf.stats.ma200w"),     stats.ma200 ? fmtPrice(stats.ma200) : "—", ""],
            [t("htf.stats.priceToMa"),  stats.ratio ? stats.ratio.toFixed(2) + "×" : "—", stats.ratio && stats.ratio > 3 ? "red" : stats.ratio && stats.ratio > 1.5 ? "yellow" : "green"],
            [t("htf.stats.postHalving"),stats.wksSince + "w", ""],
            [t("htf.stats.cycleLow"),   fmtPrice(stats.cycleLow), ""],
            [t("htf.stats.trend"),      stats.recentTrend.charAt(0).toUpperCase() + stats.recentTrend.slice(1), stats.recentTrend],
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
            <span className="htf-thumb-title">{t(`htf.sections.${s.id}.title`)}</span>
            <span className="htf-thumb-sub">{t(`htf.sections.${s.id}.sub`)}</span>
          </button>
        ))}
      </div>

      {/* ── Active panel ── */}
      <div key={active} className="htf-panel">
        <div className="htf-panel-hd">
          <span className="htf-panel-title">{t(`htf.sections.${active}.title`)}</span>
          {active === "ai" && <span className="htf-ai-badge">{t("htf.aiLabel")}</span>}
        </div>

        {active === "monthly" && stats && (
          <div className="htf-panel-inner">
            <ExplainerBlock
              how={t("htf.explainer.monthly.how")}
              now={monthlyNowText(stats.wksSince, stats.phase, t)}
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
        {active === "etf" && (
          <div className="htf-panel-inner">
            <ETFInflows />
          </div>
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
