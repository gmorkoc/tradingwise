import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ReactDOM from "react-dom";
import { BottomSheet } from "./BottomSheet";
import { useTranslation, Trans } from "react-i18next";
import i18next from "i18next";
import { Capacitor } from "@capacitor/core";
import { PENDING_PREDICT_EVENT, clearPendingPredict, getPendingPredict } from "../services/pendingPredict";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  HistogramSeries,
  IChartApi,
  createSeriesMarkers,
  SeriesMarker,
  UTCTimestamp,
  LineStyle,
  PriceScaleMode,
} from "lightweight-charts";
import { coinglass, CandleDataPoint, CoinSymbol, COINS, getTickerSnapshot, MAX_RANGE_CANDLES } from "../services/coinglass";
import { fetchCoinMeta, fetchOpenInterestCoins, CoinMeta } from "../services/coinMeta";
import { ZoneResult, ZoneSignal } from "./PriceChart.types";
import SignalIndicator from "./SignalIndicator";
import {
  getCandlePatternAnalysis,
  CandlePatternResult,
  ChartPrediction,
  getZoneAnalysis,
  ZoneAnalysisResult,
} from "../services/openai";
import { PredictionOverlay, PredictionPath, LineDotFillOverlay, RoundedCandleOverlay } from "./DrawingOverlay";
import { ChartEventAnnotations, ChartEvent } from "./ChartEventAnnotations";
import { OrderBookProfileModal } from "./OrderBookProfile";
import { OrderBook } from "./OrderBook";
import { PredictionModal } from "./PredictionModal";
import { ChartDrawingTools, Drawing, ChartDrawingToolsHandle } from "./ChartDrawingTools";
import { ZoneAnalysisModal } from "./ZoneAnalysisModal";
import { ChartGoTo } from "./ChartGoTo";
import { analyseLiquidations, LEVERAGES_ALL } from "../utils/liquidationClusters";
import { AstroSuggestions } from "./AstroSuggestions";
import { CompactPriceView } from "./CompactPriceView";
import { CmcChart, CMC_RANGES, type CmcRange } from "./CmcChart";
import { ProVisionHud, ProVisionSignalPanel } from "./ProVisionHud";
import { useAIQuota } from "../hooks/useAIQuota";
import { supabase } from "../services/supabase";
import { useAuth } from "../contexts/AuthContext";
import { ConsensusStrip, type ConsensusItem } from "./ConsensusStrip";
import { technicalsLean } from "./CoinPageTabs";
import "../styles/PriceChart.css";
import { IndicatorPicker, type PickerItem } from "./IndicatorPicker";
import { useChartIndicators, useIndicatorSelection } from "../hooks/useChartIndicators";
import { getIndicatorDef } from "../services/customIndicators";
import { useProVisionGate, openProVisionPaywall } from "../hooks/useProVisionGate";
import { useStorePrices } from "../hooks/useStorePrices";
import { useLiveKline, binanceKlineInterval } from "../hooks/useLiveKline";
import { fetchProVision, fetchProVisionMtf, ProVisionLockedError, type PvTile, type PvResult } from "../services/proVision";
import { ProVisionOverlay } from "./ProVisionOverlay";
import { ProVisionGuide } from "./ProVisionGuide";
import { getMacroEvents, eventShortName, EVENT_PAUSE_BEFORE_MS, EVENT_PAUSE_AFTER_MS, type MacroEvent } from "../services/macroEvents";

export type TimeInterval =
  | "1sec"
  | "1min"
  | "5min"
  | "15min"
  | "1h"
  | "4h"
  | "6h"
  | "1day"
  | "1week"
  | "1month"
  | "all";
// Default visible window per interval on a fresh view — shared between the
// initial per-coin/interval load and the fullscreen-toggle view reset
// (see the isFullscreen effect further down), so both apply exactly the
// same "what does a reset view look like" definition.
// Pro Vision range prices: compact, enough precision for cheap coins.
function fmtPvPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return p.toPrecision(4);
}

// Cells on each side of the Signal check segment bars.
const PV_SEG = 10;
// Desktop promo for signed-out / free users: "ghost" (blurred ProVision
// teaser painted over the chart + center unlock button), "callout" (bubble
// under the top-bar ProVision switch, rendered in App.tsx) or "float"
// (glass card over the chart).
export const PV_PROMO_STYLE = "callout" as string;
// Short description per check (MA, DMI, Ichimoku, RSI, Stochastic, MACD, Volume).
const PV_ROW_DESC = [
  "Price vs 20 & 200 averages",
  "Who's pushing, and how hard",
  "Price vs the cloud",
  "Momentum, last 14 candles",
  "Where price sits in its range",
  "Momentum shift",
  "Market buys vs sells",
];

// Pro Vision volume amounts: 3.95K, 4.63M.
function fmtPvVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(v >= 10 ? 0 : 2);
}

// Pro Vision event countdown: "2h 14m", "45m", "under 1m".
function fmtCountdown(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return i18next.t("priceChart.under1m");
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

const INTERVAL_WINDOW: Partial<Record<TimeInterval, number>> = {
  "1min": 6 * 60 * 60,
  "5min": 2 * 24 * 60 * 60,
  "15min": 4 * 24 * 60 * 60,
  "1h": 14 * 24 * 60 * 60,
  "4h": 28 * 24 * 60 * 60,
  "6h": 56 * 24 * 60 * 60,
};
type IntervalTrends = Record<string, "bullish" | "bearish" | null>;
export type ChartStyle = "candle" | "hollow" | "line" | "heikinAshi";
const CHART_STYLE_LABELS: Record<ChartStyle, string> = {
  candle: "Candle",
  hollow: "Hollow Candle",
  line: "Line",
  heikinAshi: "Heikin Ashi",
};
export const CHART_STYLE_ICONS: Record<ChartStyle, JSX.Element> = {
  candle: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="7" y1="2" x2="7" y2="6" />
      <rect x="4.5" y="6" width="5" height="9" fill="currentColor" stroke="none" />
      <line x1="7" y1="15" x2="7" y2="20" />
      <line x1="17" y1="4" x2="17" y2="9" />
      <rect x="14.5" y="9" width="5" height="7" fill="currentColor" stroke="none" />
      <line x1="17" y1="16" x2="17" y2="22" />
    </svg>
  ),
  hollow: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <line x1="7" y1="2" x2="7" y2="6" />
      <rect x="4.5" y="6" width="5" height="9" />
      <line x1="7" y1="15" x2="7" y2="20" />
      <line x1="17" y1="4" x2="17" y2="9" />
      <rect x="14.5" y="9" width="5" height="7" />
      <line x1="17" y1="16" x2="17" y2="22" />
    </svg>
  ),
  line: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 16 9 10 13 14 21 4" />
    </svg>
  ),
  heikinAshi: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="7" y1="3" x2="7" y2="7" />
      <rect x="4.5" y="7" width="5" height="7" rx="1.5" fill="currentColor" stroke="none" />
      <line x1="7" y1="14" x2="7" y2="19" />
      <line x1="17" y1="5" x2="17" y2="8" />
      <rect x="14.5" y="8" width="5" height="9" rx="1.5" fill="currentColor" stroke="none" />
      <line x1="17" y1="17" x2="17" y2="21" />
    </svg>
  ),
};

interface PriceChartProps {
  refreshTrigger?: number;
  theme?: "dark" | "light";
  coin?: CoinSymbol;
  quoteVolume24h?: number;
  onZoneChange?: (zone: ZoneResult | null, price: number) => void;
  onOpenAuth?: () => void;
  onOpenUpgrade?: (plan?: "pro" | "elite") => void;
  onOpenCoinPicker?: (anchor: HTMLElement) => void;
  // Direct jump to one of the top-5-by-market-cap coins shown next to the
  // selector (chart-hero-top-coins below) — skips the full picker modal,
  // same shortcut Watchlist/TopMoversCarousel's own onSelectCoin already
  // gives from further down this same page.
  onSelectCoin?: (symbol: string) => void;
  onFullscreenChange?: (isFullscreen: boolean) => void;
  coinChatOpen?: boolean;
  onToggleCoinChat?: () => void;
  // Standalone "Advance Price Chart" page instance — permanently
  // fullscreen-rendered, independent mount from the compact chart card.
  // See toggleFullscreen below for how these replace the old local-overlay
  // enter/exit behavior.
  pageMode?: boolean;
  /** Which chart this is, so its saved settings (indicators, style, grid,
   *  scale) stay its own: "trade" (#trade), "advance" (#advance-chart) or
   *  "sheet" (the coin bottom sheet). Defaults to advance for pageMode,
   *  trade otherwise. */
  prefsScope?: "trade" | "advance" | "sheet";
  onNavigateToPage?: () => void;
  /** Mobile Tools sheet → full chart page with the drawing panel open. */
  /** Mobile Tools sheet → the Trade page's Paper Trade view. */
  onOpenPaperTrade?: () => void;
  onOpenDrawingTools?: () => void;
  onNavigateBack?: () => void;
  // MobileSymbolSheet.tsx — lets an external interval row (built outside
  // this component, against its own simpler reference-match label set)
  // drive this chart's real interval instead of duplicating candle-fetch/
  // indicator logic in a second chart implementation. One-way: setting
  // requestInterval pushes it into this component's own internal
  // `interval` state (below); onIntervalChange reports every change
  // (external or from this component's own UI) back out so the caller's
  // row can highlight the active one. Both optional — every other call
  // site is unaffected.
  requestInterval?: TimeInterval;
  onIntervalChange?: (interval: TimeInterval) => void;
  // Same controlled pattern as requestInterval/onIntervalChange, for the
  // candle-style toggle only — MobileSymbolSheet.tsx deliberately exposes
  // nothing for indicators/grid (never mirrors indicatorsList/
  // gridStyleControls out), so there's no way for that sheet to show
  // either regardless of what's added here later.
  requestChartStyle?: ChartStyle;
  onChartStyleChange?: (style: ChartStyle) => void;
  // MobileSymbolSheet.tsx — every indicator/overlay toggle is a shared,
  // persisted (readChartPrefs/localStorage) preference across every
  // PriceChart instance app-wide, so simply not rendering this
  // component's own Indicators menu (that sheet never does) isn't enough
  // — whatever the user last turned on elsewhere would still draw on this
  // embedded chart. This forces every one of them off for just this
  // instance, once, without touching the saved preference other
  // instances still read.
  forceHideIndicators?: boolean;
  // MobileSymbolSheet.tsx again — this sheet builds its own coin/price/
  // change header and its own interval row (mss-interval-row) above/below
  // this embedded compact <PriceChart>, so this instance's own header
  // (hero id/price row, Full/Compact switch, interval pills + fullscreen)
  // would just duplicate what the sheet already shows. Every OTHER
  // <PriceChart> instance (the plain #chart page, pageMode) still renders
  // its own header as normal — this only suppresses it for this one embed.
  forceHideHeader?: boolean;
  // OrderFlowPanel.tsx's "Today's Story" feed (App.tsx) — App.tsx has no
  // other way to reach the candles/srLevels/zone state ChartEventAnnotations
  // already computes these from internally.
  onChartEventsChange?: (events: ChartEvent[]) => void;
  // Rendered inside .price-chart-container itself (below the chart, outside
  // the fullscreen/scroll wrapper) — App.tsx uses this for Watchlist/
  // TopMoversCarousel so they visually live inside this card instead of as
  // separate full-width blocks below it.
  children?: React.ReactNode;
  // App.tsx's own .mch-stats (LIQ above/below, Open Interest, Funding,
  // RSI/MACD/L-S ratio) — same composition pattern as `children` above,
  // just rendered inside .chart-fs-header-group instead of below the whole
  // card, so it reads as part of the chart's own header instead of a
  // separate top-level bar. Already collapsed to nothing in pageMode via
  // that group's own chart-fs-header-group--empty modifier, so this never
  // needs its own pageMode check here.
  headerStats?: React.ReactNode;
  /** Trade page: section tab bar under the coin header, and the active
   *  tab's panel (non-null = a tab other than Overview, chart hidden). */
  pageTabBar?: React.ReactNode;
  pageTabContent?: React.ReactNode;
  // Optional column rendered inside .price-chart-container, to the right of
  // the chart (header, canvas, range bar, AI read) — App.tsx's Order Book /
  // Order Flow column. Not shown in fullscreen. `children` still runs full
  // width below both.
  sideColumn?: React.ReactNode;
}

export const INTERVALS: TimeInterval[] = [
  "1sec",
  "1min",
  "5min",
  "15min",
  "1h",
  "4h",
  "6h",
  "1day",
  "1week",
  "1month",
  "all",
];

const INTERVAL_LABELS: Record<TimeInterval, string> = {
  "1sec": "1s  (last 30 min)",
  "1min": "1m  (last 6 hours)",
  "5min": "5m  (last 24 hours)",
  "15min": "15m (last 48 hours)",
  "1h": "1H  (~7 days)",
  "4h": "4H  (~4 weeks)",
  "6h": "6H  (~15 days)",
  "1day": "24H (90 days)",
  "1week": "1W  (52 weeks)",
  "1month": "1M  (24 months)",
  "all": "ALL (full history)",
};

// Menu/sheet wording (no parentheses): short label + plain description
// now lives in the locale files (priceChart.ivDesc.*).
// INTERVAL_LABELS above stays as-is — the AI interval read uses it.

export const INTERVAL_SHORT: Record<TimeInterval, string> = {
  "1sec": "1s",
  "1min": "1m",
  "5min": "5m",
  "15min": "15m",
  "1h": "1H",
  "4h": "4H",
  "6h": "6H",
  "1day": "24H",
  "1week": "1W",
  "1month": "1M",
  "all": "ALL",
};

// Intervals that require at least Pro
const PRO_INTERVALS = new Set<TimeInterval>(["1sec", "all"]);
// Desktop chart page toolbar (CMC): main interval buttons + the rest in a ⌄ menu.
const TV_MAIN_INTERVALS: TimeInterval[] = ["15min", "1h", "4h", "1day"];
const TV_MORE_INTERVALS: TimeInterval[] = ["1sec", "1min", "5min", "6h", "1week", "1month", "all"];
// Phones (CMC app row): six in the row, the rest in Chart tools (⚙).
const PHONE_IVS: TimeInterval[] = ["15min", "1h", "4h", "1day", "1week", "1month"];
const TV_INTERVAL_LABEL: Record<TimeInterval, string> = {
  "1sec": "1s", "1min": "1m", "5min": "5m", "15min": "15m", "1h": "1h", "4h": "4h", "6h": "6h",
  "1day": "24h", "1week": "1W", "1month": "1M", "all": "All",
};
const TV_INTERVAL_NAME: Record<TimeInterval, string> = {
  "1sec": "1 second", "1min": "1 minute", "5min": "5 minutes", "15min": "15 minutes", "1h": "1 hour",
  "4h": "4 hours", "6h": "6 hours", "1day": "1 day", "1week": "1 week", "1month": "1 month", "all": "All time",
};

// Live clock for the right end of the range bar ("14:01:15 (UTC-4)").
// Its own component so the once-a-second tick only re-renders this span,
// not the whole chart.
export function RangeBarClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const off = -now.getTimezoneOffset();
  const h = Math.trunc(off / 60);
  const m = Math.abs(off % 60);
  const utc = `UTC${off === 0 ? "" : h > 0 ? `+${h}` : `${h}`}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
  const time = now.toLocaleTimeString("en-GB", { hour12: false });
  return <span className="chart-range-clock">{time} ({utc})</span>;
}

// Range presets for the bar under the chart (TradingView-style): each one
// picks a candle interval AND zooms to that much history.
const RANGE_PRESETS: { key: string; label: string; interval: TimeInterval; seconds: number; tip: string }[] = [
  { key: "1h", label: "1h", interval: "5min", seconds: 60 * 60, tip: "1 hour in 5 minute intervals" },
  { key: "4h", label: "4h", interval: "15min", seconds: 4 * 60 * 60, tip: "4 hours in 15 minute intervals" },
  { key: "1d", label: "1d", interval: "1h", seconds: 24 * 60 * 60, tip: "1 day in 1 hour intervals" },
  { key: "1w", label: "1w", interval: "4h", seconds: 7 * 24 * 60 * 60, tip: "1 week in 4 hour intervals" },
  { key: "1m", label: "1m", interval: "1day", seconds: 30 * 24 * 60 * 60, tip: "1 month in 1 day intervals" },
  { key: "1y", label: "1y", interval: "1week", seconds: 365 * 24 * 60 * 60, tip: "1 year in 1 week intervals" },
];
const INTERVAL_SECONDS: Record<TimeInterval, number> = {
  "1sec": 1, "1min": 60, "5min": 300, "15min": 900, "1h": 3600, "4h": 14400,
  "6h": 21600, "1day": 86400, "1week": 604800, "1month": 2592000, "all": Infinity,
};
// A date range stays active across interval changes (1y then 4H = a year
// of 4H candles) as long as it makes sense for that candle size: at
// least 3 candles, and no more than one chart load can fetch.
const rangeFitsInterval = (seconds: number, iv: TimeInterval) => {
  const n = seconds / INTERVAL_SECONDS[iv];
  return n >= 3 && n <= MAX_RANGE_CANDLES;
};

// Full coin name for the chart title ("Bitcoin" rather than "BTC") — COINS
// already carries this (services/coinglass.ts), just keyed by symbol here
// for an O(1) lookup instead of re-scanning the array on every render.
export const COIN_FULL_NAME: Record<string, string> = Object.fromEntries(
  COINS.map((c) => [c.symbol, c.name]),
);

// Coin avatar (mobile header, right column) — glyph + brand color per
// coin, same glyph set App.tsx/GlobalSearch.tsx/PriceTickerFullscreen.tsx
// each keep their own copy of rather than sharing.
export const COIN_GLYPHS: Record<string, string> = {
  BTC: "₿",
  ETH: "Ξ",
  XRP: "◈",
  SOL: "◎",
  BNB: "⬡",
  SUI: "⬟",
  DOGE: "Ð",
  ADA: "₳",
  NEAR: "Ⓝ",
  RENDER: "⬡",
  ZEC: "ⓩ",
};
export const COIN_COLORS: Record<string, string> = {
  BTC: "#f7931a",
  ETH: "#627eea",
  XRP: "#23292f",
  SOL: "#9945ff",
  BNB: "#f0b90b",
  SUI: "#4da2ff",
  DOGE: "#c2a633",
  ADA: "#0033ad",
  NEAR: "#000000",
  RENDER: "#6633cc",
  ZEC: "#f4b728",
};
// COINS (coinglass.ts) is already ordered by market cap — the first 5
// entries, in order, are the top 5. Next to the coin selector, overlapping
// avatar-stack style (chart-hero-top-coins below).
const TOP5_COINS = COINS.slice(0, 5).map((c) => c.symbol);

const FIB_LEVELS = [
  { ratio: 0, label: "0", color: "rgba(251,191,36,0.85)" },
  { ratio: 0.236, label: "0.236", color: "rgba(167,139,250,0.85)" },
  { ratio: 0.382, label: "0.382", color: "rgba(52,211,153,0.85)" },
  { ratio: 0.5, label: "0.5", color: "rgba(251,113,133,0.85)" },
  { ratio: 0.618, label: "0.618", color: "rgba(129,140,248,0.85)" },
  { ratio: 0.786, label: "0.786", color: "rgba(249,115,22,0.85)" },
  { ratio: 1, label: "1", color: "rgba(251,191,36,0.85)" },
] as const;

export function formatLivePrice(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(6)}`;
}

// Reference-match compact axis labels ("92k" instead of "92000.00") —
// desktop non-fullscreen only, wired through createChart's own
// localization.priceFormatter below.
function formatCompactAxisPrice(p: number): string {
  if (p >= 1000) {
    const k = p / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  if (p >= 1) return p.toFixed(2);
  return p.toFixed(6);
}

// Advance Price Chart page, mobile — tap feedback on the dock's toggles
// (sheet expand/collapse, Toolbox), Close, indicator checkboxes, and
// candle taps. No-op on web/desktop, where this plugin isn't meaningful
// (and may not be present). Medium rather than Light — Light was hard to
// feel reliably on-device.
function hapticTap() {
  if (Capacitor.isNativePlatform()) {
    Haptics.impact({ style: ImpactStyle.Medium }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[hapticTap] Haptics.impact failed:", e);
    });
  }
}

export function formatCompactVolume(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

// Same compact scale as formatCompactVolume, no $ prefix — for coin-unit
// quantities (circulating/total supply) rather than USD amounts.
export function formatCompactNumber(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

function formatClockTime(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Utility: Bollinger Bands ────────────────────────────────────────────────

function calcBollingerBands(candles: CandleDataPoint[], period = 20, mult = 2) {
  const upper: { time: number; value: number }[] = [];
  const middle: { time: number; value: number }[] = [];
  const lower: { time: number; value: number }[] = [];

  for (let i = period - 1; i < candles.length; i++) {
    const closes = candles.slice(i - period + 1, i + 1).map((c) => c.close);
    const sma = closes.reduce((s, v) => s + v, 0) / period;
    const variance = closes.reduce((s, v) => s + (v - sma) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper.push({
      time: candles[i].time,
      value: Math.round((sma + mult * sd) * 100) / 100,
    });
    middle.push({ time: candles[i].time, value: Math.round(sma * 100) / 100 });
    lower.push({
      time: candles[i].time,
      value: Math.round((sma - mult * sd) * 100) / 100,
    });
  }
  return { upper, middle, lower };
}

// ── Utility: Support / Resistance ──────────────────────────────────────────

function calcSupportResistance(
  candles: CandleDataPoint[],
  lookback = 5,
  maxLevels = 5,
  tolerance = 0.005,
) {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const isSwingHigh = candles
      .slice(i - lookback, i + lookback + 1)
      .every((c, idx) => idx === lookback || c.high <= high);
    const isSwingLow = candles
      .slice(i - lookback, i + lookback + 1)
      .every((c, idx) => idx === lookback || c.low >= low);
    if (isSwingHigh) highs.push(high);
    if (isSwingLow) lows.push(low);
  }

  const cluster = (levels: number[]) => {
    const clusters: { price: number; count: number }[] = [];
    for (const price of levels) {
      const existing = clusters.find(
        (c) => Math.abs(c.price - price) / price < tolerance,
      );
      if (existing) {
        existing.price =
          (existing.price * existing.count + price) / (existing.count + 1);
        existing.count++;
      } else {
        clusters.push({ price, count: 1 });
      }
    }
    return clusters.sort((a, b) => b.count - a.count).slice(0, maxLevels);
  };

  return { resistance: cluster(highs), support: cluster(lows) };
}

// ── Utility: Buy / Sell Zones ──────────────────────────────────────────────

function calcBuySellZones(candles: CandleDataPoint[]): ZoneResult | null {
  if (candles.length < 20) return null;

  const last = candles[candles.length - 1];
  const { upper, lower } = calcBollingerBands(candles);
  const { resistance, support } = calcSupportResistance(candles);

  const topBand = upper[upper.length - 1]?.value;
  const botBand = lower[lower.length - 1]?.value;
  if (!topBand || !botBand || topBand === botBand) return null;

  const bbPos = (last.close - botBand) / (topBand - botBand);
  const buyRef = support[0]?.price ?? botBand;
  const sellRef = resistance[0]?.price ?? topBand;

  const buyZone = { upper: buyRef * 1.006, lower: buyRef * 0.994 };
  const sellZone = { upper: sellRef * 1.006, lower: sellRef * 0.994 };

  // Trend context via EMA50 — prevents "Strong Buy" in a downtrend
  const closes = candles.map((c) => c.close);
  const ema50arr = coinglass.calculateEMA(closes, 50);
  const ema50 = ema50arr[ema50arr.length - 1];
  const downtrend = ema50 != null && last.close < ema50;
  const uptrend = ema50 != null && last.close > ema50;

  let signal: ZoneSignal;
  if (bbPos <= 0.12 || last.close <= buyZone.upper)
    signal = downtrend ? "oversold" : "strong-buy";
  else if (bbPos <= 0.35) signal = downtrend ? "neutral" : "buy";
  else if (bbPos >= 0.88 || last.close >= sellZone.lower)
    signal = uptrend ? "overbought" : "strong-sell";
  else if (bbPos >= 0.65) signal = uptrend ? "neutral" : "sell";
  else signal = "neutral";

  return { buyZone, sellZone, signal };
}

// ── Utility: RSI ───────────────────────────────────────────────────────────

function calcRSI(
  candles: CandleDataPoint[],
  period = 14,
): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];
  if (candles.length <= period) return result;

  let avgGain = 0,
    avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;

  result.push({
    time: candles[period].time,
    value: +(100 - 100 / (1 + avgGain / (avgLoss || 1e-10))).toFixed(2),
  });

  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result.push({
      time: candles[i].time,
      value: +(100 - 100 / (1 + avgGain / (avgLoss || 1e-10))).toFixed(2),
    });
  }
  return result;
}

// ── Utility: RSI Divergence detection ─────────────────────────────────────

interface DivergenceResult {
  type: "bullish" | "bearish";
  pivots: { time: number; price: number; rsi: number }[];
}

function detectRSIDivergence(
  candles: CandleDataPoint[],
  rsiData: { time: number; value: number }[],
  lookback = 120,
): DivergenceResult | null {
  if (candles.length < 14 || rsiData.length < 5) return null;
  const recent = candles.slice(-Math.min(candles.length, lookback));
  // Smaller datasets need a tighter window to find enough swing points
  const swingWindow = recent.length >= 60 ? 3 : recent.length >= 30 ? 2 : 1;
  const rsiByTime = new Map(rsiData.map((r) => [r.time, r.value]));

  const swingLows: { time: number; price: number; rsi: number }[] = [];
  const swingHighs: { time: number; price: number; rsi: number }[] = [];

  for (let i = swingWindow; i < recent.length - swingWindow; i++) {
    const c = recent[i];
    const rsi = rsiByTime.get(c.time as number);
    if (rsi === undefined) continue;
    let isLow = true,
      isHigh = true;
    for (let j = i - swingWindow; j <= i + swingWindow; j++) {
      if (j === i) continue;
      if (recent[j].low < c.low) isLow = false;
      if (recent[j].high > c.high) isHigh = false;
    }
    if (isLow) swingLows.push({ time: c.time as number, price: c.low, rsi });
    if (isHigh) swingHighs.push({ time: c.time as number, price: c.high, rsi });
  }

  if (swingLows.length >= 2) {
    const l1 = swingLows[swingLows.length - 2];
    const l2 = swingLows[swingLows.length - 1];
    if (l2.price < l1.price && l2.rsi > l1.rsi + 0.2)
      return { type: "bullish", pivots: [l1, l2] };
  }
  if (swingHighs.length >= 2) {
    const h1 = swingHighs[swingHighs.length - 2];
    const h2 = swingHighs[swingHighs.length - 1];
    if (h2.price > h1.price && h2.rsi < h1.rsi - 0.2)
      return { type: "bearish", pivots: [h1, h2] };
  }
  return null;
}

// ── Utility: SMA / EMA overlay lines ──────────────────────────────────────

function calcSMALine(
  candles: CandleDataPoint[],
  period: number,
): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    result.push({ time: candles[i].time, value: +(sum / period).toFixed(2) });
  }
  return result;
}

function calcEMALine(
  candles: CandleDataPoint[],
  period: number,
): { time: number; value: number }[] {
  if (candles.length < period) return [];
  const closes = candles.map((c) => c.close);
  const out = emaArr(closes, period);
  const result: { time: number; value: number }[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    result.push({ time: candles[i].time, value: +out[i].toFixed(2) });
  }
  return result;
}

// Heikin Ashi — each bar's open/close smoothed against the running HA
// sequence rather than the raw candle, which is what gives it its
// characteristic smoother, trend-following look. High/low still anchor to
// the real wick extremes (widened to include the HA open/close) so it
// never clips through the actual price action.
function calcHeikinAshi(candles: CandleDataPoint[]): CandleDataPoint[] {
  const result: CandleDataPoint[] = [];
  let prevHaOpen = 0;
  let prevHaClose = 0;
  candles.forEach((c, i) => {
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0 ? (c.open + c.close) / 2 : (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    result.push({ ...c, open: haOpen, high: haHigh, low: haLow, close: haClose });
    prevHaOpen = haOpen;
    prevHaClose = haClose;
  });
  return result;
}

// ── Utility: EMA + MACD ────────────────────────────────────────────────────

function emaArr(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function calcMACD(
  candles: CandleDataPoint[],
  fast = 12,
  slow = 26,
  signal = 9,
) {
  const closes = candles.map((c) => c.close);
  const emaF = emaArr(closes, fast);
  const emaS = emaArr(closes, slow);

  const raw: number[] = [];
  const times: number[] = [];
  for (let i = slow - 1; i < candles.length; i++) {
    raw.push(emaF[i] - emaS[i]);
    times.push(candles[i].time);
  }

  const sig = emaArr(raw, signal);
  const macdLine: { time: number; value: number }[] = [];
  const signalLine: { time: number; value: number }[] = [];
  const histogram: { time: number; value: number; color: string }[] = [];

  for (let i = signal - 1; i < raw.length; i++) {
    const m = raw[i],
      s = sig[i],
      h = m - s;
    const prev = histogram[histogram.length - 1]?.value ?? h;
    const color =
      h >= 0
        ? h >= prev
          ? "rgba(74,222,128,0.85)"
          : "rgba(74,222,128,0.45)"
        : h <= prev
          ? "rgba(251,113,133,0.85)"
          : "rgba(251,113,133,0.45)";
    macdLine.push({ time: times[i], value: +m.toFixed(2) });
    signalLine.push({ time: times[i], value: +s.toFixed(2) });
    histogram.push({ time: times[i], value: +h.toFixed(2), color });
  }
  return { macdLine, signalLine, histogram };
}

// ── Utility: CME Gaps ─────────────────────────────────────────────────────

interface CMEGap {
  top: number;
  bottom: number;
  direction: "up" | "down";
}

function calcCMEGaps(candles: CandleDataPoint[]): CMEGap[] {
  const gaps: CMEGap[] = [];

  for (let i = 0; i < candles.length - 1; i++) {
    const date = new Date(candles[i].time * 1000);
    if (date.getUTCDay() !== 5) continue; // Only Friday candles

    // Find Monday within the next 3 candles
    let mondayIdx = -1;
    for (let j = i + 1; j < Math.min(i + 4, candles.length); j++) {
      if (new Date(candles[j].time * 1000).getUTCDay() === 1) {
        mondayIdx = j;
        break;
      }
    }
    if (mondayIdx === -1) continue;

    const fridayClose = candles[i].close;
    const mondayOpen = candles[mondayIdx].open;
    const gapPct = Math.abs(mondayOpen - fridayClose) / fridayClose;
    if (gapPct < 0.001) continue; // Skip gaps < 0.1%

    const isGapUp = mondayOpen > fridayClose;
    const top = Math.max(fridayClose, mondayOpen);
    const bottom = Math.min(fridayClose, mondayOpen);

    // Check if filled by any subsequent candle
    let filled = false;
    for (let j = mondayIdx + 1; j < candles.length; j++) {
      if (isGapUp ? candles[j].low <= bottom : candles[j].high >= top) {
        filled = true;
        break;
      }
    }

    if (!filled) {
      gaps.push({ top, bottom, direction: isGapUp ? "up" : "down" });
    }
  }

  return gaps;
}

// ── Interval analysis + candle pattern (unchanged) ─────────────────────────

interface IntervalAnalysis {
  sentiment: "bullish" | "bearish" | "neutral";
  title: string;
  body: string;
}

function analyzeInterval(
  candles: CandleDataPoint[],
  intervalLabel: string,
): IntervalAnalysis {
  if (candles.length < 5) {
    return {
      sentiment: "neutral",
      title: i18next.t("priceChart.banner.noData.title"),
      body: i18next.t("priceChart.banner.noData.body"),
    };
  }
  const first = candles[0],
    last = candles[candles.length - 1];
  const overallChange = (last.close - first.close) / first.close;
  const pct = (overallChange * 100).toFixed(2);
  const absPct = Math.abs(parseFloat(pct));
  const recent = candles.slice(-5);
  const greenCount = recent.filter((c) => c.close > c.open).length;
  const redCount = recent.filter((c) => c.close < c.open).length;
  const { upper, lower } = calcBollingerBands(candles);
  const topBand = upper[upper.length - 1]?.value;
  const botBand = lower[lower.length - 1]?.value;
  const bbPos =
    topBand && botBand && topBand !== botBand
      ? (last.close - botBand) / (topBand - botBand)
      : 0.5;
  const isBullish = overallChange > 0;
  const tb = (k: string) => ({
    title: i18next.t(`priceChart.banner.${k}.title`, { iv: intervalLabel }),
    body: i18next.t(`priceChart.banner.${k}.body`, { pct, absPct, green: greenCount, red: redCount }),
  });

  if (bbPos > 0.85)
    return { sentiment: "bullish", ...tb("upperBand") };
  if (bbPos < 0.15)
    return { sentiment: "bearish", ...tb("lowerBand") };
  if (greenCount >= 4)
    return { sentiment: "bullish", ...tb("strongBuying") };
  if (redCount >= 4)
    return { sentiment: "bearish", ...tb("sustainedSelling") };
  if (absPct < 0.3)
    return { sentiment: "neutral", ...tb("consolidation") };
  if (isBullish)
    return { sentiment: "bullish", ...tb("upwardBias") };
  return { sentiment: "bearish", ...tb("downwardBias") };
}

// ── AI pattern cache ────────────────────────────────────────────────────────
type PatternInsight = CandlePatternResult;

function patternCacheKey(coin: string, interval: string) {
  return `ai_pattern_${coin}_${interval}`;
}
function readPatternCache(
  coin: string,
  interval: string,
): { data: PatternInsight; at: number } | null {
  try {
    const r = localStorage.getItem(patternCacheKey(coin, interval));
    if (!r) return null;
    const parsed = JSON.parse(r);
    // Older cache entries (written before the "at" timestamp was added)
    // are a bare PatternInsight, not the {data,at} wrapper.
    if (parsed && typeof parsed === "object" && "data" in parsed && "at" in parsed) {
      return parsed as { data: PatternInsight; at: number };
    }
    return { data: parsed as PatternInsight, at: Date.now() };
  } catch {
    return null;
  }
}
function writePatternCache(
  coin: string,
  interval: string,
  data: PatternInsight,
) {
  try {
    localStorage.setItem(
      patternCacheKey(coin, interval),
      JSON.stringify({ data, at: Date.now() }),
    );
  } catch {}
}

// ── Chart candle cache ──────────────────────────────────────────────────────
// Last real candle set fetched for a coin/interval, persisted across page
// loads/refreshes. On the very first load there's no in-memory stale data
// to blur the way a coin switch has (see hasLoadedOnce) — this gives the
// first-load placeholder the user's own actual last-seen chart (real
// price scale and shape) instead of an arbitrary hardcoded sawtooth, so
// it reads as "the chart, blurred" rather than visibly fake numbers.
// Capped to the most recent 150 candles — plenty for a placeholder shape,
// far smaller than a full history for localStorage's quota.
function chartCandleCacheKey(coin: string, interval: string) {
  return `chart_candles_${coin}_${interval}`;
}
function readChartCandleCache(
  coin: string,
  interval: string,
): CandleDataPoint[] | null {
  try {
    const r = localStorage.getItem(chartCandleCacheKey(coin, interval));
    if (!r) return null;
    const parsed = JSON.parse(r);
    return Array.isArray(parsed) && parsed.length > 0
      ? (parsed as CandleDataPoint[])
      : null;
  } catch {
    return null;
  }
}
function writeChartCandleCache(
  coin: string,
  interval: string,
  data: CandleDataPoint[],
) {
  try {
    localStorage.setItem(
      chartCandleCacheKey(coin, interval),
      JSON.stringify(data.slice(-150)),
    );
  } catch {}
}

// ── Chart preferences (indicators/grid/candle style) ────────────────────────
// Global, not per-coin/interval (unlike the candle/pattern caches above) —
// these are display preferences the user set up once and expects every
// chart load to just remember, same as any other app setting.
const CHART_PREFS_KEY = "chart_prefs_v1";
interface ChartPrefs {
  showBB?: boolean;
  showRSI?: boolean;
  showMACD?: boolean;
  showEMA20?: boolean;
  showEMA50?: boolean;
  showEMA200?: boolean;
  showMA20?: boolean;
  showMA50?: boolean;
  showMA200?: boolean;
  showFib?: boolean;
  showSR?: boolean;
  showZones?: boolean;
  showDayHL?: boolean;
  showCME?: boolean;
  showGrid?: boolean;
  chartStyle?: ChartStyle;
}
// Each chart (Trade, Advance Chart, coin sheet) keeps its own copy under
// its own key, so a change on one never shows up on the others. None of
// them reads the old shared key (chart_prefs_v1) any more — it still held
// indicators switched on back when every chart shared one setting, which
// kept showing up on Trade. Each chart starts clean once, then remembers
// its own setup.
type ChartPrefsScope = "trade" | "advance" | "sheet";
const chartPrefsKey = (scope: ChartPrefsScope) => `${CHART_PREFS_KEY}:v2:${scope}`;
function readChartPrefs(scope: ChartPrefsScope): ChartPrefs {
  try {
    const r = localStorage.getItem(chartPrefsKey(scope));
    return r ? (JSON.parse(r) as ChartPrefs) : {};
  } catch {
    return {};
  }
}
function writeChartPrefs(scope: ChartPrefsScope, prefs: ChartPrefs) {
  try {
    localStorage.setItem(chartPrefsKey(scope), JSON.stringify(prefs));
  } catch {}
}

// ── Gann Pivot Detection ────────────────────────────────────────────────────

interface GannPivot {
  time: number;
  price: number;
  type: "high" | "low";
}

interface GannCycleDate {
  label: string;
  timestamp: number;
  isPast: boolean;
}

function detectGannPivots(candles: CandleDataPoint[], n: number): GannPivot[] {
  const pivots: GannPivot[] = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];
    let isHigh = true,
      isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) pivots.push({ time: c.time, price: c.high, type: "high" });
    if (isLow) pivots.push({ time: c.time, price: c.low, type: "low" });
  }
  return pivots;
}

// Gann time cycle offsets in seconds for different interval granularities
const GANN_CYCLE_OFFSETS: Record<string, { label: string; seconds: number }[]> =
  {
    daily: [
      { label: "30d", seconds: 30 * 86400 },
      { label: "45d", seconds: 45 * 86400 },
      { label: "60d", seconds: 60 * 86400 },
      { label: "90d", seconds: 90 * 86400 },
      { label: "120d", seconds: 120 * 86400 },
      { label: "144d", seconds: 144 * 86400 },
      { label: "180d", seconds: 180 * 86400 },
      { label: "270d", seconds: 270 * 86400 },
      { label: "360d", seconds: 360 * 86400 },
    ],
    hourly: [
      { label: "24h", seconds: 24 * 3600 },
      { label: "48h", seconds: 48 * 3600 },
      { label: "72h", seconds: 72 * 3600 },
      { label: "90h", seconds: 90 * 3600 },
      { label: "120h", seconds: 120 * 3600 },
      { label: "144h", seconds: 144 * 3600 },
      { label: "180h", seconds: 180 * 3600 },
    ],
    minutes: [
      { label: "4h", seconds: 4 * 3600 },
      { label: "8h", seconds: 8 * 3600 },
      { label: "12h", seconds: 12 * 3600 },
      { label: "24h", seconds: 24 * 3600 },
      { label: "48h", seconds: 48 * 3600 },
    ],
  };

function gannCycleGroup(interval: string): string {
  if (interval === "1day" || interval === "1week" || interval === "1month") return "daily";
  if (interval === "1h" || interval === "4h" || interval === "6h")
    return "hourly";
  return "minutes";
}

function computeGannCycles(
  lastPivot: GannPivot,
  interval: string,
): GannCycleDate[] {
  const now = Date.now() / 1000;
  const offsets = GANN_CYCLE_OFFSETS[gannCycleGroup(interval)];
  return offsets.map(({ label, seconds }) => {
    const timestamp = lastPivot.time + seconds;
    return { label, timestamp, isPast: timestamp < now };
  });
}

// Translated pattern text (priceChart.patterns.<key>.name/summary/narrative/nextMove).
function pat(key: string, type: PatternInsight["type"]): PatternInsight {
  const k = `priceChart.patterns.${key}`;
  return {
    name: i18next.t(`${k}.name`),
    type,
    summary: i18next.t(`${k}.summary`),
    narrative: i18next.t(`${k}.narrative`),
    nextMove: i18next.t(`${k}.nextMove`),
  };
}

// kept as instant fallback while AI loads
function detectCandlePattern(
  candles: CandleDataPoint[],
): PatternInsight | null {
  if (candles.length < 3) return null;
  const c0 = candles[candles.length - 1];
  const c1 = candles[candles.length - 2];
  const c2 = candles[candles.length - 3];
  const rng = (c: CandleDataPoint) => Math.max(c.high - c.low, 0.0001);
  const bod = (c: CandleDataPoint) => Math.abs(c.close - c.open);
  const upW = (c: CandleDataPoint) => c.high - Math.max(c.open, c.close);
  const loW = (c: CandleDataPoint) => Math.min(c.open, c.close) - c.low;
  const mid = (c: CandleDataPoint) => (c.open + c.close) / 2;
  const bull = (c: CandleDataPoint) => c.close > c.open;
  const bear = (c: CandleDataPoint) => c.close < c.open;

  if (
    bull(c2) &&
    bull(c1) &&
    bull(c0) &&
    c1.close > c2.close &&
    c0.close > c1.close &&
    bod(c2) / rng(c2) > 0.5 &&
    bod(c1) / rng(c1) > 0.5 &&
    bod(c0) / rng(c0) > 0.5
  )
    return pat("threeWhiteSoldiers", "bullish");
  if (
    bear(c2) &&
    bear(c1) &&
    bear(c0) &&
    c1.close < c2.close &&
    c0.close < c1.close &&
    bod(c2) / rng(c2) > 0.5 &&
    bod(c1) / rng(c1) > 0.5 &&
    bod(c0) / rng(c0) > 0.5
  )
    return pat("threeBlackCrows", "bearish");
  if (
    bear(c2) &&
    bod(c1) / rng(c1) < 0.35 &&
    bull(c0) &&
    c0.close > mid(c2) &&
    bod(c2) / rng(c2) > 0.4
  )
    return pat("morningStar", "bullish");
  if (
    bull(c2) &&
    bod(c1) / rng(c1) < 0.35 &&
    bear(c0) &&
    c0.close < mid(c2) &&
    bod(c2) / rng(c2) > 0.4
  )
    return pat("eveningStar", "bearish");
  if (bear(c1) && bull(c0) && c0.open < c1.close && c0.close > c1.open)
    return pat("bullishEngulfing", "bullish");
  if (bull(c1) && bear(c0) && c0.open > c1.close && c0.close < c1.open)
    return pat("bearishEngulfing", "bearish");
  if (bear(c1) && bull(c0) && c0.open < c1.low && c0.close > mid(c1))
    return pat("piercingLine", "bullish");
  if (bull(c1) && bear(c0) && c0.open > c1.high && c0.close < mid(c1))
    return pat("darkCloudCover", "bearish");
  if (
    bear(c1) &&
    bull(c0) &&
    c0.open > c1.close &&
    c0.close < c1.open &&
    bod(c1) > bod(c0) * 2
  )
    return pat("bullishHarami", "bullish");
  if (
    bull(c1) &&
    bear(c0) &&
    c0.open < c1.close &&
    c0.close > c1.open &&
    bod(c1) > bod(c0) * 2
  )
    return pat("bearishHarami", "bearish");

  const r0 = rng(c0),
    b0 = bod(c0),
    u0 = upW(c0),
    l0 = loW(c0);
  if (b0 / r0 < 0.06) {
    if (u0 / r0 > 0.6 && l0 / r0 < 0.1)
      return pat("gravestoneDoji", "bearish");
    if (l0 / r0 > 0.6 && u0 / r0 < 0.1)
      return pat("dragonflyDoji", "bullish");
    return pat("doji", "neutral");
  }
  if (b0 / r0 > 0.9) {
    if (bull(c0))
      return pat("bullishMarubozu", "bullish");
    return pat("bearishMarubozu", "bearish");
  }
  if (l0 / r0 >= 0.55 && u0 / r0 <= 0.15 && b0 / r0 <= 0.3) {
    const isDown =
      candles.length >= 5 && c0.close < candles[candles.length - 5].close;
    if (isDown)
      return pat("hammer", "bullish");
    return pat("hangingMan", "bearish");
  }
  if (u0 / r0 >= 0.55 && l0 / r0 <= 0.15 && b0 / r0 <= 0.3) {
    const isUp =
      candles.length >= 5 && c0.close > candles[candles.length - 5].close;
    if (isUp)
      return pat("shootingStar", "bearish");
    return pat("invertedHammer", "bullish");
  }
  if (c0.high < c1.high && c0.low > c1.low)
    return pat("insideBar", "neutral");
  if (candles.length >= 5) {
    const slice = candles.slice(-5);
    if (slice.every((c) => c.close > c.open))
      return pat("sustainedBullish", "bullish");
    if (slice.every((c) => c.close < c.open))
      return pat("sustainedBearish", "bearish");
  }
  return null;
}

// Most candle sequences don't match any of detectCandlePattern's named
// three-candle setups — that's normal, not a failure. Previously this just
// meant `null` all the way through, which read as "pattern-insight is
// broken" whenever the AI call on top of it was also unavailable (quota
// exhausted on a lower tier, or the call failed/is still pending): a paid
// user who'd already cleared the isPaid paywall gate got a blank gap
// instead of any analysis at all. This gives them the same trend read the
// interval banner already computed, in pattern-insight's own voice,
// instead of nothing — AI still overwrites it when it succeeds (see the
// getCandlePatternAnalysis call site), this is just what's always there
// underneath that.
function fallbackPatternInsight(
  bannerSentiment: "bullish" | "bearish" | "neutral" | null,
): PatternInsight {
  if (bannerSentiment === "bullish") {
    return pat("noPatternBullish", "bullish");
  }
  if (bannerSentiment === "bearish") {
    return pat("noPatternBearish", "bearish");
  }
  return pat("noClearPattern", "neutral");
}

// Applies overall-trend context so the pattern and banner never contradict.
// If the detected pattern is bullish but the interval is in a downtrend
// (or vice versa), the type is softened to "neutral" and the nextMove note
// is prefixed with a counter-trend warning.
function trendAwarePattern(
  candles: CandleDataPoint[],
  bannerSentiment: "bullish" | "bearish" | "neutral" | null,
): PatternInsight {
  const result = detectCandlePattern(candles);
  if (!result) return fallbackPatternInsight(bannerSentiment);
  if (!bannerSentiment || bannerSentiment === "neutral") return result;

  if (result.type === "bullish" && bannerSentiment === "bearish")
    return {
      ...result,
      type: "neutral",
      nextMove: i18next.t("priceChart.counterTrendBearish", { next: result.nextMove }),
    };
  if (result.type === "bearish" && bannerSentiment === "bullish")
    return {
      ...result,
      type: "neutral",
      nextMove: i18next.t("priceChart.counterTrendBullish", { next: result.nextMove }),
    };
  return result;
}

// A hardcoded placeholder chart drawn into the real candle/line/volume
// series on first page load/refresh only (see hasLoadedOnce) — there's no
// real stale data yet to blur the way a later coin/interval switch has,
// so this fills the canvas with a plausible-looking shape purely so
// there's something present to blur instead of an empty box. Gets
// overwritten by redrawCandleSeries(data) the instant the real fetch
// resolves.
function makeFakeFirstLoadCandles(): CandleDataPoint[] {
  const closes = [
    100, 102, 101, 104, 103, 106, 105, 108, 107, 110, 109, 112, 111, 114, 113,
    116, 115, 118, 117, 120, 119, 122, 121, 124, 123, 126, 125, 128, 127, 130,
  ];
  const now = Math.floor(Date.now() / 1000);
  const step = 3600;
  return closes.map((close, i) => {
    const open = i === 0 ? close - 1 : closes[i - 1];
    const high = Math.max(open, close) + 1;
    const low = Math.min(open, close) - 1;
    return {
      time: now - (closes.length - i) * step,
      open,
      high,
      low,
      close,
      volume: 50 + ((i * 37) % 60),
    };
  });
}


// ── Component ──────────────────────────────────────────────────────────────

export const PriceChart: React.FC<PriceChartProps> = ({
  refreshTrigger,
  theme = "dark",
  coin = "BTC",
  quoteVolume24h,
  onZoneChange,
  onOpenAuth,
  onOpenUpgrade = () => {},
  onOpenCoinPicker,
  onSelectCoin,
  onFullscreenChange,
  coinChatOpen,
  onToggleCoinChat,
  pageMode,
  prefsScope: prefsScopeProp,
  onNavigateToPage,
  onOpenDrawingTools,
  onOpenPaperTrade,
  onNavigateBack,
  requestInterval,
  onIntervalChange,
  requestChartStyle,
  onChartStyleChange,
  forceHideIndicators,
  forceHideHeader,
  onChartEventsChange,
  children,
  sideColumn,
  headerStats,
  pageTabBar,
  pageTabContent,
}) => {
  const prefsScope: ChartPrefsScope = prefsScopeProp ?? (pageMode ? "advance" : "trade");
  const { t, i18n } = useTranslation();
  const { exceeded, consume, isPaid } = useAIQuota();
  // AI chart read (trend + pattern card under the chart) is on request:
  // hidden behind an "Analyze" button until asked for. Stays open across
  // coin/interval switches for the session once opened.
  const [aiReadOpen, setAiReadOpen] = useState(false);
  const aiReadOpenRef = useRef(false);
  aiReadOpenRef.current = aiReadOpen;
  // Latest-closure ref so the chart load effect always calls the current
  // coin/interval/quota version.
  const runPatternAIRef = useRef<(candles: CandleDataPoint[]) => void>(() => {});
  runPatternAIRef.current = (candles: CandleDataPoint[]) => {
    if (!isPaid || exceeded || candles.length === 0) return;
    const c = coin;
    const iv = interval;
    consume().then((ok) => {
      if (!ok) return;
      getCandlePatternAnalysis(c, iv, candles).then((res) => {
        if (res.success && res.result) {
          setPatternInsight(res.result);
          setPatternInsightAt(Date.now());
          writePatternCache(c, iv, res.result);
        }
      });
    });
  };
  const openAiRead = () => {
    setAiReadOpen(true);
    // Skip the AI call if this coin+interval already has a cached result.
    if (!readPatternCache(coin, interval)) runPatternAIRef.current(lastCandlesRef.current);
  };
  const isLight = theme === "light";

  const [interval, setInterval] = useState<TimeInterval>("1day");
  // Active range preset (bar under the chart). Only counts while the chart
  // is still on that preset's interval — picking another interval anywhere
  // else silently drops it back to that interval's normal default window.
  const [rangePreset, setRangePreset] = useState<string | null>(null);
  // Stays active across interval changes while it fits that candle size
  // (rangeFitsInterval); otherwise the interval's own default window.
  const activeRangePreset = RANGE_PRESETS.find((p) => p.key === rangePreset && rangeFitsInterval(p.seconds, interval)) ?? null;
  const rangeSecondsRef = useRef<{ interval: TimeInterval; seconds: number } | null>(null);
  rangeSecondsRef.current = activeRangePreset ? { interval, seconds: activeRangePreset.seconds } : null;
  // A range that doesn't fit the newly picked interval is dropped for good
  // (not silently revived if the user later switches back).
  useEffect(() => {
    if (rangePreset && !activeRangePreset) setRangePreset(null);
  }, [rangePreset, activeRangePreset]);
  // "1 year in 4H candles" — the preset's own tip only matches its own
  // default interval.
  const activeRangeDesc = activeRangePreset
    ? (activeRangePreset.interval === interval ? t(`chartBar.rangeTip.${activeRangePreset.key}`, activeRangePreset.tip) : t("priceChart.rangeInCandles", { range: activeRangePreset.label, iv: INTERVAL_SHORT[interval] }))
    : null;
  // Visible window for a fresh view: the active preset's span if any,
  // otherwise the interval's own default.
  const viewWindowFor = (iv: TimeInterval) =>
    rangeSecondsRef.current?.interval === iv ? rangeSecondsRef.current.seconds : INTERVAL_WINDOW[iv];
  // "Go to" dialog (calendar button in the range bar). A custom range that
  // needs a different interval is parked here and applied by the normal
  // load path once that interval's candles arrive.
  const [goToOpen, setGoToOpen] = useState(false);
  // Price scale toggles (right end of the range bar): % / log are mutually
  // exclusive modes (both off = normal), auto = price axis auto-fits the
  // visible candles. Persisted.
  const [scaleMode, setScaleMode] = useState<"normal" | "percent" | "log">(() => {
    try {
      // Own key per chart (Trade / Advance / sheet), no shared fallback.
      const v = localStorage.getItem(`chartScaleMode:v2:${prefsScope}`);
      return v === "percent" || v === "log" ? v : "normal";
    } catch { return "normal"; }
  });
  const [autoScale, setAutoScale] = useState(true);
  useEffect(() => {
    try { localStorage.setItem(`chartScaleMode:v2:${prefsScope}`, scaleMode); } catch { /* ignore */ }
  }, [scaleMode]);
  const pendingRangeRef = useRef<{ interval: TimeInterval; from: number; to: number } | null>(null);
  // Mobile "Date Range" picker: our own BottomSheet everywhere, iOS app
  // included (the native iOS action sheet ignored the app's theme).
  const [dateRangeSheetOpen, setDateRangeSheetOpen] = useState(false);
  const [statsSheetOpen, setStatsSheetOpen] = useState(false);
  const openDateRangeSheet = () => {
    setDateRangeSheetOpen(true);
  };
  // Range preset (1h…1y): switch the candle interval and zoom to that span.
  const applyRangePreset = (p: (typeof RANGE_PRESETS)[number]) => {
    setRangePreset(p.key);
    if (interval === p.interval) {
      // Same interval — no reload coming, so zoom right now.
      const candles = lastCandlesRef.current;
      if (candles.length) {
        const to = candles[candles.length - 1].time as number;
        chartRef.current?.timeScale().setVisibleRange({
          from: (to - p.seconds) as UTCTimestamp,
          to: to as UTCTimestamp,
        });
      }
    } else {
      // Different interval — the normal load path applies the preset's
      // window via viewWindowFor() on first load for the new interval.
      rangeSecondsRef.current = { interval: p.interval, seconds: p.seconds };
      setInterval(p.interval);
    }
  };
  const fmtDay = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  // Jump to one moment, keeping the current zoom level. Returns an error
  // message instead when it's older than what this interval has loaded.
  const goToDate = (ts: number): string | null => {
    const candles = lastCandlesRef.current;
    const ts0 = chartRef.current?.timeScale();
    if (!candles.length || !ts0) return t("priceChart.goTo.notLoaded");
    const first = candles[0].time as number;
    const last = candles[candles.length - 1].time as number;
    if (ts < first) {
      return t("priceChart.goTo.tooOldLong", { date: fmtDay(first) });
    }
    const vr = ts0.getVisibleRange();
    const span = vr ? (vr.to as number) - (vr.from as number) : (INTERVAL_WINDOW[interval] ?? 7 * 86400);
    let from = ts - span / 2;
    let to = ts + span / 2;
    if (to > last) { from -= to - last; to = last; }
    setRangePreset(null);
    ts0.setVisibleRange({ from: Math.max(from, first) as UTCTimestamp, to: to as UTCTimestamp });
    return null;
  };
  // Show exactly from → to, picking a candle size that fits the span.
  const goToRange = (from: number, to: number): string | null => {
    const span = to - from;
    const iv: TimeInterval =
      span <= 6 * 3600 ? "5min"
      : span <= 2 * 86400 ? "15min"
      : span <= 10 * 86400 ? "1h"
      : span <= 60 * 86400 ? "4h"
      : span <= 2 * 365 * 86400 ? "1day"
      : "1week";
    setRangePreset(null);
    if (iv === interval) {
      const candles = lastCandlesRef.current;
      if (!candles.length) return t("priceChart.goTo.notLoaded");
      const first = candles[0].time as number;
      const last = candles[candles.length - 1].time as number;
      if (to < first) return t("priceChart.goTo.tooOld", { date: fmtDay(first) });
      chartRef.current?.timeScale().setVisibleRange({
        from: Math.max(from, first) as UTCTimestamp,
        to: Math.min(to, last) as UTCTimestamp,
      });
      return null;
    }
    pendingRangeRef.current = { interval: iv, from, to };
    setInterval(iv);
    return null;
  };
  useEffect(() => {
    if (requestInterval && requestInterval !== interval) setInterval(requestInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestInterval]);
  useEffect(() => {
    onIntervalChange?.(interval);
  }, [interval, onIntervalChange]);
  const [loading, setLoading] = useState(true);
  // True once the very first fetch has completed — distinguishes "first
  // page load/refresh" (nothing real to blur yet, so placeholder content
  // fills in below) from a later coin/interval switch (real stale content
  // already exists and blurs in place instead).
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  // coin/interval the last fetch actually ran for — lets the fetch effect
  // tell a real coin/interval switch (the user did something, blur-in-
  // place is the right feedback) apart from a same-coin/interval refresh
  // (refreshTrigger alone changed, the user did nothing — this should be
  // silent). Without this, every 30s background refresh (App.tsx's own
  // setInterval(fetchBTCData, 30000), unrelated to whichever chart
  // interval is selected) re-blurred the whole chart/stats for its full
  // fetch+recompute+redraw duration, which read as a freeze.
  const lastLoadedKeyRef = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [trends, setTrends] = useState<IntervalTrends>({});
  const [banner, setBanner] = useState<IntervalAnalysis | null>(null);
  const [bannerAt, setBannerAt] = useState<number | null>(null);
  const [zone, setZone] = useState<ZoneResult | null>(null);
  const [patternInsight, setPatternInsight] = useState<PatternInsight | null>(
    () => readPatternCache(coin, "1h")?.data ?? null,
  );
  const [patternInsightAt, setPatternInsightAt] = useState<number | null>(
    () => readPatternCache(coin, "1h")?.at ?? null,
  );
  // Lazy-initialized from localStorage (readChartPrefs, above) once per
  // mount — indicator/grid/candle-style choices persist across page loads
  // instead of resetting to off/"line" every time.
  const [showBB, setShowBB] = useState(() => readChartPrefs(prefsScope).showBB ?? false);
  const [showRSI, setShowRSI] = useState(() => readChartPrefs(prefsScope).showRSI ?? false);
  const [showMACD, setShowMACD] = useState(() => readChartPrefs(prefsScope).showMACD ?? false);
  const [showEMA20, setShowEMA20] = useState(() => readChartPrefs(prefsScope).showEMA20 ?? false);
  const [showEMA50, setShowEMA50] = useState(() => readChartPrefs(prefsScope).showEMA50 ?? false);
  const [showEMA200, setShowEMA200] = useState(() => readChartPrefs(prefsScope).showEMA200 ?? false);
  const [showMA20, setShowMA20] = useState(() => readChartPrefs(prefsScope).showMA20 ?? false);
  const [showMA50, setShowMA50] = useState(() => readChartPrefs(prefsScope).showMA50 ?? false);
  const [showMA200, setShowMA200] = useState(() => readChartPrefs(prefsScope).showMA200 ?? false);
  // setShowGann dropped — nothing can turn this on while the Gann Pivots
  // checkbox is commented out of the indicators menu above (user request);
  // restoring that checkbox should also restore the setter here.
  const [showGann] = useState(false);
  const [showFib, setShowFib] = useState(() => readChartPrefs(prefsScope).showFib ?? false);
  const [showSR, setShowSR] = useState(() => readChartPrefs(prefsScope).showSR ?? false);
  const [showZones, setShowZones] = useState(() => readChartPrefs(prefsScope).showZones ?? false);
  const [showDayHL, setShowDayHL] = useState(() => readChartPrefs(prefsScope).showDayHL ?? false);
  useEffect(() => {
    if (!forceHideIndicators) return;
    setShowBB(false); setShowRSI(false); setShowMACD(false);
    setShowEMA20(false); setShowEMA50(false); setShowEMA200(false);
    setShowMA20(false); setShowMA50(false); setShowMA200(false);
    setShowFib(false); setShowSR(false);
    setShowZones(false); setShowDayHL(false); setShowCME(false);
    setShowGrid(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceHideIndicators]);
  const [srLevels, setSrLevels] = useState<{ resistance: { price: number }[]; support: { price: number }[] }>({ resistance: [], support: [] });
  const [gannCycles, setGannCycles] = useState<GannCycleDate[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  // Mobile: one "Show Tools" button opens every chart tool in a sheet.
  const [toolsSheetOpen, setToolsSheetOpen] = useState(false);
  // Desktop's Indicators/Chart style dropdowns portal to document.body
  // (like the mobile sheets already do) instead of position:absolute
  // inside the component tree — an ancestor (.main-content) has
  // overflow-x:hidden, which was clipping/hiding part of the dropdown
  // behind the side nav regardless of z-index, since overflow clipping
  // isn't something z-index can escape. Position is computed from the
  // trigger button's own rect on open.
  const indicatorsBtnRef = useRef<HTMLButtonElement>(null);
  const styleBtnRef = useRef<HTMLButtonElement>(null);
  const [indicatorsMenuPos, setIndicatorsMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [styleMenuPos, setStyleMenuPos] = useState<{ top: number; left: number } | null>(null);
  // Desktop's Interval button opens the same kind of dropdown as
  // Indicators/Chart style instead of the mobile bottom sheet, for
  // consistency across the three.
  const [intervalMenuOpen, setIntervalMenuOpen] = useState(false);
  const intervalBtnRef = useRef<HTMLButtonElement>(null);
  const [intervalMenuPos, setIntervalMenuPos] = useState<{ top: number; left: number } | null>(null);
  // CME gaps no longer exist — kept off (ignores old saved prefs); no menu entry.
  const [showCME, setShowCME] = useState(false);
  const [, setIsLive] = useState(false);
  const [dayHigh, setDayHigh] = useState<number | null>(null);
  const [dayLow, setDayLow] = useState<number | null>(null);
  const [bidPrice, setBidPrice] = useState<number | null>(null);
  const [askPrice, setAskPrice] = useState<number | null>(null);
  const [baseVolume24h, setBaseVolume24h] = useState<number | null>(null);
  const [dayChangePercent, setDayChangePercent] = useState<number | null>(null);
  const [dayChangeAbs, setDayChangeAbs] = useState<number | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [priceDirection, setPriceDirection] = useState<"up" | "down" | null>(null);
  const prevPriceRef = useRef<number | null>(null);
  const updateCurrentPrice = useCallback((price: number) => {
    const prev = prevPriceRef.current;
    if (prev !== null && price !== prev) {
      setPriceDirection(price > prev ? "up" : "down");
    }
    prevPriceRef.current = price;
    setCurrentPrice(price);
  }, []);
  const [intervalSheetOpen, setIntervalSheetOpen] = useState(false);
  const [patternInsightSheetOpen, setPatternInsightSheetOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dayLineRefs = useRef<any[]>([]);

  const [showDepthProfile, setShowDepthProfile] = useState(false);
  // Manual toggle — defaults on for the Advance Price Chart page
  // (pageMode), off everywhere else (compact view, desktop fullscreen).
  // Advance Price Chart page — always starts with grid on, regardless of
  // the shared saved preference other chart instances read/write (a user
  // who turned grid off elsewhere shouldn't land here with it off too;
  // they can still toggle it back off here if they want, same as always).
  // Grid on by default for the Advance page and the desktop chart page's
  // TradingView view (CMC look); elsewhere the saved preference.
  // Desktop chart page: always on (no toggle there any more).
  const [showGrid, setShowGrid] = useState(() =>
    // Chart page (desktop and phones) and Advance Chart: grid on by default.
    pageMode || prefsScope === "trade"
      ? true
      : !!(readChartPrefs(prefsScope).showGrid ?? false));
  // Desktop #trade: Price / Market cap switch above the chart.
  const [chartMetric, setChartMetric] = useState<"price" | "mcap">("price");
  // CoinMarketCap-style chart: line (default) or our candle chart
  // ("TradingView" button, where ProVision lives); range + Log for the line.
  // Phones keep their own choice and default to candles (CMC's app does).
  const cmcStyleKey = window.matchMedia("(min-width: 641px)").matches ? "cmcChartStyle" : "cmcChartStyleM";
  const [cmcStyle, setCmcStyleState] = useState<"line" | "candles">(() => {
    try {
      const v = localStorage.getItem(cmcStyleKey);
      return v === "candles" || v === "line" ? v : cmcStyleKey === "cmcChartStyleM" ? "candles" : "line";
    } catch { return "line"; }
  });
  const setCmcStyle = (s: "line" | "candles") => {
    setCmcStyleState(s);
    try { localStorage.setItem(cmcStyleKey, s); } catch { /* ignore */ }
  };
  const [cmcRange, setCmcRange] = useState<CmcRange>("1");
  const [cmcLog, setCmcLog] = useState(false);
  // Desktop chart page: the AI Chart Read card stays hidden until the
  // chart's "Analyze Chart" button asks for it.
  const [aiCtaOn, setAiCtaOn] = useState(false);
  // TradingView-view toolbar menus: "int" = more intervals, "set" = settings.
  const [tvMenu, setTvMenu] = useState<null | "int" | "set">(null);
  // Phones, chart page: last tap on the chart (double-tap → Advance Chart).
  const phoneTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  // Phones, chart page: an interval picked outside the visible row (e.g. 5m
  // from Chart tools) takes the row's last slot until another one is picked.
  const [phoneExtraIv, setPhoneExtraIv] = useState<TimeInterval | null>(null);
  // Phones, chart page: the header price row, and whether it's scrolled away.
  const cmchPriceRef = useRef<HTMLDivElement>(null);
  const [priceOff, setPriceOff] = useState(false);
  useEffect(() => {
    if (!PHONE_IVS.slice(0, -1).includes(interval)) setPhoneExtraIv(interval === PHONE_IVS[PHONE_IVS.length - 1] ? null : interval);
  }, [interval]);
  // Desktop interval bar: 3 fixed intervals, then a 4th slot that is the
  // interval selector — it shows (and keeps) whatever was picked from it.
  const [deskIv4, setDeskIv4] = useState<TimeInterval>(TV_MAIN_INTERVALS[3]);
  useEffect(() => {
    if (!TV_MAIN_INTERVALS.slice(0, 3).includes(interval)) setDeskIv4(interval);
  }, [interval]);
  // "candle" default for a first-ever visit — reference-match request —
  // otherwise whatever the user last picked (readChartPrefs).
  // Default style: Line on phones, candles on desktop (a saved choice wins).
  const [chartStyle, setChartStyle] = useState<ChartStyle>(() => {
    // Desktop chart page (TradingView view): always opens on Candle.
    if (prefsScope === "trade" && !pageMode && window.matchMedia("(min-width: 641px)").matches) return "candle";
    // Phone chart page: candles unless the user picked another style.
    if (prefsScope === "trade" && !pageMode) return readChartPrefs(prefsScope).chartStyle ?? "candle";
    return readChartPrefs(prefsScope).chartStyle ?? (window.matchMedia("(min-width: 901px)").matches ? "candle" : "line");
  });
  useEffect(() => {
    if (requestChartStyle && requestChartStyle !== chartStyle) setChartStyle(requestChartStyle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestChartStyle]);
  useEffect(() => {
    onChartStyleChange?.(chartStyle);
  }, [chartStyle, onChartStyleChange]);
  // Persist indicator/grid/candle-style choices to localStorage on every
  // change — the matching lazy useState initializers above (readChartPrefs)
  // are what actually restores them on the next mount/page load.
  useEffect(() => {
    writeChartPrefs(prefsScope, {
      showBB, showRSI, showMACD,
      showEMA20, showEMA50, showEMA200,
      showMA20, showMA50, showMA200,
      showFib, showSR, showZones, showDayHL, showCME,
      showGrid, chartStyle,
    });
  }, [showBB, showRSI, showMACD, showEMA20, showEMA50, showEMA200, showMA20, showMA50, showMA200, showFib, showSR, showZones, showDayHL, showCME, showGrid, chartStyle]);
  // Line-style color — green/red when the visible window has moved
  // meaningfully in one direction, blue when it's basically flat. Recomputed
  // in redrawCandleSeries alongside the line data itself, from the same
  // candles array, so it always matches whatever's actually on screen.
  const [lineTrendColor, setLineTrendColor] = useState("#818cf8");
  // Bumped every time the chart instance itself is recreated (theme/grid/
  // fullscreen change calls createChart() again) — a real, guaranteed-to-
  // differ signal for LineDotFillOverlay to resubscribe/repaint against
  // the new instance, independent of whether lineTrendColor happens to
  // compute to the same value as before (a same-value setState is a no-op
  // in React, so color alone isn't a reliable trigger here).
  const [chartGeneration, setChartGeneration] = useState(0);
  // True while lastCandlesRef holds the first-load placeholder candles.
  const placeholderCandlesRef = useRef(false);
  // Mirrors chartStyle for the fetch effect to read without depending on
  // it directly (same ref-mirror pattern as showFibRef) — switching style
  // should redraw from already-fetched data, not re-fetch candles.
  const chartStyleRef = useRef<ChartStyle>("candle");
  const [showAstroChart, setShowAstroChart] = useState(false);
  // Native iOS, or desktop web (not mobile web — the regular chart is
  // already compact enough there) — a full-screen, minimal price + live
  // trade-tick view (see CompactPriceView.tsx), toggled on top of the
  // full chart rather than replacing it. Same min-width:641px breakpoint
  // App.tsx's own isDesktopWidth uses.
  const [showCompactView, setShowCompactView] = useState(false);
  // Compact View shows one fixed live line, not a real per-interval
  // chart — changing the interval while it's up implies the user wants
  // the real candlestick chart at that interval, so switch back to Full
  // immediately instead of leaving them on a view the new interval
  // doesn't actually affect.
  useEffect(() => { setShowCompactView(false); }, [interval]);
  // Desktop #chart hero row's coin icon — real per-coin logo (same
  // CoinCap image CompactPriceView's own header already uses) instead of
  // the generic colored-letter circle every other icon spot here still
  // uses, falling back to that same letter circle if the image 404s.
  const [heroLogoError, setHeroLogoError] = useState(false);
  useEffect(() => setHeroLogoError(false), [coin]);
  const [isDesktopWidth, setIsDesktopWidth] = useState(() => window.matchMedia("(min-width: 641px)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 641px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktopWidth(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  // Mobile never shows the grid or any overlay indicator — there's no
  // toggle UI for them there (gridToggleButton/indicatorsControl stay
  // desktop-only, chart-hero-icon-row), so a value persisted from
  // earlier desktop use (readChartPrefs' localStorage) would otherwise
  // be stuck permanently visible on a phone with no way to turn it back
  // off. Forces them off instead of adding more mobile toggle UI.
  useEffect(() => {
    // pageMode (Advance Chart) excluded — that page defaults showGrid to
    // true on purpose (see its own useState initializer above) regardless
    // of width, a different page this complaint isn't about.
    if (isDesktopWidth || pageMode) return;
    // Phone chart page keeps its grid (CMC/TradingView look).
    setShowGrid(prefsScope === "trade");
    setShowBB(false);
    setShowRSI(false);
    setShowMACD(false);
    setShowEMA20(false);
    setShowEMA50(false);
    setShowEMA200(false);
    setShowMA20(false);
    setShowMA50(false);
    setShowMA200(false);
    setShowFib(false);
    setShowSR(false);
    setShowZones(false);
    setShowDayHL(false);
    setShowCME(false);
  }, [isDesktopWidth]);
  const chartSectionRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(() => !!pageMode);
  // #trade chart (phones + desktop, outside fullscreen): candle type and
  // ProVision only — no indicators, grid, depth profile or volume. Anything
  // switched on in fullscreen is cleared again when fullscreen closes.
  const tradeChartLocked = prefsScope === "trade" && !pageMode && !isFullscreen;
  // Pan / zoom / axis-drag: fullscreen everywhere, and always on the
  // desktop chart page.
  // Desktop and phone chart page: drag to pan, pinch / wheel to zoom.
  const chartInteractive = isFullscreen || (prefsScope === "trade" && !pageMode);
  // Phones (not fullscreen): vertical swipes keep scrolling the page.
  const chartVertDrag = chartInteractive && (isDesktopWidth || isFullscreen);
  // Desktop chart page: volume is back as a light band along the bottom,
  // colored like the candles; phones keep the trade chart candles-only.
  const faintVolRef = useRef(false);
  faintVolRef.current = prefsScope === "trade" && !pageMode && isDesktopWidth;
  // Desktop: the candles' TradingView green/red, light (background band).
  const volColor = (up: boolean) =>
    faintVolRef.current
      ? up ? "rgba(8,153,129,0.32)" : "rgba(242,54,69,0.32)"
      : up ? "rgba(74,222,128,0.45)" : "rgba(251,113,133,0.45)";
  // Section tabs (News, Technicals… and Market cap): remember how tall the
  // chart view is and keep at least that height on the other tabs, so the
  // page below doesn't jump. Not a fixed height — longer content still grows.
  const [overviewH, setOverviewH] = useState(0);
  useEffect(() => {
    const el = chartSectionRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Measures the main column only (.pcc-main), so the table below it
    // (children) keeps the same position on every tab.
    const ro = new ResizeObserver(() => {
      if (el.classList.contains("price-chart-container--ctab") || el.classList.contains("price-chart-container--fs")) return;
      const main = el.querySelector<HTMLElement>(":scope > .pcc-main");
      const h = main ? Math.round(main.getBoundingClientRect().height) : 0;
      if (h > 0) setOverviewH((prev) => (Math.abs(prev - h) > 2 ? h : prev));
    });
    ro.observe(el);
    const main = el.querySelector<HTMLElement>(":scope > .pcc-main");
    if (main) ro.observe(main);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    // Desktop keeps the user's indicators (Indicators button) and its grid;
    // the lock (everything off) is phones-only now.
    if (!tradeChartLocked || isDesktopWidth) return;
    setShowGrid(prefsScope === "trade" && !pageMode);
    setShowBB(false);
    setShowRSI(false);
    setShowMACD(false);
    setShowEMA20(false);
    setShowEMA50(false);
    setShowEMA200(false);
    setShowMA20(false);
    setShowMA50(false);
    setShowMA200(false);
    setShowFib(false);
    setShowSR(false);
    setShowZones(false);
    setShowDayHL(false);
    setShowCME(false);
    setShowDepthProfile(false);
  }, [tradeChartLocked]);
  useEffect(() => {
    onFullscreenChange?.(isFullscreen);
  }, [isFullscreen, onFullscreenChange]);
  // Fullscreen "Minimal Header" layout — High/Low/Vol/Signal collapse
  // into one tappable strip inline in the header (unchanged from the
  // original design), expanding in place to show Bid/Ask/Vol-coin/
  // Signal meter/Divergence meter. Starts expanded by default on desktop
  // (room to spare) but collapsed on mobile — either way, still a toggle
  // the user can collapse/expand themselves, not forced open. Reference-
  // match (TradingView desktop chart) exception: the Advance Chart page
  // starts collapsed too, tucked away behind the same chevron instead of
  // cluttering the clean reference look by default.
  const [fsStatsExpanded, setFsStatsExpanded] = useState(isDesktopWidth && !pageMode);
  useEffect(() => {
    if (!isFullscreen) setFsStatsExpanded(isDesktopWidth);
  }, [isFullscreen, isDesktopWidth]);
  // Fullscreen's persistent docked bottom sheet — options only (Style,
  // Indicators, Interval). The peek bar stays visible at all times; it
  // never fully disappears, only grows/shrinks. The sheet itself starts
  // collapsed (peek only) as before — only once the user expands it,
  // Style is the category that's already open, instead of none.
  const [fsSheetExpanded, setFsSheetExpanded] = useState(false);
  // Advance Price Chart page, mobile only — the floating drawing toolbox.
  // Hidden by default (this is only ever read when pageMode, so the
  // default is harmless elsewhere) — the full chart gets the full width
  // first; the "Toolbox" segment in the dock turns it on if wanted.
  const [fsDrawPanelOpen, setFsDrawPanelOpen] = useState(false);
  // Arriving from the Trade page's "Drawing tools" row: open the panel.
  // Flag covers a fresh mount; the event covers an already-mounted page.
  useEffect(() => {
    if (!pageMode) return;
    const open = () => {
      try { sessionStorage.removeItem("pcOpenDrawPanel"); } catch { /* ignore */ }
      setFsDrawPanelOpen(true);
    };
    try { if (sessionStorage.getItem("pcOpenDrawPanel") === "1") open(); } catch { /* ignore */ }
    window.addEventListener("pc-open-draw-panel", open);
    return () => window.removeEventListener("pc-open-draw-panel", open);
  }, [pageMode]);
  const [fsOpenCategories, setFsOpenCategories] = useState<Record<string, boolean>>({ overview: true });
  // Advance chart, mobile: the dock sheet shows every section at once in
  // the Chart tools layout (section labels, rows, chips) — no accordion.
  const fsDockFlat = !!pageMode && !isDesktopWidth;
  // Advance chart bottom bar: ƒx opens its own Indicators menu.
  const [indSheetOpen, setIndSheetOpen] = useState(false);
  // Indicators list sheet, opened from the Chart tools sheet.
  const [toolsIndOpen, setToolsIndOpen] = useState(false);
  // Advance chart (mobile): the top-right Menu's dropdown (Reset / Save / Close).
  const [advMenuOpen, setAdvMenuOpen] = useState(false);
  // Custom date range picker sits below the sheet — close the sheet so
  // it's visible when picked from the sheet's Date range row.
  useEffect(() => {
    if (fsDockFlat && goToOpen) setFsSheetExpanded(false);
  }, [fsDockFlat, goToOpen]);
  // Advance chart (mobile): iOS-style swipe from the left screen edge to go
  // back. Page (and its docked bottom panel) follow the finger; past ~30%
  // of the width or a quick flick it slides off and leaves the page.
  const edgeBackRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!(pageMode && !isDesktopWidth)) return;
    let st: { x: number; y: number; t: number; decided: boolean; active: boolean } | null = null;
    const els = () => [chartSectionRef.current, fsDockRef.current].filter(Boolean) as HTMLElement[];
    const settle = (go: boolean) => {
      els().forEach((el) => {
        el.style.transition = "transform 0.22s ease";
        el.style.transform = go ? `translateX(${window.innerWidth}px)` : "";
      });
      window.setTimeout(() => {
        els().forEach((el) => { el.style.transition = ""; el.style.transform = ""; el.style.boxShadow = ""; });
        if (go) edgeBackRef.current();
      }, go ? 200 : 230);
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > 18) return;
      // Not from the drawing rail or from inside an open sheet.
      if ((e.target as Element | null)?.closest?.(".cdt-toolbar, .mss-backdrop, .bs-backdrop, .interval-sheet")) return;
      st = { x: t.clientX, y: t.clientY, t: Date.now(), decided: false, active: false };
    };
    const onMove = (e: TouchEvent) => {
      if (!st) return;
      const t = e.touches[0];
      const dx = t.clientX - st.x;
      const dy = t.clientY - st.y;
      if (!st.decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        st.decided = true;
        st.active = dx > 0 && Math.abs(dx) > Math.abs(dy);
        if (!st.active) { st = null; return; }
        els().forEach((el) => { el.style.transition = "none"; el.style.boxShadow = "-12px 0 28px rgba(0,0,0,0.25)"; });
      }
      // Ours now — keep the chart from panning under the gesture.
      e.preventDefault();
      e.stopPropagation();
      const x = Math.max(0, dx);
      els().forEach((el) => { el.style.transform = `translateX(${x}px)`; });
    };
    const onEnd = (e: TouchEvent) => {
      if (!st) return;
      const s = st;
      st = null;
      if (!s.active) return;
      const t = e.changedTouches[0];
      const dx = t ? t.clientX - s.x : 0;
      const v = dx / Math.max(1, Date.now() - s.t);
      const go = dx > window.innerWidth * 0.3 || (v > 0.6 && dx > 40);
      if (go) hapticTap();
      settle(go);
    };
    document.addEventListener("touchstart", onStart, { capture: true, passive: true });
    document.addEventListener("touchmove", onMove, { capture: true, passive: false });
    document.addEventListener("touchend", onEnd, { capture: true });
    document.addEventListener("touchcancel", onEnd, { capture: true });
    return () => {
      document.removeEventListener("touchstart", onStart, { capture: true } as EventListenerOptions);
      document.removeEventListener("touchmove", onMove, { capture: true } as EventListenerOptions);
      document.removeEventListener("touchend", onEnd, { capture: true } as EventListenerOptions);
      document.removeEventListener("touchcancel", onEnd, { capture: true } as EventListenerOptions);
    };
  }, [pageMode, isDesktopWidth]);
  // Accordion — only one category open at a time; expanding one collapses
  // whichever other was open instead of stacking them all open at once.
  const toggleFsCategory = useCallback((key: string) => {
    setFsOpenCategories((prev) => (prev[key] ? {} : { [key]: true }));
  }, []);
  // No longer set by anything in the peek row — kept for the handle's
  // manual full-accordion expand/collapse, which always resets this to
  // null so the full category list shows.
  const [fsFocusedCategory, setFsFocusedCategory] = useState<string | null>(null);
  // Advance Price Chart page, mobile — "Option E" hero-card carousel in
  // the peek row: which of the content categories (Technicals/Key stats/
  // Overview/About/Stats) is currently showing, swiped between via
  // fsHeroTouchX below instead of a tap-to-reveal icon row.
  const [fsHeroIndex, setFsHeroIndex] = useState(0);
  const fsHeroTouchX = useRef<number | null>(null);
  // Peek handle — native-feeling drag instead of a binary swipe-up/down
  // threshold: the sheet's height follows the finger in real time
  // (imperative style writes during the drag, see onTouchMove below, for
  // 60fps without a re-render per pixel moved) and only commits to
  // fsSheetExpanded — which then drives the CSS-transitioned rest state
  // — once the finger lifts. fsDockBodyH is the body's own measured
  // natural height (ResizeObserver-tracked below) so max-height can
  // animate between 0 and an exact pixel value instead of "auto", which
  // CSS can't transition.
  const fsDockBodyRef = useRef<HTMLDivElement>(null);
  const fsDockBodyInnerRef = useRef<HTMLDivElement>(null);
  const [fsDockBodyH, setFsDockBodyH] = useState(0);
  const fsDockDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const fsDockRef = useRef<HTMLDivElement>(null);
  // Reference-match (TradingView mobile "symbol info" sheet) — Overview/
  // Key stats/About need real fundamentals (ATH, supply, market cap,
  // project links) this app never tracked before; Open Interest is a
  // separate live fetch (Binance futures, this app's own existing OI
  // source elsewhere is BTC-only, see coinglass.ts) multiplied by the
  // live price already on hand instead of a second price fetch. Both
  // reset to null on coin change so a stale coin's numbers never flash
  // before the new fetch resolves, and only run while the sheet can
  // actually be seen (isFullscreen && mobile) — no point spending the
  // request otherwise.
  const [coinMeta, setCoinMeta] = useState<CoinMeta | null>(null);
  const [oiCoins, setOiCoins] = useState<number | null>(null);
  useEffect(() => {
    const mobileFs = isFullscreen && !isDesktopWidth;
    // Desktop bar header also needs coin meta (genesis date → "16Y old").
    const desktopBar = isDesktopWidth && !isFullscreen && !pageMode;
    if (!mobileFs && !desktopBar) return;
    let cancelled = false;
    setCoinMeta(null);
    fetchCoinMeta(coin).then((m) => { if (!cancelled) setCoinMeta(m); });
    if (mobileFs) {
      setOiCoins(null);
      fetchOpenInterestCoins(coin).then((v) => { if (!cancelled) setOiCoins(v); });
    }
    return () => { cancelled = true; };
  }, [isFullscreen, isDesktopWidth, pageMode, coin]);
  // Advance Price Chart page, mobile — how much bottom clearance the
  // scroll container needs to reserve so the chart's own time-axis date
  // labels clear the docked bottom sheet. Measured from the actual
  // rendered dock (peek state only — see the fsSheetExpanded guard
  // below), not a guessed pixel constant, so it's correct on every
  // device (notch/no-notch, Dynamic Island, etc.) and stays correct if
  // the peek row's own content ever changes again later.
  const [fsDockClearance, setFsDockClearance] = useState(104);
  useEffect(() => {
    if (!(pageMode && !isDesktopWidth && isFullscreen)) return;
    const el = fsDockRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // Only commit while collapsed — expanded, the sheet grows up to
      // 80vh and that's not clearance we want the chart to give up.
      if (!fsSheetExpanded) setFsDockClearance(el.offsetHeight);
    });
    ro.observe(el);
    if (!fsSheetExpanded) setFsDockClearance(el.offsetHeight);
    return () => ro.disconnect();
  }, [pageMode, isDesktopWidth, isFullscreen, fsSheetExpanded]);
  // Natural height of the (always-mounted) accordion body content, so
  // .fs-dock-body's max-height can animate to an exact px value instead
  // of "auto" — stays correct as categories open/close or data loads in.
  useEffect(() => {
    if (!(pageMode && !isDesktopWidth && isFullscreen)) return;
    const el = fsDockBodyInnerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFsDockBodyH(el.scrollHeight));
    ro.observe(el);
    setFsDockBodyH(el.scrollHeight);
    return () => ro.disconnect();
  }, [pageMode, isDesktopWidth, isFullscreen]);
  useEffect(() => {
    if (!isFullscreen) {
      setFsSheetExpanded(false);
      setFsOpenCategories({ style: true });
      setFsFocusedCategory(null);
    }
  }, [isFullscreen]);
  // Tapping anywhere outside the docked sheet collapses it back to peek,
  // same as tapping its own peek bar would — only listens while it's
  // actually expanded, so it never intercepts normal chart taps.
  useEffect(() => {
    if (!fsSheetExpanded || fsDockFlat) return;
    const onPointerDown = (e: PointerEvent) => {
      if (fsDockRef.current && !fsDockRef.current.contains(e.target as Node)) {
        setFsSheetExpanded(false);
        setFsFocusedCategory(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [fsSheetExpanded, fsDockFlat]);
  // Lets the fullscreen-toggle effect (further down) tell a genuine
  // isFullscreen transition apart from this same effect re-firing for an
  // unrelated reason (grid/theme change) — only a real transition should
  // force the chart style/reset the view, not every fire of that effect.
  const prevIsFullscreenForToggleRef = useRef(isFullscreen);
  const textColor = isLight
    ? isFullscreen
      ? "#0a0b0d"
      : "#5b616e"
    // Dark: neutral grey on #trade (the lavender read as purple there).
    : prefsScope === "trade" && !pageMode ? "#8e8e93" : "#9490c0";
  // Desktop chart page (TradingView view): TradingView's own faint grid —
  // #f0f3fa in light, a near-invisible white tint in dark.
  const gridColor = prefsScope === "trade" && !pageMode
    ? (isLight ? "#f0f3fa" : "rgba(240, 243, 250, 0.06)")
    : isLight ? "#f0f1f3" : "#2b2748";
  // Light is #ffffff (--color-background) in BOTH modes — compact
  // already was; the old code had fullscreen light backwards at
  // "#f8fafc" (--color-surface-alt), the exact same grayish mismatch
  // dark had, just never noticed since dark was the one being tested.
  // Dark compact matches --pc-bg's real value (--color-surface-alt,
  // #111827), same as always. Dark FULLSCREEN uses --color-background's
  // real value (#070c18) instead — confirmed working earlier this
  // session. Scoped to just this chart-canvas paint color, not the
  // shared --pc-bg/--pc-scrim-rgb tokens other components use too.
  // Dark theme is pure black everywhere (same as the Liquidation Heatmap
  // card), fullscreen included.
  // The coin bottom sheet's chart matches the sheet's own dark surface
  // (#0a0a0b, BottomSheet.css / .mss-sheet) instead of pure black.
  const bgColor = isLight ? "#ffffff" : prefsScope === "sheet" ? "#0a0a0b" : "#000000";
  // true when we're using the CSS fallback (iOS / no Fullscreen API)
  const cssFsRef = useRef(false);

  useEffect(() => {
    const onChange = () => {
      if (!cssFsRef.current) setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    // Standalone page instance — permanently fullscreen-rendered, never
    // has a local overlay state to toggle. Every exit affordance (Exit
    // button, double-tap, double-click) already calls this one function,
    // so routing it to onNavigateBack here covers all of them for free.
    if (pageMode) {
      onNavigateBack?.();
      return;
    }
    if (isFullscreen) {
      cssFsRef.current = false;
      setIsFullscreen(false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      return;
    }
    // Compact instance — "entering fullscreen" now navigates to the
    // standalone Advance Price Chart page instead of toggling a local
    // CSS overlay. The local-overlay fallback below only fires if no
    // navigation callback was wired (shouldn't happen once App.tsx always
    // passes onNavigateToPage).
    if (onNavigateToPage) {
      onNavigateToPage();
      return;
    }
    cssFsRef.current = true;
    setIsFullscreen(true);
  }, [pageMode, isFullscreen, onNavigateToPage, onNavigateBack]);
  edgeBackRef.current = toggleFullscreen;

  const fsScrollRef = useRef<HTMLDivElement>(null);

  const updateFsThumb = useCallback(() => {}, []);

  useEffect(() => {
    if (!isFullscreen) return;
    const t = setTimeout(updateFsThumb, 120);
    return () => clearTimeout(t);
  }, [isFullscreen, updateFsThumb]);

  // REMOVED: this used to manually forward vertical touchmove deltas to
  // fsScrollRef's scrollTop (capture-phase, stopPropagation+preventDefault)
  // as a workaround for LWC's canvas consuming the touch before native
  // scroll could. Same anti-pattern as the compact-view scroll handler
  // removed earlier this session — no momentum after releasing, and now
  // actively fights the real fix: touch-action:pan-y on .chart-dblclick-
  // wrap (PriceChart.css) plus vertTouchDrag:false below (so LWC's own
  // vertical-drag price-scale feature never competes for the same
  // gesture) lets iOS scroll .price-chart-fs-scroll on its native fast
  // path, full momentum included, while horizontal drag/pinch still goes
  // to LWC exactly as before (pan-y only ever claims the vertical axis).

  const dblClickWrapRef = useRef<HTMLDivElement>(null);
  // Portal target for ChartEventAnnotations' cards/pager — rendered as a
  // sibling AFTER .chart-dblclick-wrap closes, so they're normal page
  // flow and can't stretch that wrapper's absolutely-positioned overlays
  // (dots layer, PredictionOverlay, LineDotFillOverlay) down over them.
  const eventCardsSlotRef = useRef<HTMLDivElement>(null);

  // Manual double-tap to enter/exit fullscreen (iOS) — native dblclick
  // synthesis from two touches is unreliable here (gets swallowed once
  // LWC's own pan/zoom/crosshair touch handling is active in fullscreen,
  // same root cause as the scroll-capture effect above), so this tracks
  // tap timing/position independently instead of depending on the browser
  // to synthesize it. Used to be fullscreen-only (exit), now covers both
  // directions since the same risk applies entering from the compact view
  // too. Passive-only (no preventDefault/stopPropagation) — it just
  // watches, so it can't interfere with whatever LWC or native scroll
  // does with the same touches.
  // Double-tap anywhere on the chart toggles fullscreen. React touch
  // props (not a one-time addEventListener on the ref) so it keeps working
  // when the wrapper element gets re-mounted. Passive: never blocks scroll.

  // Main chart refs
  const containerRef = useRef<HTMLDivElement>(null);
  // Reference-match floating date/price bubble shown next to the crosshair,
  // desktop non-fullscreen only — written imperatively from
  // subscribeCrosshairMove (not React state) so it updates every mouse-move
  // tick without triggering a re-render.
  const crosshairTooltipRef = useRef<HTMLDivElement>(null);
  // Desktop chart page: TradingView-style OHLC line (top-left of the chart).
  const ohlcRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candleRef = useRef<any>(null);
  // Shared indicator catalog (indicatorLibrary.ts) — same picker + drawing
  // on every chart in the app. RSI/MACD stay on this chart's own panels.
  const [libIndicators, toggleLibIndicator, clearLibIndicators] = useIndicatorSelection(`price-chart:v2:${prefsScope}`); // own list per chart, fresh start
  // Close-price line, used only when chartStyle === "line" — kept alive
  // (hidden) the rest of the time rather than swapped in/out, so toggling
  // styles never has to add/remove a series mid-session.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lineCloseRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const volumeRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbUpperRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbMiddleRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbLowerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbFillUpperRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbFillLowerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const srLineRefs = useRef<any[]>([]);
  const zoneLineRefs = useRef<any[]>([]);
  const lastCandlesRef = useRef<CandleDataPoint[]>([]);

  // ── Pro Vision (Trade + Advance charts, Pro/Elite) ────────────────────
  // Recomputed whenever the chart's data reloads (chartGeneration bumps).
  // Who may run it on this coin: ProVision plan / Elite (unlimited), free
  // trial, or Pro's 3 coins a day — see useProVisionGate.
  const pvGate = useProVisionGate();
  // ProVision draws on the chart page too (desktop and phones) and on the
  // Advance page — turned on from the chart page's ProVision tab / banner.
  const pvScope = prefsScope === "trade" || prefsScope === "advance";
  const pvActive = pvGate.activeFor(coin) && pvScope;
  // Desktop chart page: turning ProVision on jumps to the candle chart
  // ("TradingView"), where ProVision is drawn. Only on the off → on switch,
  // so picking the line view afterwards still sticks.
  const pvWasOnRef = useRef(pvGate.on);
  useEffect(() => {
    if (pvGate.on && !pvWasOnRef.current && prefsScope === "trade") {
      setChartMetric("price");
      setCmcStyle("candles");
    }
    pvWasOnRef.current = pvGate.on;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvGate.on]);
  // ProVision strength pill: sits bottom-left, just above the time axis's
  // top border. Measured (chart bottom − axis height, relative to the pill's
  // own positioned parent) since that parent also holds bars below the chart.
  const pvStrengthRef = useRef<HTMLDivElement | null>(null);
  const [pvStrengthBottom, setPvStrengthBottom] = useState<number | null>(null);
  const [pvStrengthLeft, setPvStrengthLeft] = useState<number | null>(null);
  const pvStrengthMeasureRef = useRef<() => void>(() => {});
  useEffect(() => {
    const measure = () => {
      const pill = pvStrengthRef.current;
      const canvas = containerRef.current;
      const parent = pill?.offsetParent as HTMLElement | null;
      if (!pill || !canvas || !parent) return;
      const axisH = chartRef.current?.timeScale().height() ?? 26;
      const pr = parent.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      const next = Math.round(pr.bottom - cr.bottom + axisH + 6);
      setPvStrengthBottom((prev) => (prev === next ? prev : next));
      // Always flush with the chart's own left edge.
      const left = Math.round(cr.left - pr.left);
      setPvStrengthLeft((prev) => (prev === left ? prev : left));
    };
    pvStrengthMeasureRef.current = measure;
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    const parent = pvStrengthRef.current?.offsetParent;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvActive, isFullscreen, isDesktopWidth, chartGeneration, interval]);
  // ── coinhintz consensus (#trade only) ─────────────────────────────────
  const { tier: authTier, user: authUser } = useAuth();
  // Predict is free for every account (the $1k prediction balance comes
  // with signing up) — guests are asked to sign in, nobody is upsold.
  const openPredict = () => {
    if (!authUser) { onOpenAuth?.(); return; }
    setShowCompactView(true);
  };
  // Shared predictions link for this coin (services/pendingPredict.ts):
  // open predictions now if signed in, else ask to sign in once and open
  // them as soon as the account exists.
  const predictAskedRef = useRef(false);
  useEffect(() => {
    // Only the main chart page acts (not Advance Chart or the symbol sheet).
    if (pageMode || prefsScope === "sheet") return;
    const check = () => {
      if (getPendingPredict() !== coin) return;
      if (authUser) { clearPendingPredict(); setShowCompactView(true); return; }
      if (!predictAskedRef.current) { predictAskedRef.current = true; onOpenAuth?.(); }
    };
    check();
    window.addEventListener(PENDING_PREDICT_EVENT, check);
    return () => window.removeEventListener(PENDING_PREDICT_EVENT, check);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin, authUser]);
  const consensusOn = prefsScope === "trade" && !pageMode;
  // Buy & Sell scanner's current call for this coin (Pro+; RLS-readable).
  const [scanSignal, setScanSignal] = useState<{ direction: "buy" | "sell"; active: boolean } | null>(null);
  useEffect(() => {
    if (!consensusOn || !isPaid) { setScanSignal(null); return; }
    let alive = true;
    supabase.from("buy_signals").select("direction, is_active").eq("coin", coin).maybeSingle()
      .then(({ data }) => {
        if (!alive) return;
        const d = data as { direction: "buy" | "sell"; is_active: boolean } | null;
        setScanSignal(d ? { direction: d.direction, active: d.is_active } : null);
      });
    return () => { alive = false; };
  }, [coin, isPaid, consensusOn]);
  // The chart's notable moments ("Broke below support…"), for the phone
  // Consensus sheet's Events row.
  const [chartEvts, setChartEvts] = useState<ChartEvent[]>([]);
  // Consensus headline + count, for the first slide under the phone chart.
  const [consensusSummary, setConsensusSummary] = useState<{ lead: "bull" | "bear" | "neutral"; headline: string; countLine: string } | null>(null);
  // Technicals' lean on the chart's own candles (free, computed locally).
  const techLean = useMemo(
    () => (consensusOn ? technicalsLean(lastCandlesRef.current) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [consensusOn, coin, interval, chartGeneration, loading],
  );
  const pvActiveRef = useRef(pvActive);
  pvActiveRef.current = pvActive;
  // Switch is on but this coin isn't unlocked (Pro's 4th coin, ended trial).
  const pvLocked = pvGate.on && pvScope && !pvGate.access.allowed(coin);
  // Free accounts (and signed-out visitors) always see the ProVision banner
  // on these pages, switch on or off — Pro only sees it when it's locked.
  const pvFreeLocked = pvScope && pvGate.access.mode === "locked";
  const pvLockReason = pvLocked || pvFreeLocked ? pvGate.access.lockReason(coin) : null;
  // Free trial running: keep a banner up with the time left.
  const pvTrialLeftMs = pvScope && pvGate.access.mode === "trial" && pvGate.access.trialEndsAt
    ? Math.max(0, pvGate.access.trialEndsAt - Date.now())
    : null;
  // Exact time left ("2d 9h", "9h", "under an hour") — never rounds days up,
  // so a trial started today no longer reads "3 days left" all day.
  const pvTrialLeftLabel = (ms: number, compact = false) => {
    const totalH = Math.floor(ms / 3_600_000);
    const d = Math.floor(totalH / 24);
    const h = totalH % 24;
    if (d >= 1) return h > 0 ? `${d}d ${h}h` : compact ? `${d}d` : t("priceChart.trial.days", { count: d });
    if (totalH >= 1) return `${totalH}h`;
    return compact ? "<1h" : t("priceChart.trial.underHour");
  };
  // (Pro's coin count is claimed by the server when it computes the read.)
  // Short "preparing" intro each time Pro Vision is switched on (not on page
  // load when it was already on).
  const PV_INTRO_MS = 2800;
  const [pvIntro, setPvIntro] = useState(false);
  // ProVision paints candles (ribbon, trend colours, labels) — none of it
  // shows on the line style, so switching it on moves Line → Candle.
  // Only reacts to ProVision turning on; picking Line afterwards still works.
  useEffect(() => {
    if (pvActive && chartStyle === "line") setChartStyle("candle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvActive]);
  const pvWasActive = useRef(pvActive);
  useEffect(() => {
    const was = pvWasActive.current;
    pvWasActive.current = pvActive;
    if (!pvActive) { setPvIntro(false); return; }
    if (was) return;
    setPvIntro(true);
    const id = window.setTimeout(() => setPvIntro(false), PV_INTRO_MS);
    return () => clearTimeout(id);
  }, [pvActive]);
  // Live loop: every 5s pull the newest 2 candles of this interval and fold
  // them into the read, so the Signal check updates in real time even on
  // intervals the chart itself only refreshes occasionally.
  const [pvLiveTail, setPvLiveTail] = useState<CandleDataPoint[]>([]);
  const [pvUpdatedAt, setPvUpdatedAt] = useState(0);
  useEffect(() => {
    // The live kline stream feeds pvLiveTail itself when available.
    if (!pvActive || interval === "all" || binanceKlineInterval(interval)) return;
    let alive = true;
    const pull = () => coinglass.getLatestCandles(coin, interval, 2).then((t) => {
      if (alive && t.length) { setPvLiveTail(t); setPvUpdatedAt(Date.now()); }
    });
    pull();
    const id = window.setInterval(pull, 5000);
    return () => { alive = false; clearInterval(id); setPvLiveTail([]); };
  }, [pvActive, coin, interval]);
  // Short charts (1s/1m/5m): signals come from the 15m chart instead — the
  // short candles' own signals only broke even after fees in backtests.
  // The app only fetches the 15m candles; the server does the merge.
  const pvShortSec = interval === "1sec" ? 1 : interval === "1min" ? 60 : interval === "5min" ? 300 : 0;
  const [pvHtfCandles, setPvHtfCandles] = useState<CandleDataPoint[] | null>(null);
  useEffect(() => {
    if (!pvActive || !pvShortSec) { setPvHtfCandles(null); return; }
    let alive = true;
    coinglass.getHistoricalCandles("15min", coin, 520 * 900)
      .then((cs) => { if (alive) setPvHtfCandles(cs); })
      .catch(() => { if (alive) setPvHtfCandles(null); });
    return () => { alive = false; };
    // Refetch when the chart reloads (cache keeps this cheap).
  }, [pvActive, pvShortSec, coin, chartGeneration]);

  // The ProVision read itself comes from the server (provision-compute),
  // which checks access first. Recomputed when the chart reloads, and at
  // most every 8s for the live forming candle.
  const [pvBase, setPvBase] = useState<PvResult | null>(null);
  // Server refused (Pro's 3 coins used up on another device, trial ended…).
  const [pvServerLocked, setPvServerLocked] = useState(false);
  // Why the read isn't showing (failed call / empty result) — null when fine.
  const [pvError, setPvError] = useState<string | null>(null);
  // ProVision yearly price: App Store price on iOS, $99 on the web.
  const pvPrice = useStorePrices().provision;
  // Banner reason: the app's own check, or the server's refusal (Pro limit).
  // Free-trial strip ("3 days left · Keep it"): standalone above the Signal
  // Check, or inside its card on the Advance Chart.
  const pvTrialBannerEl = pvTrialLeftMs === null ? null : (() => {
    const left = pvTrialLeftLabel(pvTrialLeftMs);
    return (
      <button
        type="button"
        className="pv-locked pv-locked--trial"
        onClick={() => openProVisionPaywall({ reason: "trial-active", coin })}
      >
        <span className="pv-locked-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
        </span>
        <span className="pv-locked-text">
          <strong>
            <span className="pv-trial-long">{t("priceChart.trial.bannerLong", { left })}</span>
            <span className="pv-trial-short">{t("priceChart.trial.bannerShort", { left })}</span>
          </strong>
          <span>
            <span className="pv-trial-long">{t("priceChart.trial.everyCoinPrice", { price: pvPrice })}</span>
            <span className="pv-trial-short">{t("priceChart.trial.thenPrice", { price: pvPrice })}</span>
          </span>
        </span>
        <span className="pv-locked-cta">{t("priceChart.trial.keepIt")}</span>
      </button>
    );
  })();
  // Desktop promo card over the chart: dismissed for the rest of the session.
  const [pvPromoDismissed, setPvPromoDismissed] = useState(() => {
    try { return sessionStorage.getItem("pvPromoDismissed") === "1"; } catch { return false; }
  });
  // Ghost teaser has its own "Not now" memory (separate from the others).
  const [pvGhostDismissed, setPvGhostDismissed] = useState(() => {
    try { return sessionStorage.getItem("pvGhostDismissed") === "1"; } catch { return false; }
  });
  // "Enjoying ProVision? Keep it ›" chip for the Signal Check header.
  const pvTrialChip = (extraClass: string) => {
    if (pvTrialLeftMs === null) return null;
    const long = pvTrialLeftLabel(pvTrialLeftMs);
    const short = pvTrialLeftLabel(pvTrialLeftMs, true);
    return (
      <span
        role="button"
        tabIndex={0}
        className={`pv-trial-chip ${extraClass}`}
        onClick={(e) => { e.stopPropagation(); openProVisionPaywall({ reason: "trial-active", coin }); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openProVisionPaywall({ reason: "trial-active", coin }); } }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
        <span className="pv-trial-chip-long">{t("priceChart.trial.enjoyingPv")}</span>
        <span className="pv-trial-chip-short">{t("priceChart.trial.enjoyingIt")}</span>
        <span className="pv-trial-chip-cta">{t("priceChart.trial.keepItArrow")}</span>
        <span className="pv-trial-chip-left pv-trial-chip-long">{t("priceChart.trial.left", { left: long })}</span>
        <span className="pv-trial-chip-left pv-trial-chip-short">{short}</span>
      </span>
    );
  };
  const pvBannerReason = pvLockReason
    ?? (pvServerLocked && pvGate.on && pvScope ? (pvGate.access.lockReason(coin) ?? "pro-limit") : null);
  const pvLastCalc = useRef(0);
  const pvCalcKey = `${coin}|${interval}|${chartGeneration}|${pvHtfCandles ? pvHtfCandles.length : 0}`;
  const pvLastKey = useRef("");
  useEffect(() => {
    if (!pvActive) { setPvBase(null); setPvServerLocked(false); setPvError(null); pvLastKey.current = ""; return; }
    if (pvShortSec && !pvHtfCandles) return; // wait for the 15m candles
    const keyChanged = pvLastKey.current !== pvCalcKey;
    const wait = keyChanged ? 0 : Math.max(0, 3000 - (Date.now() - pvLastCalc.current));
    let alive = true;
    const id = window.setTimeout(() => {
      const base = lastCandlesRef.current;
      if (!base.length) return;
      // Replace the forming candle / append a just-opened one (never reorder).
      const merged = base.slice();
      for (const t of pvLiveTail) {
        const lastT = merged[merged.length - 1].time;
        if (t.time === lastT) merged[merged.length - 1] = t;
        else if (t.time > lastT) merged.push(t);
      }
      pvLastCalc.current = Date.now();
      pvLastKey.current = pvCalcKey;
      fetchProVision(coin, merged, pvShortSec && pvHtfCandles ? { candles: pvHtfCandles, shortSec: pvShortSec } : undefined)
        .then((r) => {
          if (!alive) return;
          setPvBase(r);
          setPvServerLocked(false);
          // Server answered but had nothing to read (too little history).
          setPvError(r ? null : t("priceChart.pvErr.notEnough"));
        })
        .catch(async (e) => {
          if (!alive) return;
          // 401 = the server didn't accept the sign-in (expired session),
          // NOT a plan problem. Refresh the session once and let the next
          // run retry; if that fails, ask to sign in again instead of
          // showing the "locked / upgrade" banner to a paying user.
          if (e instanceof ProVisionLockedError && e.reason === "signin") {
            console.warn("[ProVision] sign-in rejected by server — refreshing session");
            const { error: refreshErr } = await supabase.auth.refreshSession();
            if (!alive) return;
            setPvBase(null);
            setPvServerLocked(false);
            if (refreshErr) setPvError(t("priceChart.pvErr.signinExpired"));
            else { setPvError(t("priceChart.pvErr.reconnecting")); pvLastKey.current = ""; }
            return;
          }
          if (e instanceof ProVisionLockedError) {
            console.warn("[ProVision] server refused access:", e.message);
            setPvBase(null);
            setPvServerLocked(true);
            setPvError(null);
            // Refresh the allowance so the banner shows the right coins.
            window.dispatchEvent(new Event("provision-coins-change"));
            return;
          }
          // Anything else (rate limit, server error, network) used to be
          // swallowed, leaving "Reading…" up forever. Say so, log the
          // server's reply, and keep retrying (this effect re-runs on the
          // next live candle update).
          const res = (e as { context?: Response })?.context;
          let detail = "";
          try { detail = res ? (await res.clone().json())?.error ?? "" : ""; } catch { /* not JSON */ }
          const status = res?.status;
          console.warn("[ProVision] read failed", status ?? "", detail || (e as Error)?.message || e);
          setPvError(status === 429 ? t("priceChart.pvErr.tooMany") : status ? t("priceChart.pvErr.server", { status }) : t("priceChart.pvErr.unreachable"));
        });
    }, wait);
    return () => { alive = false; clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvActive, pvCalcKey, pvLiveTail]);

  // Multi-timeframe column: the verdict on 5m / 15m / 1h / 4h / 1D,
  // refreshed every minute (one server call for all five).
  const [pvMtf, setPvMtf] = useState<{ label: string; iv: TimeInterval; bias: "bull" | "bear" | "neutral" | null; checks: ("bull" | "bear" | "neutral")[]; strength: number | null }[]>([]);
  useEffect(() => {
    if (!pvActive || pvServerLocked) { setPvMtf([]); return; }
    let alive = true;
    const frames: [TimeInterval, string][] = [["5min", "5m"], ["15min", "15m"], ["1h", "1h"], ["4h", "4h"], ["1day", "1D"]];
    const load = async () => {
      const sets = await Promise.all(frames.map(async ([iv, label]) => {
        try { return { label, iv, candles: await coinglass.getHistoricalCandles(iv, coin) }; }
        catch { return { label, iv, candles: [] as CandleDataPoint[] }; }
      }));
      try {
        const rows = await fetchProVisionMtf(coin, sets.map((s) => ({ label: s.label, candles: s.candles })));
        if (!alive) return;
        setPvMtf(sets.map((s) => {
          const r = rows.find((x) => x.label === s.label);
          return { label: s.label, iv: s.iv, bias: r?.bias ?? null, checks: r?.checks ?? [], strength: r?.strength ?? null };
        }));
      } catch { /* keep the last read */ }
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [pvActive, pvServerLocked, coin]);

  // Scheduled macro events (FOMC, CPI, jobs…): warn ahead, and pause
  // signals from 30 min before to 1 h after each release.
  const [pvEvents, setPvEvents] = useState<MacroEvent[]>([]);
  const [pvNow, setPvNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pvActive) return;
    let alive = true;
    const load = () => getMacroEvents().then((e) => { if (alive) setPvEvents(e); });
    load();
    const tick = window.setInterval(() => setPvNow(Date.now()), 30_000);
    const reload = window.setInterval(load, 30 * 60 * 1000);
    return () => { alive = false; clearInterval(tick); clearInterval(reload); };
  }, [pvActive]);
  const pvEventInfo = useMemo(() => {
    const inWindow = (ms: number) => pvEvents.find((e) => ms >= e.time - EVENT_PAUSE_BEFORE_MS && ms <= e.time + EVENT_PAUSE_AFTER_MS);
    const live = inWindow(pvNow) ?? null;
    const next = pvEvents.find((e) => e.time > pvNow && e.time - pvNow <= 24 * 3600 * 1000) ?? null;
    return { inWindow, live, next };
  }, [pvEvents, pvNow]);
  const pvResult = useMemo<PvResult | null>(() => {
    if (!pvBase || !pvEvents.length) return pvBase;
    // Drop signals (and the live zone) that fired inside an event window.
    const signals = pvBase.signals.filter((s) => !pvEventInfo.inWindow(s.time * 1000));
    const zone = pvBase.zone && pvEventInfo.inWindow(pvBase.zone.from * 1000) ? null : pvBase.zone;
    return { ...pvBase, signals, zone };
  }, [pvBase, pvEvents, pvEventInfo]);
  // Phone #trade market card: hold a loader until the chart and the signal
  // read are in. Safety valve: give up waiting on the signal after 10s.
  const [kmWaitedOut, setKmWaitedOut] = useState(false);
  useEffect(() => {
    setKmWaitedOut(false);
    const t = window.setTimeout(() => setKmWaitedOut(true), 10000);
    return () => window.clearTimeout(t);
  }, [coin, interval]);
  const pvColorMap = useMemo(() => {
    if (!pvResult) return null;
    const m = new Map<number, string>();
    const cs = lastCandlesRef.current;
    pvResult.trend.forEach((b, i) => {
      // No clear trend = yellow (like the classic signal-ribbon look).
      if (cs[i]) m.set(cs[i].time, b === "bull" ? "#4ade80" : b === "bear" ? "#fb7185" : "#facc15");
    });
    return m;
  }, [pvResult]);
  const [pvTileOpen, setPvTileOpen] = useState<PvTile | null>(null);
  // Advance Chart fills the screen, so its Signal check starts collapsed
  // to one line (verdict + hit rate); Trade shows it open.
  // Expanded by default — except the Advance Chart on phones.
  // Advance Chart: starts collapsed (one line: score · verdict · hit rate) —
  // the full card took too much room; your open/closed choice is kept.
  const [pvCardOpen, setPvCardOpenState] = useState(() => {
    if (prefsScope !== "advance") return true;
    try { return localStorage.getItem("pvAdvCardOpen") === "1"; } catch { return false; }
  });
  const setPvCardOpen = (v: boolean | ((p: boolean) => boolean)) => setPvCardOpenState((p) => {
    const n = typeof v === "function" ? v(p) : v;
    if (prefsScope === "advance") { try { localStorage.setItem("pvAdvCardOpen", n ? "1" : "0"); } catch { /* ignore */ } }
    return n;
  });
  // "How to use Pro Vision": opens once, the first time Pro Vision is on
  // (remembered), and from the card's "How to use" link after that.
  const [pvGuideOpen, setPvGuideOpen] = useState(false);
  useEffect(() => {
    if (!pvActive) return;
    let seen = false;
    try { seen = localStorage.getItem("proVisionGuideSeen:v1") === "1"; } catch { /* ignore */ }
    if (seen) return;
    try { localStorage.setItem("proVisionGuideSeen:v1", "1"); } catch { /* ignore */ }
    setPvGuideOpen(true);
  }, [pvActive]);
  useChartIndicators({
    chart: chartRef.current,
    mainSeries: candleRef.current,
    getCandles: () => lastCandlesRef.current,
    // Phones' trade chart stays candles-only; desktop has an Indicators button.
    enabled: tradeChartLocked && !isDesktopWidth ? [] : libIndicators,
    isDark: !isLight,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gannMarkersPluginRef = useRef<any>(null);

  // Indicator chart refs
  const rsiContainerRef = useRef<HTMLDivElement>(null);
  const macdContainerRef = useRef<HTMLDivElement>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);
  const macdChartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rsiSeriesRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const macdLineRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const macdSignalRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const macdHistRef = useRef<any>(null);
  const syncingRef = useRef(false);
  const viewInitializedForRef = useRef<string | null>(null);

  // Persists drawings across fullscreen toggle (component unmount/remount)
  const drawingsPersistRef = useRef<Drawing[]>([]);

  // Drawing tools state
  const [predictionPath, setPredictionPath] = useState<PredictionPath | null>(
    null,
  );
  const [chartPrediction, setChartPrediction] =
    useState<ChartPrediction | null>(null);
  const [showPredictionModal, setShowPredictionModal] = useState(false);

  const [zoneAnalysis, setZoneAnalysis] = useState<{
    candles: CandleDataPoint[];
    loading: boolean;
    error?: string;
    result?: ZoneAnalysisResult;
  } | null>(null);
  // True while the user is expected to be dragging out a zone on the chart —
  // drives the button's "Draw a zone…" state until the draw commits.
  const [awaitingZoneDraw, setAwaitingZoneDraw] = useState(false);
  // True once a zone shape exists on the chart — shows the "Clear" button
  // next to "Explain Zone" instead of floating it over the drawn shape.
  const [hasZone, setHasZone] = useState(false);
  const drawingToolsRef = useRef<ChartDrawingToolsHandle>(null);

  const handleExplainZoneStart = useCallback(() => {
    if (!isPaid) { onOpenUpgrade?.("pro"); return; }
    drawingToolsRef.current?.activateZoneTool();
    setAwaitingZoneDraw(true);
  }, [isPaid, onOpenUpgrade]);

  const handleClearZone = useCallback(() => {
    drawingToolsRef.current?.clearZoneTool();
    setHasZone(false);
  }, []);

  const handleCancelZoneDraw = useCallback(() => {
    drawingToolsRef.current?.cancelZoneTool();
    setAwaitingZoneDraw(false);
  }, []);

  const handleZoneComplete = useCallback((_drawing: Drawing, candles: CandleDataPoint[]) => {
    setAwaitingZoneDraw(false);
    setHasZone(true);
    if (candles.length < 2) {
      setZoneAnalysis({ candles, loading: false, error: t("priceChart.zone.tooSmall") });
      return;
    }
    if (exceeded) {
      setZoneAnalysis({ candles, loading: false, error: t("priceChart.zone.limit") });
      return;
    }
    setZoneAnalysis({ candles, loading: true });

    // Give the AI extra context: a few candles right before the zone (to spot
    // what prior high/low might get swept) and an estimated liquidation-cluster
    // picture as of the zone's end, so it can reason about stop hunts / liquidity
    // grabs instead of only describing candle shapes.
    const allCandles = lastCandlesRef.current;
    const zoneStartTime = candles[0].time as number;
    const zoneEndTime = candles[candles.length - 1].time as number;
    const startIdx = allCandles.findIndex((c) => (c.time as number) === zoneStartTime);
    const endIdx = allCandles.findIndex((c) => (c.time as number) === zoneEndTime);
    const leadIn = startIdx > 0 ? allCandles.slice(Math.max(0, startIdx - 15), startIdx) : [];
    const liqHistoryEnd = endIdx >= 0 ? endIdx : allCandles.length - 1;
    const liqHistory = allCandles.slice(Math.max(0, liqHistoryEnd - 300), liqHistoryEnd + 1);
    const liqResult = liqHistory.length >= 10 ? analyseLiquidations(liqHistory, [...LEVERAGES_ALL]) : null;

    consume().then((ok) => {
      if (!ok) {
        setZoneAnalysis((prev) => prev ? { ...prev, loading: false, error: t("priceChart.zone.limit") } : prev);
        return;
      }
      getZoneAnalysis(coin, interval, candles, {
        leadIn,
        liquidation: liqResult
          ? {
              dominantSide: liqResult.dominantSide,
              longClusters: liqResult.longClusters.map((c) => ({ priceCenter: c.priceCenter, strength: c.strength, label: c.label })),
              shortClusters: liqResult.shortClusters.map((c) => ({ priceCenter: c.priceCenter, strength: c.strength, label: c.label })),
            }
          : null,
      }).then((res) => {
        setZoneAnalysis((prev) => {
          if (!prev) return prev;
          return res.success && res.result
            ? { ...prev, loading: false, result: res.result }
            : { ...prev, loading: false, error: res.error || t("priceChart.zone.failed") };
        });
      });
    });
  }, [coin, interval, exceeded, consume, t]);

  const [divergence, setDivergence] = useState<DivergenceResult | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const divMarkersRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rsiDivMarkersRef = useRef<any>(null);

  // CME gap price line refs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmeLineRefs = useRef<any[]>([]);

  // Fibonacci retracement price line refs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fibLineRefs = useRef<any[]>([]);
  const showFibRef = useRef(true);

  // EMA / MA overlay refs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ema20Ref = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ema50Ref = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ema200Ref = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ma20Ref = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ma50Ref = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ma200Ref = useRef<any>(null);

  // ── Create main chart ────────────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;

    const initChart = () => {
      const el = containerRef.current;
      if (!el || !isMounted) return;
      const width = el.clientWidth || el.offsetWidth;
      const height = el.clientHeight || 400;

      if (width <= 0 || height <= 0) {
        requestAnimationFrame(initChart);
        return;
      }

      // Opens on whatever chartStyle already is — that state is itself
      // lazy-initialized from the saved chart_prefs_v1 preference (or
      // "candle" as the default for a first-ever visit, matching the
      // reference Coinbase-style screenshot the header/toolbar was
      // matched to). This must happen BEFORE the candle/line series are
      // created just below, since their own `visible` option is set once
      // at creation from this exact ref — setting it only afterward left
      // the new series born with the PREVIOUS mode's visibility already
      // baked in.
      const forcedStyle: ChartStyle = chartStyle;
      chartStyleRef.current = forcedStyle;

      const chart = createChart(el, {
        width,
        height,
        // Same built-in responsive sizing the RSI/MACD sub-charts already
        // use (their own createChart calls below) — the library's own
        // ResizeObserver keeps width/height in sync with the container on
        // every layout change (window resize, orientation change, sidebar
        // toggle, etc.), replacing the manual ResizeObserver/window
        // "resize" listener this used to hand-roll further down (removed —
        // autoSize and manual chart.resize() calls aren't meant to be used
        // together).
        autoSize: true,
        localization: !isFullscreen && isDesktopWidth
          ? { priceFormatter: formatCompactAxisPrice }
          : undefined,
        layout: {
          // Library's own TradingView attribution badge, bottom-left of
          // the pane — defaults to true on every createChart() call. Not
          // app content, not something we want showing.
          attributionLogo: false,
          background: {
            type: ColorType.Solid,
            // Matches bgColor below exactly (same #111827 reasoning) — this
            // is the INITIAL createChart call, a separate literal from the
            // theme-sync effect's applyOptions, so it needs the same fix or
            // every fresh mount/recreation briefly paints the old mismatched
            // value before the sync effect corrects it a tick later.
            color: isLight ? "#ffffff" : "#111827",
          },
          textColor: isLight ? "#5b616e" : "#9490c0",
        },
        // Gridlines only read as useful at fullscreen/expanded size — in
        // the compact inline card they just add visual noise, so start
        // transparent; the theme-sync effect below turns them on once
        // isFullscreen flips true.
        grid: {
          vertLines: { color: "transparent" },
          horzLines: { color: "transparent" },
        },
        // Reference-match: dashed crosshair with a dark price-label pill
        // on the axis, matching the Coinbase-style screenshot — only
        // visually distinct from the library default in the dashed style
        // + pill color; still off entirely in fullscreen/mobile via the
        // subscribeCrosshairMove gate below, which also drives the custom
        // white date/price tooltip bubble.
        crosshair: {
          mode: 1,
          vertLine: {
            width: 1,
            style: LineStyle.Dashed,
            color: isLight ? "#0a0b0d" : "#9490c0",
            labelBackgroundColor: isLight ? "#0a0b0d" : "#2b2748",
          },
          horzLine: {
            width: 1,
            style: LineStyle.Dashed,
            color: isLight ? "#0a0b0d" : "#9490c0",
            labelBackgroundColor: isLight ? "#0a0b0d" : "#2b2748",
          },
        },
        // Matches the gridlines — transparent until the theme-sync effect
        // turns it on for fullscreen/expanded view or the Grid toggle.
        rightPriceScale: { borderColor: "transparent" },
        timeScale: {
          borderColor: isLight ? "#e7e9eb" : "#2b2748",
          timeVisible: true,
          secondsVisible: false,
          // Without this, autoSize's resize() keeps bar spacing constant
          // and reveals more (unloaded) history instead of rescaling the
          // currently-visible range to fill the new width — if there isn't
          // enough history loaded yet, growing the window just exposes
          // blank canvas on one side instead of stretching the existing
          // candles to fill it.
          lockVisibleTimeRangeOnResize: true,
          // Default min (0.5px per candle) caps a phone-width chart at
          // ~600 candles — too few for a kept date range like a year of
          // 4H candles (~2,200). Thin enough to fit MAX_RANGE_CANDLES.
          minBarSpacing: 0.05,
        },
        // Matches the theme-sync effect — starts display-only (isFullscreen
        // is false on first mount) so the page scrolls past the chart
        // smoothly instead of the chart eating the gesture to pan/zoom.
        handleScroll: {
          mouseWheel: false,
          pressedMouseMove: false,
          horzTouchDrag: false,
          vertTouchDrag: false,
        },
        handleScale: {
          mouseWheel: false,
          pinch: false,
          axisPressedMouseMove: false,
        },
      });

      // Overlays start with their current on/off state — the visibility
      // effects below only fire when a toggle changes, so a rebuilt chart
      // (theme, fullscreen, Market cap ↔ Price…) would otherwise show them.
      const bbOpts = {
        lineWidth: 1 as const,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: showBB,
      };
      const maOpts = {
        lineWidth: 1 as const,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
      };

      // Bollinger Band channel fill — two stacked Area series. The first
      // fills from the upper band down to the bottom of the pane; the
      // second "erases" everything below the lower band by repainting it
      // in the chart's own background color, leaving only the band
      // between upper and lower visibly tinted. Added before the candles
      // so the fill sits behind price action, not on top of it.
      bbFillUpperRef.current = chart.addSeries(AreaSeries, {
        lineVisible: false,
        topColor: "rgba(129,140,248,0.10)",
        bottomColor: "rgba(129,140,248,0.10)",
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: showBB,
      });
      bbFillLowerRef.current = chart.addSeries(AreaSeries, {
        lineVisible: false,
        topColor: bgColor,
        bottomColor: bgColor,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: showBB,
      });

      // Every view (desktop/mobile, fullscreen or not) paints its own
      // rounded-corner candles via RoundedCandleOverlay instead (LWC's own
      // CandlestickSeries has no radius option) — making the real series
      // transparent (NOT
      // visible:false — that stopped the price scale autoscaling off it
      // entirely, collapsing the Y-axis to whatever tiny range the other
      // series left) keeps it painting nothing of its own while staying the
      // real data/scale source for autoscale, markers, crosshair price
      // lookups, and drawing tools; the overlay paints the rounded bars on
      // top of this invisible-but-present series.
      const candleColorsTransparent = (chartStyleRef.current as ChartStyle) !== "line";
      candleRef.current = chart.addSeries(CandlestickSeries, {
        upColor: candleColorsTransparent ? "transparent" : "#4ade80",
        downColor: candleColorsTransparent ? "transparent" : "#fb7185",
        borderUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
        borderDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
        wickUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
        wickDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
        visible: (chartStyleRef.current as ChartStyle) !== "line",
      });
      lineCloseRef.current = chart.addSeries(LineSeries, {
        color: "#818cf8",
        lineWidth: 2,
        visible: (chartStyleRef.current as ChartStyle) === "line",
      });
      volumeRef.current = chart.addSeries(HistogramSeries, {
        priceScaleId: "volume",
        priceLineVisible: false,
        lastValueVisible: false,
        color: "rgba(100,100,100,0.4)",
        // #trade chart: no volume bars on phones (candles + ProVision only);
        // desktop shows a faint gray band.
        visible: !tradeChartLocked || isDesktopWidth,
      });
      chart
        .priceScale("volume")
        // Mobile fullscreen only — the "Chart Settings" dock sits fixed
        // at the bottom of the viewport there and was covering the
        // volume bars entirely (bottom:0 ran them right to the canvas
        // edge); a bottom margin lifts them clear of it. Desktop
        // fullscreen and compact (no dock overlay) keep bottom:0.
        .applyOptions({ scaleMargins: { top: faintVolRef.current ? 0.86 : 0.8, bottom: isFullscreen && !isDesktopWidth && !pageMode ? 0.14 : 0 } });

      bbUpperRef.current = chart.addSeries(LineSeries, {
        ...bbOpts,
        color: "rgba(251,113,133,0.7)",
      });
      bbMiddleRef.current = chart.addSeries(LineSeries, {
        ...bbOpts,
        color: "rgba(148,163,184,0.6)",
        lineStyle: 1,
      });
      bbLowerRef.current = chart.addSeries(LineSeries, {
        ...bbOpts,
        color: "rgba(74,222,128,0.7)",
      });
      ema20Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#4ade80",
        title: "EMA 20",
        visible: showEMA20,
      });
      ema50Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#fb923c",
        title: "EMA 50",
        visible: showEMA50,
      });
      ema200Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#c084fc",
        title: "EMA 200",
        visible: showEMA200,
      });
      ma20Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#818cf8",
        title: "MA 20",
        visible: showMA20,
      });
      ma50Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#f472b6",
        title: "MA 50",
        visible: showMA50,
      });
      ma200Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#facc15",
        title: "MA 200",
        visible: showMA200,
      });

      chartRef.current = chart;
      setChartGeneration((g) => g + 1);
      if (lastCandlesRef.current.length > 0) {
        // redrawCandleSeries (not a narrower candleRef-only setData) —
        // this effect recreates the whole chart (theme/grid/fullscreen
        // change), including a brand-new lineCloseRef with no data on it
        // yet. The old candleRef-only call left "line" style's series
        // empty after a theme switch until some unrelated later refresh
        // happened to repopulate it — invisible back when "candle" was
        // the default (candleRef did get redrawn), but immediately
        // obvious now that "line" is. This also recomputes lineTrendColor
        // from the real data instead of leaving it stale.
        redrawCandleSeries(lastCandlesRef.current);
        updateCurrentPrice(lastCandlesRef.current[lastCandlesRef.current.length - 1].close);
        // Reset to the same default window every recreation (theme/grid/
        // fullscreen toggle all land here) — most relevantly, closing
        // fullscreen back to the compact view no longer leaves whatever
        // zoom/pan the chart was left at; it's always a fresh, correct
        // view instead, same INTERVAL_WINDOW definition the very first
        // load for this coin+interval already uses.
        const window = viewWindowFor(interval);
        const lastCandleTime = lastCandlesRef.current[lastCandlesRef.current.length - 1].time as number;
        if (window) {
          chart.timeScale().setVisibleRange({
            from: (lastCandleTime - window) as UTCTimestamp,
            to: lastCandleTime as UTCTimestamp,
          });
        } else {
          chart.timeScale().fitContent();
        }
      }

      // Advance Price Chart page, mobile — light tap feedback when
      // tapping a candle (chart.remove() in this effect's cleanup tears
      // this subscription down with it, no separate unsubscribe needed).
      if (pageMode && !isDesktopWidth) {
        chart.subscribeClick(() => hapticTap());
      }

      // Reference-match floating tooltip bubble (date + price) that
      // follows the crosshair — desktop, non-fullscreen only; fullscreen/
      // mobile keep the library's default axis-only crosshair labels.
      // Written straight to the DOM (not React state) since this fires on
      // every mouse-move tick.
      // Desktop chart page (TradingView view): O H L C + change, top-left —
      // the hovered candle, else the latest one. Written to the DOM directly.
      if (!pageMode && isDesktopWidth) {
        const fmt = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: v >= 1 ? 2 : 4, maximumFractionDigits: v >= 1 ? 2 : 6 });
        const renderOhlc = (d: { open: number; high: number; low: number; close: number } | null) => {
          const el = ohlcRef.current;
          if (!el || !d) return;
          const chg = d.close - d.open;
          const pct = d.open ? (chg / d.open) * 100 : 0;
          const cls = chg >= 0 ? "up" : "dn";
          el.innerHTML =
            `<span>${t("priceChart.ohlc.o")}</span><b class="${cls}">${fmt(d.open)}</b><span>${t("priceChart.ohlc.h")}</span><b class="${cls}">${fmt(d.high)}</b>` +
            `<span>${t("priceChart.ohlc.l")}</span><b class="${cls}">${fmt(d.low)}</b><span>${t("priceChart.ohlc.c")}</span><b class="${cls}">${fmt(d.close)}</b>` +
            `<b class="${cls}">${chg >= 0 ? "" : "−"}${fmt(Math.abs(chg))} (${chg >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%)</b>`;
        };
        const latest = () => {
          const c = lastCandlesRef.current;
          return c.length ? c[c.length - 1] : null;
        };
        chart.subscribeCrosshairMove((param) => {
          const s = candleRef.current;
          const d = s ? (param.seriesData.get(s) as { open?: number; high?: number; low?: number; close?: number } | undefined) : undefined;
          if (d && d.open != null && d.high != null && d.low != null && d.close != null) {
            renderOhlc({ open: d.open, high: d.high, low: d.low, close: d.close });
          } else {
            renderOhlc(latest());
          }
        });
        requestAnimationFrame(() => renderOhlc(latest()));
      }
      if (!pageMode && isDesktopWidth) {
        chart.subscribeCrosshairMove((param) => {
          const tooltipEl = crosshairTooltipRef.current;
          const wrapEl = containerRef.current;
          if (!tooltipEl || !wrapEl) return;
          const activeSeries = chartStyleRef.current === "line" ? lineCloseRef.current : candleRef.current;
          const point = activeSeries && param.seriesData.get(activeSeries);
          if (
            !param.point ||
            !point ||
            param.point.x < 0 ||
            param.point.x > wrapEl.clientWidth ||
            param.point.y < 0 ||
            param.point.y > wrapEl.clientHeight
          ) {
            tooltipEl.style.opacity = "0";
            return;
          }
          const price = "close" in point ? point.close : (point as { value: number }).value;
          const date = new Date((param.time as number) * 1000);
          const dateLabel = date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
          tooltipEl.querySelector(".chart-crosshair-tooltip-date")!.textContent = dateLabel;
          tooltipEl.querySelector(".chart-crosshair-tooltip-price")!.textContent = formatLivePrice(price);
          const tooltipWidth = 150;
          let left = param.point.x + 14;
          if (left + tooltipWidth > wrapEl.clientWidth) left = param.point.x - tooltipWidth - 14;
          let top = param.point.y - 44;
          if (top < 0) top = param.point.y + 14;
          tooltipEl.style.left = `${left}px`;
          tooltipEl.style.top = `${top}px`;
          tooltipEl.style.opacity = "1";
        });
      }
    };

    initChart();

    return () => {
      isMounted = false;
      chartRef.current?.remove();
      chartRef.current = candleRef.current = lineCloseRef.current = volumeRef.current = null;
      bbUpperRef.current = bbMiddleRef.current = bbLowerRef.current = null;
      bbFillUpperRef.current = bbFillLowerRef.current = null;
      ema20Ref.current = ema50Ref.current = ema200Ref.current = null;
      ma20Ref.current = ma50Ref.current = ma200Ref.current = null;
      viewInitializedForRef.current = null;
    };
  }, [isLight]);

  // ── Predict handler ───────────────────────────────────────────────────────

  // ── Update chart colours on theme change ────────────────────────────────
  useEffect(() => {
    const themeOpts = {
      layout: {
        // #trade: the top matches the page background exactly (seamless
        // with everything around it) and a faint icy blue fades in toward
        // the bottom; every other chart keeps a flat background.
        // #trade: light theme gets the soft fade; dark theme has no chart
        // background at all (transparent — sits straight on the page).
        // Phones (chart page): no chart background at all — sits on the page.
        background: prefsScope === "trade" && !pageMode
          ? isLight && isDesktopWidth
            ? { type: ColorType.VerticalGradient, topColor: bgColor, bottomColor: "#fcfcfd" }
            : { type: ColorType.Solid, color: "transparent" }
          : { type: ColorType.Solid, color: bgColor },
        textColor,
      },
      localization: !isFullscreen && isDesktopWidth
        ? { priceFormatter: formatCompactAxisPrice }
        : { priceFormatter: undefined },
      grid: {
        // Reference-match (TradingView desktop chart): dotted gridlines
        // on the Advance Chart page specifically — every other view keeps
        // the existing solid (default) grid style.
        vertLines: { color: showGrid ? gridColor : "transparent", style: pageMode ? LineStyle.Dotted : LineStyle.Solid },
        horzLines: { color: showGrid ? gridColor : "transparent", style: pageMode ? LineStyle.Dotted : LineStyle.Solid },
      },
      rightPriceScale: { borderColor: showGrid ? gridColor : "transparent" },
      timeScale: { borderColor: gridColor },
      crosshair: {
        vertLine: {
          color: isLight ? "#0a0b0d" : "#9490c0",
          labelBackgroundColor: isLight ? "#0a0b0d" : "#2b2748",
        },
        horzLine: {
          color: isLight ? "#0a0b0d" : "#9490c0",
          labelBackgroundColor: isLight ? "#0a0b0d" : "#2b2748",
        },
      },
      // Pan/zoom only once expanded — in the compact inline card these
      // gestures mostly just fight with the page's own scroll/swipe
      // instead of being useful, so the compact view is display-only and
      // double-click (see .chart-dblclick-wrap) is the way to zoom at all.
      // vertTouchDrag now follows isFullscreen too — the fullscreen page
      // itself no longer scrolls at all on mobile (a fixed header + a
      // non-scrolling flex layout instead), so there's nothing left for
      // this gesture to compete with there; a single-finger vertical drag
      // now pans/zooms the price scale, same as TradingView. Compact view
      // still needs it off, since that page does scroll normally.
      // Desktop chart page: always draggable / zoomable (TradingView-like);
      // elsewhere only in fullscreen, as before.
      handleScroll: { mouseWheel: chartInteractive, pressedMouseMove: chartInteractive, horzTouchDrag: chartInteractive, vertTouchDrag: chartVertDrag },
      handleScale: {
        mouseWheel: chartInteractive,
        pinch: chartInteractive,
        axisPressedMouseMove: chartInteractive,
      },
    };
    const chart = chartRef.current;
    chart?.applyOptions(themeOpts);
    rsiChartRef.current?.applyOptions(themeOpts);
    macdChartRef.current?.applyOptions(themeOpts);
    bbFillLowerRef.current?.applyOptions({ topColor: bgColor, bottomColor: bgColor });
    // Keeps the real candle series' own paint transparent (so the
    // RoundedCandleOverlay shows through) in sync on a plain fullscreen
    // toggle too, not just the initial chart creation — see the long
    // comment at this series' addSeries() call above for why this is
    // transparent colors, not visible:false.
    {
      const candleColorsTransparent = (chartStyleRef.current as ChartStyle) !== "line";
      candleRef.current?.applyOptions({
        upColor: candleColorsTransparent ? "transparent" : "#4ade80",
        downColor: candleColorsTransparent ? "transparent" : "#fb7185",
        borderUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
        borderDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
        wickUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
        wickDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
      });
    }
    // Mirrors the volume scaleMargins set at chart creation (initChart,
    // above) — that only re-runs on a theme change, not a plain
    // fullscreen toggle, so this effect (which DOES fire on every
    // fullscreen toggle) needs its own copy to actually keep the volume
    // bars clear of the mobile fullscreen dock when just entering/
    // exiting fullscreen without a theme change alongside it.
    chart?.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: isFullscreen && !isDesktopWidth && !pageMode ? 0.14 : 0 },
    });

    // THIS is the effect that actually fires on a fullscreen toggle — the
    // chart instance itself is NOT recreated here (that only happens on a
    // theme change, a separate effect above), so the "reset the view"
    // logic that used to live only inside chart creation never ran for a
    // plain fullscreen enter/exit at all. prevIsFullscreenForToggleRef
    // scopes this to an actual isFullscreen transition specifically —
    // this effect also fires for grid/theme changes alone, which
    // shouldn't reset the zoom the user was just looking at. Style is no
    // longer force-changed here (it used to reset to "candle" on every
    // fullscreen toggle) — chartStyle is a persisted user preference now
    // (chart_prefs_v1), so entering/exiting fullscreen shouldn't silently
    // override whatever style the user picked.
    if (chart && prevIsFullscreenForToggleRef.current !== isFullscreen) {
      prevIsFullscreenForToggleRef.current = isFullscreen;
      if (lastCandlesRef.current.length > 0) {
        const window = viewWindowFor(interval);
        const lastCandleTime = lastCandlesRef.current[lastCandlesRef.current.length - 1].time as number;
        if (window) {
          chart.timeScale().setVisibleRange({
            from: (lastCandleTime - window) as UTCTimestamp,
            to: lastCandleTime as UTCTimestamp,
          });
        } else {
          chart.timeScale().fitContent();
        }
      }
    }
  // redrawCandleSeries intentionally omitted — a useCallback with []
  // deps, so its reference is provably stable across renders; including
  // it would need a forward reference this effect can't take (it's
  // declared further down the component).
  }, [theme, isFullscreen, showGrid, bgColor, textColor, gridColor, interval, chartInteractive]);

  // ── Fetch candles ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const waitForSeriesReady = async () => {
      let attempts = 0;
      while (!cancelled && !candleRef.current && attempts < 200) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        attempts += 1;
      }
    };

    const fetchKey = `${coin}:${interval}`;
    const isBackgroundRefresh = hasLoadedOnce && lastLoadedKeyRef.current === fetchKey;
    lastLoadedKeyRef.current = fetchKey;

    const fetch = async () => {
      if (!isBackgroundRefresh) setLoading(true);
      setError("");
      if (!hasLoadedOnce) {
        await waitForSeriesReady();
        if (!cancelled) {
          // Prefer the user's own real last-seen candles for this coin/
          // interval (persisted across page loads) over the generic
          // hardcoded shape — real price scale, real history, actually
          // theirs, just stale for a moment. Only genuinely new
          // coin/interval combos ever fall back to the synthetic one.
          const fake =
            readChartCandleCache(coin, interval) ?? makeFakeFirstLoadCandles();
          // Drawn in the chart's own style — candles (the default now), or a
          // line only when the line style is picked — so the blurred
          // loading backdrop looks like the chart that's about to appear.
          if ((chartStyleRef.current as ChartStyle) === "line") {
            lineCloseRef.current?.setData(
              fake.map((c) => ({ time: c.time, value: c.close })),
            );
            lineCloseRef.current?.applyOptions({ visible: true, color: "#818cf8" });
            candleRef.current?.applyOptions({ visible: false });
          } else {
            // The candles are painted by RoundedCandleOverlay from
            // lastCandlesRef — give it the placeholder (flagged, so it's
            // never mistaken for real data below) and make it repaint.
            lastCandlesRef.current = fake;
            placeholderCandlesRef.current = true;
            redrawCandleSeries(fake);
            candleRef.current?.applyOptions({ visible: true });
            lineCloseRef.current?.applyOptions({ visible: false });
            setChartGeneration((g) => g + 1);
          }
          volumeRef.current?.setData(
            fake.map((c) => ({
              time: c.time,
              value: c.volume ?? 0,
              color: volColor(c.close >= c.open),
            })),
          );
          chartRef.current?.timeScale().fitContent();
        }
      }
      try {
        // Kept date range: load enough candles to cover it (capped).
        const rangeSpan = rangeSecondsRef.current?.interval === interval ? rangeSecondsRef.current.seconds : undefined;
        const fresh = await coinglass.getHistoricalCandles(interval, coin, rangeSpan);
        if (cancelled) return;
        // (The candle placeholder is never "data" — only real candles are.)
        const data = fresh.length > 0 ? fresh : placeholderCandlesRef.current ? [] : lastCandlesRef.current;
        placeholderCandlesRef.current = false;
        if (data.length === 0) {
          setError(t("chart.noData"));
          // Nothing real ever came in for this coin/interval, so whatever
          // is on the canvas right now is only the fake/cached first-load
          // placeholder (see makeFakeFirstLoadCandles/readChartCandleCache
          // above) — showing it next to an error message reads as real
          // (if stale) data, which it never was.
          lineCloseRef.current?.setData([]);
          candleRef.current?.setData([]);
          volumeRef.current?.setData([]);
        } else {
          if (fresh.length > 0) {
            lastCandlesRef.current = fresh;
            writeChartCandleCache(coin, interval, fresh);
          }
          await waitForSeriesReady();
          if (cancelled) return;
          redrawCandleSeries(data);
          // The !hasLoadedOnce branch above force-hides candleRef (always-
          // line placeholder, by design) — now that real data is in,
          // restore its visibility to match the CURRENT style. Forcing
          // "candle" everywhere (chartStyleRef is now always "candle",
          // never "line" by default) means the chartStyle-sync effect
          // elsewhere never re-fires to undo that hide on its own (its
          // deps don't change if chartStyle was already "candle" from
          // mount), so candles silently never appeared after the very
          // first load — or after switching coins, which goes through
          // this same !hasLoadedOnce placeholder path again.
          candleRef.current?.applyOptions({ visible: (chartStyleRef.current as ChartStyle) !== "line" });
          lineCloseRef.current?.applyOptions({ visible: (chartStyleRef.current as ChartStyle) === "line" });
          // RoundedCandleOverlay only repaints when its
          // own `generation` prop changes or a visible-time-range event
          // fires on the chart — neither is guaranteed to happen exactly
          // when real data replaces the first-load placeholder, which is
          // what actually left the overlay blank/stale on some loads (the
          // real series itself was already fixed above, but the overlay
          // painting on top of it wasn't repainting in sync). Bumping
          // this here forces it to redraw against the real data every
          // time, not just at initial chart creation.
          setChartGeneration((g) => g + 1);
          updateCurrentPrice(data[data.length - 1].close);
          if (showFibRef.current) redrawFibLines();
          volumeRef.current?.setData(
            data.map((c) => ({
              time: c.time,
              value: c.volume ?? 0,
              color: volColor(c.close >= c.open),
            })),
          );
          const { upper, middle, lower } = calcBollingerBands(data);
          bbUpperRef.current?.setData(upper);
          bbMiddleRef.current?.setData(middle);
          bbLowerRef.current?.setData(lower);
          bbFillUpperRef.current?.setData(upper);
          bbFillLowerRef.current?.setData(lower);

          // S/R, Buy/Sell zone, and 24H High/Low are all rendered by their
          // own dedicated effects below (redrawn on toggle without
          // re-fetching candles) — this just computes the raw data they
          // read from state.
          const { resistance, support } = calcSupportResistance(data);
          setSrLevels({ resistance, support });

          // Buy/sell zone — always calculate for signal direction; chart lines only for Pro+
          const lastPrice = data[data.length - 1].close;
          const zones = calcBuySellZones(data);
          setZone(zones);
          onZoneChange?.(isPaid ? zones : null, lastPrice);

          const now24 = Date.now() / 1000;
          const cutoff24 = now24 - 86400;
          // For 1sec/1min only a few minutes of data exist — use all of it.
          // For 1week candles open days ago and won't pass the filter — fallback to last candle.
          const shortInterval =
            interval === "1sec" ||
            interval === "1min" ||
            interval === "5min" ||
            interval === "15min" ||
            interval === "all";
          const filtered24 = shortInterval
            ? data
            : data.filter((c) => (c.time as number) >= cutoff24);
          const hlCandles = filtered24.length > 0 ? filtered24 : data.slice(-1);
          if (hlCandles.length > 0) {
            const dHigh = Math.max(...hlCandles.map((c) => c.high));
            const dLow = Math.min(...hlCandles.map((c) => c.low));
            setDayHigh(dHigh);
            setDayLow(dLow);
            const windowOpen = hlCandles[0].open;
            if (windowOpen) {
              setDayChangeAbs(lastPrice - windowOpen);
              setDayChangePercent(((lastPrice - windowOpen) / windowOpen) * 100);
            } else {
              setDayChangeAbs(null);
              setDayChangePercent(null);
            }
          } else {
            setDayHigh(null);
            setDayLow(null);
            setDayChangeAbs(null);
            setDayChangePercent(null);
          }

          const newBanner = analyzeInterval(data, t(`priceChart.ivLabel.${interval}`, INTERVAL_LABELS[interval]));
          setBanner(newBanner);
          setBannerAt(newBanner ? Date.now() : null);

          // Show cached or rule-based insight immediately; fallback is trend-aware
          const cached = readPatternCache(coin, interval);
          if (cached) {
            setPatternInsight(cached.data);
            setPatternInsightAt(cached.at);
          } else {
            setPatternInsight(trendAwarePattern(data, newBanner?.sentiment ?? null));
            setPatternInsightAt(Date.now());
          }
          // AI pattern call only while the viewer has the AI chart read
          // open (on request), and only if quota allows.
          if (aiReadOpenRef.current) runPatternAIRef.current(data);

          // EMA / MA overlays
          ema20Ref.current?.setData(calcEMALine(data, 20));
          ema50Ref.current?.setData(calcEMALine(data, 50));
          ema200Ref.current?.setData(calcEMALine(data, 200));
          ma20Ref.current?.setData(calcSMALine(data, 20));
          ma50Ref.current?.setData(calcSMALine(data, 50));
          ma200Ref.current?.setData(calcSMALine(data, 200));

          // Push data to indicator charts if they exist
          const rsiData = calcRSI(data);
          if (rsiSeriesRef.current) {
            rsiSeriesRef.current.setData(rsiData);
          }

          // RSI divergence — always calculate for signal direction; markers only for Pro+
          const div = detectRSIDivergence(data, rsiData);
          setDivergence(div);
          if (candleRef.current) {
            const priceMarkers: SeriesMarker<number>[] = (div && isPaid && !forceHideIndicators)
              ? div.pivots.map((p, pi, all) => ({
                  time: p.time,
                  position:
                    div.type === "bullish"
                      ? ("belowBar" as const)
                      : ("aboveBar" as const),
                  shape:
                    div.type === "bullish"
                      ? ("arrowUp" as const)
                      : ("arrowDown" as const),
                  color: div.type === "bullish" ? "#4ade80" : "#fb7185",
                  size: 3,
                  // Label once (latest pivot) — two labels side by side overlapped.
                  text: pi === all.length - 1 ? (div.type === "bullish" ? t("priceChart.canvas.bullDiv") : t("priceChart.canvas.bearDiv")) : "",
                }))
              : [];
            if (!divMarkersRef.current) {
              divMarkersRef.current = createSeriesMarkers(
                candleRef.current,
                priceMarkers,
              );
            } else {
              divMarkersRef.current.setMarkers(priceMarkers);
            }
          }
          if (rsiSeriesRef.current) {
            const rsiMarkers: SeriesMarker<number>[] = div
              ? div.pivots.map((p) => ({
                  time: p.time,
                  position:
                    div.type === "bullish"
                      ? ("belowBar" as const)
                      : ("aboveBar" as const),
                  shape:
                    div.type === "bullish"
                      ? ("arrowUp" as const)
                      : ("arrowDown" as const),
                  color: div.type === "bullish" ? "#4ade80" : "#fb7185",
                  size: 2,
                }))
              : [];
            if (!rsiDivMarkersRef.current) {
              rsiDivMarkersRef.current = createSeriesMarkers(
                rsiSeriesRef.current,
                rsiMarkers,
              );
            } else {
              rsiDivMarkersRef.current.setMarkers(rsiMarkers);
            }
          }
          if (
            macdHistRef.current &&
            macdLineRef.current &&
            macdSignalRef.current
          ) {
            const { macdLine, signalLine, histogram } = calcMACD(data);
            macdHistRef.current.setData(histogram);
            macdLineRef.current.setData(macdLine);
            macdSignalRef.current.setData(signalLine);
          }

          // Set visible range only on first load for this coin+interval — preserves zoom on refresh
          const viewKey = `${coin}-${interval}`;
          if (viewInitializedForRef.current !== viewKey) {
            viewInitializedForRef.current = viewKey;
            const window = viewWindowFor(interval);
            const pending = pendingRangeRef.current;
            if (pending && pending.interval === interval && data.length > 0) {
              pendingRangeRef.current = null;
              const first = data[0].time as number;
              const last = data[data.length - 1].time as number;
              chartRef.current?.timeScale().setVisibleRange({
                from: Math.max(pending.from, first) as UTCTimestamp,
                to: Math.min(Math.max(pending.to, first), last) as UTCTimestamp,
              });
            } else if (window && data.length > 0) {
              const to = data[data.length - 1].time as number;
              chartRef.current?.timeScale().setVisibleRange({
                from: (to - window) as UTCTimestamp,
                to: to as UTCTimestamp,
              });
            } else {
              chartRef.current?.timeScale().fitContent();
            }
          }
        }
      } catch {
        if (!cancelled) {
          setError(t("chart.failed"));
          // Same reasoning as the "No chart data available" branch above —
          // only clear when there's no real data to fall back on, so a
          // failed refetch on an already-loaded coin still shows its last
          // real (stale) chart rather than wiping a working view.
          if (lastCandlesRef.current.length === 0) {
            lineCloseRef.current?.setData([]);
            candleRef.current?.setData([]);
            volumeRef.current?.setData([]);
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setHasLoadedOnce(true);
        }
      }
    };
    fetch();
    return () => {
      cancelled = true;
    };
  }, [interval, refreshTrigger, coin]);

  // ── Clear prediction + divergence on interval/coin change ────────────────
  useEffect(() => {
    setPredictionPath(null);
    setChartPrediction(null);
    setDivergence(null);
    divMarkersRef.current?.setMarkers([]);
    rsiDivMarkersRef.current?.setMarkers([]);
    divMarkersRef.current = null;
    rsiDivMarkersRef.current = null;
  }, [interval, coin]);

  // ── Bid/ask + base-asset volume for the fullscreen stats bar ─────────────
  // Only polled while that bar is actually on screen (fullscreen, any
  // width — mobile and desktop both show it now) — it's the only
  // consumer, and Binance's /24hr ticker is cheap but no reason to hit it
  // in the background.
  useEffect(() => {
    if (!isFullscreen) {
      setBidPrice(null);
      setAskPrice(null);
      setBaseVolume24h(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const snap = await getTickerSnapshot(coin);
      if (!cancelled && snap) {
        setBidPrice(snap.bid);
        setAskPrice(snap.ask);
        setBaseVolume24h(snap.volume);
      }
    };
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [coin, isFullscreen]);

  // ── Live forming candle on EVERY timeframe (Binance kline stream) ───────
  // The last bar grows tick by tick. Chart series are updated directly
  // (no React render per tick); the price readout updates ≤1×/s and the
  // ProVision live tail ≤ every 2.5s so it re-reads in near real time.
  const liveLastPriceAt = useRef(0);
  const liveLastTailAt = useRef(0);
  const liveIv = binanceKlineInterval(interval);
  useLiveKline(coin, liveIv, (candle) => {
    if (!candleRef.current) return;
    const cs = lastCandlesRef.current;
    const last = cs[cs.length - 1];
    if (!last || candle.time < last.time) return; // stale / before history loaded
    // Keep our own copy in step so overlays / ProVision see the live bar.
    if (candle.time === last.time) cs[cs.length - 1] = { ...last, ...candle };
    else cs.push(candle);
    if (chartStyleRef.current === "line") {
      lineCloseRef.current?.update({ time: candle.time as UTCTimestamp, value: candle.close });
    } else if (chartStyleRef.current === "hollow") {
      candleRef.current.update({ ...candle, time: candle.time as UTCTimestamp, color: candle.close >= candle.open ? "transparent" : undefined });
    } else if (chartStyleRef.current === "candle") {
      candleRef.current.update({ ...candle, time: candle.time as UTCTimestamp });
    }
    volumeRef.current?.update({
      time: candle.time as UTCTimestamp,
      value: candle.volume,
      color: volColor(candle.close >= candle.open),
    });
    const now = Date.now();
    if (now - liveLastPriceAt.current >= 1000) {
      liveLastPriceAt.current = now;
      updateCurrentPrice(candle.close);
    }
    if (pvActiveRef.current && now - liveLastTailAt.current >= 2500) {
      liveLastTailAt.current = now;
      setPvLiveTail([candle]);
      setPvUpdatedAt(now);
    }
  });
  useEffect(() => { setIsLive(!!liveIv); }, [liveIv]);

  // ── Fallback polling (1sec + 1min) when the stream is unavailable ───────
  useEffect(() => {
    // The kline stream above covers these now; this stays only as a
    // backstop for coins Binance doesn't list (stream can't connect).
    if ((interval !== "1sec" && interval !== "1min") || liveIv) {
      return;
    }
    const isSecond = interval === "1sec";
    const timer = window.setInterval(
      async () => {
        const candle = isSecond
          ? await coinglass.getLiveSecondCandle(coin)
          : await coinglass.getLiveMinuteCandle(coin);
        if (candle) {
          // Heikin Ashi needs the running prior-bar state to update
          // correctly tick-by-tick — skipped here and left to catch up on
          // the next full refresh rather than injecting a raw (wrong) bar.
          if (chartStyleRef.current === "line") {
            lineCloseRef.current?.update({ time: candle.time, value: candle.close });
          } else if (chartStyleRef.current === "hollow") {
            candleRef.current?.update({
              ...candle,
              color: candle.close >= candle.open ? "transparent" : undefined,
            });
          } else if (chartStyleRef.current === "candle") {
            candleRef.current?.update(candle);
          }
          updateCurrentPrice(candle.close);
          if (candle.volume !== undefined) {
            volumeRef.current?.update({
              time: candle.time,
              value: candle.volume,
              color: volColor(candle.close >= candle.open),
            });
          }
        }
      },
      isSecond ? 1_000 : 10_000,
    );
    return () => {
      window.clearInterval(timer);
      setIsLive(false);
    };
  }, [interval, coin]);

  // ── Refetch interval trends on coin/refresh change ───────────────────────
  // banner/zone/patternInsight are intentionally left alone here — they
  // used to get nulled out immediately, which meant those panels just
  // vanished the instant a coin/interval switch started instead of
  // staying on screen (blurred, see .price-chart-container--loading) until
  // the fresh fetch actually replaces them.
  useEffect(() => {
    setTrends({});
    coinglass
      .getIntervalTrends(coin)
      .then(setTrends)
      .catch(() => {});
  }, [refreshTrigger, coin]);

  useEffect(() => {
    lastCandlesRef.current = [];
  }, [coin]);

  // ── Overlay visibility ───────────────────────────────────────────────────
  useEffect(() => {
    bbUpperRef.current?.applyOptions({ visible: showBB });
    bbMiddleRef.current?.applyOptions({ visible: showBB });
    bbLowerRef.current?.applyOptions({ visible: showBB });
    bbFillUpperRef.current?.applyOptions({ visible: showBB });
    bbFillLowerRef.current?.applyOptions({ visible: showBB });
  }, [showBB]);
  useEffect(() => {
    ema20Ref.current?.applyOptions({ visible: showEMA20 });
  }, [showEMA20]);
  useEffect(() => {
    ema50Ref.current?.applyOptions({ visible: showEMA50 });
  }, [showEMA50]);
  useEffect(() => {
    ema200Ref.current?.applyOptions({ visible: showEMA200 });
  }, [showEMA200]);
  useEffect(() => {
    ma20Ref.current?.applyOptions({ visible: showMA20 });
  }, [showMA20]);
  useEffect(() => {
    ma50Ref.current?.applyOptions({ visible: showMA50 });
  }, [showMA50]);
  useEffect(() => {
    ma200Ref.current?.applyOptions({ visible: showMA200 });
  }, [showMA200]);

  // ── Chart style (candle / hollow / line / Heikin Ashi) ───────────────────
  // candleRef stays a CandlestickSeries at all times (every price-line
  // feature in this file — S/R, zones, Fib, CME, day H/L — is anchored to
  // it), so "line" mode just hides it and shows lineCloseRef instead,
  // rather than swapping series types.
  const redrawCandleSeries = useCallback((candles: CandleDataPoint[]) => {
    lineCloseRef.current?.setData(
      candles.map((c) => ({ time: c.time, value: c.close })),
    );
    if (candles.length > 1) {
      const first = candles[0].close;
      const last = candles[candles.length - 1].close;
      const pctChange = first !== 0 ? ((last - first) / first) * 100 : 0;
      // A small dead zone around 0 reads as "flat" (blue/neutral) rather
      // than flipping to green/red on a barely-there move.
      const color = pctChange > 0.15 ? "#4ade80" : pctChange < -0.15 ? "#fb7185" : "#818cf8";
      setLineTrendColor(color);
      lineCloseRef.current?.applyOptions({ color });
    }
    if (!candleRef.current) return;
    const style = chartStyleRef.current;
    const source = style === "heikinAshi" ? calcHeikinAshi(candles) : candles;
    if (style === "hollow") {
      candleRef.current.setData(
        source.map((c) => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          color: c.close >= c.open ? "transparent" : undefined,
        })),
      );
    } else {
      candleRef.current.setData(source);
    }
  }, []);

  useEffect(() => {
    chartStyleRef.current = chartStyle;
    candleRef.current?.applyOptions({ visible: chartStyle !== "line" });
    lineCloseRef.current?.applyOptions({ visible: chartStyle === "line" });
    // The rounded-candle overlay (RoundedCandleOverlay, below) only knows
    // how to paint standard OHLC bodies — picking Hollow/Line/Heikin Ashi
    // from the style dropdown needs the REAL series visible again (not
    // forced transparent) so those styles actually render, instead of the
    // overlay silently keeping yesterday's plain candles on screen no
    // matter what style got picked.
    const candleColorsTransparent = chartStyle !== "line";
    candleRef.current?.applyOptions({
      upColor: candleColorsTransparent ? "transparent" : "#4ade80",
      downColor: candleColorsTransparent ? "transparent" : "#fb7185",
      borderUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
      borderDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
      wickUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
      wickDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
    });
    if (lastCandlesRef.current.length > 0) redrawCandleSeries(lastCandlesRef.current);
  }, [chartStyle, isFullscreen, isDesktopWidth, redrawCandleSeries]);

  // ── Fibonacci retracement lines ──────────────────────────────────────────
  const redrawFibLines = useCallback(() => {
    for (const pl of fibLineRefs.current) {
      try {
        candleRef.current?.removePriceLine(pl);
      } catch {
        /* ok */
      }
    }
    fibLineRefs.current = [];
    if (!showFibRef.current || !candleRef.current) return;
    const candles = lastCandlesRef.current;
    if (candles.length === 0) return;
    const high = Math.max(...candles.map((c) => c.high));
    const low = Math.min(...candles.map((c) => c.low));
    const range = high - low;
    for (const { ratio, label, color } of FIB_LEVELS) {
      const price = high - ratio * range;
      const pl = candleRef.current.createPriceLine({
        price,
        color,
        lineWidth: 3,
        lineStyle: 0,
        axisLabelVisible: true,
        title: `Fib ${label}`,
      });
      if (pl) fibLineRefs.current.push(pl);
    }
  }, []);

  useEffect(() => {
    showFibRef.current = showFib;
    redrawFibLines();
  }, [showFib, redrawFibLines]);

  // ── Gann Pivot markers ───────────────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current) return;
    if (!showGann) {
      gannMarkersPluginRef.current?.setMarkers([]);
      setGannCycles([]);
      return;
    }
    const candles = lastCandlesRef.current;
    if (candles.length === 0) return;
    const n =
      interval === "1week" || interval === "1month" || interval === "all"
        ? 3
        : interval === "1day" || interval === "4h" || interval === "6h"
          ? 5
          : 8;
    const pivots = detectGannPivots(candles, n);
    if (pivots.length === 0) return;
    const lastPivot = pivots[pivots.length - 1];
    setGannCycles(computeGannCycles(lastPivot, interval));
    const markers: SeriesMarker<number>[] = pivots.map((p) => ({
      time: p.time as number,
      position: p.type === "high" ? "aboveBar" : "belowBar",
      shape: p.type === "high" ? "arrowDown" : "arrowUp",
      color: p.type === "high" ? "#fb7185" : "#4ade80",
      size: 1,
    }));
    if (!gannMarkersPluginRef.current) {
      gannMarkersPluginRef.current = createSeriesMarkers(
        candleRef.current,
        markers,
      );
    } else {
      gannMarkersPluginRef.current.setMarkers(markers);
    }
  }, [showGann, interval]);

  // Re-sync sub-chart time scales after they become visible (display:none → block
  // causes lightweight-charts to emit a stale range change that overwrites main chart)
  useEffect(() => {
    if (!showRSI && !showMACD) return;
    requestAnimationFrame(() => {
      const range = chartRef.current?.timeScale().getVisibleLogicalRange();
      if (range) {
        if (showRSI)
          rsiChartRef.current?.timeScale().setVisibleLogicalRange(range);
        if (showMACD)
          macdChartRef.current?.timeScale().setVisibleLogicalRange(range);
      } else {
        chartRef.current?.timeScale().fitContent();
      }
    });
  }, [showRSI, showMACD]);

  // ── Support / Resistance lines ───────────────────────────────────────────
  useEffect(() => {
    for (const pl of srLineRefs.current) {
      try {
        candleRef.current?.removePriceLine(pl);
      } catch {
        /* ok */
      }
    }
    srLineRefs.current = [];
    if (!showSR || !candleRef.current) return;
    for (const { price } of srLevels.resistance) {
      const pl = candleRef.current.createPriceLine({
        price,
        color: "rgba(251,113,133,0.75)",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "R",
      });
      if (pl) srLineRefs.current.push(pl);
    }
    for (const { price } of srLevels.support) {
      const pl = candleRef.current.createPriceLine({
        price,
        color: "rgba(74,222,128,0.75)",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "S",
      });
      if (pl) srLineRefs.current.push(pl);
    }
  }, [showSR, srLevels]);

  // ── Buy / Sell zone lines ────────────────────────────────────────────────
  useEffect(() => {
    for (const pl of zoneLineRefs.current) {
      try {
        candleRef.current?.removePriceLine(pl);
      } catch {
        /* ok */
      }
    }
    zoneLineRefs.current = [];
    if (!showZones || !isPaid || !zone || !candleRef.current) return;
    const zoneLines: [number, string, string][] = [
      [zone.buyZone.upper, "rgba(74,222,128,0.5)", `${t("chart.buy")} ▲`],
      [zone.buyZone.lower, "rgba(74,222,128,0.5)", `${t("chart.buy")} ▼`],
      [zone.sellZone.upper, "rgba(251,113,133,0.5)", `${t("chart.sell")} ▲`],
      [zone.sellZone.lower, "rgba(251,113,133,0.5)", `${t("chart.sell")} ▼`],
    ];
    for (const [price, color, title] of zoneLines) {
      const pl = candleRef.current.createPriceLine({
        price,
        color,
        title,
        lineWidth: 1,
        lineStyle: 3,
        axisLabelVisible: true,
      });
      if (pl) zoneLineRefs.current.push(pl);
    }
  }, [showZones, zone, isPaid]);

  // ── 24H High/Low lines ────────────────────────────────────────────────────
  useEffect(() => {
    for (const pl of dayLineRefs.current) {
      try {
        candleRef.current?.removePriceLine(pl);
      } catch {
        /* ok */
      }
    }
    dayLineRefs.current = [];
    if (!showDayHL || dayHigh === null || dayLow === null || !candleRef.current) return;
    const hlHigh = candleRef.current.createPriceLine({
      price: dayHigh,
      color: "#facc15",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "24H H",
    });
    const hlLow = candleRef.current.createPriceLine({
      price: dayLow,
      color: "#818cf8",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "24H L",
    });
    if (hlHigh) dayLineRefs.current.push(hlHigh);
    if (hlLow) dayLineRefs.current.push(hlLow);
  }, [showDayHL, dayHigh, dayLow]);

  // ── CME gap lines ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    for (const pl of cmeLineRefs.current) {
      try {
        candleRef.current?.removePriceLine(pl);
      } catch {
        /* noop */
      }
    }
    cmeLineRefs.current = [];

    if (!showCME) return;

    coinglass
      .getHistoricalCandles("1day", coin)
      .then((candles) => {
        if (cancelled || !candleRef.current || candles.length === 0) return;
        const gaps = calcCMEGaps(candles);
        for (const gap of gaps) {
          const color = "rgba(251, 191, 36, 0.85)";
          const topLine = candleRef.current.createPriceLine({
            price: gap.top,
            color,
            lineWidth: 1 as const,
            lineStyle: 2,
            axisLabelVisible: true,
            title: gap.direction === "up" ? "CME ↑▲" : "CME ↓▲",
          });
          const botLine = candleRef.current.createPriceLine({
            price: gap.bottom,
            color,
            lineWidth: 1 as const,
            lineStyle: 2,
            axisLabelVisible: true,
            title: gap.direction === "up" ? "CME ↑▼" : "CME ↓▼",
          });
          if (topLine) cmeLineRefs.current.push(topLine);
          if (botLine) cmeLineRefs.current.push(botLine);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [coin, refreshTrigger, showCME]);

  // ── Create indicator charts once on mount ───────────────────────────────
  useEffect(() => {
    const rsiEl = rsiContainerRef.current;
    const macdEl = macdContainerRef.current;
    if (!rsiEl || !macdEl) return;
    const baseOpts = {
      // Same attribution-logo opt-out as the main chart above — these sub-
      // charts (RSI/MACD panes) default it to true too.
      layout: { attributionLogo: false, background: { type: ColorType.Solid, color: bgColor }, textColor },
      // Matches the main chart — transparent until the manual Grid
      // toggle turns gridlines on (fullscreen no longer force-enables
      // them).
      grid: {
        vertLines: { color: showGrid ? gridColor : "transparent", style: pageMode ? LineStyle.Dotted : LineStyle.Solid },
        horzLines: { color: showGrid ? gridColor : "transparent", style: pageMode ? LineStyle.Dotted : LineStyle.Solid },
      },
      rightPriceScale: {
        borderColor: showGrid ? gridColor : "transparent",
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      // vertTouchDrag follows isFullscreen here too — same reasoning as
      // the main chart above.
      handleScroll: { mouseWheel: chartInteractive, pressedMouseMove: chartInteractive, horzTouchDrag: chartInteractive, vertTouchDrag: chartVertDrag },
      handleScale: {
        axisPressedMouseMove: chartInteractive,
        mouseWheel: chartInteractive,
        pinch: chartInteractive,
      },
    };

    const rsiChart = createChart(rsiEl, {
      ...baseOpts,
      autoSize: true,
      timeScale: { visible: false },
    });

    const macdChart = createChart(macdEl, {
      ...baseOpts,
      autoSize: true,
      timeScale: {
        borderColor: gridColor,
        timeVisible: true,
        secondsVisible: false,
      },
    });

    // RSI series
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rsiSeries: any = rsiChart.addSeries(LineSeries, {
      color: "#818cf8",
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    rsiSeries.createPriceLine({
      price: 70,
      color: "rgba(251,113,133,0.65)",
      lineWidth: 1 as const,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "OB",
    });
    rsiSeries.createPriceLine({
      price: 50,
      color: "rgba(148,163,184,0.25)",
      lineWidth: 1 as const,
      lineStyle: 1,
      axisLabelVisible: false,
      title: "",
    });
    rsiSeries.createPriceLine({
      price: 30,
      color: "rgba(74,222,128,0.65)",
      lineWidth: 1 as const,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "OS",
    });

    // MACD series
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const macdHist: any = macdChart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: false,
      base: 0,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const macdLn: any = macdChart.addSeries(LineSeries, {
      color: "#818cf8",
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const macdSig: any = macdChart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    macdHist.createPriceLine({
      price: 0,
      color: "rgba(148,163,184,0.3)",
      lineWidth: 1 as const,
      lineStyle: 0,
      axisLabelVisible: false,
      title: "",
    });

    rsiSeriesRef.current = rsiSeries;
    macdHistRef.current = macdHist;
    macdLineRef.current = macdLn;
    macdSignalRef.current = macdSig;
    rsiChartRef.current = rsiChart;
    macdChartRef.current = macdChart;

    // Time scale sync (bidirectional, all three charts)
    const mainChart = chartRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const syncMain = (r: any) => {
      if (syncingRef.current || !r) return;
      syncingRef.current = true;
      try {
        rsiChart.timeScale().setVisibleLogicalRange(r);
        macdChart.timeScale().setVisibleLogicalRange(r);
      } finally {
        syncingRef.current = false;
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const syncRsi = (r: any) => {
      if (syncingRef.current || !r) return;
      syncingRef.current = true;
      try {
        mainChart?.timeScale().setVisibleLogicalRange(r);
        macdChart.timeScale().setVisibleLogicalRange(r);
      } finally {
        syncingRef.current = false;
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const syncMacd = (r: any) => {
      if (syncingRef.current || !r) return;
      syncingRef.current = true;
      try {
        mainChart?.timeScale().setVisibleLogicalRange(r);
        rsiChart.timeScale().setVisibleLogicalRange(r);
      } finally {
        syncingRef.current = false;
      }
    };
    mainChart?.timeScale().subscribeVisibleLogicalRangeChange(syncMain);
    rsiChart.timeScale().subscribeVisibleLogicalRangeChange(syncRsi);
    macdChart.timeScale().subscribeVisibleLogicalRangeChange(syncMacd);

    // Populate immediately from cached candles
    const candles = lastCandlesRef.current;
    if (candles.length > 0) {
      rsiSeries.setData(calcRSI(candles));
      const { macdLine, signalLine, histogram } = calcMACD(candles);
      macdHist.setData(histogram);
      macdLn.setData(macdLine);
      macdSig.setData(signalLine);
    }

    return () => {
      mainChart?.timeScale().unsubscribeVisibleLogicalRangeChange(syncMain);
      rsiChart.timeScale().unsubscribeVisibleLogicalRangeChange(syncRsi);
      macdChart.timeScale().unsubscribeVisibleLogicalRangeChange(syncMacd);
      rsiChart.remove();
      macdChart.remove();
      rsiChartRef.current = macdChartRef.current = null;
      rsiSeriesRef.current =
        macdHistRef.current =
        macdLineRef.current =
        macdSignalRef.current =
          null;
    };
  }, []);

  // REMOVED: this used to manually forward every touchmove pixel to
  // .main-content's scrollTop (no isFullscreen guard — ran in both modes),
  // as a workaround for "iOS Safari pans the viewport on any touch-drag
  // inside the chart." That workaround predates the real fix now in
  // PriceChart.css (pointer-events:none on .chart-canvas-wrap outside
  // fullscreen + touch-action:pan-y on .chart-dblclick-wrap), which lets
  // iOS scroll .main-content on its own native fast path, full momentum
  // included. With both active at once, native momentum scroll would
  // start, then this handler's unconditional preventDefault + manual
  // scrollTop += took back over mid-gesture and killed it — exactly the
  // "smooth while the finger is still down, dead the instant you release"
  // symptom. The CSS fix alone is sufficient; this was actively fighting it.

  // ── Screenshot ───────────────────────────────────────────────────────────
  // Pulled out of handleScreenshot (below) so "Ask Agent Ready" can reuse
  // the exact same composed chart+overlays+RSI/MACD image without
  // triggering a save/share dialog — same canvas work, two different
  // destinations for the resulting data URL.
  const captureChartDataUrl = (): { dataUrl: string; filename: string } | null => {
    const mainCanvas = chartRef.current?.takeScreenshot();
    if (!mainCanvas) return null;

    const rsiCanvas =
      showRSI && rsiChartRef.current
        ? rsiChartRef.current.takeScreenshot()
        : null;
    const macdCanvas =
      showMACD && macdChartRef.current
        ? macdChartRef.current.takeScreenshot()
        : null;

    const HEADER_H = 44;
    const W = mainCanvas.width;
    const H =
      HEADER_H +
      mainCanvas.height +
      (rsiCanvas?.height ?? 0) +
      (macdCanvas?.height ?? 0);

    const out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    const ctx = out.getContext("2d")!;

    // Background
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, W, H);

    // Header bar
    ctx.fillStyle = "#0a1628";
    ctx.fillRect(0, 0, W, HEADER_H);
    ctx.fillStyle = "rgba(129,140,248,0.18)";
    ctx.fillRect(0, HEADER_H - 1, W, 1);

    // Left label: coin + interval
    ctx.font = "bold 14px 'Inter', system-ui, sans-serif";
    ctx.fillStyle = "#e2e8f0";
    ctx.textBaseline = "middle";
    const shortInterval = INTERVAL_LABELS[interval]?.split(" ")[0] ?? interval;
    ctx.fillText(`${coin}/USDT · ${shortInterval}`, 16, HEADER_H / 2);

    // Zone signal
    if (zone) {
      const sigLabel: Record<string, string> = {
        "strong-buy": t("chart.strongBuy"),
        buy: t("chart.buy"),
        oversold: t("chart.oversold"),
        neutral: t("chart.neutralZone"),
        overbought: t("chart.overbought"),
        sell: t("chart.sell"),
        "strong-sell": t("chart.strongSell"),
      };
      const sigColor: Record<string, string> = {
        "strong-buy": "#4ade80",
        buy: "#86efac",
        oversold: "#f59e0b",
        neutral: "#94a3b8",
        overbought: "#f59e0b",
        sell: "#fca5a5",
        "strong-sell": "#fb7185",
      };
      const sigText = sigLabel[zone.signal] ?? zone.signal;
      ctx.font = "bold 11px 'Inter', system-ui, sans-serif";
      ctx.fillStyle = sigColor[zone.signal] ?? "#94a3b8";
      ctx.fillText(
        `● ${sigText}`,
        W / 2 - ctx.measureText(`● ${sigText}`).width / 2,
        HEADER_H / 2,
      );
    }

    // Right label: timestamp
    ctx.font = "12px 'Inter', system-ui, sans-serif";
    ctx.fillStyle = "#64748b";
    const ts = new Date().toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    ctx.fillText(ts, W - ctx.measureText(ts).width - 16, HEADER_H / 2);

    // Draw chart canvases
    let y = HEADER_H;
    ctx.drawImage(mainCanvas, 0, y);

    // Composite drawing overlay on top of main chart (same position/size)
    const drawingCanvas = document.querySelector(
      ".cdt-canvas",
    ) as HTMLCanvasElement | null;
    if (drawingCanvas && drawingCanvas.width > 0 && drawingCanvas.height > 0) {
      ctx.drawImage(drawingCanvas, 0, y, mainCanvas.width, mainCanvas.height);
    }

    y += mainCanvas.height;
    if (rsiCanvas) {
      ctx.drawImage(rsiCanvas, 0, y);
      y += rsiCanvas.height;
    }
    if (macdCanvas) {
      ctx.drawImage(macdCanvas, 0, y);
    }

    const dataUrl = out.toDataURL("image/png");
    const filename = `${coin}-${shortInterval}-${new Date().toISOString().slice(0, 10)}.png`;
    return { dataUrl, filename };
  };

  const handleScreenshot = async () => {
    const captured = captureChartDataUrl();
    if (!captured) return;
    const { dataUrl, filename } = captured;

    if (Capacitor.isNativePlatform()) {
      // <a download> is a no-op in a WKWebView — there's no downloads
      // folder on iOS for it to land in, so the button did nothing.
      // Write the PNG to the app's cache dir instead and hand it to the
      // native share sheet, where "Save Image" drops it straight into
      // Photos (NSPhotoLibraryAddUsageDescription already covers this —
      // see Info.plist).
      try {
        const base64 = dataUrl.split(",")[1];
        const written = await Filesystem.writeFile({
          path: filename,
          data: base64,
          directory: Directory.Cache,
        });
        await Share.share({ url: written.uri, dialogTitle: t("chart.save") });
      } catch (err) {
        console.error("Chart save failed:", err);
      }
      return;
    }

    // Trigger download
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = filename;
    link.click();
  };

  // "Ask Agent Ready" button (Advance Chart page toolbar) — captures the
  // current chart the same way Save does, then hands it to TradingAgent
  // (always mounted at the App.tsx root) via the same kind of custom-
  // event trigger "open-trading-agent"/"toggle-trading-agent" already
  // use there, instead of a new prop drilled all the way down to this
  // page specifically. TradingAgent owns showing/sending it from here —
  // this just opens the panel with the image attached, doesn't auto-send.
  // Shared by the Advance Chart page's top toolbar (next to Save) and
  // ChartDrawingTools' own mobile rail (its onReset prop) — same "fit
  // everything back to the loaded range" behavior either way.
  const handleResetView = () => {
    chartRef.current?.timeScale().fitContent();
    rsiChartRef.current?.timeScale().fitContent();
    macdChartRef.current?.timeScale().fitContent();
  };
  // Chart page (desktop + phones): once the user drags / zooms the chart, a
  // small ↺ appears at the bottom of the plot to snap the view back (CMC).
  const [viewMoved, setViewMoved] = useState(false);
  useEffect(() => { setViewMoved(false); }, [coin, interval]);
  const resetMovedView = () => {
    handleResetView();
    try { chartRef.current?.priceScale("right").applyOptions({ autoScale: true }); } catch { /* chart gone */ }
    setViewMoved(false);
  };
  // Mobile toolbar "Reset": the whole chart back to its defaults — every
  // indicator off (this chart's own + the shared catalog), no grid,
  // Line style (the mobile default), normal auto-fit price scale, no date
  // range — then fit the view.
  const handleFullReset = () => {
    setShowBB(false); setShowRSI(false); setShowMACD(false);
    setShowEMA20(false); setShowEMA50(false); setShowEMA200(false);
    setShowMA20(false); setShowMA50(false); setShowMA200(false);
    setShowFib(false); setShowSR(false); setShowZones(false); setShowDayHL(false); setShowCME(false);
    clearLibIndicators();
    // Chart page (desktop + phones): its defaults are grid on + candles.
    const chartPage = prefsScope === "trade" && !pageMode;
    setShowGrid(chartPage);
    setChartStyle(chartPage ? "candle" : "line");
    setScaleMode("normal");
    setAutoScale(true);
    setRangePreset(null);
    setShowDepthProfile(false);
    setShowCompactView(false);
    setViewMoved(false);
    requestAnimationFrame(() => {
      chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
      handleResetView();
    });
  };

  const handleAskAgentReady = () => {
    const captured = captureChartDataUrl();
    if (!captured) return;
    window.dispatchEvent(new CustomEvent("open-trading-agent-with-image", {
      detail: {
        imageDataUrl: captured.dataUrl,
        prompt: t("priceChart.askAgentPrompt", { coin }),
      },
    }));
  };
  // TradingAgent's own floating trigger (bottom-right, always mounted at
  // the App.tsx root) dispatches this when tapped on this exact page
  // (triggerCapturesChart prop, App.tsx) instead of opening blank — the
  // toolbar's own "Ask Agent Ready" button was removed in favor of this
  // single entry point, so handleAskAgentReady above is now only ever
  // called from here.
  useEffect(() => {
    if (!(pageMode && isDesktopWidth)) return;
    const onRequest = () => handleAskAgentReady();
    window.addEventListener("request-chart-screenshot", onRequest);
    return () => window.removeEventListener("request-chart-screenshot", onRequest);
  }, [pageMode, isDesktopWidth, coin]);

  // The checkbox list — shared between desktop's positioned dropdown and
  // mobile's bottom sheet (indicatorsControl below).
  const indicatorsList = (
    <>
      <div className="indicators-menu-group-label">
        {t("chart.overlays")}
      </div>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showBB}
          onChange={(e) => setShowBB(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "rgba(251,113,133,0.85)" }}
        />
        <span>{t("chart.bollingerBands")}</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showEMA20}
          onChange={(e) => setShowEMA20(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "#4ade80" }}
        />
        <span>{t("chart.ema20")}</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showEMA50}
          onChange={(e) => setShowEMA50(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "#fb923c" }}
        />
        <span>{t("chart.ema50")}</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showEMA200}
          onChange={(e) => setShowEMA200(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "#c084fc" }}
        />
        <span>{t("chart.ema200")}</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showMA20}
          onChange={(e) => setShowMA20(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "#818cf8" }}
        />
        <span>{t("chart.ma20")}</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showMA50}
          onChange={(e) => setShowMA50(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "#f472b6" }}
        />
        <span>{t("chart.ma50")}</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showMA200}
          onChange={(e) => setShowMA200(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "#facc15" }}
        />
        <span>{t("chart.ma200")}</span>
      </label>
      {/* Gann Pivots indicator temporarily hidden from the menu (user
          request) — underlying detection/toggle state left intact below,
          just not reachable from the UI, so re-enabling is a one-line
          revert of this comment-out rather than rebuilding the feature. */}
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showFib}
          onChange={(e) => {
            if (!isPaid) { onOpenUpgrade?.("pro"); return; }
            setShowFib(e.target.checked);
          }}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "rgba(251,191,36,0.85)" }}
        />
        <span>{t("priceChart.ind.fib")}</span>
        <span className="tier-badge tier-badge--pro">P</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showSR}
          onChange={(e) => setShowSR(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "rgba(251,113,133,0.75)" }}
        />
        <span>{t("priceChart.ind.sr")}</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showDayHL}
          onChange={(e) => setShowDayHL(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "#facc15" }}
        />
        <span>{t("priceChart.ind.dayhl")}</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showZones}
          onChange={(e) => {
            if (!isPaid) { onOpenUpgrade?.("pro"); return; }
            setShowZones(e.target.checked);
          }}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "rgba(74,222,128,0.75)" }}
        />
        <span>{t("priceChart.ind.zones")}</span>
        <span className="tier-badge tier-badge--pro">P</span>
      </label>
      <div className="indicators-menu-divider" />
      <div className="indicators-menu-group-label">
        {t("chart.subcharts")}
      </div>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showRSI}
          onChange={(e) => setShowRSI(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "#818cf8" }}
        />
        <span>{t("chart.rsi14")}</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showMACD}
          onChange={(e) => setShowMACD(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "#f97316" }}
        />
        <span>{t("chart.macd1269")}</span>
      </label>
    </>
  );

  // Minimal dot+label chip version of the same indicator toggles above,
  // for the Advance Chart page's quick-row (no checkbox input, no group
  // headers — those didn't fit a single scrollable row of small pills).
  const fsQuickIndicators: Array<{ key: string; label: string; color: string; checked: boolean; onToggle: () => void; pro?: boolean }> = [
    { key: "bb", label: t("chart.bollingerBands"), color: "rgba(251,113,133,0.85)", checked: showBB, onToggle: () => setShowBB((v) => !v) },
    { key: "ema20", label: t("chart.ema20"), color: "#4ade80", checked: showEMA20, onToggle: () => setShowEMA20((v) => !v) },
    { key: "ema50", label: t("chart.ema50"), color: "#fb923c", checked: showEMA50, onToggle: () => setShowEMA50((v) => !v) },
    { key: "ema200", label: t("chart.ema200"), color: "#c084fc", checked: showEMA200, onToggle: () => setShowEMA200((v) => !v) },
    { key: "ma20", label: t("chart.ma20"), color: "#818cf8", checked: showMA20, onToggle: () => setShowMA20((v) => !v) },
    { key: "ma50", label: t("chart.ma50"), color: "#f472b6", checked: showMA50, onToggle: () => setShowMA50((v) => !v) },
    { key: "ma200", label: t("chart.ma200"), color: "#facc15", checked: showMA200, onToggle: () => setShowMA200((v) => !v) },
    { key: "fib", label: t("priceChart.ind.fib"), color: "rgba(251,191,36,0.85)", checked: showFib, pro: true, onToggle: () => { if (!isPaid) { onOpenUpgrade?.("pro"); return; } setShowFib((v) => !v); } },
    { key: "sr", label: t("priceChart.ind.sr"), color: "rgba(251,113,133,0.75)", checked: showSR, onToggle: () => setShowSR((v) => !v) },
    { key: "dayhl", label: t("priceChart.ind.dayhl"), color: "#facc15", checked: showDayHL, onToggle: () => setShowDayHL((v) => !v) },
    { key: "zones", label: t("priceChart.ind.zones"), color: "rgba(74,222,128,0.75)", checked: showZones, pro: true, onToggle: () => { if (!isPaid) { onOpenUpgrade?.("pro"); return; } setShowZones((v) => !v); } },
    { key: "rsi", label: t("chart.rsi14"), color: "#818cf8", checked: showRSI, onToggle: () => setShowRSI((v) => !v) },
    { key: "macd", label: t("chart.macd1269"), color: "#f97316", checked: showMACD, onToggle: () => setShowMACD((v) => !v) },
  ];
  // This chart's own indicators, listed in the shared picker by category.
  const BUILTIN_CATEGORY: Record<string, PickerItem["category"]> = {
    bb: "Volatility", ema20: "Moving Averages", ema50: "Moving Averages", ema200: "Moving Averages",
    ma20: "Moving Averages", ma50: "Moving Averages", ma200: "Moving Averages",
    cme: "Levels & Zones", fib: "Levels & Zones", sr: "Levels & Zones", dayhl: "Levels & Zones", zones: "Levels & Zones",
    rsi: "Momentum", macd: "Momentum",
  };
  const BUILTIN_DESC: Record<string, string> = {
    bb: "20-period average with ±2 standard-deviation bands — squeezes and breakouts.",
    ema20: "Fast exponential average — short-term trend and pullback support.",
    ema50: "Medium-term exponential average — the trend most swing traders watch.",
    ema200: "Long-term exponential average — bull vs bear market line.",
    ma20: "Simple 20-period average of closes.",
    ma50: "Simple 50-period average — medium-term trend.",
    ma200: "Simple 200-period average — the classic long-term trend line.",
    cme: "Price gaps left on CME Bitcoin futures over weekends — often get filled.",
    fib: "Fibonacci retracement levels from the recent swing high and low.",
    sr: "Key support and resistance levels detected from price history.",
    dayhl: "Today's 24-hour high and low as lines on the chart.",
    zones: "Highlighted areas where buyers or sellers have stepped in before.",
    rsi: "Relative Strength Index in its own panel — over 70 overbought, under 30 oversold.",
    macd: "MACD line, signal and histogram in their own panel.",
  };
  const pickerBuiltIn: PickerItem[] = fsQuickIndicators.map((ind) => ({
    id: `pc-${ind.key}`,
    name: ind.label,
    description: t(`priceChart.ind.desc.${ind.key}`, BUILTIN_DESC[ind.key]),
    kind: ind.key === "rsi" || ind.key === "macd" ? "pane" : "overlay",
    category: BUILTIN_CATEGORY[ind.key] ?? "Trend",
    checked: ind.checked,
    onToggle: ind.onToggle,
    pro: ind.pro,
    color: ind.color,
  }));

  // Indicators toggle — icon button matches Order Depth/Save/Expand
  // (chart-legend-actions), same spot on desktop and mobile. Desktop opens
  // the classic positioned dropdown under the button; mobile opens a
  // bottom sheet instead — same indicatorsList content either way.
  const indicatorsControl = (
    <div className="indicators-menu-wrapper">
      <button
        ref={indicatorsBtnRef}
        className={`chart-depth-btn chart-indicators-btn${menuOpen ? " chart-depth-btn--active" : ""}`}
        onClick={() => {
          if (!menuOpen && isDesktopWidth && indicatorsBtnRef.current) {
            const r = indicatorsBtnRef.current.getBoundingClientRect();
            setIndicatorsMenuPos({ top: r.bottom + 6, left: r.left });
          }
          if (!isDesktopWidth) { setToolsIndOpen(true); return; }
          setMenuOpen((v) => !v);
        }}
        title={t("chart.indicators")}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </svg>
        <span className="chart-icon-label">{t("chart.indicators")}</span>
      </button>
      {menuOpen && (isDesktopWidth ? (
        indicatorsMenuPos && ReactDOM.createPortal(
          <>
            <div className="indicators-menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="indicators-menu indicators-menu--portal" style={{ top: indicatorsMenuPos.top, left: indicatorsMenuPos.left }}>
              {indicatorsList}
              <div className="indicators-menu-divider" />
              <button type="button" className="indicators-menu-all" onClick={() => { setMenuOpen(false); setToolsIndOpen(true); }}>
                {libIndicators.length ? t("priceChart.allIndicatorsOn", { n: libIndicators.length }) : t("priceChart.allIndicators")} ›
              </button>
            </div>
          </>,
          document.body,
        )
      ) : (
        <BottomSheet open onClose={() => setMenuOpen(false)} title={<>{t("chart.indicators")}</>}>
            <div className="indicators-menu indicators-menu--sheet">{indicatorsList}</div>
        </BottomSheet>
      ))}
    </div>
  );

  // The "Select Interval" bottom sheet — opened by fsIntervalButton
  // (below), now the only interval control on every platform/width.
  // Rendered unconditionally (not tied to any one trigger button's own
  // mount state) further down in the main return.
  const intervalSheetPortal = intervalSheetOpen && (
    <BottomSheet open onClose={() => setIntervalSheetOpen(false)} title={<>{t("priceChart.c.selectInterval")}</>}>
        <div className="interval-sheet-list date-range-sheet-list">
          {INTERVALS.map((opt) => {
            const needsPro = PRO_INTERVALS.has(opt);
            const locked   = needsPro && !isPaid;
            const trend    = trends[opt];
            return (
              <button
                type="button"
                key={opt}
                className={`date-range-sheet-item${interval === opt ? " active" : ""}${locked ? " interval-sheet-item--locked" : ""}`}
                onClick={() => {
                  if (locked) { onOpenUpgrade?.("pro"); return; }
                  setInterval(opt);
                  setIntervalSheetOpen(false);
                }}
              >
                <span className="date-range-sheet-label">
                  {INTERVAL_SHORT[opt]}
                  {trend === "bullish" ? <span className="interval-pill-trend interval-pill-trend--up">↑</span>
                    : trend === "bearish" ? <span className="interval-pill-trend interval-pill-trend--down">↓</span>
                    : null}
                </span>
                <span className="date-range-sheet-sub">{t(`priceChart.ivDesc.${opt}`)}</span>
                {locked ? <span className="interval-sheet-item-pro">PRO</span>
                  : interval === opt ? <span className="chart-style-check">✓</span>
                  : <span />}
              </button>
            );
          })}
        </div>
    </BottomSheet>
  );

  // Grid toggle + chart-style picker — shown both in the compact view's
  // own standalone row (chart-interval-row-standalone) and in fullscreen's
  // legend-actions row, so switching into fullscreen doesn't hide them.
  // Grid toggle now renders next to Indicators in .chart-legend-actions
  // instead of alongside Chart style — split out of the combined control
  // below so it can be positioned separately while Chart style stays put.
  // Desktop Chart page (not fullscreen, not the Advance Chart page) uses the
  // exchange-style bar header instead of the classic hero header.
  // Chart page header bar — desktop AND mobile now (mobile matches the
  // desktop layout); fullscreen / the Advance Chart page / the embedded
  // MobileSymbolSheet chart keep their own headers.
  const useBarHeader = !isFullscreen && !pageMode && !forceHideHeader;
  // Mobile only: Chart / Order Book / Trades tabs under the header bar.
  // Order Book / Trades swap the chart area for the book (chart stays
  // mounted underneath, just hidden).
  const [mobileView, setMobileView] = useState<"chart" | "orderbook" | "trades">("chart");
  const mobileTabs = useBarHeader && !isDesktopWidth;
  // Mobile Trade chart: on page load, a ~2s hint in the middle of the chart
  // that some tools only work in full screen. Shown once per load.
  const [fsHint, setFsHint] = useState<"show" | "fade" | "gone">("gone");
  const fsHintShownRef = useRef(false);
  const fsHintTimersRef = useRef<number[]>([]);
  useEffect(() => {
    // Wait for the real chart (not the loading placeholder).
    if (!mobileTabs || loading || fsHintShownRef.current) return;
    fsHintShownRef.current = true;
    setFsHint("show");
    fsHintTimersRef.current = [
      window.setTimeout(() => setFsHint("fade"), 2000),
      window.setTimeout(() => setFsHint("gone"), 2400),
    ];
  }, [mobileTabs, loading]);
  useEffect(() => () => { fsHintTimersRef.current.forEach((t) => window.clearTimeout(t)); }, []);
  // Advance chart (mobile): on open, a short animation showing that a swipe
  // from the left edge closes the page. Once per load.
  const [swipeHint, setSwipeHint] = useState<"show" | "fade" | "gone">("gone");
  const swipeHintShownRef = useRef(false);
  const swipeHintTimersRef = useRef<number[]>([]);
  useEffect(() => {
    if (!pageMode || isDesktopWidth || loading || swipeHintShownRef.current) return;
    swipeHintShownRef.current = true;
    setSwipeHint("show");
    swipeHintTimersRef.current = [
      window.setTimeout(() => setSwipeHint("fade"), 2600),
      window.setTimeout(() => setSwipeHint("gone"), 3000),
    ];
  }, [pageMode, isDesktopWidth, loading]);
  useEffect(() => () => { swipeHintTimersRef.current.forEach((t) => window.clearTimeout(t)); }, []);
  // Stats-row scroll indicator (mobile): thumb size = visible share of
  // the row, position = how far it's scrolled.
  const barStatsRef = useRef<HTMLDivElement>(null);
  const [barScroll, setBarScroll] = useState({ scrollable: false, size: 1, pos: 0 });
  const updateBarScroll = useCallback(() => {
    const el = barStatsRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = {
      scrollable: max > 2,
      // Long thumb (at least ~40% of the track — reaches roughly up to
      // the coin block), like the reference.
      size: el.scrollWidth > 0 ? Math.max(0.4, Math.min(1, el.clientWidth / el.scrollWidth)) : 1,
      pos: max > 0 ? el.scrollLeft / max : 0,
    };
    // Only re-render when something actually changed.
    setBarScroll((prev) =>
      prev.scrollable === next.scrollable && Math.abs(prev.size - next.size) < 0.005 && Math.abs(prev.pos - next.pos) < 0.005
        ? prev
        : next,
    );
  }, []);
  useEffect(() => {
    const el = barStatsRef.current;
    if (!el) return;
    updateBarScroll();
    const ro = new ResizeObserver(updateBarScroll);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [mobileTabs, coin, updateBarScroll]);
  // "16Y old" / "8M old" from the coin's genesis date (when known).
  const coinAgeLabel = (() => {
    const g = coinMeta?.genesisDate;
    if (!g) return null;
    const t = Date.parse(g);
    if (!Number.isFinite(t)) return null;
    const months = Math.floor((Date.now() - t) / (30.44 * 86400000));
    if (months < 1) return i18next.t("priceChart.age.new");
    return months >= 12 ? i18next.t("priceChart.age.years", { n: Math.floor(months / 12) }) : i18next.t("priceChart.age.months", { n: months });
  })();
  const gridToggleButton = (
    <button
      type="button"
      className={`chart-depth-btn chart-grid-toggle-btn${showGrid ? " chart-depth-btn--active" : ""}`}
      onClick={() => setShowGrid((v) => !v)}
      title={showGrid ? t("priceChart.hideGrid") : t("priceChart.showGrid")}
      data-tooltip={showGrid ? t("priceChart.hideGrid") : t("priceChart.showGrid")}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
        <line x1="9" y1="3" x2="9" y2="21" />
        <line x1="15" y1="3" x2="15" y2="21" />
      </svg>
      <span className="chart-icon-label">{t("priceChart.grid")}</span>
    </button>
  );
  const gridStyleControls = (
    <div className="chart-grid-style-row">
      <div className="indicators-menu-wrapper chart-style-menu-wrapper">
        <button
          ref={styleBtnRef}
          type="button"
          className={`chart-depth-btn chart-style-btn${styleMenuOpen ? " chart-depth-btn--active" : ""}`}
          onClick={() => {
            if (!styleMenuOpen && isDesktopWidth && styleBtnRef.current) {
              const r = styleBtnRef.current.getBoundingClientRect();
              setStyleMenuPos({ top: r.bottom + 6, left: r.left });
            }
            setStyleMenuOpen((v) => !v);
          }}
          title={t("priceChart.chartStyle")}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="7" y1="3" x2="7" y2="8" />
            <rect x="4" y="8" width="6" height="8" />
            <line x1="7" y1="16" x2="7" y2="21" />
            <line x1="17" y1="5" x2="17" y2="10" />
            <rect x="14" y="10" width="6" height="6" />
            <line x1="17" y1="16" x2="17" y2="19" />
          </svg>
          <span className="chart-icon-label">{t(`priceChart.style.${chartStyle}`)}</span>
        </button>
        {styleMenuOpen && (isDesktopWidth ? (
          styleMenuPos && ReactDOM.createPortal(
            <>
              <div className="indicators-menu-backdrop" onClick={() => setStyleMenuOpen(false)} />
              <div className="indicators-menu indicators-menu--portal" style={{ top: styleMenuPos.top, left: styleMenuPos.left }}>
                {(Object.keys(CHART_STYLE_LABELS) as ChartStyle[]).map((s) => (
                  <div
                    key={s}
                    className="indicators-menu-item"
                    onClick={() => {
                      setChartStyle(s);
                      setStyleMenuOpen(false);
                    }}
                  >
                    {t(`priceChart.style.${s}`)}
                    {chartStyle === s && <span className="chart-style-check">✓</span>}
                  </div>
                ))}
              </div>
            </>,
            document.body,
          )
        ) : (
          <BottomSheet open onClose={() => setStyleMenuOpen(false)} title={<>{t("priceChart.chartStyle")}</>}>
              <div className="indicators-menu indicators-menu--sheet">
                {(Object.keys(CHART_STYLE_LABELS) as ChartStyle[]).map((s) => (
                  <div
                    key={s}
                    className="indicators-menu-item"
                    onClick={() => {
                      setChartStyle(s);
                      setStyleMenuOpen(false);
                    }}
                  >
                    {t(`priceChart.style.${s}`)}
                    {chartStyle === s && <span className="chart-style-check">✓</span>}
                  </div>
                ))}
              </div>
          </BottomSheet>
        ))}
      </div>
    </div>
  );

  // Fullscreen only (mobile/iOS and desktop alike) — Interval sits next
  // to Grid in the icon row, opening the SAME "Select Interval" bottom
  // sheet chartControlsPanel's own "more" button already uses
  // (intervalSheetOpen) rather than a second, duplicate picker.
  const fsIntervalButton = (
    <div className="indicators-menu-wrapper">
      <button
        ref={intervalBtnRef}
        type="button"
        className={`chart-depth-btn chart-fs-interval-btn${(isDesktopWidth ? intervalMenuOpen : intervalSheetOpen) ? " chart-depth-btn--active" : ""}`}
        onClick={() => {
          if (isDesktopWidth) {
            if (!intervalMenuOpen && intervalBtnRef.current) {
              const r = intervalBtnRef.current.getBoundingClientRect();
              setIntervalMenuPos({ top: r.bottom + 6, left: r.left });
            }
            setIntervalMenuOpen((v) => !v);
            return;
          }
          setIntervalSheetOpen(true);
        }}
        title={t("priceChart.c.interval")}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.5 2" />
        </svg>
        <span className="chart-icon-label">{INTERVAL_SHORT[interval]}</span>
      </button>
      {intervalMenuOpen && isDesktopWidth && intervalMenuPos && ReactDOM.createPortal(
        <>
          <div className="indicators-menu-backdrop" onClick={() => setIntervalMenuOpen(false)} />
          <div className="indicators-menu indicators-menu--portal" style={{ top: intervalMenuPos.top, left: intervalMenuPos.left }}>
            {INTERVALS.map((opt) => {
              const needsPro = PRO_INTERVALS.has(opt);
              const locked = needsPro && !isPaid;
              const trend = trends[opt];
              return (
                <div
                  key={opt}
                  className="indicators-menu-item"
                  onClick={() => {
                    if (locked) { onOpenUpgrade?.("pro"); return; }
                    setInterval(opt);
                    setIntervalMenuOpen(false);
                  }}
                >
                  <b className="interval-menu-short">{INTERVAL_SHORT[opt]}</b>
                  <span className="interval-menu-desc">{t(`priceChart.ivDesc.${opt}`)}</span>
                  {trend === "bullish" ? <span className="interval-pill-trend interval-pill-trend--up">↑</span>
                    : trend === "bearish" ? <span className="interval-pill-trend interval-pill-trend--down">↓</span>
                    : null}
                  {locked ? <span className="interval-sheet-item-pro">PRO</span>
                    : interval === opt ? <span className="chart-style-check">✓</span>
                    : null}
                </div>
              );
            })}
          </div>
        </>,
        document.body,
      )}
    </div>
  );

  // Reference-match inline interval pills (desktop, non-fullscreen only) —
  // the 11-value INTERVALS list is too many for a flat pill row like the
  // screenshot's 5m/1h/8h/1D/1W, so this shows the 5 most-used intervals
  // as real pills and folds the rest (1sec/15min/6h/1month/all) behind a
  // trailing "More" pill that opens the exact same dropdown fsIntervalButton
  // already uses above — nothing becomes unreachable, it's reorganized.
  // Re-applied on anything that can recreate the chart (theme, fullscreen,
  // coin/interval reloads), not just on toggle.
  useEffect(() => {
    chartRef.current?.priceScale("right").applyOptions({
      mode: scaleMode === "percent" ? PriceScaleMode.Percentage : scaleMode === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      autoScale,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleMode, autoScale, coin, interval, isFullscreen, theme, showGrid, loading]);
  // Mobile shows four up front (5m 1H 24H 1W); desktop keeps 4H too.
  const QUICK_INTERVALS: TimeInterval[] = isDesktopWidth
    ? ["5min", "1h", "4h", "1day", "1week"]
    : ["5min", "1h", "1day", "1week"];
  // Picked something else from the sheet/menu → it takes the last quick
  // slot (e.g. 5m 1H 24H 4H) so the row always shows the active interval.
  const shownQuickIntervals: TimeInterval[] = QUICK_INTERVALS.includes(interval)
    ? QUICK_INTERVALS
    : [...QUICK_INTERVALS.slice(0, -1), interval];
  const quickIntervalPills = (
    <div className="chart-quick-interval-pills">
      {shownQuickIntervals.map((opt) => {
        const needsPro = PRO_INTERVALS.has(opt);
        const locked = needsPro && !isPaid;
        const trend = trends[opt];
        return (
          <button
            type="button"
            key={opt}
            className={`interval-pill${interval === opt ? " interval-pill--active" : ""}`}
            onClick={() => {
              if (locked) { onOpenUpgrade?.("pro"); return; }
              setInterval(opt);
            }}
          >
            {INTERVAL_SHORT[opt]}
            {trend === "bullish" ? <span className="interval-pill-trend interval-pill-trend--up">↑</span>
              : trend === "bearish" ? <span className="interval-pill-trend interval-pill-trend--down">↓</span>
              : null}
          </button>
        );
      })}
      <button
        ref={intervalBtnRef}
        type="button"
        className={`interval-pill interval-pill--more${(isDesktopWidth ? intervalMenuOpen : intervalSheetOpen) ? " interval-pill--active" : ""}`}
        onClick={() => {
          // Same width-aware split as fsIntervalButton above: desktop gets
          // the floating anchored dropdown, mobile/iOS gets the real
          // native-style bottom sheet (.interval-sheet/intervalSheetPortal,
          // portaled to document.body below) instead of that dropdown
          // rendered small and cramped at phone width.
          if (isDesktopWidth) {
            if (!intervalMenuOpen && intervalBtnRef.current) {
              const r = intervalBtnRef.current.getBoundingClientRect();
              setIntervalMenuPos({ top: r.bottom + 6, left: r.left });
            }
            setIntervalMenuOpen((v) => !v);
            return;
          }
          setIntervalSheetOpen(true);
        }}
        title={t("priceChart.c.interval")}
      >
        {/* Always just the down arrow (the active interval is shown in
            the row itself). */}
        <svg className="interval-pill-more-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {/* fsIntervalButton (above) owns the only other copy of this exact
          dropdown, but that component is never mounted at the same time
          as this one (the toolbar picks one or the other) — without its
          own copy here, the "···" button toggled state with nothing ever
          rendering the list. Desktop only — mobile/iOS uses intervalSheetOpen
          (intervalSheetPortal, rendered once near the bottom of this
          component) instead, same as fsIntervalButton already does. */}
      {intervalMenuOpen && isDesktopWidth && intervalMenuPos && ReactDOM.createPortal(
        <>
          <div className="indicators-menu-backdrop" onClick={() => setIntervalMenuOpen(false)} />
          <div className="indicators-menu indicators-menu--portal" style={{ top: intervalMenuPos.top, left: intervalMenuPos.left }}>
            {INTERVALS.map((opt) => {
              const needsPro = PRO_INTERVALS.has(opt);
              const locked = needsPro && !isPaid;
              const trend = trends[opt];
              return (
                <div
                  key={opt}
                  className="indicators-menu-item"
                  onClick={() => {
                    if (locked) { onOpenUpgrade?.("pro"); return; }
                    setInterval(opt);
                    setIntervalMenuOpen(false);
                  }}
                >
                  <b className="interval-menu-short">{INTERVAL_SHORT[opt]}</b>
                  <span className="interval-menu-desc">{t(`priceChart.ivDesc.${opt}`)}</span>
                  {trend === "bullish" ? <span className="interval-pill-trend interval-pill-trend--up">↑</span>
                    : trend === "bearish" ? <span className="interval-pill-trend interval-pill-trend--down">↓</span>
                    : null}
                  {locked ? <span className="interval-sheet-item-pro">PRO</span>
                    : interval === opt ? <span className="chart-style-check">✓</span>
                    : null}
                </div>
              );
            })}
          </div>
        </>,
        document.body,
      )}
    </div>
  );

  // Back to a single icon button (the label+link version in between was
  // its own separate row, disconnected from the other icon controls) —
  // now styled and placed exactly like its chart-hero-icon-row siblings
  // (chart-depth-btn: depth profile/screenshot/fullscreen), not its own
  // row below the header. One constant, rendered from inside that row
  // only now, so the icon/handler still can't drift out of sync between
  // call sites.
  const chartViewSwitchRow = (
    <button
      type="button"
      className={`chart-depth-btn${showCompactView ? " chart-depth-btn--active" : ""}`}
      onClick={() => {
        if (showCompactView) { setShowCompactView(false); return; }
        openPredict();
      }}
      title={showCompactView ? t("priceChart.c.switchToFull") : t("priceChart.c.switchToCompact")}
      data-tooltip={showCompactView ? t("priceChart.c.switchToFull") : t("priceChart.c.switchToCompact")}
    >
      {/* Shape-based, not another set of lines (grid/depth/chart-style
          nearby already are) — represents the CURRENT view, not the
          target: candles while on the normal full chart, radio-wave
          while already in compact. */}
      {!showCompactView ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="3" x2="8" y2="21" />
          <rect x="6" y="8" width="4" height="8" rx="1" fill="currentColor" stroke="none" />
          <line x1="16" y1="5" x2="16" y2="19" />
          <rect x="14" y="9" width="4" height="7" rx="1" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
          <path d="M15.21 8.17 A5 5 0 0 1 15.21 15.83" />
          <path d="M8.79 8.17 A5 5 0 0 0 8.79 15.83" />
          <path d="M17.14 5.87 A8 8 0 0 1 17.14 18.13" />
          <path d="M6.86 5.87 A8 8 0 0 0 6.86 18.13" />
          <path d="M19.07 3.57 A11 11 0 0 1 19.07 20.43" />
          <path d="M4.93 3.57 A11 11 0 0 0 4.93 20.43" />
        </svg>
      )}
    </button>
  );

  // Fullscreen's persistent docked bottom sheet — options only (Style/
  // Indicators/Interval), grouped as independent accordion categories the
  // user expands one at a time instead of scrolling one long list. High/
  // Low/Vol/Signal/Bid/Ask/Divergence stay inline in the header instead
  // (chart-fs-stats-strip/chart-fs-info-row above) — this sheet never
  // duplicates live stats, only settings.
  // Chart style / grid / depth / view-switch / screenshot / fullscreen
  // icon buttons — shared by the classic header and the desktop bar header.
  const fullscreenToolBtn = (
    <button
      type="button"
      className="chart-depth-btn"
      onClick={toggleFullscreen}
      title={t("priceChart.c.fullscreen")}
      data-tooltip={t("priceChart.c.fullscreen")}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
      </svg>
      {mobileTabs && <span className="chart-tool-label">{t("priceChart.c.fullscreen")}</span>}
      {/* Desktop #trade only: text label beside the icon. */}
      {isDesktopWidth && prefsScope === "trade" && !pageMode && (
        <span className="chart-fs-label">{t("priceChart.c.fullChart")}</span>
      )}
    </button>
  );
  // Desktop Trade page: a lean toolbar (chart style, grid, compact view,
  // full screen only).
  const tradeDesktopLean = isDesktopWidth && prefsScope === "trade" && !pageMode;
  // Desktop chart page: the CoinMarketCap line chart takes the candle
  // chart's place (Market cap always; Price unless "TradingView" is picked).
  // Phones (chart page, Chart tab): same CoinMarketCap line chart, with its
  // own compact toolbar under the Chart / Order Book / Trades tabs.
  const phoneCmcPage = mobileTabs && prefsScope === "trade" && !pageMode;
  const phoneCmc = phoneCmcPage && mobileView === "chart" && !pageTabContent;
  const cmcHidesCandles = ((tradeDesktopLean && !!pageTabBar) || phoneCmc) && (chartMetric === "mcap" || cmcStyle === "line");
  const cmcLineView = cmcHidesCandles && !pageTabContent && !isFullscreen;
  // Desktop TradingView view: drawing tools rail on the chart's left edge.
  // Desktop TradingView view and the phone chart page's candle view (CMC app).
  const tvDrawRail = (tradeDesktopLean || phoneCmc) && !cmcHidesCandles && !pageTabContent && !isFullscreen;
  // Desktop chart page: floating "Analyze this chart with ProVision" prompt
  // over the chart on load (CMC's "Agentic Charts" pill) — the way into
  // ProVision (Advance Chart) from here; ✕ dismisses it for good.
  const [pvPillGone, setPvPillGone] = useState(() => {
    try { return localStorage.getItem("pvPromoPillDismissed") === "1"; } catch { return false; }
  });
  // Trial over (or Pro's daily coins used up): the banner turns into the
  // renewal prompt instead of the "Analyze" pitch. Its ✕ snoozes it for a day
  // (separately from the pitch's permanent dismiss).
  const pvPillLock = pvGate.access.lockReason(coin);
  const pvRenew = pvPillLock === "trial-ended" || pvPillLock === "pro-limit" ? pvPillLock : null;
  const [pvRenewSnoozed, setPvRenewSnoozed] = useState(() => {
    try { return Date.now() < Number(localStorage.getItem("pvRenewPillSnoozeUntil") ?? 0); } catch { return false; }
  });
  // Trial over / locked → the banner on the chart becomes the renewal
  // prompt (its ✕ snoozes it for a day).
  // Phones: the "Analyze" pitch is only for people without ProVision —
  // anyone who has it uses the ✦ in the interval row instead.
  const pvPillShown = pvRenew ? !pvRenewSnoozed : !pvPillGone && !(phoneCmc && pvGate.access.mode !== "locked");
  // (Desktop: hidden once ProVision is running on this chart.)
  // Every case (Analyze or Renew): hidden while the chart loads, then it
  // takes the "Loading chart data" pill's spot — never two pills at once.
  const pvPromoPill = (tradeDesktopLean || phoneCmc) && pvPillShown && !(isDesktopWidth && pvActive) && !loading ? (
    <div className={`pv-pill${pvRenew ? " pv-pill--renew" : ""}`} role="region" aria-label="ProVision">
      <button
        type="button"
        className="pv-pill-main"
        // Renewal → the upgrade. Signed out → sign in first. Otherwise
        // desktop turns ProVision on right here (drawn on this chart) or, if
        // this account can't use it yet, opens the ProVision screen; phones
        // go to the Advance Chart page.
        onClick={() => {
          if (pvRenew) { openProVisionPaywall({ reason: pvRenew, coin }); return; }
          if (!authUser) { onOpenAuth?.(); return; }
          if (!isDesktopWidth) { onOpenDrawingTools?.(); return; }
          if (pvGate.access.mode === "locked" && pvBannerReason) { openProVisionPaywall({ reason: pvBannerReason, coin }); return; }
          if (!pvGate.on) pvGate.toggle(coin);
        }}
      >
        <span className="pv-pill-ic" aria-hidden="true">
          {pvRenew ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
          )}
        </span>
        {pvRenew === "trial-ended" ? (
          <span><Trans i18nKey="priceChart.pill.trialEnded" components={{ b: <b className="pv-pill-brand" /> }} /> · <b className="pv-pill-renew">{t("priceChart.pill.renew")}</b></span>
        ) : pvRenew === "pro-limit" ? (
          <span><Trans i18nKey="priceChart.pill.lockedOn" values={{ coin }} components={{ b: <b className="pv-pill-brand" /> }} /> · <b className="pv-pill-renew">{t("priceChart.pill.unlock")}</b></span>
        ) : (
          <span><Trans i18nKey="priceChart.pill.analyze" components={{ b: <b className="pv-pill-brand" /> }} /></span>
        )}
        <svg className="pv-pill-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
      </button>
      <span className="pv-pill-sep" aria-hidden="true" />
      <button
        type="button"
        className="pv-pill-x"
        aria-label={t("priceChart.dismiss")}
        onClick={() => {
          if (pvRenew) {
            setPvRenewSnoozed(true);
            try { localStorage.setItem("pvRenewPillSnoozeUntil", String(Date.now() + 24 * 3600_000)); } catch { /* ignore */ }
            return;
          }
          setPvPillGone(true);
          try { localStorage.setItem("pvPromoPillDismissed", "1"); } catch { /* ignore */ }
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  ) : null;
  // Desktop #trade: Signal Check shows as a card on the chart; below the
  // chart only the track record (and alerts) stay.
  const pvHudOn = tradeDesktopLean && pvActive && !isFullscreen;
  // Phones #trade: Signal Check + event cards live inside the Consensus
  // sheet instead of stacking under the chart.
  const pvInSheet = consensusOn && !isDesktopWidth && !isFullscreen;
  // Phones, Advance Chart: the Signal Check header opens its details in a
  // bottom sheet (the card itself stays collapsed).
  const pvAdvSheetMode = prefsScope === "advance" && !isDesktopWidth;
  const [pvAdvSheetOpen, setPvAdvSheetOpen] = useState(false);
  // Score-ring card: always starts minimised (just the ring icon in the
  // bottom bar) on every load; tap the icon to bring the card up.
  const [pvRingMin, setPvRingMin] = useState(true);
  const [pvRingRestored, setPvRingRestored] = useState(false);
  const pvRingRef = useRef<HTMLButtonElement | null>(null);
  const pvRingTouchY = useRef<number | null>(null);
  const pvRingSwipeRef = useRef(false);
  // First few visits: a one-off up/down nudge hinting at the swipes.
  const [pvRingHint] = useState(() => {
    try {
      const n = Number(localStorage.getItem("pvRingHintSeen") || "0");
      if (n >= 3) return false;
      localStorage.setItem("pvRingHintSeen", String(n + 1));
      return true;
    } catch { return false; }
  });
  const setRingMin = (v: boolean) => setPvRingMin(v);
  // Phones #trade: Signal Check / Consensus tiles; one can be expanded.
  const consensusItemsRef = useRef<ConsensusItem[]>([]);
  const [insightOpen, setInsightOpen] = useState<null | "pv" | "cns">(null);
  // Bumped when the details sheet closes, to replay the docked icon's pop.
  const [pvDockPop, setPvDockPop] = useState(0);
  // Shrink + glide the card down into the far left of the bottom bar,
  // then dock it there as a small ring.
  // Self-contained (no measuring): a CSS class shrinks + slides it down-left
  // and fades it out, then the small ring docks in the bar.
  const [pvRingLeaving, setPvRingLeaving] = useState(false);
  const minimizeRing = () => {
    const el = pvRingRef.current;
    if (el) { el.style.transition = ""; el.style.transform = ""; el.style.opacity = ""; }
    setPvRingLeaving(true);
    window.setTimeout(() => { setPvRingLeaving(false); setPvRingRestored(false); setRingMin(true); }, 380);
  };
  // Signal Check (ProVisionHud): "bar" = desktop strip above the chart,
  // "card" = stacked, inside the phone Consensus sheet.
  const renderPvHud = (layout: "bar" | "card" | "pro" | "pro-wide") => {
    if (!pvResult) return null;
    const isPro = layout === "pro" || layout === "pro-wide";
    const PvView = isPro ? ProVisionSignalPanel : ProVisionHud;
    return (
    <PvView
      wide={layout === "pro-wide"}
      layout={isPro ? "card" : layout}
      result={pvResult}
      mtf={pvMtf.map((m) => ({ label: m.label, bias: m.bias }))}
      onRow={(r) => {
        if (r < 6) { setPvTileOpen(pvResult.tiles[r]); return; }
        setPvTileOpen({
          key: "macd", label: t("priceChart.vol.label"), bias: pvResult.volume.bias,
          value: pvResult.volume.buyPct >= pvResult.volume.sellPct ? t("priceChart.vol.buyersPct", { pct: Math.max(pvResult.volume.buyPct, pvResult.volume.sellPct) }) : t("priceChart.vol.sellersPct", { pct: Math.max(pvResult.volume.buyPct, pvResult.volume.sellPct) }),
          detail: t(pvResult.volume.real ? "priceChart.vol.detailReal" : "priceChart.vol.detailEst", { buy: fmtPvVol(pvResult.volume.buyVol), sell: fmtPvVol(pvResult.volume.sellVol) }),
        });
      }}
      trialLeft={pvTrialLeftMs !== null ? pvTrialLeftLabel(pvTrialLeftMs, true) : null}
      onKeep={() => openProVisionPaywall({ reason: "trial-active", coin })}
      onHowTo={() => setPvGuideOpen(true)}
      notice={(() => {
        const ev = pvEventInfo.live ?? pvEventInfo.next;
        if (ev) {
          const name = eventShortName(ev.title);
          if (pvEventInfo.live) return { icon: "⏸", text: t("priceChart.notice.eventNow", { name }), hot: true };
          const soon = ev.time - pvNow <= 2 * 3600 * 1000;
          return { icon: "⚠", text: t("priceChart.notice.eventIn", { name, time: fmtCountdown(ev.time - pvNow) }), hot: soon };
        }
        if (pvResult.regime.kind === "range") return { icon: "≈", text: t("priceChart.notice.sideways") };
        if (pvResult.barSec <= 300) return { icon: "⏱", text: pvResult.signalSource ? t("priceChart.notice.signalsFrom", { src: pvResult.signalSource }) : t("priceChart.notice.shortTf") };
        if (pvResult.liquidity.thin) return { icon: "!", text: t("priceChart.notice.thin") };
        return null;
      })()}
    />
    );
  };
  const heroIconRow = (
    <div className="chart-hero-icon-row">
      {/* Desktop #trade: the interval is a dropdown here, beside the icons
          (the pill row is hidden there). */}
      {tradeDesktopLean && fsIntervalButton}
      {/* Chart style (candle/line/area) picker — mobile and
          desktop both now; it already has its own mobile
          bottom-sheet branch built in (isDesktopWidth ? portal
          dropdown : indicators-sheet), unlike gridToggleButton
          right below, which stays desktop-only. */}
      {!isDesktopWidth && (
        <button
          type="button"
          className={`chart-depth-btn chart-ai-read-btn${aiReadOpen ? " chart-depth-btn--active" : ""}`}
          onClick={() => {
            if (aiReadOpen) setAiReadOpen(false);
            else if (isPaid) openAiRead();
            else setAiReadOpen(true);
          }}
          title={t("priceChart.aiChartRead")}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z" />
          </svg>
          <span className="chart-tool-label">{t("priceChart.aiRead")}</span>
        </button>
      )}
      {gridStyleControls}
      {/* Desktop #trade keeps only chart style, grid, compact view and full
          screen — indicators, depth profile and screenshot are hidden there. */}
      {isDesktopWidth && !tradeDesktopLean && (
        <button
          type="button"
          className={`chart-depth-btn chart-fx-btn${toolsIndOpen ? " chart-depth-btn--active" : ""}`}
          onClick={() => setToolsIndOpen(true)}
          title={t("chart.indicators")}
          data-tooltip={t("chart.indicators")}
          aria-label={t("chart.indicators")}
        >
          <span className="chart-fx-glyph">ƒx</span>
          {libIndicators.length + fsQuickIndicators.filter((i) => i.checked).length > 0 && (
            <span className="chart-fx-count">{libIndicators.length + fsQuickIndicators.filter((i) => i.checked).length}</span>
          )}
        </button>
      )}
      {isDesktopWidth && !tradeDesktopLean && gridToggleButton}
      {!tradeDesktopLean && (
      <button
        className={`chart-depth-btn${showDepthProfile ? " chart-depth-btn--active" : ""}`}
        onClick={() => setShowDepthProfile((v) => !v)}
        title={showDepthProfile ? t("priceChart.hideDepth") : t("priceChart.showDepth")}
        data-tooltip={showDepthProfile ? t("priceChart.hideDepth") : t("priceChart.showDepth")}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="6" />
          <line x1="21" y1="10" x2="6" y2="10" />
          <line x1="15" y1="14" x2="6" y2="14" />
          <line x1="12" y1="18" x2="6" y2="18" />
        </svg>
        {mobileTabs && <span className="chart-tool-label">{t("priceChart.depth")}</span>}
      </button>
      )}
      {/* Desktop only — mobile goes back to its own text link
          below the header instead (chart-compact-link, right
          after this row closes), not merged into this icon
          set. */}
      {isDesktopWidth && chartViewSwitchRow}
      {!tradeDesktopLean && (
      <button
        type="button"
        className="chart-depth-btn"
        onClick={handleScreenshot}
        title={t("chart.save")}
        data-tooltip={t("chart.save")}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
        {mobileTabs && <span className="chart-tool-label">{t("chart.save")}</span>}
      </button>
      )}
      {/* Fullscreen: in this row on desktop; on the mobile toolbar it's
          pinned at the right end instead (fullscreenToolBtn). */}
      {isDesktopWidth && fullscreenToolBtn}
    </div>
  );
  // Mobile toolbar: the whole icon row collapses into this one button.
  const showToolsButton = (
    <div className="chart-hero-icon-row">
      <button
        type="button"
        className={`chart-depth-btn chart-show-tools-btn${toolsSheetOpen ? " chart-depth-btn--active" : ""}`}
        onClick={() => setToolsSheetOpen(true)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="6" x2="14" y2="6" /><circle cx="17" cy="6" r="2.5" /><line x1="20" y1="6" x2="20" y2="6" />
          <line x1="10" y1="12" x2="20" y2="12" /><circle cx="7" cy="12" r="2.5" />
          <line x1="4" y1="18" x2="13" y2="18" /><circle cx="16" cy="18" r="2.5" />
        </svg>
        <span className="chart-tool-label">{t("priceChart.tools")}</span>
      </button>
    </div>
  );
  const toolsSwitch = (on: boolean) => <span className={`cts-switch${on ? " cts-switch--on" : ""}`} aria-hidden="true"><i /></span>;
  const toolsSheetPortal = toolsSheetOpen && (
    <BottomSheet open onClose={() => setToolsSheetOpen(false)} title={<>{t("chartBar.chartTools")}</>} className="cts-sheet" ariaLabel={t("chartBar.chartTools")}>
        <div className="interval-sheet-list date-range-sheet-list">
          {onOpenPaperTrade && (
            <button
              type="button"
              className="date-range-sheet-item cts-row cts-row--paper"
              onClick={() => { setToolsSheetOpen(false); onOpenPaperTrade(); }}
            >
              <span className="cts-row-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
              </span>
              <span className="cts-row-text">
                <span className="date-range-sheet-label">{t("priceChart.ts.paperTrade", { coin })}</span>
                <span className="date-range-sheet-sub">{t("priceChart.ts.paperTradeSub")}</span>
              </span>
              <span className="cts-row-chev">›</span>
            </button>
          )}
          <div className="cts-section-label">{t("priceChart.chartStyle")}</div>
          <div className="cts-styles">
            {(Object.keys(CHART_STYLE_LABELS) as ChartStyle[]).map((s) => (
              <button
                type="button"
                key={s}
                className={`cts-style${chartStyle === s ? " active" : ""}`}
                onClick={() => setChartStyle(s)}
              >
                {CHART_STYLE_ICONS[s]}
                <span>{t(`priceChart.style.${s}`)}</span>
              </button>
            ))}
          </div>
          {/* Every interval (1s … All) — PRO ones open the upgrade. */}
          <div className="cts-section-label">{t("priceChart.c.interval")}</div>
          <div className="cts-ivs">
            {(["1sec", "1min", "5min", "15min", "1h", "4h", "6h", "1day", "1week", "1month", "all"] as TimeInterval[]).map((iv) => {
              const pro = PRO_INTERVALS.has(iv) && !isPaid;
              return (
                <button
                  type="button"
                  key={iv}
                  className={`cts-iv${interval === iv ? " active" : ""}`}
                  onClick={() => {
                    hapticTap();
                    if (pro) { setToolsSheetOpen(false); onOpenUpgrade?.("pro"); return; }
                    setInterval(iv);
                  }}
                >
                  {TV_INTERVAL_LABEL[iv]}
                  {pro && <span className="cts-iv-pro">PRO</span>}
                </button>
              );
            })}
          </div>
          {/* "Indicators" row → opens its own sheet with the list.
              Not on the #trade chart (candle type + ProVision only). */}
          {!tradeChartLocked && (
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            onClick={() => { hapticTap(); setToolsSheetOpen(false); setToolsIndOpen(true); }}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("chart.indicators")}</span>
              <span className="date-range-sheet-sub">
                {(() => { const on = [...fsQuickIndicators.filter((i) => i.checked).map((i) => i.label), ...libIndicators.map((id) => getIndicatorDef(id)?.name ?? id)]; return on.length ? t("priceChart.ts.indicatorsOn", { n: on.length, list: `${on.slice(0, 3).join(", ")}${on.length > 3 ? "…" : ""}` }) : t("priceChart.ts.noneOn"); })()}
              </span>
            </span>
            <span className="cts-row-chev">›</span>
          </button>
          )}
          <div className="cts-section-label">{t("priceChart.tools")}</div>
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            role="switch"
            aria-checked={aiReadOpen}
            onClick={() => {
              if (aiReadOpen) { setAiReadOpen(false); return; }
              if (isPaid) openAiRead(); else setAiReadOpen(true);
              // Results show under the chart — close so they're visible.
              setToolsSheetOpen(false);
            }}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.aiChartRead")}{!isPaid && <span className="interval-sheet-item-pro">PRO</span>}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.aiSub")}</span>
            </span>
            {toolsSwitch(aiReadOpen)}
          </button>
          {!tradeChartLocked && (
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            role="switch"
            aria-checked={showDepthProfile}
            onClick={() => setShowDepthProfile((v) => !v)}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="6" /><line x1="21" y1="10" x2="6" y2="10" /><line x1="15" y1="14" x2="6" y2="14" /><line x1="12" y1="18" x2="6" y2="18" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.ts.depth")}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.depthSub")}</span>
            </span>
            {toolsSwitch(showDepthProfile)}
          </button>
          )}
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            role="switch"
            aria-checked={showGrid}
            onClick={() => setShowGrid((v) => !v)}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="1" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.grid")}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.gridSub")}</span>
            </span>
            {toolsSwitch(showGrid)}
          </button>
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            onClick={() => { hapticTap(); handleFullReset(); setToolsSheetOpen(false); }}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.ts.reset")}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.resetSub")}</span>
            </span>
          </button>
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            role="switch"
            aria-checked={showCompactView}
            onClick={() => {
              if (showCompactView) { setShowCompactView(false); return; }
              setToolsSheetOpen(false);
              openPredict();
            }}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="10" x2="21" y2="10" /><line x1="9" y1="10" x2="9" y2="20" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.c.switchToCompact")}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.predictSub")}</span>
            </span>
            {toolsSwitch(showCompactView)}
          </button>
          {onOpenDrawingTools && (
            <button
              type="button"
              className="date-range-sheet-item cts-row"
              onClick={() => {
                setToolsSheetOpen(false);
                try { sessionStorage.setItem("pcOpenDrawPanel", "1"); } catch { /* ignore */ }
                onOpenDrawingTools();
                setTimeout(() => window.dispatchEvent(new Event("pc-open-draw-panel")), 0);
              }}
            >
              <span className="cts-row-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>
              </span>
              <span className="cts-row-text">
                <span className="date-range-sheet-label">{t("priceChart.c.toolbox")}</span>
                <span className="date-range-sheet-sub">{t("priceChart.ts.drawSub")}</span>
              </span>
              <span className="cts-row-chev">›</span>
            </button>
          )}
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            onClick={() => { setToolsSheetOpen(false); handleScreenshot(); }}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.ts.saveImage")}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.saveSub")}</span>
            </span>
            <span />
          </button>
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            onClick={() => { setToolsSheetOpen(false); toggleFullscreen(); }}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.c.fullscreen")}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.fullscreenSub")}</span>
            </span>
            <span />
          </button>
        </div>
    </BottomSheet>
  );
  const fsSignalBucket = zone
    ? (zone.signal === "oversold" || zone.signal === "buy" || zone.signal === "strong-buy"
        ? "oversold"
        : zone.signal === "overbought" || zone.signal === "sell" || zone.signal === "strong-sell"
        ? "overbought"
        : "neutral")
    : null;
  const fsSignalLabel = fsSignalBucket === "oversold" ? t("chart.oversold")
    : fsSignalBucket === "overbought" ? t("chart.overbought")
    : fsSignalBucket === "neutral" ? t("chart.neutralZone")
    : null;
  const fsSignalPct = fsSignalBucket === "oversold" ? 0 : fsSignalBucket === "overbought" ? 100 : 50;
  const fsDivBucket = divergence?.type === "bearish" ? "bearish" : divergence?.type === "bullish" ? "bullish" : "none";
  const fsDivDotBucket = fsDivBucket === "bearish" ? "overbought" : fsDivBucket === "bullish" ? "oversold" : "neutral";
  const fsDivLabel = fsDivBucket === "bearish" ? t("priceChart.c.bearish")
    : fsDivBucket === "bullish" ? t("priceChart.c.bullish")
    : t("priceChart.c.none");
  const fsDivPct = fsDivBucket === "bearish" ? 0 : fsDivBucket === "bullish" ? 100 : 50;

  // Reference-match (TradingView mobile "symbol info" sheet) — the
  // Technicals gauge reuses zone.signal, the exact same real composite
  // signal already driving fsSignalBucket/the zone-signal badges
  // elsewhere on this page, just read as a 5-point Strong Sell…Strong Buy
  // scale instead of the 3-bucket oversold/neutral/overbought one those
  // use. oversold/overbought fold into Buy/Sell respectively — same
  // bullish-on-oversold convention fsSignalBucket already uses above.
  const fsTechnicalsPct: Record<ZoneSignal, number> = {
    "strong-sell": 5, "sell": 25, "overbought": 25,
    "neutral": 50,
    "oversold": 75, "buy": 75, "strong-buy": 95,
  };
  const fsTechnicalsLabel: Record<ZoneSignal, string> = {
    "strong-sell": t("chart.strongSell"), "sell": t("chart.sell"), "overbought": t("chart.sell"),
    "neutral": t("chart.neutralZone"),
    "oversold": t("chart.buy"), "buy": t("chart.buy"), "strong-buy": t("chart.strongBuy"),
  };
  const fsTechnicalsColor: Record<ZoneSignal, string> = {
    "strong-sell": "#ef4444", "sell": "#ef4444", "overbought": "#ef4444",
    "neutral": "var(--color-text-muted)",
    "oversold": "#16a34a", "buy": "#16a34a", "strong-buy": "#16a34a",
  };
  const fsSignalClass = (signal: ZoneSignal) =>
    signal === "strong-sell" || signal === "sell" || signal === "overbought" ? " fs-hero-value--down"
    : signal === "strong-buy" || signal === "buy" || signal === "oversold" ? " fs-hero-value--up"
    : "";

  // "Option E — swipeable hero card" (user-approved) — one full, rich
  // category card at a time instead of a tap-to-reveal icon row; the
  // data itself is the card. Only the categories that actually have
  // browsable content belong here — Style/Indicators/Interval/Toolbox/
  // Alerts stay pure actions in the slim strip below since there's
  // nothing to "read" about them, just a value to set.
  const fsHeroCategories = useMemo(() => {
    const list: Array<"technicals" | "keystats" | "overview" | "about" | "stats" | "agent"> = [];
    if (zone) list.push("technicals");
    list.push("keystats", "overview", "about", "stats", "agent");
    return list;
  }, [zone]);
  const fsHeroKey = fsHeroCategories[Math.min(fsHeroIndex, fsHeroCategories.length - 1)];
  // Agent Ready's quick take, hero card only — cached per-coin for 5
  // minutes (not a real Agent Ready conversation turn, see chart-quick-
  // take edge function's own comment) so swiping back to the same coin
  // doesn't refire the request, but switching coins or waiting past the
  // window asks again.
  const fsAgentTakeCache = useRef<Record<string, { text: string; at: number } | "loading" | "error">>({});
  const [, forceFsAgentTakeRerender] = useState(0);
  useEffect(() => {
    if (!(pageMode && !isDesktopWidth && isFullscreen && fsHeroKey === "agent")) return;
    const cached = fsAgentTakeCache.current[coin];
    if (cached === "loading") return;
    if (cached && cached !== "error" && Date.now() - cached.at < 5 * 60 * 1000) return;
    fsAgentTakeCache.current[coin] = "loading";
    forceFsAgentTakeRerender((v) => v + 1);
    let cancelled = false;
    supabase.functions.invoke("chart-quick-take", {
      body: {
        coin,
        interval: INTERVAL_SHORT[interval],
        price: currentPrice,
        changePct24h: dayChangePercent,
        signal: zone ? fsTechnicalsLabel[zone.signal] : null,
      },
    }).then(({ data, error }) => {
      if (cancelled) return;
      fsAgentTakeCache.current[coin] = error || !data?.take ? "error" : { text: data.take, at: Date.now() };
      forceFsAgentTakeRerender((v) => v + 1);
    });
    return () => { cancelled = true; };
  }, [pageMode, isDesktopWidth, isFullscreen, fsHeroKey, coin, interval, currentPrice, dayChangePercent, zone]);
  const renderFsHeroCard = (key: string) => {
    switch (key) {
      case "technicals": {
        const pct = zone ? fsTechnicalsPct[zone.signal] : 50;
        const color = zone ? fsTechnicalsColor[zone.signal] : "var(--color-text-muted)";
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow">{t("priceChart.c.technicals")}</div>
              <div className={`fs-hero-value${zone ? fsSignalClass(zone.signal) : ""}`}>
                {zone ? fsTechnicalsLabel[zone.signal] : "—"}
              </div>
              <div className="fs-hero-sub">
                <span>{t("priceChart.c.divergence")} {fsDivLabel}</span>
              </div>
            </div>
            <div className="fs-hero-icon" style={{ background: `conic-gradient(${color} ${pct}%, var(--color-border) 0)` }}>
              <span className="fs-hero-icon-core" />
            </div>
          </>
        );
      }
      case "keystats":
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow">{t("priceChart.c.keyStats")}</div>
              <div className="fs-hero-value">{coinMeta?.marketCapUSD != null ? formatCompactVolume(coinMeta.marketCapUSD) : "—"}</div>
              <div className="fs-hero-sub">
                <span>{t("priceChart.c.tradingVolume24h")} {quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}</span>
              </div>
            </div>
            <span className="fs-hero-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            </span>
          </>
        );
      case "overview":
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow">{t("priceChart.c.overview")}</div>
              <div className="fs-hero-value">{coinMeta?.athUSD != null ? formatLivePrice(coinMeta.athUSD) : "—"}</div>
              <div className="fs-hero-sub">
                <span>{t("priceChart.c.circulatingSupply")} {coinMeta?.circulatingSupply != null ? `${formatCompactNumber(coinMeta.circulatingSupply)} ${coin}` : "—"}</span>
              </div>
            </div>
            <span className="fs-hero-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </span>
          </>
        );
      case "about":
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow">{t("priceChart.c.about")}</div>
              <div className="fs-hero-value">{coinMeta?.category ?? "—"}</div>
              <div className="fs-hero-sub">
                <span>{coinMeta?.homepage ? coinMeta.homepage.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : t("priceChart.c.noLink")}</span>
              </div>
            </div>
            <span className="fs-hero-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
              </svg>
            </span>
          </>
        );
      case "agent": {
        const cached = fsAgentTakeCache.current[coin];
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow-row">
                <span className="ta-trigger-orb fs-hero-agent-orb" aria-hidden="true" />
                <span className="fs-hero-eyebrow">{t("priceChart.c.agentTake")}</span>
              </div>
              {cached === "loading" || cached === undefined ? (
                <div className="fs-hero-value fs-hero-agent-loading">{t("priceChart.c.agentThinking")}</div>
              ) : cached === "error" ? (
                <div className="fs-hero-value">{t("priceChart.c.agentUnavailable")}</div>
              ) : (
                <div className="fs-hero-agent-text">{cached.text}</div>
              )}
            </div>
            <span className="fs-hero-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l1.8 4.6L18 8l-4.2 1.4L12 14l-1.8-4.6L6 8l4.2-1.4L12 2z" />
                <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
              </svg>
            </span>
          </>
        );
      }
      case "stats":
      default:
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow">{t("priceChart.c.stats")}</div>
              <div className="fs-hero-value fs-hero-value--up">{dayHigh !== null ? formatLivePrice(dayHigh) : "—"}</div>
              <div className="fs-hero-sub">
                <span className="fs-hero-sub-down">{t("priceChart.c.low")} {dayLow !== null ? formatLivePrice(dayLow) : "—"}</span>
                <span>{t("priceChart.c.volUsd")} {quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}</span>
              </div>
            </div>
            <span className="fs-hero-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" /><path d="M7 16l4-5 3 3 5-7" />
              </svg>
            </span>
          </>
        );
    }
  };

  const fsDockInner = (
    <div ref={fsDockBodyInnerRef} className={`fs-dock-body-inner${fsDockFlat ? " fs-dock-body-inner--flat" : ""}`}>

      {(!fsFocusedCategory || fsFocusedCategory === "style") && (
      <div className="fs-dock-category">
        <button type="button" className="fs-dock-category-header" onClick={() => { if (!fsDockFlat) toggleFsCategory("style"); }}>
          <span className="fs-dock-category-icon fs-dock-category-icon--style">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
              <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
              <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
              <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.2-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-4.4-4-8.9-10-8.9z" />
            </svg>
          </span>
          <span className="fs-dock-category-label">{t("priceChart.c.style")}</span>
          <svg className={`fs-dock-category-chevron${fsOpenCategories.style ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {(fsDockFlat || fsOpenCategories.style) && (
          fsDockFlat ? (
          <div className="fs-dock-category-body">
            <div className="cts-styles">
              {(Object.keys(CHART_STYLE_LABELS) as ChartStyle[]).map((s) => (
                <button
                  type="button"
                  key={s}
                  className={`cts-style${chartStyle === s ? " active" : ""}`}
                  onClick={() => { hapticTap(); setChartStyle(s); }}
                >
                  {CHART_STYLE_ICONS[s]}
                  <span>{t(`priceChart.style.${s}`)}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="date-range-sheet-item cts-row"
              role="switch"
              aria-checked={showGrid}
              onClick={() => setShowGrid((v) => !v)}
            >
              <span className="cts-row-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="1" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" /></svg>
              </span>
              <span className="cts-row-text">
                <span className="date-range-sheet-label">{t("priceChart.grid")}</span>
                <span className="date-range-sheet-sub">{t("priceChart.ts.gridSub")}</span>
              </span>
              <span className={`cts-switch${showGrid ? " cts-switch--on" : ""}`} aria-hidden="true"><i /></span>
            </button>
            {/* Indicators: one row (like Grid) → the shared Indicators screen. */}
            <button
              type="button"
              className="date-range-sheet-item cts-row"
              onClick={() => { hapticTap(); setToolsIndOpen(true); }}
            >
              <span className="cts-row-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></svg>
              </span>
              <span className="cts-row-text">
                <span className="date-range-sheet-label">{t("chart.indicators")}</span>
                <span className="date-range-sheet-sub">
                  {(() => { const on = [...fsQuickIndicators.filter((i) => i.checked).map((i) => i.label), ...libIndicators.map((id) => getIndicatorDef(id)?.name ?? id)]; return on.length ? t("priceChart.ts.indicatorsOn", { n: on.length, list: `${on.slice(0, 3).join(", ")}${on.length > 3 ? "…" : ""}` }) : t("priceChart.ts.noneOn"); })()}
                </span>
              </span>
              <span className="cts-row-chev">›</span>
            </button>
          </div>
          ) : (
          <div className="fs-dock-category-body">
            <button
              type="button"
              className={`fs-controls-row-toggle${showGrid ? " fs-controls-row-toggle--on" : ""}`}
              onClick={() => setShowGrid((v) => !v)}
            >
              <span>{t("priceChart.grid")}</span>
              <span className="fs-controls-switch" />
            </button>
            <div className="fs-controls-style-grid">
              {(Object.keys(CHART_STYLE_LABELS) as ChartStyle[]).map((s) => (
                <button
                  type="button"
                  key={s}
                  className={`fs-controls-chip${chartStyle === s ? " fs-controls-chip--active" : ""}`}
                  onClick={() => setChartStyle(s)}
                >
                  <span className="fs-controls-chip-icon">{CHART_STYLE_ICONS[s]}</span>
                  {t(`priceChart.style.${s}`)}
                </button>
              ))}
            </div>
          </div>
          )
        )}
      </div>
      )}

      {!fsDockFlat && (!fsFocusedCategory || fsFocusedCategory === "indicators") && (
      <div className="fs-dock-category">
        <button type="button" className="fs-dock-category-header" onClick={() => { if (!fsDockFlat) toggleFsCategory("indicators"); }}>
          <span className="fs-dock-category-icon fs-dock-category-icon--indicators">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" />
              <path d="M7 16l4-5 3 3 5-7" />
            </svg>
          </span>
          <span className="fs-dock-category-label">{t("chart.indicators")}</span>
          <svg className={`fs-dock-category-chevron${fsOpenCategories.indicators ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {(fsDockFlat || fsOpenCategories.indicators) && (
          <div className="fs-dock-category-body">
            {/* onChangeCapture delegates one haptic call to every
                indicator checkbox inside indicatorsList (15+ of them)
                without touching each one's own onChange — this is the
                Advance Price Chart page's dock only, so it doesn't
                affect the same indicatorsList embedded elsewhere
                (compact view / desktop fullscreen dropdowns). */}
            {fsDockFlat ? (
              <div className="cts-chips">
                {fsQuickIndicators.map((ind) => (
                  <button
                    type="button"
                    key={ind.key}
                    className={`cts-chip${ind.checked ? " active" : ""}`}
                    onClick={() => { hapticTap(); ind.onToggle(); }}
                  >
                    <span className="cts-chip-dot" style={{ background: ind.color }} />
                    {ind.label}
                    {ind.pro && !isPaid && <span className="interval-sheet-item-pro">PRO</span>}
                  </button>
                ))}
              </div>
            ) : (
            <div
              className="indicators-menu indicators-menu--sheet"
              onChangeCapture={() => { if (pageMode) hapticTap(); }}
            >
              {indicatorsList}
            </div>
            )}
          </div>
        )}
      </div>
      )}

      {(!fsFocusedCategory || fsFocusedCategory === "interval") && (
      <div className="fs-dock-category">
        <button type="button" className="fs-dock-category-header" onClick={() => { if (!fsDockFlat) toggleFsCategory("interval"); }}>
          <span className="fs-dock-category-icon fs-dock-category-icon--interval">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3.5 2" />
            </svg>
          </span>
          <span className="fs-dock-category-label">{fsDockFlat ? "Timeframe & scale" : t("priceChart.c.interval")}</span>
          <svg className={`fs-dock-category-chevron${fsOpenCategories.interval ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {(fsDockFlat || fsOpenCategories.interval) && (
          <div className="fs-dock-category-body">
            {fsDockFlat && (
              <button
                type="button"
                className="date-range-sheet-item cts-row cts-select"
                onClick={() => { hapticTap(); setIntervalSheetOpen(true); }}
              >
                <span className="cts-row-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                </span>
                <span className="cts-row-text">
                  <span className="date-range-sheet-label">{t("priceChart.c.interval")}</span>
                  <span className="date-range-sheet-sub">{t(`priceChart.ivDesc.${interval}`)}</span>
                </span>
                <span className="cts-select-value">
                  {INTERVAL_SHORT[interval]}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                </span>
              </button>
            )}
            {fsDockFlat && (
              <>
                <button
                  type="button"
                  className="date-range-sheet-item cts-row cts-select"
                  onClick={() => { hapticTap(); openDateRangeSheet(); }}
                >
                  <span className="cts-row-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
                  </span>
                  <span className="cts-row-text">
                    <span className="date-range-sheet-label">{t("priceChart.dateRange")}</span>
                    <span className="date-range-sheet-sub">{activeRangeDesc ?? t("priceChart.ts.dateRangeSub")}</span>
                  </span>
                  <span className="cts-select-value">
                    {activeRangePreset ? activeRangePreset.label : t("priceChart.ts.default")}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  </span>
                </button>
                <div className="date-range-sheet-item cts-row">
                  <span className="cts-row-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="20" x2="4" y2="4" /><path d="M8 16l4-5 3 3 5-7" /></svg>
                  </span>
                  <span className="cts-row-text">
                    <span className="date-range-sheet-label">{t("priceChart.ts.priceScale")}</span>
                    <span className="date-range-sheet-sub">{t("priceChart.ts.priceScaleSub")}</span>
                  </span>
                  <span className="cts-seg">
                    <button type="button" className={`cts-seg-btn${scaleMode === "percent" ? " active" : ""}`} aria-pressed={scaleMode === "percent"}
                      onClick={() => { hapticTap(); setScaleMode((m) => (m === "percent" ? "normal" : "percent")); }}>%</button>
                    <button type="button" className={`cts-seg-btn${scaleMode === "log" ? " active" : ""}`} aria-pressed={scaleMode === "log"}
                      onClick={() => { hapticTap(); setScaleMode((m) => (m === "log" ? "normal" : "log")); }}>log</button>
                    <button type="button" className={`cts-seg-btn${autoScale ? " active" : ""}`} aria-pressed={autoScale}
                      onClick={() => { hapticTap(); setAutoScale((a) => !a); }}>{t("priceChart.ts.auto")}</button>
                  </span>
                </div>
              </>
            )}
            {!fsDockFlat && (
            <div className="interval-sheet-list">
              {INTERVALS.map((opt) => {
                const needsPro = PRO_INTERVALS.has(opt);
                const locked = needsPro && !isPaid;
                const trend = trends[opt];
                return (
                  <button
                    type="button"
                    key={opt}
                    className={`interval-sheet-item${interval === opt ? " interval-sheet-item--active" : ""}${locked ? " interval-sheet-item--locked" : ""}`}
                    onClick={() => {
                      if (locked) { onOpenUpgrade?.("pro"); return; }
                      setInterval(opt);
                    }}
                  >
                    <span className="interval-sheet-item-label">
                      <b className="interval-menu-short">{INTERVAL_SHORT[opt]}</b>
                      <span className="interval-menu-desc">{t(`priceChart.ivDesc.${opt}`)}</span>
                      {trend === "bullish" ? <span className="interval-pill-trend interval-pill-trend--up">↑</span>
                        : trend === "bearish" ? <span className="interval-pill-trend interval-pill-trend--down">↓</span>
                        : null}
                    </span>
                    {locked ? <span className="interval-sheet-item-pro">PRO</span>
                      : interval === opt ? <span className="interval-sheet-item-check">✓</span>
                      : null}
                  </button>
                );
              })}
            </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* Tools — the Chart tools sheet's action rows, right in this sheet. */}
      {fsDockFlat && (
      <div className="fs-dock-category">
        <div className="fs-dock-category-header">
          <span className="fs-dock-category-label">{t("priceChart.tools")}</span>
        </div>
        <div className="fs-dock-category-body">
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            role="switch"
            aria-checked={showDepthProfile}
            onClick={() => { hapticTap(); setShowDepthProfile((v) => !v); }}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="6" /><line x1="21" y1="10" x2="6" y2="10" /><line x1="15" y1="14" x2="6" y2="14" /><line x1="12" y1="18" x2="6" y2="18" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.ts.depth")}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.depthSub")}</span>
            </span>
            <span className={`cts-switch${showDepthProfile ? " cts-switch--on" : ""}`} aria-hidden="true"><i /></span>
          </button>
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            role="switch"
            aria-checked={fsDrawPanelOpen}
            onClick={() => {
              hapticTap();
              const next = !fsDrawPanelOpen;
              setFsDrawPanelOpen(next);
              // Opening: collapse the sheet so the drawing rail is usable.
              if (next) setFsSheetExpanded(false);
            }}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.c.toolbox")}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.drawSub")}</span>
            </span>
            <span className={`cts-switch${fsDrawPanelOpen ? " cts-switch--on" : ""}`} aria-hidden="true"><i /></span>
          </button>
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            onClick={() => {
              hapticTap();
              setFsSheetExpanded(false);
              // PriceAlerts (App.tsx root, always mounted) owns its own
              // open state — click its real bell button.
              document.querySelector<HTMLButtonElement>(".alerts-bell")?.click();
            }}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.ts.priceAlert")}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.priceAlertSub", { coin })}</span>
            </span>
            <span className="cts-row-chev">›</span>
          </button>
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            onClick={() => { hapticTap(); setFsSheetExpanded(false); handleScreenshot(); }}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.ts.saveImage")}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.saveSub")}</span>
            </span>
            <span />
          </button>
          <button
            type="button"
            className="date-range-sheet-item cts-row"
            onClick={() => { hapticTap(); toggleFullscreen(); }}
          >
            <span className="cts-row-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
            </span>
            <span className="cts-row-text">
              <span className="date-range-sheet-label">{t("priceChart.exitFullscreen")}</span>
              <span className="date-range-sheet-sub">{t("priceChart.ts.exitFsSub")}</span>
            </span>
            <span />
          </button>
        </div>
      </div>
      )}

      {/* Market data group: Overview / Technicals / Key stats / About /
          Stats, under the chart controls. */}
      {fsDockFlat && <div className="fs-dock-group-title">{t("priceChart.marketData")}</div>}

      {/* Reference-match (TradingView mobile "symbol info" sheet) —
          Overview/Technicals/Key stats/About, Advance Chart page only
          (same pageMode scoping the existing Stats category below
          already uses) — the regular compact-chart mobile fullscreen
          doesn't grow this extra content unexpectedly. */}
      {pageMode && (!fsFocusedCategory || fsFocusedCategory === "overview") && (
      <div className="fs-dock-category">
        <button type="button" className="fs-dock-category-header" onClick={() => { if (!fsDockFlat) toggleFsCategory("overview"); }}>
          <span className="fs-dock-category-icon fs-dock-category-icon--overview">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </span>
          <span className="fs-dock-category-label">{t("priceChart.c.overview")}</span>
          <svg className={`fs-dock-category-chevron${fsOpenCategories.overview ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {(fsDockFlat || fsOpenCategories.overview) && (
          <div className="fs-dock-category-body">
            <div className="fs-info-list">
              <div className="fs-info-row">
                <span className="fs-info-label">{t("priceChart.c.allTimeHigh")}</span>
                <span className="fs-info-value">{coinMeta?.athUSD != null ? formatLivePrice(coinMeta.athUSD) : "—"}</span>
              </div>
              <div className="fs-info-row">
                <span className="fs-info-label">{t("priceChart.c.circulatingSupply")}</span>
                <span className="fs-info-value">{coinMeta?.circulatingSupply != null ? `${formatCompactNumber(coinMeta.circulatingSupply)} ${coin}` : "—"}</span>
              </div>
              <div className="fs-info-row">
                <span className="fs-info-label">{t("priceChart.c.totalSupply")}</span>
                <span className="fs-info-value">{coinMeta?.totalSupply != null ? `${formatCompactNumber(coinMeta.totalSupply)} ${coin}` : "—"}</span>
              </div>
              <div className="fs-info-row">
                <span className="fs-info-label">{t("priceChart.c.openInterest")}</span>
                <span className="fs-info-value">{oiCoins != null && currentPrice != null ? formatCompactVolume(oiCoins * currentPrice) : "—"}</span>
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      {pageMode && zone && (!fsFocusedCategory || fsFocusedCategory === "technicals") && (
      <div className="fs-dock-category">
        <button type="button" className="fs-dock-category-header" onClick={() => { if (!fsDockFlat) toggleFsCategory("technicals"); }}>
          <span className="fs-dock-category-icon fs-dock-category-icon--technicals">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a10 10 0 1 0 10 10" />
              <path d="M12 12l5-5" />
            </svg>
          </span>
          <span className="fs-dock-category-label">{t("priceChart.c.technicals")}</span>
          <svg className={`fs-dock-category-chevron${fsOpenCategories.technicals ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {(fsDockFlat || fsOpenCategories.technicals) && (() => {
          const pct = fsTechnicalsPct[zone.signal];
          const theta = (180 - pct * 1.8) * (Math.PI / 180);
          const needleX = 80 + 52 * Math.cos(theta);
          const needleY = 86 - 52 * Math.sin(theta);
          return (
            <div className="fs-dock-category-body">
              <div className="fs-gauge">
                <svg width="160" height="92" viewBox="0 0 160 92">
                  <path d="M10,86 A70,70 0 0 1 23.4,44.8" fill="none" stroke="#ef4444" strokeWidth="14" strokeLinecap="round" />
                  <path d="M23.4,44.8 A70,70 0 0 1 58.4,19.4" fill="none" stroke="#f97316" strokeWidth="14" />
                  <path d="M58.4,19.4 A70,70 0 0 1 101.6,19.4" fill="none" stroke="#9ca3af" strokeWidth="14" />
                  <path d="M101.6,19.4 A70,70 0 0 1 136.6,44.8" fill="none" stroke="#4ade80" strokeWidth="14" />
                  <path d="M136.6,44.8 A70,70 0 0 1 150,86" fill="none" stroke="#16a34a" strokeWidth="14" strokeLinecap="round" />
                  <line x1="80" y1="86" x2={needleX} y2={needleY} stroke="var(--color-text)" strokeWidth="2.4" strokeLinecap="round" />
                  <circle cx="80" cy="86" r="4.5" fill="var(--color-text)" />
                </svg>
                <div className="fs-gauge-labels">
                  <span>{t("chart.strongSell")}</span>
                  <span>{t("chart.sell")}</span>
                  <span>{t("chart.neutralZone")}</span>
                  <span>{t("chart.buy")}</span>
                  <span>{t("chart.strongBuy")}</span>
                </div>
                <div className={`fs-gauge-value fs-gauge-value--${zone.signal}`}>{fsTechnicalsLabel[zone.signal]}</div>
              </div>
            </div>
          );
        })()}
      </div>
      )}

      {pageMode && (!fsFocusedCategory || fsFocusedCategory === "keystats") && (
      <div className="fs-dock-category">
        <button type="button" className="fs-dock-category-header" onClick={() => { if (!fsDockFlat) toggleFsCategory("keystats"); }}>
          <span className="fs-dock-category-icon fs-dock-category-icon--keystats">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
          </span>
          <span className="fs-dock-category-label">{t("priceChart.c.keyStats")}</span>
          <svg className={`fs-dock-category-chevron${fsOpenCategories.keystats ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {(fsDockFlat || fsOpenCategories.keystats) && (
          <div className="fs-dock-category-body">
            <div className="fs-info-list">
              <div className="fs-info-row">
                <span className="fs-info-label">{t("priceChart.c.tradingVolume24h")}</span>
                <span className="fs-info-value">{quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}</span>
              </div>
              <div className="fs-info-row">
                <span className="fs-info-label">{t("priceChart.c.marketCap")}</span>
                <span className="fs-info-value">{coinMeta?.marketCapUSD != null ? formatCompactVolume(coinMeta.marketCapUSD) : "—"}</span>
              </div>
              <div className="fs-info-row">
                <span className="fs-info-label">{t("priceChart.c.fdv")}</span>
                <span className="fs-info-value">{coinMeta?.fdvUSD != null ? formatCompactVolume(coinMeta.fdvUSD) : "—"}</span>
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      {pageMode && (!fsFocusedCategory || fsFocusedCategory === "about") && (
      <div className="fs-dock-category">
        <button type="button" className="fs-dock-category-header" onClick={() => { if (!fsDockFlat) toggleFsCategory("about"); }}>
          <span className="fs-dock-category-icon fs-dock-category-icon--about">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </span>
          <span className="fs-dock-category-label">{t("priceChart.c.about")}</span>
          <svg className={`fs-dock-category-chevron${fsOpenCategories.about ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {(fsDockFlat || fsOpenCategories.about) && (
          <div className="fs-dock-category-body">
            <div className="fs-info-list">
              <div className="fs-info-row">
                <span className="fs-info-label">{t("priceChart.c.category")}</span>
                <span className="fs-info-value">{coinMeta?.category ?? "—"}</span>
              </div>
              {([
                ["priceChart.c.website", "Website", coinMeta?.homepage],
                ["priceChart.c.sourceCode", "Source Code", coinMeta?.sourceCode],
                ["priceChart.c.explorers", "Explorers", coinMeta?.explorer],
                ["priceChart.c.whitepaper", "Whitepaper", coinMeta?.whitepaper],
                ["priceChart.c.community", "Community", coinMeta?.subreddit],
              ] as const).map(([key, fallback, url]) => (
                <div className="fs-info-row" key={key}>
                  <span className="fs-info-label">{t(key, fallback)}</span>
                  {url ? (
                    <a className="fs-info-link" href={url} target="_blank" rel="noopener noreferrer">
                      {url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                    </a>
                  ) : (
                    <span className="fs-info-value">—</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      )}

      {/* Advance Price Chart page only — High/Low/Vol/Bid/Ask/Vol-coin/
          Signal/Divergence, the same content the header's expandable
          stats strip shows elsewhere, just relocated here since the
          header on this page is trimmed down to coin/price/change. */}
      {pageMode && (!fsFocusedCategory || fsFocusedCategory === "stats") && (
      <div className="fs-dock-category">
        <button type="button" className="fs-dock-category-header" onClick={() => { if (!fsDockFlat) toggleFsCategory("stats"); }}>
          <span className="fs-dock-category-icon fs-dock-category-icon--stats">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v18h18" />
              <path d="M7 16l4-5 3 3 5-7" />
            </svg>
          </span>
          <span className="fs-dock-category-label">{t("priceChart.c.stats")}</span>
          <span className="chart-fs-strip-item" style={{ marginLeft: 6 }}>{t("priceChart.c.high")} <b className="chart-fs-strip-up">{dayHigh !== null ? formatLivePrice(dayHigh) : "—"}</b></span>
          <span className="chart-fs-strip-item">{t("priceChart.c.low")} <b className="chart-fs-strip-down">{dayLow !== null ? formatLivePrice(dayLow) : "—"}</b></span>
          <svg className={`fs-dock-category-chevron${fsOpenCategories.stats ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {(fsDockFlat || fsOpenCategories.stats) && (
          <div className="fs-dock-category-body">
            <div className="chart-fs-stats-grid">
              <div className="chart-fs-stat-col">
                <div className="chart-fs-stat-row">
                  <span className="chart-fs-stat-label">{t("priceChart.c.volUsd")}</span>
                  <span className="chart-fs-stat-value">
                    {quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}
                  </span>
                </div>
                <div className="chart-fs-stat-row">
                  <span className="chart-fs-stat-label">{t("priceChart.c.bid")}</span>
                  <span className="chart-fs-stat-value chart-fs-stat-value--up">
                    {bidPrice !== null ? formatLivePrice(bidPrice) : "—"}
                  </span>
                </div>
                <div className="chart-fs-stat-row">
                  <span className="chart-fs-stat-label">{t("priceChart.c.ask")}</span>
                  <span className="chart-fs-stat-value chart-fs-stat-value--down">
                    {askPrice !== null ? formatLivePrice(askPrice) : "—"}
                  </span>
                </div>
              </div>
              <div className="chart-fs-stat-col chart-fs-stat-col--right">
                <div className="chart-fs-stat-row">
                  <span className="chart-fs-stat-label">{t("priceChart.c.volCoin", { coin })}</span>
                  <span className="chart-fs-stat-value">
                    {baseVolume24h !== null ? formatCompactVolume(baseVolume24h) : "—"}
                  </span>
                </div>
              </div>
            </div>
            {zone && isPaid && fsSignalBucket && (
              <div className="chart-fs-meter">
                <span className="chart-fs-meter-label">{t("priceChart.c.signal")}</span>
                <div className="chart-fs-meter-row">
                  <span className="chart-fs-meter-track">
                    <span
                      className={`chart-fs-meter-dot chart-fs-meter-dot--${fsSignalBucket}`}
                      style={{ left: `${fsSignalPct}%` }}
                    />
                  </span>
                  <span className={`chart-fs-meter-value chart-fs-meter-value--${fsSignalBucket}`}>{fsSignalLabel}</span>
                </div>
              </div>
            )}
            {!isPaid && (
              <button
                className={`zone-signal-gate zone-signal-gate--${zone?.signal ?? "neutral"}`}
                onClick={() => onOpenUpgrade?.("pro")}
              >
                <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-${zone?.signal ?? "neutral"}`} />
                {t("priceChart.unlockStatus")}
              </button>
            )}
            {isPaid && (
              <div className="chart-fs-meter">
                <span className="chart-fs-meter-label">{t("priceChart.c.div")}</span>
                <div className="chart-fs-meter-row">
                  <span className="chart-fs-meter-track chart-fs-meter-track--rev">
                    <span
                      className={`chart-fs-meter-dot chart-fs-meter-dot--${fsDivDotBucket}`}
                      style={{ left: `${fsDivPct}%` }}
                    />
                  </span>
                  <span className={`chart-fs-meter-value chart-fs-meter-value--${fsDivDotBucket}`}>{fsDivLabel}</span>
                </div>
              </div>
            )}
            {!isPaid && (
              <button
                className={`zone-signal-gate zone-signal-gate--div-${divergence?.type ?? "neutral"}`}
                onClick={() => onOpenUpgrade?.("pro")}
              >
                <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-div-${divergence?.type ?? "neutral"}`} />
                {t("priceChart.unlockDivergence")}
              </button>
            )}
          </div>
        )}
      </div>
      )}

    </div>
  );
  // Advance chart (mobile): the sheet opens as a full-height sheet with the
  // exact behavior of MobileSymbolSheet (.mss-* — dimmed backdrop, slide
  // up, sticky header with handle + ✕, drag the header down to dismiss)
  // instead of growing the dock in place.
  const fsFlatSheet = fsDockFlat && (
    <BottomSheet open={fsSheetExpanded} onClose={() => setFsSheetExpanded(false)} title={t("priceChart.coinChart", { coin })} className="fs-flat-sheet">
      {fsDockInner}
    </BottomSheet>
  );
  const fsDockSheet = isFullscreen && !isDesktopWidth && ReactDOM.createPortal(
    <div ref={fsDockRef} className={`fs-dock${fsSheetExpanded ? " fs-dock--expanded" : ""}${fsDockFlat ? " fs-dock--flat" : ""}`}>
      {fsDockFlat ? (
        // TradingView-style slim bar: one flat row, same background as the
        // chart. Tap or swipe up anywhere on it opens the full sheet; its
        // own buttons do their own thing.
        <div
          className="fs-bar"
          onClick={() => { hapticTap(); setFsSheetExpanded(true); }}
          onTouchStart={(e) => { fsDockDragRef.current = { startY: e.touches[0].clientY, startH: 0 }; }}
          onTouchEnd={(e) => {
            const drag = fsDockDragRef.current;
            fsDockDragRef.current = null;
            if (drag && e.changedTouches[0].clientY - drag.startY < -20) { hapticTap(); setFsSheetExpanded(true); }
          }}
        >
          <div className="fs-bar-scroll">
            {/* Minimised Signal Check: a small score ring docked far left;
                tap brings the card back. */}
            {pvAdvSheetMode && pvRingMin && pvActive && pvResult && (() => {
              const b = pvResult.verdict.bias;
              const score = Math.max(0, Math.min(100, pvResult.bullStrength));
              const C = 2 * Math.PI * 11;
              return (
                <button
                  key={`dock:${pvDockPop}`}
                  type="button"
                  className={`fs-bar-btn pv-ring-dock pv-ring-entry--${b}`}
                  // Tap → the full Signal Check, fully expanded.
                  onClick={(e) => { e.stopPropagation(); hapticTap(); setPvAdvSheetOpen(true); }}
                  aria-label={t("priceChart.pv.ringAria", { score })}
                >
                  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                    <circle cx="14" cy="14" r="11" className="pv-ring-track" />
                    <circle cx="14" cy="14" r="11" className="pv-ring-fill" strokeDasharray={`${((score / 100) * C).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 14 14)" />
                  </svg>
                  <span className="pv-ring-dock-num">{score}</span>
                </button>
              );
            })()}
            <button
              type="button"
              className="fs-bar-btn fs-bar-interval"
              onClick={(e) => { e.stopPropagation(); hapticTap(); setIntervalSheetOpen(true); }}
              aria-label={t("priceChart.c.interval")}
            >
              {INTERVAL_SHORT[interval]}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <button
              type="button"
              className="fs-bar-btn fs-bar-interval"
              onClick={(e) => { e.stopPropagation(); hapticTap(); openDateRangeSheet(); }}
              aria-label={t("priceChart.dateRange")}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
              {activeRangePreset && <span>{activeRangePreset.label}</span>}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <span className="fs-bar-sep" />
            <button
              type="button"
              className="fs-bar-btn fs-bar-icon"
              onClick={(e) => {
                e.stopPropagation();
                hapticTap();
                const keys = Object.keys(CHART_STYLE_LABELS) as ChartStyle[];
                setChartStyle(keys[(keys.indexOf(chartStyle) + 1) % keys.length]);
              }}
              aria-label={t("priceChart.chartStyleIs", { style: t(`priceChart.style.${chartStyle}`) })}
              title={t(`priceChart.style.${chartStyle}`)}
            >
              {CHART_STYLE_ICONS[chartStyle]}
            </button>
            <button
              type="button"
              className={`fs-bar-btn fs-bar-icon${showGrid ? " fs-bar-btn--on" : ""}`}
              onClick={(e) => { e.stopPropagation(); hapticTap(); setShowGrid((v) => !v); }}
              aria-label={t("priceChart.grid")}
              aria-pressed={showGrid}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="1" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" /></svg>
            </button>
            <button
              type="button"
              className={`fs-bar-btn fs-bar-icon${fsQuickIndicators.some((i) => i.checked) ? " fs-bar-btn--on" : ""}`}
              onClick={(e) => { e.stopPropagation(); hapticTap(); setToolsIndOpen(true); }}
              aria-label={t("chart.indicators", "Indicators")}
            >
              <span className="fs-bar-fx">ƒx</span>
              {fsQuickIndicators.filter((i) => i.checked).length > 0 && (
                <span className="fs-bar-count">{fsQuickIndicators.filter((i) => i.checked).length}</span>
              )}
            </button>
            <button
              type="button"
              className={`fs-bar-btn fs-bar-icon${fsDrawPanelOpen ? " fs-bar-btn--on" : ""}`}
              onClick={(e) => { e.stopPropagation(); hapticTap(); setFsDrawPanelOpen((v) => !v); }}
              aria-label={t("priceChart.c.toolbox")}
              aria-pressed={fsDrawPanelOpen}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>
            </button>
            {/* Save + Close live in the top-right Menu now. */}
          </div>
          <button
            type="button"
            className="fs-bar-btn fs-bar-icon fs-bar-more"
            onClick={(e) => { e.stopPropagation(); hapticTap(); setFsSheetExpanded(true); }}
            aria-label={t("priceChart.more")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
          </button>
        </div>
      ) : (
      <div className="fs-dock-peek">
        <button
          type="button"
          className="fs-dock-peek-toggle"
          onClick={() => {
            if (pageMode) hapticTap();
            setFsFocusedCategory(null);
            setFsSheetExpanded((v) => !v);
          }}
          onTouchStart={(e) => {
            fsDockDragRef.current = { startY: e.touches[0].clientY, startH: fsSheetExpanded ? fsDockBodyH : 0 };
            if (fsDockFlat && fsDockRef.current) fsDockRef.current.style.transition = "none";
            const body = fsDockBodyRef.current;
            // No transition while actively dragging — it has to follow
            // the finger with zero lag, not ease toward it.
            if (body) body.style.transition = "none";
          }}
          onTouchMove={(e) => {
            if (fsDockFlat) {
              // The dock follows the finger upward as a small rubber-band
              // stretch toward opening the sheet.
              const drag = fsDockDragRef.current;
              const dock = fsDockRef.current;
              if (!drag || !dock) return;
              const dy = e.touches[0].clientY - drag.startY;
              const y = dy > 0 ? 0 : Math.max(dy / 3, -40);
              dock.style.transform = `translateY(${y}px)`;
              return;
            }
            const drag = fsDockDragRef.current;
            const body = fsDockBodyRef.current;
            if (!drag || !body || fsDockBodyH <= 0) return;
            const dy = e.touches[0].clientY - drag.startY;
            let next = drag.startH - dy; // dragging up (dy<0) opens further
            // Rubber-band resistance past either end, like a native sheet.
            if (next < 0) next = next / 3;
            else if (next > fsDockBodyH) next = fsDockBodyH + (next - fsDockBodyH) / 3;
            body.style.maxHeight = `${Math.max(0, next)}px`;
          }}
          onTouchEnd={(e) => {
            const drag = fsDockDragRef.current;
            fsDockDragRef.current = null;
            if (fsDockFlat) {
              // Swipe up on the handle opens the sheet (a tap is onClick).
              const dock = fsDockRef.current;
              if (dock) { dock.style.transition = ""; dock.style.transform = ""; }
              const dy = drag ? e.changedTouches[0].clientY - drag.startY : 0;
              if (dy < -20) { hapticTap(); setFsSheetExpanded(true); }
              return;
            }
            const body = fsDockBodyRef.current;
            if (body) body.style.transition = "";
            if (!drag || !body) return;
            const dy = e.changedTouches[0].clientY - drag.startY;
            body.style.maxHeight = "";
            // Negligible movement = a tap, left entirely to onClick above
            // (no need to also decide expanded/collapsed here — that
            // would just fight the toggle on a plain tap).
            if (Math.abs(dy) < 6) return;
            const settled = fsDockBodyH > 0 ? (drag.startH - dy) / fsDockBodyH : 0;
            if (pageMode) hapticTap();
            setFsFocusedCategory(null);
            setFsSheetExpanded(settled > 0.35);
          }}
          onTouchCancel={(e) => {
            // iOS can cancel instead of ending a swipe — settle it the same way.
            if (!fsDockFlat) return;
            const drag = fsDockDragRef.current;
            fsDockDragRef.current = null;
            const dock = fsDockRef.current;
            if (dock) { dock.style.transition = ""; dock.style.transform = ""; }
            const t0 = e.changedTouches[0];
            const dy = drag && t0 ? t0.clientY - drag.startY : 0;
            if (dy < -20) { hapticTap(); setFsSheetExpanded(true); }
          }}
        >
          <span className="fs-dock-handle" />
        </button>
        {/* "Option E — swipeable hero card" (user-approved) — one full,
            rich category card at a time (Technicals/Key stats/Overview/
            About/Stats), swiped between with dot pagination instead of a
            row of tap-to-reveal icons. The data shown IS the card: no tap
            needed to see it. Advance Chart page, mobile only. */}
        {pageMode && !isDesktopWidth && fsHeroCategories.length > 0 && (
          <div
            className="fs-hero"
            onTouchStart={(e) => { fsHeroTouchX.current = e.touches[0].clientX; }}
            onTouchEnd={(e) => {
              const startX = fsHeroTouchX.current;
              fsHeroTouchX.current = null;
              if (startX == null) return;
              const dx = e.changedTouches[0].clientX - startX;
              if (Math.abs(dx) < 36) return;
              hapticTap();
              setFsHeroIndex((i) => {
                const len = fsHeroCategories.length;
                return dx < 0 ? (i + 1) % len : (i - 1 + len) % len;
              });
            }}
          >
            <div className="fs-hero-card">
              {/* key={fsHeroKey} forces a remount on every card change (auto
                  or manual) so the slide-in animation replays each time. */}
              <div className="fs-hero-card-content" key={fsHeroKey}>
                {renderFsHeroCard(fsHeroKey)}
              </div>
            </div>
            {fsHeroCategories.length > 1 && (
              <div className="fs-hero-dots">
                {fsHeroCategories.map((key, i) => (
                  <button
                    key={key}
                    type="button"
                    className={`fs-hero-dot${i === fsHeroIndex ? " fs-hero-dot--active" : ""}`}
                    aria-label={key}
                    onClick={() => { hapticTap(); setFsHeroIndex(i); }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {!fsDockFlat && (
      <div
        ref={fsDockBodyRef}
        className="fs-dock-body"
        style={{ maxHeight: fsSheetExpanded ? fsDockBodyH : 0 }}
      >
        {fsDockInner}
      </div>
      )}
    </div>,
    document.body,
  );

  // First page load/refresh has no real data yet to show blurred, unlike
  // a later coin/interval switch — these placeholders fill the same spots
  // with plausible-looking content purely so there's something present to
  // blur (via .price-chart-container--loading) instead of empty gaps.
  // They're display-only derived values, never written back into the
  // real dayHigh/banner/patternInsight state those features rely on.
  const isFirstLoad = loading && !hasLoadedOnce;
  const displayDayHigh = dayHigh ?? (isFirstLoad ? 100 : null);
  const displayDayLow = dayLow ?? (isFirstLoad ? 95 : null);
  const displayBanner: IntervalAnalysis | null =
    banner ??
    (isFirstLoad
      ? {
          sentiment: "neutral",
          title: t("priceChart.placeholder.bannerTitle"),
          body: t("priceChart.placeholder.bannerBody"),
        }
      : null);
  const displayPatternInsight: PatternInsight | null =
    patternInsight ??
    (isFirstLoad
      ? {
          name: t("priceChart.placeholder.patternName"),
          type: "neutral",
          summary: t("priceChart.placeholder.patternSummary"),
          narrative: t("priceChart.placeholder.patternNarrative"),
          nextMove: t("priceChart.placeholder.patternNext"),
        }
      : null);

  // Shared by both title-row zone-signal spots below (fullscreen compact
  // header + normal/desktop header) — same label, computed once.
  const zoneLabel = zone && {
    "strong-buy": t("chart.strongBuy"),
    "buy": t("chart.buy"),
    "oversold": t("chart.oversold"),
    "overbought": t("chart.overbought"),
    "neutral": t("chart.neutralZone"),
    "sell": t("chart.sell"),
    "strong-sell": t("chart.strongSell"),
  }[zone.signal];

  // Reference-match: signal + zone + divergence as one plain-text sentence
  // inside the AI insight banner, instead of separate dot-indicator/pill
  // badges (SignalIndicator, .div-badge) next to the title. These three
  // are genuinely independent sources (an earlier version used a
  // zone.signal-derived bull/bear bucket as "signal" too, which just
  // restated zoneLabel in different words — "Buy Zone signal in a
  // bullish zone" — so this uses trends[interval] instead, the same
  // independent bullish/bearish reading the interval pills' own little
  // arrows already show): "signal" = this interval's trend direction,
  // "zone" = zoneLabel (the price-zone status, e.g. "Buy Zone"/
  // "Oversold"), "div" = divergence.
  const intervalSignal = trends[interval];
  const signalWord = intervalSignal ? t(`priceChart.c.${intervalSignal}`) : "";
  const divWord = divergence ? t(`priceChart.c.${divergence.type}`) : "";
  const rawZoneDivergenceSentence = isPaid && (intervalSignal || zoneLabel || divergence)
    ? intervalSignal && zoneLabel && divergence
      ? t("priceChart.c.signalZoneDivSentence", { signal: signalWord, zone: zoneLabel, div: divWord })
      : intervalSignal && zoneLabel
        ? t("priceChart.c.signalZoneSentence", { signal: signalWord, zone: zoneLabel })
        : zoneLabel && divergence
          ? t("priceChart.c.zoneDivSentence", { zone: zoneLabel, div: divWord })
          : intervalSignal && divergence
            ? t("priceChart.c.signalDivSentence", { signal: signalWord, div: divWord })
            : zoneLabel
              ? t("priceChart.c.zoneSentence", { zone: zoneLabel })
              : intervalSignal
                ? t("priceChart.c.signalSentence", { signal: signalWord })
                : divergence
                  ? t("priceChart.c.divergenceSentence", { div: divWord })
                  : null
    : null;
  // Sentence-case regardless of how the pieces above were capitalized
  // (zoneLabel comes in as "Buy Zone"/"Oversold" etc) — first letter up,
  // everything else down.
  const zoneDivergenceSentence = rawZoneDivergenceSentence
    ? rawZoneDivergenceSentence.charAt(0).toUpperCase() + rawZoneDivergenceSentence.slice(1).toLowerCase()
    : null;

  // Phones, chart page: CoinMarketCap app header, under the tabs —
  // "Bitcoin price BTC" (opens the coin picker) + stats / share, the big
  // price and its change, the "Why is BTC's price up today?" AI chip, then
  // the green "Trade BTC  P" button.
  // Phones, chart page: when the price row scrolls up under the top bar,
  // App shows the price there instead ("coin-header-price"); it goes away
  // once the row is back in view.
  useEffect(() => {
    const el = cmchPriceRef.current;
    if (!el || !phoneCmcPage) { setPriceOff(false); return; }
    const root = el.closest(".main-content") as HTMLElement | null;
    const io = new IntersectionObserver(
      ([en]) => setPriceOff(!en.isIntersecting && en.boundingClientRect.top < (en.rootBounds?.top ?? 0) + 10),
      { root, rootMargin: root ? "0px" : "-64px 0px 0px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [phoneCmcPage, coin]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("coin-header-price", {
      detail: priceOff && currentPrice !== null ? { coin, price: formatLivePrice(currentPrice), chg: dayChangePercent } : null,
    }));
  }, [priceOff, currentPrice, dayChangePercent, coin]);
  useEffect(() => () => { window.dispatchEvent(new CustomEvent("coin-header-price", { detail: null })); }, []);

  const phoneHeaderEl = phoneCmcPage ? (
    <div className="cmch">
      <div className="cmch-top">
        <button type="button" className="cmch-id" onClick={(e) => onOpenCoinPicker?.(e.currentTarget)} aria-label={t("priceChart.changeCoin")}>
          {/* Flips (spins) every time the live price ticks — keyed on the
              price so the animation restarts on each change. */}
          <span key={`spin:${currentPrice ?? ""}`} className={`cmch-logo-spin${currentPrice !== null ? " cmch-logo-spin--on" : ""}`}>
            {!heroLogoError ? (
              <img className="cmch-logo" src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`} alt="" onError={() => setHeroLogoError(true)} />
            ) : (
              <span className="cmch-logo cmch-logo--glyph" style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}>{COIN_GLYPHS[coin] ?? coin[0]}</span>
            )}
          </span>
          <span className="cmch-name">{t("priceChart.coinPrice", { name: COIN_FULL_NAME[coin] ?? coin })}</span>
          <span className="cmch-sym">{coin}</span>
          <svg className="cmch-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
        {/* Share. (Compact view sits beside the chart title; ProVision is
            in the interval row.) */}
        <div className="cmch-acts">
          <button type="button" className="cmch-act" onClick={() => setStatsSheetOpen(true)} aria-label={t("priceChart.allStats")}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v18h18" /><path d="M7 16v-4M12 16V8M17 16v-7" /></svg>
          </button>
          <button
            type="button"
            className="cmch-act"
            aria-label={t("priceChart.share")}
            onClick={() => {
              hapticTap();
              // Always the public page (the app's own address is
              // capacitor://… and means nothing to anyone else).
              const name = COIN_FULL_NAME[coin] ?? coin;
              const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
              const url = `https://www.coinhintz.io/chart/${slug}`;
              const title = t("priceChart.shareTitle", { name, coin });
              // iOS app: the native share sheet (the web view has none).
              if (Capacitor.isNativePlatform()) {
                Share.share({ title, text: title, url, dialogTitle: t("priceChart.share") }).catch(() => {});
                return;
              }
              const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> };
              if (nav.share) nav.share({ title, url }).catch(() => {});
              else navigator.clipboard?.writeText(url).catch(() => {});
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>
          </button>
        </div>
      </div>
      <div className="cmch-price" ref={cmchPriceRef}>
        {currentPrice !== null
          ? <strong>{formatLivePrice(currentPrice)}</strong>
          : <span className="cmch-skel" aria-label={t("priceChart.loadingPrice")} />}
        {dayChangePercent !== null && (
          <span className={`cmch-chg${dayChangePercent >= 0 ? " up" : " down"}`}>
            {dayChangePercent >= 0 ? "▲" : "▼"} {Math.abs(dayChangePercent).toFixed(2)}%
          </span>
        )}
      </div>
      {/* Market stats (liquidations, OI, funding, RSI, MACD, L/S, 24h vol) —
          one row under the price, scrolls sideways. */}
      {(headerStats || quoteVolume24h !== undefined) && (
        <div className="cmch-stats">
          <div className="chart-bar-stats">
            {headerStats}
            {quoteVolume24h !== undefined && (
              <div className="chart-bar-stat">
                <span className="chart-bar-stat-label">{t("priceChart.vol24h")}</span>
                <span className="chart-bar-stat-value">{formatCompactVolume(quoteVolume24h)}</span>
              </div>
            )}
          </div>
        </div>
      )}
      {/* The green "Trade BTC  P" button → Paper Trade. */}
      {onOpenPaperTrade && (
        <button type="button" className="chart-trade-cta cmch-cta" onClick={onOpenPaperTrade}>
          {t("priceChart.tradeCoin", { coin })}
          <span className="chart-trade-cta-p" aria-hidden="true">P</span>
        </button>
      )}
    </div>
  ) : null;

  // Phones, chart page: two quick taps on the chart (within 300ms, close
  // together, single finger) open the Advance Chart page. Taps on buttons,
  // the drawing rail, the timeline handles or the banner don't count.
  const onPhoneChartTap = (e: React.TouchEvent) => {
    if (e.changedTouches.length !== 1 || e.touches.length > 0) { phoneTapRef.current = null; return; }
    if ((e.target as Element).closest("button, a, .cdt-toolbar, .pv-pill, .cmcc-foot")) return;
    const t = e.changedTouches[0];
    const now = Date.now();
    const prev = phoneTapRef.current;
    if (prev && now - prev.t < 300 && Math.hypot(t.clientX - prev.x, t.clientY - prev.y) < 30) {
      phoneTapRef.current = null;
      onOpenDrawingTools?.();
      return;
    }
    phoneTapRef.current = { t: now, x: t.clientX, y: t.clientY };
  };

  // CoinMarketCap line chart (desktop toolbar view and the phone Chart tab).
  const cmcChartEl = cmcLineView ? (
    <CmcChart
      coin={coin}
      theme={theme}
      metric={chartMetric}
      range={cmcRange}
      log={cmcLog}
      moments={chartEvts}
      overlay={pvPromoPill}
      onAnalyze={() => {
        // Run the AI Chart Read right away (paid) — free users get
        // the upgrade card — under the chart, scrolled into view.
        setAiCtaOn(true);
        if (isPaid && !aiReadOpen) openAiRead();
        window.setTimeout(() => {
          document.querySelector(".ai-read-cta, .ai-read, .chart-ai-placeholder")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 60);
      }}
    />
  ) : null;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      ref={chartSectionRef}
      className={`price-chart-container${mobileTabs && mobileView !== "chart" ? " price-chart-container--mview-book" : ""}${sideColumn && !isFullscreen ? " price-chart-container--split" : ""}${isFullscreen ? " price-chart-container--fs" : ""}${loading ? " price-chart-container--loading" : ""}${pageMode ? " price-chart-container--page" : ""}${(pageTabContent || cmcHidesCandles) && !isFullscreen ? " price-chart-container--ctab" : ""}${phoneCmc ? " price-chart-container--phonecmc" : ""}`}
    >
      <div
        ref={isFullscreen ? fsScrollRef : undefined}
        className={isFullscreen ? "price-chart-fs-scroll pcc-main" : "pcc-main"}
        style={
          pageMode && !isDesktopWidth
            ? ({ "--fs-dock-clearance": `${fsDockClearance}px` } as React.CSSProperties)
            // (Not on phones: the line view is shorter and would leave a gap.)
            : (pageTabContent || cmcHidesCandles) && !isFullscreen && overviewH > 0 && !phoneCmc
              ? { minHeight: overviewH }
              : undefined
        }
        onScroll={isFullscreen ? updateFsThumb : undefined}
      >
        {/* Reference-match (TradingView desktop chart) — the Advance Chart
            page's own top toolbar: symbol/interval/style/indicators on the
            left, save + Trade + Upgrade on the right. Desktop pageMode
            only; reuses the exact same gridStyleControls/fsIntervalButton/
            indicatorsControl components the old .chart-legend-actions row
            used (now excluded from that row in this exact scope, above,
            so there's no duplicate-ref/duplicate-menu collision). */}
        {/* Advance Chart (desktop): ProVision trial / lock notice — a
            full-width bar above the toolbar that slides down on load. */}
        {pageMode && isDesktopWidth && pvBannerReason && (
          <button
            type="button"
            className="chart-tv-pvbar"
            onClick={() => openProVisionPaywall({ reason: pvBannerReason, coin })}
          >
            <span className="chart-tv-pvbar-ic" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            </span>
            <strong>
              {pvBannerReason === "pro-limit" ? t("priceChart.pvbar.lockedOn", { coin }) : pvBannerReason === "trial-ended" ? t("priceChart.pvbar.trialEnded") : t("priceChart.pvbar.tryFree")}
            </strong>
            <span className="chart-tv-pvbar-sub">
              {pvBannerReason === "pro-limit"
                ? (pvGate.access.usedCoins.length
                  ? t("priceChart.pvbar.usedCoins", { n: pvGate.access.usedCoins.length })
                  // Server said no but no coins were used: not a daily-limit case.
                  : t("priceChart.pvbar.notIncluded"))
                : pvBannerReason === "trial-ended" ? t("priceChart.pvbar.keepFor", { price: pvPrice }) : t("priceChart.pvbar.noCard")}
            </span>
            <span className="chart-tv-pvbar-cta">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
              {pvBannerReason === "trial-available" || pvBannerReason === "signin" ? t("priceChart.pvbar.try") : t("priceChart.pvbar.unlock")}
            </span>
          </button>
        )}
        {pageMode && isDesktopWidth && (
          <div className="chart-tv-toolbar">
            <div className="chart-tv-toolbar-left">
              <button
                type="button"
                className="chart-tv-symbol"
                onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
              >
                <span
                  className="chart-tv-symbol-icon"
                  style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                >
                  {COIN_GLYPHS[coin] ?? coin[0]}
                </span>
                {coin}USD
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {fsIntervalButton}
              {gridStyleControls}
              {indicatorsControl}
              {gridToggleButton}
              <button
                type="button"
                className="chart-tv-save-btn"
                onClick={() => {
                  // PriceAlerts (App.tsx root, always mounted) owns its own
                  // open state internally too — same .ta-trigger-style
                  // click-through reuse as the Trade button above, via its
                  // own real bell button (.alerts-bell) instead of a new
                  // prop just for this.
                  document.querySelector<HTMLButtonElement>(".alerts-bell")?.click();
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="1" x2="12" y2="23" />
                  <path d="M17 5.5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
                {t("priceAlerts.title", "Alert")}
              </button>
              {/* Pro Vision switch (same shared setting as the top bar's).
                  Hidden when there's no access (trial ended / locked / not
                  started) — the Unlock / Start pill on the right covers it. */}
              {!(pvBannerReason && !pvActive) && (
              <button
                type="button"
                className={`pv-toggle pv-toggle--toolbar${pvActive ? " pv-toggle--on" : ""}`}
                role="switch"
                aria-checked={pvActive}
                aria-label="ProVision"
                title={pvActive ? t("priceChart.pvToggleOn") : t("priceChart.pvToggleOff")}
                onClick={() => pvGate.toggle(coin)}
              >
                <span className="pv-toggle-label">Pro<span className="pv-toggle-label-accent">Vision</span></span>
                <span className="pv-toggle-track" aria-hidden="true">
                  <span className="pv-toggle-knob">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
                  </span>
                </span>
              </button>
              )}
            </div>
            <div className="chart-tv-toolbar-right">
              <div className="chart-tv-segmented-group">
                <button type="button" className="chart-tv-segment-btn" onClick={handleScreenshot}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  {t("chart.save")}
                </button>
                <button type="button" className="chart-tv-segment-btn" onClick={handleResetView} title={t("chart.reset")} data-tooltip={t("chart.reset")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  {t("chart.reset")}
                </button>
                {!isPaid && (
                  <button
                    type="button"
                    className="chart-tv-segment-btn chart-tv-segment-upgrade"
                    onClick={() => onOpenUpgrade?.("pro")}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                      <path d="M13 2L3 14h7l-1 8 11-14h-8l1-6z" />
                    </svg>
                    {t("priceChart.c.upgrade")}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {/* Reference-match (TradingView desktop chart): the coin name/
            price/change/High-Low/signal header block is replaced by an
            OHLC readout + Buy/Sell boxes OVERLAID directly on the chart
            canvas's own top-left corner (new block below, inside
            .chart-canvas-wrap) instead of taking its own layout row —
            collapsing this whole group the same way pageMode mobile
            already does, reclaiming that vertical space for the chart. */}
        {!forceHideHeader && (
        <>
        <div className={`chart-fs-header-group${pageMode ? " chart-fs-header-group--empty" : ""}`}>
          {useBarHeader ? (
          <>
            {/* Desktop Chart page header, exchange-style (reference:
                Hyperliquid): coin + price + change on the left, a divider,
                then a single row of label-over-value stats, with the
                interval pills / chart icons on their own toolbar row
                underneath. headerStats (App.tsx's .mch-stats) joins the
                same stat row, restyled to match (PriceChart.css). */}
            {/* Exchange-style bar header (reference: Hyperliquid): coin +
                price + change, a divider, then label-over-value stats. */}
            {/* Desktop CMC layout (no headerStats passed): the coin, price and
                stats live in the left info column, so this header is hidden. */}
            {/* Phones: the CMC header (phoneHeaderEl) renders under the tabs. */}
            <div className={`chart-bar-header-wrap${mobileTabs ? " chart-bar-header-wrap--mobile" : ""}${tradeDesktopLean && !headerStats && !isFullscreen ? " chart-bar-header-wrap--off" : ""}${phoneCmcPage ? " chart-bar-header-wrap--off" : ""}`}>
            <div className="chart-bar-header" ref={barStatsRef} onScroll={updateBarScroll}>
              <div
                className="chart-bar-id chart-bar-id--tap"
                role="button"
                tabIndex={0}
                aria-label={t("priceChart.changeCoin")}
                onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenCoinPicker?.(e.currentTarget); } }}
              >
          {/* Reference: Hyperliquid's market selector — coin icon, ticker +
              full name, price / 24h change / age underneath, and the picker
              as its own small button (mini icon + chevron) beside it. */}
          {/* Mobile: the whole coin block opens the coin picker (the
              separate picker button is hidden there). */}
          {/* The whole block (.chart-bar-id) opens the coin picker. */}
          <div className="chart-bar-coin chart-bar-coin--tap">
            {!heroLogoError ? (
              <img
                className="chart-bar-coin-icon"
                src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
                alt=""
                loading="lazy"
                onError={() => setHeroLogoError(true)}
              />
            ) : (
              <span className="chart-bar-coin-icon chart-bar-coin-icon--glyph" style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}>
                {COIN_GLYPHS[coin] ?? coin[0]}
              </span>
            )}
            <span className="chart-bar-coin-text">
              <span className="chart-bar-coin-name">
                {coin}
                <span className="chart-bar-coin-full">{COIN_FULL_NAME[coin] ?? ""}</span>
                {/* Mobile: clear "this is a selector" cue on the name. */}
                {!isDesktopWidth && (
                  <span className="chart-bar-coin-caret" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  </span>
                )}
              </span>
              <span className="chart-bar-coin-price-row">
                {currentPrice !== null && (
                  <span className={`chart-bar-price${dayChangePercent !== null ? (dayChangePercent >= 0 ? " chart-bar-price--up" : " chart-bar-price--down") : ""}`}>
                    {formatLivePrice(currentPrice)}
                  </span>
                )}
                {dayChangePercent !== null && (
                  <span className={`chart-bar-change${dayChangePercent >= 0 ? " up" : " down"}`}>
                    {dayChangePercent >= 0 ? "↑" : "↓"}{Math.abs(dayChangePercent).toFixed(2)}%
                  </span>
                )}
                {coinAgeLabel && <span className="chart-bar-age">{coinAgeLabel}</span>}
              </span>
            </span>
          </div>
          {isDesktopWidth && (
          <span className="chart-bar-picker" aria-hidden="true">
            <span className="chart-bar-picker-icon" style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}>
              {COIN_GLYPHS[coin] ?? coin[0]}
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
          )}
        </div>
        <span className="chart-bar-divider" />
              <div className="chart-bar-stats">
                {/* Change / High / Low were removed from this row (still in
                    the full stats sheet). 24h Vol sits last. */}
                {headerStats}
                {/* Desktop CMC layout passes no headerStats: this volume moved
                    to the left info column's stats row too. */}
                {quoteVolume24h !== undefined && (headerStats || !tradeDesktopLean) && (
                  <div className="chart-bar-stat">
                    <span className="chart-bar-stat-label">{t("priceChart.vol24h")}</span>
                    <span className="chart-bar-stat-value">{formatCompactVolume(quoteVolume24h)}</span>
                  </div>
                )}
              </div>
            </div>
            {/* Mobile: visible scroll indicator for the stats row (iOS
                hides native scrollbars until you're already scrolling). */}
            {mobileTabs && barScroll.scrollable && (
              <div className="chart-bar-scrollbar" aria-hidden="true">
                <span style={{ width: `${barScroll.size * 100}%`, left: `${barScroll.pos * (1 - barScroll.size) * 100}%` }} />
              </div>
            )}
            {/* Mobile: fixed ⋮ at the right edge — all stats in a sheet. */}
            {mobileTabs && (
              <button type="button" className="chart-bar-more" onClick={() => setStatsSheetOpen(true)} aria-label={t("priceChart.allStats")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
              </button>
            )}
            </div>
            {/* Trade page section tabs (Overview · News · … · ETFs) + the
                active tab's panel, which takes the chart's place. */}
            {/* Phones: the section picker ("More ▾") sits at the end of the
                Chart / Order Book / Trades row below instead. */}
            {pageTabBar && !mobileTabs && <div className="cpt-row">{pageTabBar}</div>}
            {pageTabContent}
            {/* Desktop #trade: Price / Market cap switch + chart tools,
                right above the chart. */}
            {/* Desktop chart page: CoinMarketCap toolbar —
                [Price | Market cap] [line | TradingView] … [24h 1W 1M 1Y All | Log].
                Line view = CmcChart; TradingView = our candle chart (ProVision). */}
            {tradeDesktopLean && pageTabBar && !pageTabContent && !isFullscreen && (
              <div className="cmct">
                <div className="cmct-l">
                  <div className="cmct-seg" role="tablist" aria-label={t("priceChart.metric.label")}>
                    {([["price", t("priceChart.metric.price")], ["mcap", t("priceChart.metric.mcap")]] as const).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        role="tab"
                        aria-selected={chartMetric === k}
                        className={`cmct-btn${chartMetric === k ? " cmct-btn--on" : ""}`}
                        onClick={() => setChartMetric(k)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="cmct-seg" role="tablist" aria-label={t("chartBar.chartType", "Chart type")}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={cmcLineView}
                      aria-label={t("chartBar.lineChart", "Line chart")}
                      className={`cmct-btn${cmcLineView ? " cmct-btn--on" : ""}`}
                      onClick={() => setCmcStyle("line")}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v18h18" /><path d="m7 15 4-5 3 3 5-7" /></svg>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={!cmcLineView}
                      className={`cmct-btn${!cmcLineView ? " cmct-btn--on" : ""}`}
                      onClick={() => { setChartMetric("price"); setCmcStyle("candles"); }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v4M6 7h4v9H6zM8 16v5M16 4v5M14 9h4v6h-4zM16 15v4" /></svg>
                      TradingView
                    </button>
                  </div>
                </div>
                <div className="cmct-r">
                  {cmcLineView ? (
                    <>
                      <div className="cmct-seg" role="tablist" aria-label={t("chartBar.range", "Range")}>
                        {CMC_RANGES.map((r) => (
                          <button
                            key={r.id}
                            type="button"
                            role="tab"
                            aria-selected={cmcRange === r.id}
                            className={`cmct-btn${cmcRange === r.id ? " cmct-btn--on" : ""}`}
                            onClick={() => setCmcRange(r.id)}
                          >
                            {r.label}
                          </button>
                        ))}
                        <span className="cmct-div" aria-hidden="true" />
                        <button
                          type="button"
                          aria-pressed={cmcLog}
                          className={`cmct-btn${cmcLog ? " cmct-btn--on" : ""}`}
                          onClick={() => setCmcLog((v) => !v)}
                        >
                          Log
                        </button>
                        <span className="cmct-div" aria-hidden="true" />
                        {/* Fullscreen sits inside the same group (CMC's settings slot). */}
                        <button
                          type="button"
                          className="cmct-btn cmct-btn--icon"
                          onClick={toggleFullscreen}
                          aria-label={t("priceChart.c.fullscreen")}
                          title={t("priceChart.c.fullscreen")}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
                        </button>
                      </div>
                    </>
                  ) : (
                    // TradingView (candle) view, CMC layout:
                    // [ProVision] [15m 1h 4h 24h 1W 1M | type · compact · fullscreen]
                    <>
                      {/* Indicators moved under the range bar (full width). */}
                      {/* CMC: [15m 1h 4h 24h 1W 1M ⌄ | ⚙] — ⌄ = the other
                          intervals, ⚙ = chart type / compact / full screen
                          (each opens on hover or click). */}
                      {/* Order: Indicators | intervals | Predict · ProVision · ⚙ */}
                      <div className="cmct-seg" aria-label={t("chartBar.interval", "Interval")}>
                        <button
                          type="button"
                          className={`cmct-btn cmct-btn--ind${toolsIndOpen ? " cmct-btn--on" : ""}`}
                          onClick={() => setToolsIndOpen(true)}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 20h18" />
                            <path d="M5 16l4-5 4 3 6-8" />
                            <path d="M6 20v-3M10 20v-5M14 20v-4M18 20v-7" opacity="0.5" />
                          </svg>
                          {t("chartBar.indicators", "Indicators")}
                          {libIndicators.length > 0 && <span className="cmct-indcount">{libIndicators.length}</span>}
                        </button>
                        <span className="cmct-div" aria-hidden="true" />
                        {TV_MAIN_INTERVALS.slice(0, 3).map((iv) => (
                          <button
                            key={iv}
                            type="button"
                            className={`cmct-btn${interval === iv ? " cmct-btn--on" : ""}`}
                            aria-pressed={interval === iv}
                            onClick={() => setInterval(iv)}
                          >
                            {TV_INTERVAL_LABEL[iv]}
                          </button>
                        ))}
                        {/* 4th slot = the interval selector: shows the
                            picked interval + ⌄; picking one puts it here. */}
                        <span
                          className="cmct-dd"
                          onMouseEnter={() => setTvMenu("int")}
                          onMouseLeave={() => setTvMenu((m) => (m === "int" ? null : m))}
                        >
                          <button
                            type="button"
                            className={`cmct-btn cmct-btn--ivsel${interval === deskIv4 ? " cmct-btn--on" : ""}`}
                            aria-label={t("chartBar.intervalChoose", "Interval: {{name}} — choose another", { name: t(`chartBar.ivName.${deskIv4}`, TV_INTERVAL_NAME[deskIv4]) })}
                            aria-expanded={tvMenu === "int"}
                            onClick={() => setTvMenu((m) => (m === "int" ? null : "int"))}
                          >
                            {TV_INTERVAL_LABEL[deskIv4]}
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                          </button>
                          {tvMenu === "int" && (
                            <div className="cmct-menu" role="menu">
                              {[TV_MAIN_INTERVALS[3], ...TV_MORE_INTERVALS].map((iv) => {
                                const pro = PRO_INTERVALS.has(iv) && !isPaid;
                                return (
                                  <button
                                    key={iv}
                                    type="button"
                                    role="menuitem"
                                    className={`cmct-menu-item${interval === iv ? " cmct-menu-item--on" : ""}`}
                                    onClick={() => {
                                      setTvMenu(null);
                                      if (pro) { onOpenUpgrade?.("pro"); return; }
                                      setInterval(iv);
                                    }}
                                  >
                                    {t(`chartBar.ivName.${iv}`, TV_INTERVAL_NAME[iv])}
                                    {pro ? <span className="cmct-menu-pro">PRO</span> : interval === iv ? <span aria-hidden="true">✓</span> : null}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </span>
                        <span className="cmct-div" aria-hidden="true" />
                        {/* Predict + ProVision in the interval bar, same as
                            on phones. */}
                        <button
                          type="button"
                          className={`cmct-btn cmct-btn--icon cmct-btn--predict${showCompactView ? " cmct-btn--on" : ""}`}
                          aria-label={t("chartBar.predict", "Predict")}
                          aria-pressed={showCompactView}
                          data-tip={t("chartBar.predict", "Predict")}
                          onClick={() => {
                            if (showCompactView) { setShowCompactView(false); return; }
                            openPredict();
                          }}
                        >
                          <svg className="cmct-predict-ic" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                            <defs>
                              <linearGradient id="cmctPredictGradDesk" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
                                <stop offset="0" stopColor="#34d399" />
                                <stop offset="1" stopColor="#16a34a" />
                              </linearGradient>
                            </defs>
                            <path d="M13.5 2 4.5 13.2c-.4.5 0 1.3.6 1.3H11l-1.2 7.1c-.1.7.8 1.1 1.2.5l8.6-11.3c.4-.5 0-1.3-.6-1.3H13l1.6-6.6c.2-.8-.7-1.3-1.1-.9z" fill="url(#cmctPredictGradDesk)" />
                          </svg>
                        </button>
                        {pvGate.access.mode !== "locked" && (
                          <button
                            type="button"
                            className={`cmct-btn cmct-btn--icon cmct-btn--pv${pvGate.on ? " cmct-btn--on" : ""}`}
                            aria-label={pvGate.on ? t("chartBar.pvOff", "Turn ProVision off") : t("chartBar.pvOn", "Turn ProVision on")}
                            aria-pressed={pvGate.on}
                            data-tip="ProVision"
                            onClick={() => pvGate.toggle(coin)}
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
                          </button>
                        )}
                        <span
                          className="cmct-dd"
                          onMouseEnter={() => setTvMenu("set")}
                          onMouseLeave={() => setTvMenu((m) => (m === "set" ? null : m))}
                        >
                          <button
                            type="button"
                            className={`cmct-btn cmct-btn--icon${tvMenu === "set" ? " cmct-btn--on" : ""}`}
                            aria-label={t("chartBar.chartSettings", "Chart settings")}
                            aria-expanded={tvMenu === "set"}
                            onClick={() => setTvMenu((m) => (m === "set" ? null : "set"))}
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                              <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0" />
                              <circle cx="16" cy="7" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="17" r="2" />
                            </svg>
                          </button>
                          {tvMenu === "set" && (
                            <div className="cmct-menu cmct-menu--right" role="menu">
                              <span className="cmct-menu-label">{t("chartBar.chartType", "Chart type")}</span>
                              {(Object.keys(CHART_STYLE_LABELS) as ChartStyle[]).map((s) => (
                                <button
                                  key={s}
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={chartStyle === s}
                                  className={`cmct-menu-item${chartStyle === s ? " cmct-menu-item--on" : ""}`}
                                  onClick={() => { setChartStyle(s); setTvMenu(null); }}
                                >
                                  <span className="cmct-menu-ic" aria-hidden="true">{CHART_STYLE_ICONS[s]}</span>
                                  {t(`priceChart.style.${s}`)}
                                  {chartStyle === s && <span aria-hidden="true">✓</span>}
                                </button>
                              ))}
                              <span className="cmct-menu-sep" aria-hidden="true" />
                              <button
                                type="button"
                                role="menuitem"
                                className="cmct-menu-item"
                                onClick={() => { setTvMenu(null); toggleFullscreen(); }}
                              >
                                <span className="cmct-menu-ic" aria-hidden="true">
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
                                </span>
                                {t("chartBar.fullScreen", "Full screen")}
                              </button>
                            </div>
                          )}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
            {cmcLineView && !phoneCmc && cmcChartEl}
            {mobileTabs && (
              <div className={`chart-mview-tabs chart-mview-tabs--${mobileView}${pageTabBar ? " chart-mview-tabs--more" : ""}`}>
                <div className="chart-mview-tabs-main" role="tablist">
                  {([["chart", t("priceChart.tabs.chart")], ["orderbook", t("priceChart.tabs.orderbook")], ["trades", t("priceChart.tabs.trades")]] as const).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      role="tab"
                      aria-selected={mobileView === k}
                      className={`chart-mview-tab${mobileView === k ? " active" : ""}`}
                      onClick={() => setMobileView(k)}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="chart-mview-tabs-bar" aria-hidden="true" />
                </div>
                {/* Phones #trade: "More ▾" opens the Explore sections sheet. */}
                {pageTabBar}
              </div>
            )}
            {phoneHeaderEl}
            {/* Phones, Chart tab: "Bitcoin to USD Chart" title (CMC app). */}
            {/* (Predict / ProVision / ⚙ live in the interval row.) */}
            {phoneCmc && <h3 className="cmct-title">{t("chartBar.toUsdChart", "{{name}} to USD Chart", { name: COIN_FULL_NAME[coin] ?? coin })}</h3>}
            {/* Phones, line view: range chips above the chart (CMC app). */}
            {phoneCmc && cmcLineView && (
              <div className="cmct-ranges" role="tablist" aria-label={t("chartBar.range", "Range")}>
                {CMC_RANGES.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    role="tab"
                    aria-selected={cmcRange === r.id}
                    className={`cmct-rbtn${cmcRange === r.id ? " cmct-rbtn--on" : ""}`}
                    onClick={() => setCmcRange(r.id)}
                  >
                    {r.label}
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={cmcLog}
                  className={`cmct-rbtn${cmcLog ? " cmct-rbtn--on" : ""}`}
                  onClick={() => setCmcLog((v) => !v)}
                >
                  Log
                </button>
              </div>
            )}
            {phoneCmc && cmcLineView && <div onTouchEnd={onPhoneChartTap}>{cmcChartEl}</div>}
            {/* Phones, line view: CMC's small purple candles icon under the
                time axis, bottom-right → TradingView (candle) view. */}
            {phoneCmc && cmcLineView && (
              <div className="cmct-tvjump-row">
                <button
                  type="button"
                  className="cmct-tvjump"
                  aria-label={t("chartBar.switchToTv", "Switch to TradingView candles")}
                  onClick={() => { setChartMetric("price"); setCmcStyle("candles"); }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v4M6 7h4v9H6zM8 16v5M16 4v5M14 9h4v6h-4zM16 15v4" /></svg>
                </button>
              </div>
            )}
            {/* Phones, candle view (CMC app): [15m 1h 4h 24h 1W 1M | ⚙] —
                ⚙ opens Chart tools. An interval picked there (e.g. 5m) takes
                the last visible slot (1M) and stays until another is picked;
                ⚙ always stays. */}
            {phoneCmc && !cmcLineView && (
              <div className="cmct-ranges cmct-ivrow" role="tablist" aria-label={t("chartBar.interval", "Interval")}>
                {[...PHONE_IVS.slice(0, -1), phoneExtraIv ?? PHONE_IVS[PHONE_IVS.length - 1]].map((iv) => {
                  const pro = PRO_INTERVALS.has(iv) && !isPaid;
                  return (
                    <button
                      key={iv}
                      type="button"
                      role="tab"
                      aria-selected={interval === iv}
                      className={`cmct-rbtn${interval === iv ? " cmct-rbtn--on" : ""}`}
                      onClick={() => { if (pro) { onOpenUpgrade?.("pro"); return; } setInterval(iv); }}
                    >
                      {TV_INTERVAL_LABEL[iv]}
                    </button>
                  );
                })}
                <span className="cmct-ivdiv" aria-hidden="true" />
                {/* Predict (15-min Over/Under rounds) — same toggle as the
                    one beside the chart title. */}
                <button
                  type="button"
                  className={`cmct-rbtn cmct-rbtn--icon cmct-rbtn--predict${showCompactView ? " cmct-rbtn--on" : ""}`}
                  aria-label={t("chartBar.predict", "Predict")}
                  aria-pressed={showCompactView}
                  onClick={() => {
                    hapticTap();
                    if (showCompactView) { setShowCompactView(false); return; }
                    openPredict();
                  }}
                >
                  {/* Lightning bolt (fast 15-min rounds), green. */}
                  <svg className="cmct-predict-ic" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <defs>
                      <linearGradient id="cmctPredictGradRow" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
                        <stop offset="0" stopColor="#34d399" />
                        <stop offset="1" stopColor="#16a34a" />
                      </linearGradient>
                    </defs>
                    <path d="M13.5 2 4.5 13.2c-.4.5 0 1.3.6 1.3H11l-1.2 7.1c-.1.7.8 1.1 1.2.5l8.6-11.3c.4-.5 0-1.3-.6-1.3H13l1.6-6.6c.2-.8-.7-1.3-1.1-.9z" fill="url(#cmctPredictGradRow)" />
                  </svg>
                </button>
                {/* ProVision — only when the user can use it (trial, Pro,
                    Elite or the ProVision plan). */}
                {pvGate.access.mode !== "locked" && (
                  <button
                    type="button"
                    className={`cmct-rbtn cmct-rbtn--icon cmct-rbtn--pv${pvGate.on ? " cmct-rbtn--on" : ""}`}
                    aria-label={pvGate.on ? t("chartBar.pvOff", "Turn ProVision off") : t("chartBar.pvOn", "Turn ProVision on")}
                    aria-pressed={pvGate.on}
                    onClick={() => { hapticTap(); pvGate.toggle(coin); }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
                  </button>
                )}
                <button
                  type="button"
                  className="cmct-rbtn cmct-rbtn--icon"
                  onClick={() => setToolsSheetOpen(true)}
                  aria-label={t("chartBar.chartTools", "Chart tools")}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                    <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0" />
                    <circle cx="16" cy="7" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="17" r="2" />
                  </svg>
                </button>
              </div>
            )}
            {mobileTabs && mobileView !== "chart" && (
              <div className="chart-mview-book">
                <OrderBook coin={coin} embedded view={mobileView} />
              </div>
            )}
            {/* Desktop #trade with the tab row: tools live in the tab row. */}
            {!(tradeDesktopLean && pageTabBar) && (
            <div className={`chart-bar-toolbar${isDesktopWidth ? "" : " chart-bar-toolbar--actions"}`}>
              {!tradeDesktopLean && quickIntervalPills}
              <span className="chart-bar-toolbar-spacer" />
              {isDesktopWidth ? heroIconRow : showToolsButton}
              {!isDesktopWidth && (
                <span className="chart-tool-pinned ctb-actions">
                  {/* Full Chart (icon + label). Reset and Save image live in
                      Tools. */}
                  <button
                    type="button"
                    className="chart-depth-btn ctb-full"
                    onClick={toggleFullscreen}
                    title={t("priceChart.c.fullChart")}
                    aria-label={t("priceChart.c.fullChart")}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                    </svg>
                    <span className="chart-tool-label">{t("priceChart.c.fullChart")}</span>
                  </button>
                </span>
              )}
            </div>
            )}
          </>
          ) : (
          <>
          <div className="chart-header">
            <div className="chart-header-left">
              {/* Fullscreen (mobile/iOS and desktop alike): exchange-style
                  stats grid (High/Low · Bid/Ask · Vol) + price/change
                  line, replacing the name/LIVE/zone-signal/div-badge row
                  entirely — picked over the badge-based header directions
                  above. Only normal (non-fullscreen) mobile/desktop keep
                  the original title row below/further down. */}
              {isFullscreen ? (() => {
                // Advance Price Chart page, mobile — no header row here;
                // coin/price/change now overlay directly on the chart
                // canvas instead (chart-mobile-top-header, rendered inside
                // .chart-canvas-wrap below, same technique the desktop
                // OHLC overlay already uses) so the canvas keeps the full
                // flex height instead of losing a row's worth of space to
                // a header block.
                if (pageMode && !isDesktopWidth) return null;
                // "Minimal Header" layout — single compact coin+price row,
                // High/Low/Vol/Signal collapsed into one tappable strip
                // instead of sitting permanently expanded. Style/
                // Indicators/Interval live in the persistent docked sheet
                // instead (fsDockSheet, portaled to document.body).
                return (
                <div className="chart-fs-header-block">
                  <div className="chart-fs-compact-row">
                    <span
                      className="chart-fs-coin-avatar"
                      style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                    >
                      {COIN_GLYPHS[coin] ?? coin[0]}
                    </span>
                    <h3
                      className={`chart-fs-coin-name chart-fs-coin-name--compact chart-title-tappable${pageMode ? " chart-title-tappable--plain" : ""}`}
                      onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
                    >
                      {t("chart.title", { coin: COIN_FULL_NAME[coin] ?? coin })}
                      <svg className="chart-title-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </h3>
                    {currentPrice !== null && (
                      <span
                        className={`chart-current-price chart-fs-compact-price${priceDirection ? ` chart-current-price--${priceDirection}` : ""}`}
                      >
                        {formatLivePrice(currentPrice)}
                      </span>
                    )}
                    {dayChangeAbs !== null && dayChangePercent !== null && (
                      <span
                        className={`chart-fs-price-change chart-fs-compact-change${dayChangePercent >= 0 ? " chart-fs-price-change--up" : " chart-fs-price-change--down"}`}
                      >
                        {dayChangePercent >= 0 ? "+" : ""}{dayChangePercent.toFixed(2)}%
                      </span>
                    )}
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="chart-fs-exit-corner-btn"
                      onClick={toggleFullscreen}
                      title={t("priceChart.exitFullscreen")}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  {/* Advance Price Chart page, mobile — stats move into
                      the dock's new Stats category instead (fsDockSheet
                      below), so the header stays just the compact coin/
                      price/change row and the chart gets the rest of the
                      screen. Desktop fullscreen (and any fallback) keeps
                      the tappable strip + expandable panel as before. */}
                  {!(pageMode && !isDesktopWidth) && (
                  <>
                  <button
                    type="button"
                    className="chart-fs-stats-strip"
                    onClick={() => setFsStatsExpanded((v) => !v)}
                  >
                    <span className="chart-fs-strip-item">{t("priceChart.c.high")} <b className="chart-fs-strip-up">{dayHigh !== null ? formatLivePrice(dayHigh) : "—"}</b></span>
                    <span className="chart-fs-strip-item">{t("priceChart.c.low")} <b className="chart-fs-strip-down">{dayLow !== null ? formatLivePrice(dayLow) : "—"}</b></span>
                    <span className="chart-fs-strip-item">{t("priceChart.c.volUsd")} <b>{quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}</b></span>
                    {isPaid && fsSignalBucket && (
                      <span className={`chart-fs-strip-signal chart-fs-strip-signal--${fsSignalBucket}`}>{fsSignalLabel}</span>
                    )}
                    <div style={{ flex: 1 }} />
                    <svg className="chart-fs-strip-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: fsStatsExpanded ? "rotate(180deg)" : "rotate(0deg)" }}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  {fsStatsExpanded && (
                  <div className="chart-fs-info-row">
                  <div className="chart-fs-stats-grid">
                    <div className="chart-fs-stat-col">
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("priceChart.c.bid")}</span>
                        <span className="chart-fs-stat-value chart-fs-stat-value--up">
                          {bidPrice !== null ? formatLivePrice(bidPrice) : "—"}
                        </span>
                      </div>
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("priceChart.c.ask")}</span>
                        <span className="chart-fs-stat-value chart-fs-stat-value--down">
                          {askPrice !== null ? formatLivePrice(askPrice) : "—"}
                        </span>
                      </div>
                    </div>
                    <div className="chart-fs-stat-col chart-fs-stat-col--right">
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("priceChart.c.volCoin", { coin })}</span>
                        <span className="chart-fs-stat-value">
                          {baseVolume24h !== null ? formatCompactVolume(baseVolume24h) : "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                  {zone && isPaid && fsSignalBucket && (
                    <div className="chart-fs-meter">
                      <span className="chart-fs-meter-label">{t("priceChart.c.signal")}</span>
                      <div className="chart-fs-meter-row">
                        <span className="chart-fs-meter-track">
                          <span
                            className={`chart-fs-meter-dot chart-fs-meter-dot--${fsSignalBucket}`}
                            style={{ left: `${fsSignalPct}%` }}
                          />
                        </span>
                        <span className={`chart-fs-meter-value chart-fs-meter-value--${fsSignalBucket}`}>{fsSignalLabel}</span>
                      </div>
                    </div>
                  )}
                  {!isPaid && (
                    <button
                      className={`zone-signal-gate zone-signal-gate--${zone?.signal ?? "neutral"}`}
                      onClick={() => onOpenUpgrade?.("pro")}
                    >
                      <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-${zone?.signal ?? "neutral"}`} />
                      {t("priceChart.unlockStatus")}
                    </button>
                  )}
                  {isPaid && (
                    <div className="chart-fs-meter">
                      <span className="chart-fs-meter-label">{t("priceChart.c.div")}</span>
                      <div className="chart-fs-meter-row">
                        <span className="chart-fs-meter-track chart-fs-meter-track--rev">
                          <span
                            className={`chart-fs-meter-dot chart-fs-meter-dot--${fsDivDotBucket}`}
                            style={{ left: `${fsDivPct}%` }}
                          />
                        </span>
                        <span className={`chart-fs-meter-value chart-fs-meter-value--${fsDivDotBucket}`}>{fsDivLabel}</span>
                      </div>
                    </div>
                  )}
                  {!isPaid && (
                    <button
                      className={`zone-signal-gate zone-signal-gate--div-${divergence?.type ?? "neutral"}`}
                      onClick={() => onOpenUpgrade?.("pro")}
                    >
                      <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-div-${divergence?.type ?? "neutral"}`} />
                      {t("priceChart.unlockDivergence")}
                    </button>
                  )}
                  </div>
                  )}
                  </>
                  )}
                </div>
                );
              })() : (
                // Identical for mobile and desktop now — same markup,
                // same classes, no separate mobile-only version. The
                // existing responsive CSS (the .chart-header grid is
                // itself min-width:641px-gated, falling back to its
                // base flex-wrap below that) adapts this to width on its
                // own instead of two parallel hand-built layouts drifting
                // apart from each other over time.
                <>
                {/* Reference-match hero rows (compact view only — fullscreen
                    keeps its own header above untouched): small coin-icon +
                    pair-name row, then a big price + rounded %-change badge
                    row below it. currentPrice/dayChangePercent/priceDirection
                    already exist in this component's scope (used by the
                    fullscreen/mobile branches above). */}
                {!isFullscreen && (
                  <div className="chart-hero-id-row">
                    {(() => {
                      const icon = !heroLogoError ? (
                        <img
                          className="chart-hero-coin-icon chart-hero-coin-icon--img"
                          src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
                          alt=""
                          loading="lazy"
                          onError={() => setHeroLogoError(true)}
                        />
                      ) : (
                        <span
                          className="chart-hero-coin-icon"
                          style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                        >
                          {COIN_GLYPHS[coin] ?? coin[0]}
                        </span>
                      );
                      // Now the ONE coin switcher on this page, mobile and
                      // desktop alike — App.tsx's own mch-coin-btn (top bar)
                      // is gone, so this is the only entry point left;
                      // same onOpenCoinPicker the Advance Chart page's own
                      // chart-tv-symbol button (above) already opens.
                      return (
                        <button
                          type="button"
                          className="chart-hero-coin-selector"
                          onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
                        >
                          {icon}
                          <span className="chart-hero-pair-name">{coin}/USD</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      );
                    })()}
                    {/* Top 5 by market cap, overlapping avatar stack —
                        hover un-overlaps them for an easier target; click
                        one to jump straight to it (onSelectCoin, skips the
                        full picker), or click the trailing "…" to open the
                        full picker (onOpenCoinPicker) same as the main
                        selector button above. */}
                    <div className="chart-hero-top-coins">
                      {TOP5_COINS.map((symbol, i) => (
                        <button
                          key={symbol}
                          type="button"
                          className={`chart-hero-top-coin${symbol === coin ? " chart-hero-top-coin--current" : ""}`}
                          style={{ zIndex: TOP5_COINS.length - i, background: COIN_COLORS[symbol] ?? "var(--pc-accent)" }}
                          onClick={() => onSelectCoin?.(symbol)}
                          title={t("priceChart.switchTo", { symbol })}
                        >
                          {COIN_GLYPHS[symbol] ?? symbol[0]}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="chart-hero-top-coin chart-hero-top-coin--more"
                        style={{ zIndex: 0 }}
                        onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
                        title={t("priceChart.moreCoins")}
                      >
                        …
                      </button>
                    </div>
                  </div>
                )}
                <div className="chart-title-row">
                  {!isFullscreen && currentPrice !== null ? (
                    // Same cpv-price-row markup/classes CompactPriceView's
                    // own price display uses — adopted here (price chart's
                    // header), same direction as the icon/LIVE-badge swap,
                    // using this page's own real 24H change instead of
                    // CompactPriceView's separate 1H-window figures.
                    <span className="cpv-price-row">
                      <span className={`cpv-price${dayChangePercent !== null && dayChangePercent >= 0 ? " cpv-up" : " cpv-down"}`}>
                        {formatLivePrice(currentPrice)}
                      </span>
                      {dayChangeAbs !== null && dayChangePercent !== null && (
                        <span className={`cpv-change${dayChangePercent >= 0 ? " cpv-up" : " cpv-down"}`}>
                          {dayChangePercent >= 0 ? "▲" : "▼"} {Math.abs(dayChangePercent).toFixed(2)}%
                          <span className="cpv-change-abs">
                            ({formatLivePrice(Math.abs(dayChangeAbs))})
                          </span>
                          <span className="cpv-change-window">24H</span>
                        </span>
                      )}
                    </span>
                  ) : (
                    <h3>{t("chart.title", { coin: COIN_FULL_NAME[coin] ?? coin })}</h3>
                  )}
                  {isFullscreen && currentPrice !== null && (
                    <span className="chart-current-price-group">
                      <span
                        className={`chart-current-price${priceDirection ? ` chart-current-price--${priceDirection}` : ""}`}
                      >
                        {formatLivePrice(currentPrice)}
                      </span>
                      <span className="aiqw-live-badge"><span className="aiqw-live-dot" />{t("priceChart.live")}</span>
                    </span>
                  )}
                  {/* Reference-match: the compact hero stays just
                      icon+name/price+change — zone/divergence signal
                      badges and the High/Low row are real functionality,
                      not deleted, just folded to the fullscreen header
                      only now so the compact card matches the reference's
                      clean, minimal look. */}
                  {isFullscreen && zone && isPaid && zoneLabel && (
                    <SignalIndicator signal={zone.signal} label={zoneLabel} />
                  )}
                  {isFullscreen && !isPaid && (
                    <button
                      className={`zone-signal-gate zone-signal-gate--${zone?.signal ?? "neutral"}`}
                      onClick={() => onOpenUpgrade?.("pro")}
                    >
                      <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-${zone?.signal ?? "neutral"}`} />
                      {t("priceChart.unlockStatus")}
                    </button>
                  )}
                  {isFullscreen && divergence && isPaid && (
                    <span className={`div-badge div-badge--${divergence.type}`}>
                      {divergence.type === "bullish" ? "↑ Bull Div" : "↓ Bear Div"}
                    </span>
                  )}
                  {isFullscreen && !isPaid && (
                    <button
                      className={`zone-signal-gate zone-signal-gate--div-${divergence?.type ?? "neutral"}`}
                      onClick={() => onOpenUpgrade?.("pro")}
                    >
                      <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-div-${divergence?.type ?? "neutral"}`} />
                      {t("priceChart.unlockDivergence")}
                    </button>
                  )}
                </div>
                {displayDayHigh !== null && displayDayLow !== null && (
                  <div className="chart-fs-stat-col">
                    <div className="chart-fs-stat-col chart-fs-stat-col--row">
                      {!isFullscreen && (
                        <span className="chart-hero-selected-interval">{INTERVAL_SHORT[interval]}</span>
                      )}
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("priceChart.c.high")}</span>
                        <span className="chart-fs-stat-value chart-fs-stat-value--up">{formatLivePrice(displayDayHigh)}</span>
                      </div>
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("priceChart.c.low")}</span>
                        <span className="chart-fs-stat-value chart-fs-stat-value--down">{formatLivePrice(displayDayLow)}</span>
                      </div>
                      {!isFullscreen && quoteVolume24h !== undefined && (
                        <div className="chart-fs-stat-row">
                          {/* Mobile/iOS only — small coin icon ahead of the
                              label, same icon/fallback pattern as the hero
                              row above (.chart-hero-coin-icon). */}
                          {!isDesktopWidth && (
                            !heroLogoError ? (
                              <img
                                className="chart-fs-stat-coin-icon"
                                src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
                                alt=""
                                loading="lazy"
                                onError={() => setHeroLogoError(true)}
                              />
                            ) : (
                              <span
                                className="chart-fs-stat-coin-icon chart-fs-stat-coin-icon--fallback"
                                style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                              >
                                {COIN_GLYPHS[coin] ?? coin[0]}
                              </span>
                            )
                          )}
                          <span className="chart-fs-stat-label">{t("priceChart.c.vol24h")}</span>
                          <span className="chart-fs-stat-value">{formatCompactVolume(quoteVolume24h)}</span>
                        </div>
                      )}
                    </div>
                    {/* Zone status + divergence badges moved into the AI
                        insight banner's header below (interval-banner-
                        header) instead of living here too — same data,
                        one place. Free users (no banner at all) still get
                        the upsell gates here. */}
                    {!isFullscreen && !isPaid && (
                      <div className="chart-fs-stat-col chart-fs-stat-col--row chart-hero-zone-row">
                        <button
                          className={`zone-signal-gate zone-signal-gate--${zone?.signal ?? "neutral"}`}
                          onClick={() => onOpenUpgrade?.("pro")}
                        >
                          <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-${zone?.signal ?? "neutral"}`} />
                          {t("priceChart.unlockStatus")}
                        </button>
                        <button
                          className={`zone-signal-gate zone-signal-gate--div-${divergence?.type ?? "neutral"}`}
                          onClick={() => onOpenUpgrade?.("pro")}
                        >
                          <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-div-${divergence?.type ?? "neutral"}`} />
                          {t("priceChart.unlockDivergence")}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                </>
              )}
            </div>
            {/* Mobile only — headerStats (.mch-body/.mch-stats) moves up
                here, above chart-header-right (the pills/icon row right
                below), instead of its usual spot after .chart-header
                closes entirely (still that spot on desktop, below). */}
            {!isDesktopWidth && headerStats}
            {/* Reference-match: pills + icon buttons sit beside the coin-
                name/price rows (a 2x2 grid on desktop — name/pills on top,
                price/icons below; the grid CSS itself is min-width:641px-
                gated, so this just stacks below 641px instead). Mobile and
                desktop both now, identical markup; reuses the exact same
                handlers/components (quickIntervalPills, indicatorsControl,
                gridStyleControls, handleScreenshot, toggleFullscreen) the
                old below-header row used, so nothing is duplicated —
                that row's own copies are hidden for this exact scope
                just below (search chart-legend-actions). */}
            {!isFullscreen && (
              <div className="chart-header-right">
                {/* Mobile web/iOS: moved below the chart, merged with the
                    fullscreen button into one row (see
                    chart-mobile-interval-fs-row, right after
                    .chart-dblclick-wrap closes) — desktop keeps both here. */}
                {isDesktopWidth && quickIntervalPills}
                {heroIconRow}
                {/* Mobile's own separate row — the text link this control
                    used to be before it was folded into chart-hero-icon-
                    row (desktop only now, above) as a bare icon. */}
                {!isDesktopWidth && (
                  <button
                    type="button"
                    className="chart-compact-link"
                    onClick={() => {
                      if (showCompactView) { setShowCompactView(false); return; }
                      if (!isPaid) { onOpenUpgrade?.("pro"); return; }
                      setShowCompactView(true);
                    }}
                  >
                    {!showCompactView ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="8" y1="3" x2="8" y2="21" />
                        <rect x="6" y="8" width="4" height="8" rx="1" fill="currentColor" stroke="none" />
                        <line x1="16" y1="5" x2="16" y2="19" />
                        <rect x="14" y="9" width="4" height="7" rx="1" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
                        <path d="M15.21 8.17 A5 5 0 0 1 15.21 15.83" />
                        <path d="M8.79 8.17 A5 5 0 0 0 8.79 15.83" />
                        <path d="M17.14 5.87 A8 8 0 0 1 17.14 18.13" />
                        <path d="M6.86 5.87 A8 8 0 0 0 6.86 18.13" />
                        <path d="M19.07 3.57 A11 11 0 0 1 19.07 20.43" />
                        <path d="M4.93 3.57 A11 11 0 0 0 4.93 20.43" />
                      </svg>
                    )}
                    <span>{showCompactView ? t("priceChart.c.switchToFull") : t("priceChart.c.switchToCompact")}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {isDesktopWidth && headerStats}
          </>
          )}

        </div>
        </>
        )}

        {patternInsightSheetOpen && displayBanner && (
          <BottomSheet open onClose={() => setPatternInsightSheetOpen(false)} title={<><span className={`interval-sheet-title pattern-insight-sheet-title pattern-insight-sheet-title--${displayBanner.sentiment}`}>
                  {displayBanner.title}
                </span></>} className="pattern-insight-sheet">
              <div className="pattern-insight-sheet-meta">
                {bannerAt !== null && (
                  <span className="pattern-insight-updated">
                    {t("priceChart.c.lastUpdated")} {formatClockTime(bannerAt)}
                  </span>
                )}
                <span className="aiqw-live-badge"><span className="aiqw-live-dot" />{t("priceChart.live")}</span>
                <span className="pattern-insight-ai-badge pattern-insight-ai-badge--pill">{t("chart.aiPowered")}</span>
              </div>
              <p className="pattern-insight-sheet-body">{displayBanner.body}</p>
          </BottomSheet>
        )}

        {/* Free-user AI upsell: one combined banner, under the chart
            (below), instead of one here and another one there. */}

        {/* Desktop #trade: Signal Check as a strip right above the chart. */}
        {pvHudOn && renderPvHud("bar")}

        <div
          style={
            pageMode && !isDesktopWidth
              ? // Direct child of .price-chart-fs-scroll (the actual flex
                // container) — this is the element that needs flex:1, not
                // .chart-canvas-wrap below, which is nested one level
                // deeper inside here and isn't a flex item of anything.
                { position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }
              : { position: "relative" }
          }
          // Double-click toggles fullscreen.
          // Desktop (mouse) only — no double-tap gesture on mobile.
          onDoubleClick={isDesktopWidth ? toggleFullscreen : undefined}
          // Phones, chart page: double-tap the chart → Advance Chart.
          onTouchEnd={phoneCmc ? onPhoneChartTap : undefined}
          className={`chart-dblclick-wrap${
            Capacitor.isNativePlatform() && !isFullscreen ? " chart-dblclick-wrap--no-hint" : ""
          }${
            Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios" && !isFullscreen ? " chart-dblclick-wrap--ios-bleed" : ""
          }`}
          ref={dblClickWrapRef}
        >
            {/* Desktop chart page (TradingView view): OHLC line, top-left. */}
            {tradeDesktopLean && !isFullscreen && <div className="chart-ohlc" ref={ohlcRef} aria-live="off" />}
            {/* ↺ reset view — after the user moves / zooms the chart. */}
            {viewMoved && (tvDrawRail || phoneCmc) && !isFullscreen && (
              <button type="button" className="chart-view-reset" onClick={resetMovedView} aria-label={t("priceChart.resetView")} title={t("priceChart.resetView")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
              </button>
            )}
            {swipeHint !== "gone" && pageMode && !isDesktopWidth && (
              <div className={`chart-swipe-hint${swipeHint === "fade" ? " chart-swipe-hint--out" : ""}`} aria-hidden="true">
                <span className="chart-swipe-hint-edge" />
                <span className="chart-swipe-hint-chev">
                  {/* Hand gesture (thumb + index up, fingers folded) */}
                  <svg width="30" height="30" viewBox="1 7 21 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5.5 26.5c-2.4-2.6-2.6-6.2-.8-9.2l3.4-5.6c.8-1.3 2.8-.6 2.5 1l-.9 3.6 5.2-6.8c.9-1.2 2.8-.2 2.2 1.2l-2.9 5.2" />
                    <path d="M11.2 15.4l4.6-5.1c1-1.1 2.8 0 2.1 1.4l-3.6 5.6" />
                    <path d="M13.6 18.2l4.2-3.4c1.1-.9 2.6.5 1.7 1.7l-3.8 4" />
                    <path d="M15 21.1l3.6-2.9c1.1-.8 2.4.7 1.5 1.8l-3.4 3.3" />
                    <path d="M5.5 26.5c2.6 2.6 6.6 3 9.6.9l2.7-2.5" />
                  </svg>
                </span>
              </div>
            )}
            {fsHint !== "gone" && mobileTabs && (
              <div className={`chart-fs-hint${fsHint === "fade" ? " chart-fs-hint--out" : ""}`} aria-live="polite">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
                <span>{t("priceChart.fsHint")}</span>
              </div>
            )}
            {/* "Compact" side of the Full/Compact switch above — covers
                just this chart area (not the header/switch themselves,
                both outside .chart-dblclick-wrap) instead of the old
                full-viewport portal takeover, so switching feels like
                swapping the chart in place rather than leaving the page.
                Mobile and desktop compact both use this now — only
                fullscreen/pageMode still get the standalone modal. */}
            {/* Advance Price Chart page, mobile — this whole icon row
                (Save/Reset/depth/Exit-fullscreen etc.) moves into the
                dock's peek row instead (fsDockSheet below), so the chart
                gets the space back. Desktop fullscreen keeps it.
                Compact (non-fullscreen, non-pageMode) also skips this row
                now, mobile AND desktop — its equivalent (style/indicators/
                interval pills + save/fullscreen) moved up into
                .chart-header-right, identical reference-match layout
                either width. pageMode desktop (the dedicated Advance
                Chart page) also skips it — its own equivalent moved into
                the new top toolbar (.chart-tv-toolbar, TradingView-
                reference-match) instead, so there's one toolbar row,
                not two. */}
            {!(pageMode && !isDesktopWidth) && !(!isFullscreen && isDesktopWidth) && !(pageMode && isDesktopWidth) && !(!pageMode && !isFullscreen) && (
            <div className={`chart-legend-actions${Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios" ? " chart-legend-actions--ios" : ""}`}>
              {/* Chart style/Interval/Indicators — every compact view
                  (mobile/iOS and desktop alike) plus desktop fullscreen,
                  each opening its own dropdown there; mobile fullscreen
                  still uses the "Chart Settings" dock instead
                  (fsDockSheet below). */}
              {(!isFullscreen || isDesktopWidth) && gridStyleControls}
              {(!isFullscreen || isDesktopWidth) && fsIntervalButton}
              {(!isFullscreen || isDesktopWidth) && indicatorsControl}
              <span className="chart-legend-actions-group--right" />
              {/* Grid is already inside the dock's Style category too —
                  no separate standalone button in fullscreen. */}
              {!isFullscreen && gridToggleButton}
              <button
                className={`chart-depth-btn${showDepthProfile ? " chart-depth-btn--active" : ""}`}
                onClick={() => {
                  // OrderBookProfileModal (below) is a self-contained
                  // full-screen modal of its own — it never actually
                  // needed the CHART to also be fullscreen. That old
                  // coupling meant tapping this on the compact chart now
                  // navigated to the Advance Price Chart page instead of
                  // just opening the depth panel, since entering
                  // fullscreen there means a real page navigation.
                  setShowDepthProfile((v) => !v);
                }}
                title={
                  showDepthProfile ? t("priceChart.hideDepth") : t("priceChart.showDepth")
                }
                data-tooltip={showDepthProfile ? t("priceChart.hideDepth") : t("priceChart.showDepth")}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="6" />
                  <line x1="21" y1="10" x2="6" y2="10" />
                  <line x1="15" y1="14" x2="6" y2="14" />
                  <line x1="12" y1="18" x2="6" y2="18" />
                </svg>
                <span className="chart-icon-label">
                  {t("chart.orderDepth")}
                </span>
              </button>
              {/* Hidden for now — button removed, but showAstroChart/
                  AstroSuggestions render logic below is untouched so this
                  is a one-line revert (just uncomment) whenever it comes
                  back. */}
              {false && (
                <button
                  className={`chart-depth-btn${showAstroChart ? " chart-depth-btn--active" : ""}`}
                  onClick={() => setShowAstroChart(true)}
                  title={t("priceChart.c.astroTitle")}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2l1.8 5.6L19 9l-5.2 1.4L12 16l-1.8-5.6L5 9l5.2-1.4z" />
                    <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z" />
                  </svg>
                  <span className="chart-icon-label">
                    {t("priceChart.c.astroTitle")}
                  </span>
                </button>
              )}
              {((Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") || (!Capacitor.isNativePlatform() && isDesktopWidth)) && (
                <button
                  className="chart-depth-btn"
                  onClick={() => {
                    if (!isPaid) { onOpenUpgrade?.("pro"); return; }
                    setShowCompactView(true);
                  }}
                  title={t("chart.compactView", "Compact View")}
                  data-tooltip={t("chart.compactView", "Compact View")}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
                    <path d="M15.21 8.17 A5 5 0 0 1 15.21 15.83" />
                    <path d="M8.79 8.17 A5 5 0 0 0 8.79 15.83" />
                    <path d="M17.14 5.87 A8 8 0 0 1 17.14 18.13" />
                    <path d="M6.86 5.87 A8 8 0 0 0 6.86 18.13" />
                    <path d="M19.07 3.57 A11 11 0 0 1 19.07 20.43" />
                    <path d="M4.93 3.57 A11 11 0 0 0 4.93 20.43" />
                  </svg>
                  <span className="chart-icon-label">{t("chart.compactView", "Compact View")}</span>
                </button>
              )}
              {onToggleCoinChat && Capacitor.getPlatform() !== "ios" && (
                <button
                  className={`chart-livechat-pill${coinChatOpen ? " chart-livechat-pill--active" : ""}`}
                  onClick={onToggleCoinChat}
                  title={coinChatOpen ? t("coinChat.hide", "Hide chat") : t("coinChat.triggerLabel")}
                  data-tooltip={coinChatOpen ? t("coinChat.hide", "Hide chat") : t("coinChat.triggerLabel")}
                >
                  {coinChatOpen ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  ) : (
                    <span className="chart-livechat-dot" />
                  )}
                  {t("coinChat.triggerLabel")}
                </button>
              )}
              {/* Desktop fullscreen only — compact view already has its
                  own Grid button earlier in this row; mobile fullscreen
                  still covers Grid via the dock's Style category. */}
              {isFullscreen && isDesktopWidth && gridToggleButton}
              {/* Save joins this row everywhere (compact and fullscreen,
                  mobile/iOS and desktop alike); Reset only in fullscreen
                  (it has no non-fullscreen equivalent). The old floating
                  top-left buttons (.chart-reset-view-btn/.chart-save-
                  view-btn) are hidden unconditionally now — see below —
                  since every platform uses this icon row instead. */}
              <button
                type="button"
                className={`chart-depth-btn chart-fs-save-btn${!isDesktopWidth ? " chart-fs-save-btn--ios-push-right" : ""}`}
                onClick={handleScreenshot}
                title={t("chart.save")}
                data-tooltip={t("chart.save")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <span className="chart-icon-label">{t("chart.save")}</span>
              </button>
              {isFullscreen && (
                <button
                  type="button"
                  className="chart-depth-btn chart-fs-reset-btn"
                  onClick={() => {
                    chartRef.current?.timeScale().fitContent();
                    rsiChartRef.current?.timeScale().fitContent();
                    macdChartRef.current?.timeScale().fitContent();
                  }}
                  title={t("chart.reset")}
                  data-tooltip={t("chart.reset")}
                >
                  <span aria-hidden="true">⤢</span>
                  <span className="chart-icon-label">{t("chart.reset")}</span>
                </button>
              )}
              <button
                type="button"
                className="chart-depth-btn chart-fullscreen-btn"
                onClick={toggleFullscreen}
                title={t("priceChart.c.fullscreen")}
                data-tooltip={t("priceChart.c.fullscreen")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
                <span className="chart-icon-label">{t("priceChart.c.fullscreen")}</span>
              </button>
            </div>
            )}
          {/* Phones, chart page: a clean spinner (the chart is hidden, not blurred). */}
          {loading && phoneCmc && (
            <div className="chart-loading-overlay">
              <span className="cmch-spinner" role="status" aria-label={t("chart.loading")} />
            </div>
          )}
          {/* Once loading is done, the ProVision pill (Analyze or Renew) sits
              exactly where "Loading chart data" was (same centred overlay). */}
          {!loading && pvPromoPill && !cmcHidesCandles && !isFullscreen && (
            <div className="chart-loading-overlay chart-pv-renew-slot">{pvPromoPill}</div>
          )}
          {loading && !phoneCmc && (
            <div className="chart-loading-overlay">
              <span className="chart-loading-label">
                {t("chart.loading")}
                <svg
                  className="chart-loading-line"
                  viewBox="0 0 28 14"
                  width="28"
                  height="14"
                  fill="none"
                >
                  <path
                    pathLength={1}
                    d="M1,11 L6,8 L10,10 L14,4 L18,7 L22,3 L27,6"
                  />
                </svg>
              </span>
            </div>
          )}
          {!loading && error && lastCandlesRef.current.length === 0 && (
            <div className="chart-error">⚠️ {error}</div>
          )}
          <div
            ref={containerRef}
            className="chart-canvas-wrap chart-main-wrap"
            // Chart page: any drag / pinch / wheel on the plot → show ↺.
            onPointerDown={(tvDrawRail || phoneCmc) && !viewMoved ? (e) => {
              // Taps on the drawing rail / banner / ↺ don't count as moving the chart.
              if (!(e.target as Element).closest(".cdt-toolbar, .pv-pill, .chart-view-reset")) setViewMoved(true);
            } : undefined}
            onWheel={(tvDrawRail || phoneCmc) && !viewMoved ? () => setViewMoved(true) : undefined}
            style={
              pageMode
                ? // Advance Price Chart page (mobile AND desktop) —
                  // flex-fill instead of a fixed viewport-relative height
                  // (.price-chart-fs-scroll is a flex column for this case,
                  // see PriceChart.css — desktop now matches mobile's own
                  // treatment here instead of being a scrolling page). The
                  // chart gets exactly whatever's left after the header/
                  // toolbar, so the whole page fits in one viewport with
                  // no scroll, instead of a guessed pixel height that goes
                  // stale every time the header's own content changes.
                  { width: "100%", flex: "1 1 auto", minHeight: 0 }
                : {
                    width: "100%",
                    height: isFullscreen
                      ? (isDesktopWidth ? "calc(100vh - 200px)" : "calc(100vh - 260px)")
                      : "400px",
                  }
            }
          />
          {/* Reference-match (TradingView desktop chart) — interval-range
              bar docked at the bottom of the page instead of only living
              in the top toolbar's single pill, same real intervals/pro-
              gating the rest of the app already uses. flex-shrink:0 (see
              PriceChart.css) keeps this a fixed-height row while the
              chart canvas above it (flex:1) does all the shrinking. */}
          {/* Range presets bar (desktop — Chart page AND the Advance
              Chart page, where it replaced the old interval-pill bottom
              bar; intervals are still in the top toolbar there).
              TradingView-style: each button switches the candle interval
              and zooms the view to that span. Hover shows what it means. */}
          {(isDesktopWidth || mobileTabs) && (
            <div className={`chart-range-bar${pageMode ? " chart-range-bar--page" : ""}${!isDesktopWidth ? " chart-range-bar--mobile" : ""}`}>
              {/* Mobile: presets + custom range folded into one
                  "Date Range" dropdown (reference: Hyperliquid mobile). */}
              {!isDesktopWidth && (
                <button type="button" className="chart-range-select" onClick={openDateRangeSheet}>
                  <span>{activeRangePreset ? activeRangePreset.label : t("chartBar.dateRange", "Date Range")}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                </button>
              )}
              {isDesktopWidth && RANGE_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.key}
                  className={`chart-range-btn${activeRangePreset?.key === p.key ? " active" : ""}`}
                  data-tip={t(`chartBar.rangeTip.${p.key}`, p.tip)}
                  aria-label={t(`chartBar.rangeTip.${p.key}`, p.tip)}
                  onClick={() => applyRangePreset(p)}
                >
                  {p.label}
                </button>
              ))}
              <span className="chart-range-divider" />
              <button
                type="button"
                className={`chart-range-btn chart-range-btn--icon${goToOpen ? " active" : ""}`}
                data-tip={t("chartBar.goTo", "Go to date or custom range")}
                aria-label={t("chartBar.goTo", "Go to date or custom range")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setGoToOpen((o) => !o)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="17" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" />
                  <path d="M10 15h7M14 12l3 3-3 3" />
                </svg>
              </button>
              {goToOpen && (
                <ChartGoTo
                  onClose={() => setGoToOpen(false)}
                  onGoToDate={goToDate}
                  onGoToRange={goToRange}
                />
              )}
              <span className="chart-range-spacer" />
              <RangeBarClock />
              <span className="chart-range-divider" />
              <button
                type="button"
                className={`chart-range-btn chart-range-btn--scale${scaleMode === "percent" ? " active" : ""}`}
                data-tip={t("chartBar.pctScale", "Percentage scale")}
                aria-pressed={scaleMode === "percent"}
                onClick={() => setScaleMode((m) => (m === "percent" ? "normal" : "percent"))}
              >
                %
              </button>
              <button
                type="button"
                className={`chart-range-btn chart-range-btn--scale${scaleMode === "log" ? " active" : ""}`}
                data-tip={t("chartBar.logScale", "Logarithmic scale")}
                aria-pressed={scaleMode === "log"}
                onClick={() => setScaleMode((m) => (m === "log" ? "normal" : "log"))}
              >
                log
              </button>
              <button
                type="button"
                className={`chart-range-btn chart-range-btn--scale${autoScale ? " active" : ""}`}
                data-tip={t("chartBar.autoFit", "Auto-fit price axis to visible candles")}
                aria-pressed={autoScale}
                onClick={() => setAutoScale((a) => !a)}
              >
                auto
              </button>
            </div>
          )}
          {!pageMode && isDesktopWidth && (
            <div
              ref={crosshairTooltipRef}
              className="chart-crosshair-tooltip"
              style={{ opacity: 0 }}
            >
              <span className="chart-crosshair-tooltip-date" />
              <span className="chart-crosshair-tooltip-price" />
            </div>
          )}
          {/* Reference-match (TradingView desktop chart): OHLC readout +
              Buy/Sell boxes overlaid on the chart canvas's own top-left
              corner, replacing the old separate header row (collapsed
              above via chart-fs-header-group--empty). Real data — the
              latest loaded candle's own open/high/low/close, not
              placeholder numbers; "Sell"/"Buy" open the real TradingAgent
              panel (same .ta-trigger reuse as the toolbar's own Trade
              button) since this app has no literal order-ticket feature
              to back a real buy/sell action here. */}
          {pageMode && isDesktopWidth && (() => {
            const lastCandle = lastCandlesRef.current[lastCandlesRef.current.length - 1];
            if (!lastCandle) return null;
            const live = currentPrice ?? lastCandle.close;
            const changeUp = (dayChangeAbs ?? 0) >= 0;
            return (
              <div className="chart-tv-ohlc-overlay">
                <div className="chart-tv-ohlc-row">
                  {/* Coin icon + title: tap to switch coin. */}
                  <span
                    className="chart-tv-ohlc-pick chart-coin-pick"
                    role="button"
                    tabIndex={0}
                    aria-label={t("priceChart.switchCoin")}
                    onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenCoinPicker?.(e.currentTarget); } }}
                  >
                    <span
                      className="chart-tv-ohlc-icon"
                      style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                    >
                      {COIN_GLYPHS[coin] ?? coin[0]}
                    </span>
                    <span className="chart-tv-ohlc-title">
                      {t("priceChart.tvTitle", { name: COIN_FULL_NAME[coin] ?? coin, iv: INTERVAL_SHORT[interval] })}
                    </span>
                    <span className="chart-coin-pick-chev" aria-hidden="true">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                    </span>
                  </span>
                  <span className={`chart-tv-ohlc-dot${changeUp ? " up" : " down"}`} />
                  <span className="chart-tv-ohlc-values">
                    {t("priceChart.ohlc.o")}<b>{formatLivePrice(lastCandle.open)}</b>{" "}
                    {t("priceChart.ohlc.h")}<b>{formatLivePrice(lastCandle.high)}</b>{" "}
                    {t("priceChart.ohlc.l")}<b>{formatLivePrice(lastCandle.low)}</b>{" "}
                    <span className={changeUp ? "chart-tv-ohlc-up" : "chart-tv-ohlc-down"}>
                      {t("priceChart.ohlc.c")}<b>{formatLivePrice(live)}</b>{" "}
                      {dayChangeAbs !== null && dayChangePercent !== null && (
                        <>
                          {changeUp ? "+" : ""}{dayChangeAbs.toFixed(2)} ({changeUp ? "+" : ""}{dayChangePercent.toFixed(2)}%)
                        </>
                      )}
                    </span>
                  </span>
                </div>
                <div className="chart-tv-ticket-row">
                  <button
                    type="button"
                    className="chart-tv-sell-box"
                    onClick={() => document.querySelector<HTMLButtonElement>(".ta-trigger")?.click()}
                  >
                    <span className="chart-tv-ticket-price">{formatLivePrice(live)}</span>
                    <span className="chart-tv-ticket-label">{t("priceChart.sellCaps")}</span>
                  </button>
                  <span className="chart-tv-ticket-mid">0.00</span>
                  <button
                    type="button"
                    className="chart-tv-buy-box"
                    onClick={() => document.querySelector<HTMLButtonElement>(".ta-trigger")?.click()}
                  >
                    <span className="chart-tv-ticket-price">{formatLivePrice(live)}</span>
                    <span className="chart-tv-ticket-label">{t("priceChart.buyCaps")}</span>
                  </button>
                </div>
              </div>
            );
          })()}
          {/* Reference-match (TradingView mobile full chart) — coin icon/
              name + live pill + price/%-change, overlaid directly on the
              canvas the same way the desktop OHLC overlay above is
              (.chart-fs-header-group is collapsed to empty for this page
              now, same as desktop pageMode already was), instead of
              taking its own row and shrinking the chart's available
              height. */}
          {pageMode && !isDesktopWidth && (
            <div className="chart-mobile-top-header">
              <div
                className="chart-mobile-top-row chart-coin-pick"
                role="button"
                tabIndex={0}
                aria-label={t("priceChart.switchCoin")}
                onClick={(e) => { hapticTap(); onOpenCoinPicker?.(e.currentTarget); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenCoinPicker?.(e.currentTarget); } }}
              >
                <span
                  className="chart-mobile-top-icon"
                  style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                >
                  {COIN_GLYPHS[coin] ?? coin[0]}
                </span>
                <span className="chart-mobile-top-name">{t("priceChart.vsUsd", { name: COIN_FULL_NAME[coin] ?? coin })}</span>
                <span className="chart-mobile-top-live" aria-hidden="true" />
                <span className="chart-coin-pick-chev" aria-hidden="true">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                </span>
              </div>
              {currentPrice !== null && (
                <div className="chart-mobile-top-price-row">
                  <span className="chart-mobile-top-price">{formatLivePrice(currentPrice)}</span>
                  {dayChangeAbs !== null && dayChangePercent !== null && (
                    <span className={`chart-mobile-top-change${dayChangePercent >= 0 ? " chart-mobile-top-change--up" : " chart-mobile-top-change--down"}`}>
                      {dayChangePercent >= 0 ? "+" : "-"}{formatLivePrice(Math.abs(dayChangeAbs))} ({dayChangePercent >= 0 ? "+" : ""}{dayChangePercent.toFixed(2)}%)
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          {pageMode && !isDesktopWidth && (
            /* Menu → Reset / Save / Close (sheet below). */
            <button
              type="button"
              className="chart-mobile-top-btn chart-mobile-top-reset"
              onClick={() => { hapticTap(); setAdvMenuOpen((v) => !v); }}
              aria-haspopup="menu"
              aria-expanded={advMenuOpen}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="20" y2="17" />
              </svg>
              {t("priceChart.menu")}
            </button>
          )}
          {pageMode && !isDesktopWidth && advMenuOpen && (
            <>
              {/* Tap outside closes it. */}
              <div className="adv-menu-scrim" onClick={() => setAdvMenuOpen(false)} />
              <div className="adv-menu" role="menu">
                {([
                  ...((prefsScope === "trade" || prefsScope === "advance")
                    ? [[
                        pvActive ? t("priceChart.advMenu.pvOn") : t("priceChart.advMenu.pvOff"),
                        () => pvGate.toggle(coin),
                        <path key="a" d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
                      ] as const]
                    : []),
                  [t("priceChart.advMenu.reset"), () => handleResetView(), <><path key="a" d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path key="b" d="M3 3v5h5" /></>],
                  [t("chart.save"), () => handleScreenshot(), <><path key="a" d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle key="b" cx="12" cy="13" r="4" /></>],
                  [t("priceChart.advMenu.close"), () => toggleFullscreen(), <><line key="a" x1="18" y1="6" x2="6" y2="18" /><line key="b" x1="6" y1="6" x2="18" y2="18" /></>],
                ] as const).map(([label, run, icon], i) => (
                  <button
                    key={label}
                    type="button"
                    role="menuitem"
                    className="adv-menu-btn"
                    data-i={i}
                    onClick={() => { hapticTap(); setAdvMenuOpen(false); run(); }}
                  >
                    <span>{label}</span>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
                  </button>
                ))}
              </div>
            </>
          )}
          <PredictionOverlay
            chartRef={chartRef}
            seriesRef={candleRef}
            prediction={predictionPath}
          />
          {/* Pro Vision's painted ribbon — before the candles so it sits under them. */}
          <ProVisionOverlay
            chartRef={chartRef}
            seriesRef={candleRef}
            candlesRef={lastCandlesRef}
            result={pvResult}
            visible={!!pvResult && chartStyle !== "line"}
            generation={chartGeneration}
            layer="under"
          />
          <RoundedCandleOverlay
            chartRef={chartRef}
            seriesRef={candleRef}
            candlesRef={lastCandlesRef}
            // Desktop chart page: TradingView's own candle colors.
            upColor={prefsScope === "trade" && !pageMode && isDesktopWidth ? "#089981" : "#4ade80"}
            downColor={prefsScope === "trade" && !pageMode && isDesktopWidth ? "#f23645" : "#fb7185"}
            style={chartStyle === "hollow" ? "hollow" : chartStyle === "heikinAshi" ? "heikinAshi" : "candle"}
            generation={chartGeneration}
            visible={chartStyle !== "line"}
            colorMap={pvColorMap}
            // Desktop chart page (TradingView look): flat, square candles.
            // Phones keep the soft 3D, rounded style.
            depth={prefsScope === "trade" && !pageMode && !isDesktopWidth}
            sharp={prefsScope === "trade" && !pageMode && isDesktopWidth}
          />
          <ProVisionOverlay
            chartRef={chartRef}
            seriesRef={candleRef}
            candlesRef={lastCandlesRef}
            result={pvResult}
            visible={!!pvResult && chartStyle !== "line"}
            generation={chartGeneration}
          />
          {/* Desktop, signed-out / free: a fancy glass promo card floating
              in the chart's top-left corner (dismissible for the session). */}
          {/* "ghost": a blurred ProVision teaser painted over the chart. */}
          {PV_PROMO_STYLE === "ghost" && isDesktopWidth && !pvGhostDismissed && (pvBannerReason === "signin" || pvBannerReason === "trial-available") && (
            <div className="pv-ghost" aria-label={t("priceChart.promo.preview")}>
              <svg className="pv-ghost-art" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="pvg-band" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0%" stopColor="#fb7185" />
                    <stop offset="30%" stopColor="#fb7185" />
                    <stop offset="42%" stopColor="#facc15" />
                    <stop offset="52%" stopColor="#4ade80" />
                    <stop offset="78%" stopColor="#4ade80" />
                    <stop offset="88%" stopColor="#fb7185" />
                    <stop offset="100%" stopColor="#fb7185" />
                  </linearGradient>
                </defs>
                {[0, 9, 18, 27, 36, 45].map((o, i) => (
                  <path
                    key={o}
                    className="pv-ghost-line"
                    style={{ opacity: 0.85 - i * 0.12 }}
                    d={`M0 ${250 + o} C120 ${270 + o} 220 ${300 + o} 330 ${250 + o} S520 ${120 + o} 640 ${130 + o} S820 ${210 + o} 1000 ${190 + o}`}
                  />
                ))}
              </svg>
              <span className="pv-ghost-pill pv-ghost-pill--buy" style={{ left: "31%", top: "62%" }}>{t("priceChart.promo.strongBuy")}</span>
              <span className="pv-ghost-pill pv-ghost-pill--sell" style={{ left: "62%", top: "18%" }}>{t("priceChart.promo.sell")}</span>
              <span className="pv-ghost-pill pv-ghost-pill--buy" style={{ left: "84%", top: "38%" }}>{t("priceChart.promo.buy")}</span>
              <div className="pv-ghost-center">
                <button type="button" className="pv-ghost-btn" onClick={() => openProVisionPaywall({ reason: pvBannerReason, coin })}>
                  <span className="pv-float-border" aria-hidden="true" />
                  <span className="pv-ghost-btn-inner">
                    <svg className="pv-float-spark" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
                    <span className="pv-ghost-btn-text">
                      <strong>{t("priceChart.pvbar.unlock")}</strong>
                      <span>{t("priceChart.promo.ghostSub")}</span>
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="pv-ghost-dismiss"
                  onClick={() => {
                    setPvGhostDismissed(true);
                    try { sessionStorage.setItem("pvGhostDismissed", "1"); } catch { /* ignore */ }
                  }}
                >
                  {t("priceChart.promo.notNow")}
                </button>
              </div>
            </div>
          )}
          {PV_PROMO_STYLE === "float" && isDesktopWidth && !pvPromoDismissed && (pvBannerReason === "signin" || pvBannerReason === "trial-available") && (
            <div className="pv-float" role="complementary" aria-label={t("priceChart.promo.freeTrial")}>
              <span className="pv-float-border" aria-hidden="true" />
              <button
                type="button"
                className="pv-float-close"
                aria-label={t("priceChart.dismiss")}
                onClick={(e) => {
                  e.stopPropagation();
                  setPvPromoDismissed(true);
                  try { sessionStorage.setItem("pvPromoDismissed", "1"); } catch { /* ignore */ }
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
              <button type="button" className="pv-float-body" onClick={() => openProVisionPaywall({ reason: pvBannerReason, coin })}>
                <span className="pv-float-preview" aria-hidden="true">
                  <svg viewBox="0 0 120 64" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="pvf-band" x1="0" x2="1" y1="0" y2="0">
                        <stop offset="0%" stopColor="#fb7185" />
                        <stop offset="45%" stopColor="#facc15" />
                        <stop offset="60%" stopColor="#4ade80" />
                        <stop offset="100%" stopColor="#4ade80" />
                      </linearGradient>
                    </defs>
                    <path className="pv-float-ribbon pv-float-ribbon--3" d="M0 46 C25 50 40 52 58 40 S95 16 120 10" />
                    <path className="pv-float-ribbon pv-float-ribbon--2" d="M0 50 C25 54 40 56 58 44 S95 20 120 14" />
                    <path className="pv-float-ribbon pv-float-ribbon--1" d="M0 54 C25 58 40 60 58 48 S95 24 120 18" />
                  </svg>
                  <span className="pv-float-buy">▲ {t("priceChart.buyCaps")}</span>
                </span>
                <span className="pv-float-text">
                  <span className="pv-float-title">
                    <svg className="pv-float-spark" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
                    {t("priceChart.pvbar.unlock")}
                  </span>
                  <span className="pv-float-sub">{t("priceChart.promo.floatSub")}</span>
                </span>
                <span className="pv-float-cta">{t("priceChart.promo.tryFree")}</span>
              </button>
            </div>
          )}
          {/* Pro Vision intro: a few seconds of "preparing" over the chart. */}
          {pvIntro && ReactDOM.createPortal(
            <div className="pvi" role="status" aria-label={t("priceChart.intro.preparing")} style={{ ["--pvi-ms" as string]: `${PV_INTRO_MS}ms` }}>
              <div className="pvi-scan" aria-hidden="true" />
              <div className="pvi-card">
                <span className="pvi-orb" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
                </span>
                <span className="pvi-title">ProVision</span>
                <span className="pvi-steps" aria-hidden="true">
                  {[t("priceChart.intro.s1"), t("priceChart.intro.s2"), t("priceChart.intro.s3"), t("priceChart.intro.s4"), t("priceChart.intro.s5")].map((step, i) => (
                    <span key={step} className="pvi-step" style={{ animationDelay: `${i * (PV_INTRO_MS - 300) / 5}ms` }}>{step}…</span>
                  ))}
                </span>
                <span className="pvi-bar" aria-hidden="true"><span className="pvi-bar-fill" /></span>
              </div>
            </div>,
            document.body,
          )}
          {pvResult && (
            <div
              ref={(el) => {
                pvStrengthRef.current = el;
                // First appearance: place it right away.
                if (el) requestAnimationFrame(() => pvStrengthMeasureRef.current());
              }}
              className="pv-strength"
              aria-label={t("priceChart.strength.aria", { pct: pvResult.bullStrength })}
              style={pvStrengthBottom !== null ? { bottom: pvStrengthBottom, top: "auto", left: pvStrengthLeft ?? 0, right: "auto" } : undefined}
            >
              <span className="pv-strength-tag">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
                ProVision
              </span>
              <div className="pv-strength-track">
                <div className="pv-strength-bull" style={{ width: `${pvResult.bullStrength}%` }} />
                <div className="pv-strength-bear" style={{ width: `${100 - pvResult.bullStrength}%` }} />
              </div>
              <span className={`pv-strength-val pv-strength-val--${pvResult.bullStrength >= 50 ? "bull" : "bear"}`}>
                {pvResult.bullStrength >= 50 ? t("priceChart.strength.bull", { pct: pvResult.bullStrength }) : t("priceChart.strength.bear", { pct: 100 - pvResult.bullStrength })}
              </span>
              {pvResult.regime.kind === "range" && <span className="pv-strength-flag">{t("priceChart.strength.sideways")}</span>}
              {pvResult.spikeGuard && <span className="pv-strength-flag pv-strength-flag--spike">⚡ {t("priceChart.strength.spike")}</span>}
              {pvEventInfo.live ? (
                <span className="pv-strength-flag pv-strength-flag--event">⏸ {t("priceChart.strength.eventPaused", { name: eventShortName(pvEventInfo.live.title) })}</span>
              ) : pvEventInfo.next ? (
                <span className="pv-strength-flag pv-strength-flag--event">
                  {t("priceChart.strength.eventIn", { name: eventShortName(pvEventInfo.next.title), time: fmtCountdown(pvEventInfo.next.time - pvNow) })}
                </span>
              ) : null}
              {pvResult.liquidity.thin && <span className="pv-strength-flag">{t("priceChart.strength.thin")}</span>}
              {pvResult.signalSource && <span className="pv-strength-flag pv-strength-flag--src">{t("priceChart.strength.signals", { src: pvResult.signalSource })}</span>}
            </div>
          )}
          <LineDotFillOverlay
            chartRef={chartRef}
            seriesRef={lineCloseRef}
            candlesRef={lastCandlesRef}
            color={lineTrendColor}
            generation={chartGeneration}
            visible={!isFullscreen && chartStyle === "line"}
          />
          <ChartEventAnnotations
            chartRef={chartRef}
            seriesRef={chartStyle === "line" ? lineCloseRef : candleRef}
            candlesRef={lastCandlesRef}
            srLevels={srLevels}
            zone={zone}
            coin={coin}
            visible={!isFullscreen && !isDesktopWidth}
            cardsSlotRef={eventCardsSlotRef}
            onEventsChange={(evs) => { setChartEvts(evs); onChartEventsChange?.(evs); }}
            // Phones #trade: first slide = ProVision + Consensus; tap opens
            // the full Consensus sheet (Signal Check inside).
            // Always the first slide on phones #trade (ProVision on or off).
            // (Not on the CMC-style phone chart page.)
            leadCard={pvInSheet && !phoneCmcPage ? (() => {
              // Colour follows the consensus (not ProVision alone).
              const lead = consensusSummary?.lead ?? "neutral";
              const tone = lead === "bull" ? "bullish" as const : lead === "bear" ? "bearish" as const : "neutral" as const;
              return {
                tone,
                // Always the question; ProVision's read goes in the line below.
                title: t("priceChart.whatsNext", { name: COINS.find((c) => c.symbol === coin)?.name ?? coin }),
                value: undefined,
                // Second line supports the first instead of competing with
                // it: "3 of 5 tools agree" when they match, "tools are split"
                // / "other tools lean …" when they don't.
                body: (() => {
                  const s = consensusSummary;
                  if (!s) return t("priceChart.seeEveryTool");
                  // Consensus only (ProVision has its own card below).
                  return `${s.headline} · ${s.countLine}`;
                })(),
                side: t("priceChart.tapToSee"),
                onOpen: () => window.dispatchEvent(new Event("open-consensus-sheet")),
              };
            })() : null}
          />
          <ChartDrawingTools
            ref={drawingToolsRef}
            chartRef={chartRef}
            seriesRef={candleRef}
            containerRef={containerRef}
            candlesRef={lastCandlesRef}
            // Also on while drawing / showing an "Explain Zone" zone — the
            // drawing layer must exist for the finger/mouse to draw on.
            // Desktop chart page (TradingView view): the drawing rail is
            // always there, inside the chart (CMC/TradingView layout).
            visible={tvDrawRail || (pageMode && !isDesktopWidth ? fsDrawPanelOpen : isFullscreen) || awaitingZoneDraw || hasZone}
            // Zone-only (tools panel not open): just the drawing layer, no rail.
            hideToolbar={!tvDrawRail && !(pageMode && !isDesktopWidth ? fsDrawPanelOpen : isFullscreen)}
            contained={tvDrawRail}
            persistRef={drawingsPersistRef}
            onZoneComplete={handleZoneComplete}
            // No Save/Reset in the rail: Save is in the mobile bottom bar
            // (desktop: top toolbar), Reset is top-right on the chart.
            fullHeightRail={pageMode && isDesktopWidth}
            // Mobile: start below the coin name / price block.
            // Desktop TradingView view: just under the OHLC line.
            topOffset={pageMode && !isDesktopWidth ? 80 : tvDrawRail ? 36 : undefined}
          />
          <button
            className="chart-reset-view-btn chart-save-view-btn"
            onClick={handleScreenshot}
            title={t("priceChart.savePng")}
          >
            {t("chart.save")}
          </button>
          {/* iOS-only entry point for fullscreen, since double-tap no
              longer does it there (see .chart-dblclick-wrap above) — lands
              in the same slot Reset uses in fullscreen (top:38px, via the
              shared :not(.chart-save-view-btn) selector) since the two
              never show at the same time. */}
          {Capacitor.isNativePlatform() && !isFullscreen && (
            <button
              className="chart-reset-view-btn chart-ios-fullscreen-btn"
              onClick={toggleFullscreen}
              title={t("priceChart.c.fullscreen")}
            >
              {t("chartBar.fullScreen")}
            </button>
          )}
          {/* Fullscreen only — compact view relies entirely on
              double-click/double-tap (.chart-dblclick-wrap) to expand.
              Exit moved into the title row itself (chart-fs-coin-row,
              above) so it's pixel-aligned with the title instead of
              approximated via position:fixed + safe-area-inset guesswork
              — the header isn't sticky anymore so there was no longer any
              reason for Exit to float independently of it either. */}
          {isFullscreen && (
            <button
              className="chart-reset-view-btn"
              onClick={() => {
                chartRef.current?.timeScale().fitContent();
                rsiChartRef.current?.timeScale().fitContent();
                macdChartRef.current?.timeScale().fitContent();
              }}
            >
              {t("chart.reset")}
            </button>
          )}
          {isFullscreen && (
            <div className="chart-zone-btn-row">
              {/* One glass pill with three states:
                  idle → "✦ Explain Zone"; drawing → "✎ Drag on the chart · Cancel";
                  zone drawn → "✦ Explain Zone  ✕" (✕ clears it). */}
              <div className={`czp${awaitingZoneDraw ? " czp--drawing" : ""}`}>
                {awaitingZoneDraw ? (
                  <>
                    <span className="czp-main czp-main--static">
                      <svg className="czp-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                      <span className="czp-label">{t("priceChart.zone.drag")}</span>
                    </span>
                    <span className="czp-sep" aria-hidden="true" />
                    <button type="button" className="czp-cancel" onClick={handleCancelZoneDraw}>{t("priceChart.zone.cancel")}</button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="czp-main"
                      onClick={handleExplainZoneStart}
                      title={t("priceChart.zone.explainTip")}
                    >
                      <svg className="czp-icon czp-icon--spark" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
                      <span className="czp-label">{t("priceChart.zone.explain")}</span>
                      {!isPaid && <span className="czp-pro">PRO</span>}
                    </button>
                    {hasZone && (
                      <>
                        <span className="czp-sep" aria-hidden="true" />
                        <button type="button" className="czp-clear" onClick={handleClearZone} title={t("priceChart.zone.clearTip")} aria-label={t("priceChart.zone.clear")}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Phones, Chart tab, under the chart (CMC app):
            [Price | Market cap] [line | TradingView], then Indicators. */}
        {phoneCmc && (
          <div className="cmct cmct--phone">
            <div className="cmct-phone-row">
              <div className="cmct-seg cmct-seg--grow" role="tablist" aria-label={t("priceChart.metric.label")}>
                {([["price", t("priceChart.metric.price")], ["mcap", t("priceChart.metric.mcap")]] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={chartMetric === k}
                    className={`cmct-btn${chartMetric === k ? " cmct-btn--on" : ""}`}
                    onClick={() => setChartMetric(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="cmct-seg" role="tablist" aria-label={t("chartBar.chartType", "Chart type")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={cmcLineView}
                  aria-label={t("chartBar.lineChart", "Line chart")}
                  className={`cmct-btn cmct-btn--icon${cmcLineView ? " cmct-btn--on" : ""}`}
                  onClick={() => setCmcStyle("line")}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v18h18" /><path d="m7 15 4-5 3 3 5-7" /></svg>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={!cmcLineView}
                  className={`cmct-btn${!cmcLineView ? " cmct-btn--on" : ""}`}
                  onClick={() => { setChartMetric("price"); setCmcStyle("candles"); }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v4M6 7h4v9H6zM8 16v5M16 4v5M14 9h4v6h-4zM16 15v4" /></svg>
                  TradingView
                </button>
              </div>
            </div>
            {!cmcLineView && (
              <button type="button" className="cmct-phone-ind" onClick={() => setToolsIndOpen(true)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 20h18" />
                  <path d="M5 16l4-5 4 3 6-8" />
                  <path d="M6 20v-3M10 20v-5M14 20v-4M18 20v-7" opacity="0.5" />
                </svg>
                {t("chartBar.indicators", "Indicators")}
                {libIndicators.length > 0 && <span className="cmct-indcount">{libIndicators.length}</span>}
              </button>
            )}
          </div>
        )}

        {/* coinhintz consensus (#trade): every tool's read on this coin +
            timeframe — meter on desktop, card on phones. */}
        {consensusOn && !isFullscreen && (() => {
          const tf = INTERVAL_SHORT[interval];
          const items: ConsensusItem[] = [];
          // ProVision
          const pvReason = pvGate.access.lockReason(coin);
          if (pvActive && pvResult) {
            const b = pvResult.verdict.bias;
            items.push({
              id: "pv", name: "ProVision",
              tone: b === "bull" ? "bull" : b === "bear" ? "bear" : "neutral",
              label: b === "bull" ? t("priceChart.c.bullish") : b === "bear" ? t("priceChart.c.bearish") : t("priceChart.cns.mixed"),
              pos: pvResult.bullStrength,
              onClick: () => {
                setPvCardOpen(true);
                requestAnimationFrame(() => document.querySelector(".pv-card")?.scrollIntoView({ behavior: "smooth", block: "center" }));
              },
              // Phones: the full Signal Check opens right inside the sheet.
              detail: pvInSheet ? renderPvHud("card") : undefined,
            });
          } else if (pvReason && !pvActive) {
            items.push({
              id: "pv", name: "ProVision", tone: null, pos: null, locked: true,
              label: pvReason === "trial-available" || pvReason === "signin" ? t("priceChart.promo.tryFree") : t("priceChart.pill.unlock"),
              onClick: () => openProVisionPaywall({ reason: pvReason, coin }),
            });
          } else {
            items.push({
              id: "pv", name: "ProVision", tone: null, pos: null,
              label: pvActive ? (pvError ?? t("priceChart.cns.reading")) : t("priceChart.cns.turnOn"),
              onClick: pvActive ? undefined : () => pvGate.toggle(coin),
            });
          }
          // Buy & Sell Signals scanner
          if (!isPaid) {
            items.push({ id: "sig", name: t("priceChart.cns.signals"), tone: null, pos: null, locked: true, label: "Pro", onClick: () => onOpenUpgrade?.("pro") });
          } else {
            const live = scanSignal?.active ? scanSignal.direction : null;
            items.push({
              id: "sig", name: t("priceChart.cns.signals"),
              tone: live === "buy" ? "bull" : live === "sell" ? "bear" : "neutral",
              label: live === "buy" ? t("priceChart.cns.buySetup") : live === "sell" ? t("priceChart.cns.sellSetup") : t("priceChart.cns.noSetup"),
              pos: live === "buy" ? 80 : live === "sell" ? 20 : null,
              onClick: () => window.dispatchEvent(new CustomEvent("open-buy-signals", { detail: { coin } })),
            });
          }
          // Technicals (free)
          items.push({
            id: "tech", name: t("priceChart.c.technicals"),
            tone: techLean?.tone ?? null,
            label: techLean ? t(`priceChart.cns.lean.${techLean.tone}`, techLean.label) : t("common.loading"),
            pos: techLean ? ((techLean.score + 1) / 2) * 100 : null,
            onClick: () => window.dispatchEvent(new CustomEvent("open-coin-section", { detail: { tab: "technicals" } })),
          });
          // AI Chart Read — only an existing read; never runs a paid call by itself.
          const ai = readPatternCache(coin, interval)?.data ?? null;
          if (!isPaid) {
            items.push({ id: "ai", name: t("priceChart.aiChartRead"), tone: null, pos: null, locked: true, label: "Pro", onClick: () => onOpenUpgrade?.("pro") });
          } else if (ai) {
            items.push({
              id: "ai", name: t("priceChart.aiChartRead"),
              tone: ai.type === "bullish" ? "bull" : ai.type === "bearish" ? "bear" : "neutral",
              label: ai.type === "bullish" ? t("priceChart.cns.bullPattern") : ai.type === "bearish" ? t("priceChart.cns.bearPattern") : t("priceChart.cns.noPattern"),
              pos: ai.type === "bullish" ? 68 : ai.type === "bearish" ? 32 : 50,
              onClick: () => openAiRead(),
            });
          } else {
            items.push({ id: "ai", name: t("priceChart.aiChartRead"), tone: null, pos: null, label: t("priceChart.cns.tapToRun"), onClick: () => openAiRead() });
          }
          // Events / price zone
          const zs = zone?.signal;
          const zoneMap: Record<string, { tone: "bull" | "bear" | "neutral"; label: string; pos: number }> = {
            "strong-buy": { tone: "bull", label: t("priceChart.cns.strongBuyZone"), pos: 90 },
            "buy": { tone: "bull", label: t("priceChart.cns.buyZone"), pos: 75 },
            "oversold": { tone: "bull", label: t("chart.oversold"), pos: 64 },
            "neutral": { tone: "neutral", label: t("chart.neutralZone"), pos: 50 },
            "overbought": { tone: "bear", label: t("chart.overbought"), pos: 36 },
            "sell": { tone: "bear", label: t("priceChart.cns.sellZone"), pos: 25 },
            "strong-sell": { tone: "bear", label: t("priceChart.cns.strongSellZone"), pos: 10 },
          };
          const z = zs ? zoneMap[zs] : null;
          items.push({
            id: "ev", name: t("priceChart.cns.events"), tone: z?.tone ?? "neutral", label: z?.label ?? t("chart.neutralZone"), pos: z?.pos ?? 50,
            // Phones: the chart's notable moments (formerly the cards under the chart).
            detail: pvInSheet && chartEvts.length > 0 ? (
              <div className="cns-events">
                {[...chartEvts].sort((a, b) => b.time - a.time).map((e) => {
                  const ago = Math.max(0, Date.now() / 1000 - e.time);
                  const when = ago < 3600 ? t("priceChart.ago.m", { n: Math.max(1, Math.round(ago / 60)) }) : ago < 86400 ? t("priceChart.ago.h", { n: Math.round(ago / 3600) }) : t("priceChart.ago.d", { n: Math.round(ago / 86400) });
                  return (
                    <div key={e.id} className="cns-event">
                      <span className="cns-event-head"><span>{e.title}</span><span className="cns-event-time">{when}</span></span>
                      <span className="cns-event-body">{e.body}</span>
                    </div>
                  );
                })}
              </div>
            ) : undefined,
          });
          // Agent (Elite) — opens with a question about this read.
          const elite = authTier === "elite";
          items.push({
            id: "agent", name: t("priceChart.cns.agent"), tone: null, pos: null, locked: !elite,
            label: elite ? t("priceChart.cns.askWhy") : "Elite",
            onClick: () => window.dispatchEvent(new CustomEvent("open-trading-agent-with-prompt", {
              detail: { prompt: t("priceChart.cns.agentPrompt", { coin, tf }) },
            })),
          });
          // Reused further down by the phone insight tiles (same render).
          consensusItemsRef.current = items;
          return (
            <ConsensusStrip
              coinName={COINS.find((c) => c.symbol === coin)?.name ?? coin}
              timeframe={tf}
              items={items}
              variant="meter"
              tapToOpen={!isDesktopWidth}
              hideLine={!isDesktopWidth}
              onSummary={setConsensusSummary}
            />
          );
        })()}
        {/* ProVision switched on but not unlocked for this coin (Pro's 4th
            coin today, or the free trial ended) — say so and offer the way in. */}
        {/* The trial strip lives inside the Signal Check card once it's loaded. */}
        {!pvResult && pvTrialBannerEl}
        {/* Phones (not Advance Chart): trial banner in the same fancy card
            as "Unlock ProVision". */}
        {!pvResult && pvTrialLeftMs !== null && (
          <button type="button" className="pv-mpromo pv-mpromo--trial" onClick={() => openProVisionPaywall({ reason: "trial-active", coin })}>
            <span className="pv-float-border" aria-hidden="true" />
            <span className="pv-mpromo-body">
              <span className="pv-float-preview pv-mpromo-preview" aria-hidden="true">
                <svg viewBox="0 0 120 64" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="pvm-band-trial" x1="0" x2="1" y1="0" y2="0">
                      <stop offset="0%" stopColor="#fb7185" />
                      <stop offset="45%" stopColor="#facc15" />
                      <stop offset="60%" stopColor="#4ade80" />
                      <stop offset="100%" stopColor="#4ade80" />
                    </linearGradient>
                  </defs>
                  <path className="pv-float-ribbon pv-float-ribbon--3" d="M0 46 C25 50 40 52 58 40 S95 16 120 10" />
                  <path className="pv-float-ribbon pv-float-ribbon--2" d="M0 50 C25 54 40 56 58 44 S95 20 120 14" />
                  <path className="pv-float-ribbon pv-float-ribbon--1" d="M0 54 C25 58 40 60 58 48 S95 24 120 18" />
                </svg>
                <span className="pv-float-buy">▲ {t("priceChart.buyCaps")}</span>
              </span>
              <span className="pv-mpromo-text">
                <span className="pv-float-title">
                  <svg className="pv-float-spark" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
                  {t("priceChart.promo.freeTrial")}
                </span>
                <span className="pv-float-sub">{t("priceChart.trial.leftThen", { left: pvTrialLeftLabel(pvTrialLeftMs), price: pvPrice })}</span>
              </span>
              <span className="pv-float-cta pv-mpromo-cta">{t("priceChart.trial.keepIt")}</span>
            </span>
          </button>
        )}
        {/* Phones, signed-out / free: the fancy promo (same look as desktop). */}
        {(pvBannerReason === "signin" || pvBannerReason === "trial-available") && (
          <button type="button" className="pv-mpromo" onClick={() => openProVisionPaywall({ reason: pvBannerReason, coin })}>
            <span className="pv-float-border" aria-hidden="true" />
            <span className="pv-mpromo-body">
              <span className="pv-float-preview pv-mpromo-preview" aria-hidden="true">
                <svg viewBox="0 0 120 64" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="pvm-band" x1="0" x2="1" y1="0" y2="0">
                      <stop offset="0%" stopColor="#fb7185" />
                      <stop offset="45%" stopColor="#facc15" />
                      <stop offset="60%" stopColor="#4ade80" />
                      <stop offset="100%" stopColor="#4ade80" />
                    </linearGradient>
                  </defs>
                  <path className="pv-float-ribbon pv-float-ribbon--3" d="M0 46 C25 50 40 52 58 40 S95 16 120 10" />
                  <path className="pv-float-ribbon pv-float-ribbon--2" d="M0 50 C25 54 40 56 58 44 S95 20 120 14" />
                  <path className="pv-float-ribbon pv-float-ribbon--1" d="M0 54 C25 58 40 60 58 48 S95 24 120 18" />
                </svg>
                <span className="pv-float-buy">▲ {t("priceChart.buyCaps")}</span>
              </span>
              <span className="pv-mpromo-text">
                <span className="pv-float-title">
                  <svg className="pv-float-spark" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
                  {t("priceChart.pvbar.unlock")}
                </span>
                <span className="pv-float-sub">{t("priceChart.promo.mobileSub")}</span>
              </span>
              <span className="pv-float-cta pv-mpromo-cta">{t("priceChart.promo.tryFree")}</span>
            </span>
          </button>
        )}
        {/* Advance Chart only — the chart page uses the banner on the chart. */}
        {pvBannerReason && pageMode && (
          <button
            type="button"
            className={`pv-locked${pvBannerReason === "signin" || pvBannerReason === "trial-available" ? " pv-locked--promo" : ""}`}
            onClick={() => openProVisionPaywall({ reason: pvBannerReason, coin })}
          >
            <span className="pv-locked-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            </span>
            <span className="pv-locked-text">
              <strong>
                {pvBannerReason === "pro-limit" ? t("priceChart.pvbar.lockedOn", { coin }) : pvBannerReason === "trial-ended" ? t("priceChart.pvbar.trialEnded") : t("priceChart.pvbar.tryFree")}
              </strong>
              <span>
                {pvBannerReason === "pro-limit"
                  ? (pvGate.access.usedCoins.length
                    ? t("priceChart.pvbar.usedCoinsList", { n: pvGate.access.usedCoins.length, list: pvGate.access.usedCoins.join(", ") })
                    : t("priceChart.pvbar.notIncluded"))
                  : pvBannerReason === "trial-ended" ? t("priceChart.pvbar.keepFor", { price: pvPrice }) : t("priceChart.pvbar.noCard")}
              </span>
            </span>
            <span className="pv-locked-cta">{pvBannerReason === "trial-available" || pvBannerReason === "signin" ? t("priceChart.pvbar.start") : t("priceChart.pill.unlock")}</span>
          </button>
        )}

        {/* Phones, Advance Chart: Signal Check entry — score ring + verdict;
            tap opens the details sheet. */}
        {pvAdvSheetMode && pvActive && pvResult && !pvRingMin && (() => {
          const b = pvResult.verdict.bias;
          const word = b === "bull" ? t("priceChart.c.bullish") : b === "bear" ? t("priceChart.c.bearish") : t("priceChart.cns.mixed");
          const score = Math.max(0, Math.min(100, pvResult.bullStrength));
          const C = 2 * Math.PI * 17;
          return (
            <button
              ref={pvRingRef}
              type="button"
              className={`pv-ring-entry pv-ring-entry--${b}${pvRingRestored ? " pv-ring-entry--restored" : ""}${pvRingHint && !pvRingRestored && !pvRingLeaving ? " pv-ring-entry--hint" : ""}${pvRingLeaving ? " pv-ring-entry--leaving" : ""}`}
              onClick={() => { if (pvRingSwipeRef.current) { pvRingSwipeRef.current = false; return; } setPvAdvSheetOpen(true); }}
              // Swipe the card down → dock it in the bottom bar.
              onTouchStart={(e) => {
                pvRingTouchY.current = e.touches[0].clientY;
                const el = pvRingRef.current;
                if (el) el.style.transition = "none";
              }}
              // Follows the finger a little (resisted), so the swipe feels live.
              onTouchMove={(e) => {
                const start = pvRingTouchY.current;
                const el = pvRingRef.current;
                if (start === null || !el) return;
                const dy = e.touches[0].clientY - start;
                const eased = Math.sign(dy) * Math.min(28, Math.abs(dy) * 0.35);
                el.style.transform = `translateY(${eased}px)`;
                el.style.opacity = String(1 - Math.min(0.25, Math.abs(eased) / 112));
              }}
              onTouchEnd={(e) => {
                const start = pvRingTouchY.current;
                pvRingTouchY.current = null;
                const el = pvRingRef.current;
                if (start === null) return;
                const dy = e.changedTouches[0].clientY - start;
                // Spring back unless this swipe docks the card (the dock
                // animation takes over the transform itself).
                if (el && !(dy > 30)) {
                  el.style.transition = "transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease";
                  el.style.transform = "";
                  el.style.opacity = "";
                }
                if (dy > 30) {
                  // Swipe down → dock it in the bottom bar.
                  pvRingSwipeRef.current = true;
                  hapticTap();
                  minimizeRing();
                } else if (dy < -30) {
                  // Swipe up → expand into the details sheet.
                  pvRingSwipeRef.current = true;
                  hapticTap();
                  setPvAdvSheetOpen(true);
                }
              }}
              aria-haspopup="dialog"
            >
              <span className="pv-ring" aria-hidden="true">
                <svg width="44" height="44" viewBox="0 0 44 44">
                  <circle cx="22" cy="22" r="17" className="pv-ring-track" />
                  <circle cx="22" cy="22" r="17" className="pv-ring-fill" strokeDasharray={`${((score / 100) * C).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 22 22)" />
                </svg>
                <span className="pv-ring-num">{score}</span>
              </span>
              <span className="pv-ring-text">
                <span className="pv-ring-verdict">{t("priceChart.pv.verdictAgree", { word, agree: pvResult.verdict.agree, total: pvResult.verdict.total })}</span>
                <span className="pv-ring-sub">{t("priceChart.pv.ringSub")}</span>
              </span>
              {/* Grab handle: tap (or swipe the card down) to dock it in the
                  bottom bar; swipe up to expand into the details sheet. */}
              <span
                role="button"
                tabIndex={0}
                className="pv-ring-handle"
                aria-label={t("priceChart.pv.minimise")}
                onClick={(e) => { e.stopPropagation(); hapticTap(); minimizeRing(); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); minimizeRing(); } }}
              />
            </button>
          );
        })()}
        {/* Pro Vision: Signal check — trend + momentum tiles, buyers vs
            sellers, and an overall verdict. Tap a tile to see what it means. */}
        {pvResult && (
          <div className={`pv-card${(pvCardOpen && !pvAdvSheetMode) || pvHudOn ? "" : " pv-card--collapsed"}${prefsScope === "advance" ? " pv-card--advance" : ""}${pvHudOn || pvInSheet || pvAdvSheetMode ? " pv-card--hud" : ""}${prefsScope === "advance" && isDesktopWidth ? " pv-card--pro" : ""}`}>
            <button
              type="button"
              className={`pv-card-head pvs--${pvResult.verdict.bias}`}
              // Phones #trade: the header opens the Consensus sheet (full
              // Signal Check inside) instead of expanding here.
              onClick={() => (
                pvInSheet ? window.dispatchEvent(new Event("open-consensus-sheet"))
                  // Phones, Advance Chart: details open in a bottom sheet.
                  : pvAdvSheetMode ? setPvAdvSheetOpen(true)
                  : setPvCardOpen((v) => !v)
              )}
              aria-expanded={pvCardOpen}
              // Heartbeat speed: the further the score sits from 50 (a
              // clearer signal), the faster the icon pulses (2.6s → 1s).
              style={{ "--pv-pulse-dur": `${(2.6 - (Math.min(50, Math.abs(pvResult.bullStrength - 50)) / 50) * 1.6).toFixed(2)}s` } as React.CSSProperties}
            >
              {/* One combined header: icon, title, live score, verdict pill. */}
              <span className="pvl-title">
                <span className="pvl-title-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12h4l3-7 4 14 3-7h4" />
                  </svg>
                </span>
                <span className="pvl-title-text">{t("priceChart.pv.title")}</span>
                <span key={`hs:${pvResult.bullStrength}`} className="pvl-score">
                  {pvResult.bullStrength}<span className="pvl-score-of">/100</span>
                </span>
                {/* Desktop: thin live meter beside the score (CSS hides it on phones). */}
                {(
                  <span
                    className="pvl-meter"
                    title={t("priceChart.pv.meterTip", { n: pvResult.bullStrength, state: pvResult.bullStrength >= 60 ? t("priceChart.pv.buyersControl") : pvResult.bullStrength <= 40 ? t("priceChart.pv.sellersControl") : t("priceChart.pv.balanced") })}
                  >
                    <span className="pvl-meter-mid" aria-hidden="true" />
                    <i style={{ width: `${Math.max(2, Math.min(100, pvResult.bullStrength))}%` }} />
                  </span>
                )}
              </span>
              <span className="pv-card-head-right">
                {/* Trial chip in the header row (desktop; phones get it on
                    its own line below so the title stays whole). */}
                {pvTrialChip("pv-trial-chip--head")}
                {!pvCardOpen && pvResult.stats.winRate !== null && (
                  <span className="pv-card-mini">{t("priceChart.pv.mini", { rate: pvResult.stats.winRate, total: pvResult.stats.total })}</span>
                )}
                <span key={`v:${pvResult.verdict.bias}`} className={`pvl-pill pvl-pill--${pvResult.verdict.bias}`}>
                  <span className="pvl-pill-dot" aria-hidden="true" />
                  {t("priceChart.pv.pill", { word: pvResult.verdict.bias === "bull" ? t("priceChart.c.bullish") : pvResult.verdict.bias === "bear" ? t("priceChart.c.bearish") : t("priceChart.cns.mixed"), agree: pvResult.verdict.agree, total: pvResult.verdict.total })}
                  <span className="pvl-pill-sep">/</span>
                  <span className="pvl-pill-live">{t("priceChart.pv.live")}</span>
                </span>
                <svg className="pv-card-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </span>
            </button>
            {/* Advance Chart (desktop): pro trading panel as a vertical
                sidebar right of the chart (signal · indicators · flow ·
                timeframes · track record); the old card body is hidden. */}
            {pvCardOpen && prefsScope === "advance" && isDesktopWidth && renderPvHud("pro")}
            {pvCardOpen && (
              <button type="button" className="pv-howto" onClick={() => setPvGuideOpen(true)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
                {t("priceChart.pv.howTo")}
              </button>
            )}
            {/* Trial strip combined into the card (Trade + Advance Chart). */}
            {(pvCardOpen || pvHudOn) && pvResult.barSec <= 300 && (
              <div className="pv-alert" role="status">
                <span className="pv-alert-icon" aria-hidden="true">⏱</span>
                <span>
                  {pvResult.signalSource
                    ? <Trans i18nKey="priceChart.pv.alertSource" values={{ src: pvResult.signalSource }} components={{ s: <strong /> }} />
                    : <Trans i18nKey="priceChart.pv.alertShort" components={{ s: <strong /> }} />}
                </span>
              </div>
            )}
            {(pvCardOpen || pvHudOn) && (pvEventInfo.live || pvEventInfo.next) && (() => {
              const ev = (pvEventInfo.live ?? pvEventInfo.next)!;
              const name = eventShortName(ev.title);
              const at = new Date(ev.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
              const resume = new Date(ev.time + EVENT_PAUSE_AFTER_MS).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
              const soon = !pvEventInfo.live && ev.time - pvNow <= 2 * 3600 * 1000;
              return (
                <div className={`pv-alert pv-alert--event${pvEventInfo.live || soon ? " pv-alert--event-hot" : ""}`} role="status">
                  <span className="pv-alert-icon" aria-hidden="true">{pvEventInfo.live ? "⏸" : "⚠"}</span>
                  <span>
                    {pvEventInfo.live ? (
                      <Trans i18nKey="priceChart.pv.eventLive" values={{ name, title: ev.title, at, resume }} components={{ s: <strong /> }} />
                    ) : (
                      <><Trans i18nKey="priceChart.pv.eventSoon" values={{ name, time: fmtCountdown(ev.time - pvNow), title: ev.title, at }} components={{ s: <strong /> }} />
                        {ev.forecast ? ` ${ev.previous ? t("priceChart.pv.forecastPrev", { f: ev.forecast, p: ev.previous }) : t("priceChart.pv.forecast", { f: ev.forecast })}` : ""}</>
                    )}
                  </span>
                </div>
              );
            })()}
            {pvCardOpen && pvResult.liquidity.thin && (
              <div className="pv-alert" role="status">
                <span className="pv-alert-icon" aria-hidden="true">◌</span>
                <span>
                  <Trans i18nKey="priceChart.pv.alertThin" values={{ vol: (pvResult.liquidity.quoteVol24h / 1e6).toFixed(1) }} components={{ s: <strong /> }} />
                </span>
              </div>
            )}
            {pvCardOpen && pvResult.spikeGuard && (
              <div className="pv-alert pv-alert--spike" role="status">
                <span className="pv-alert-icon" aria-hidden="true">⚡</span>
                <span>
                  <Trans i18nKey={pvResult.spikeGuard.up ? "priceChart.pv.alertSpikeUp" : "priceChart.pv.alertSpikeDown"} count={Math.max(1, pvResult.spikeGuard.barsLeft)} components={{ s: <strong /> }} />
                </span>
              </div>
            )}
            {pvCardOpen && pvResult.regime.kind === "range" && (
              <div className="pv-alert" role="status">
                <span className="pv-alert-icon" aria-hidden="true">≈</span>
                <span>
                  <Trans i18nKey="priceChart.pv.alertRange" values={{ chop: pvResult.regime.chop.toFixed(0), adx: pvResult.regime.adx.toFixed(0) }} components={{ s: <strong /> }} />
                  {pvResult.rangeBox && ` ${t("priceChart.pv.rangeBox", { lo: fmtPvPrice(pvResult.rangeBox.bottom), hi: fmtPvPrice(pvResult.rangeBox.top) })}`}
                  {pvResult.barSec >= 3600
                    ? ` ${t("priceChart.pv.rangeModeOn")}`
                    : ` ${t("priceChart.pv.rangeWatch")}`}
                </span>
              </div>
            )}
            {/* ── Signal matrix: score meter + indicators × timeframes heat grid ── */}
            {pvCardOpen && !pvHudOn && (() => {
              const ROWS = ["MA 20/200", "DMI", "Ichimoku", "RSI", t("priceChart.pv.stochastic"), "MACD", t("priceChart.vol.label")];
              const volValue = pvResult.volume.buyPct >= pvResult.volume.sellPct
                ? t("priceChart.vol.buyersPct", { pct: Math.max(pvResult.volume.buyPct, pvResult.volume.sellPct) })
                : t("priceChart.vol.sellersPct", { pct: Math.max(pvResult.volume.buyPct, pvResult.volume.sellPct) });
              const openRow = (r: number) => {
                if (r < 6) { setPvTileOpen(pvResult.tiles[r]); return; }
                setPvTileOpen({
                  key: "macd", label: t("priceChart.vol.label"), bias: pvResult.volume.bias,
                  value: volValue,
                  detail: t(pvResult.volume.real ? "priceChart.vol.detailReal" : "priceChart.vol.detailEst", { buy: fmtPvVol(pvResult.volume.buyVol), sell: fmtPvVol(pvResult.volume.sellVol) }),
                });
              };
              const vb = pvResult.verdict.bias;
              const leanBull = pvResult.checks.filter((b) => b === "bull").length;
              const leanBear = pvResult.checks.filter((b) => b === "bear").length;
              const holdouts = ROWS.filter((_, i) => vb !== "neutral" && pvResult.checks[i] !== vb && pvResult.checks[i] !== "neutral");
              const tileVal = (r: number) => (r < 6 ? pvResult.tiles[r].value : volValue);
              return (
                <div className={`pvr pvr--${vb}`}>
                  <div className="pvr-side">
                    {/* Header: title + soft subtitle, status pill on the right. */}
                    <div className={`pvl-head pvs--${vb}`}>
                      <span className="pvl-head-text">
                        <span className="pvl-sub" data-cap={t("chart.indicators")}>
                          <span key={`lb:${leanBull}`} className="pvl-count pvl-count--bull">
                            <span className="pvl-count-arrow" aria-hidden="true">▲</span>
                            <span className="pvl-count-n">{leanBull}</span>
                            <span className="pvl-count-l">{t("priceChart.pv.bullishLc")}</span>
                          </span>
                          <span key={`lr:${leanBear}`} className="pvl-count pvl-count--bear">
                            <span className="pvl-count-arrow" aria-hidden="true">▼</span>
                            <span className="pvl-count-n">{leanBear}</span>
                            <span className="pvl-count-l">{t("priceChart.pv.bearishLc")}</span>
                          </span>
                          {holdouts.length > 0 && (
                            <span className="pvl-hold">{t("priceChart.pv.holdingOut", { list: holdouts.join(", ") })}</span>
                          )}
                          <span className="pvl-time">
                            <span className="pvl-time-dot" aria-hidden="true" />
                            <span className="pvl-desc">{t("priceChart.c.lastUpdated")} </span>
                            {pvUpdatedAt ? new Date(pvUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : t("priceChart.pv.connecting")}
                          </span>
                        </span>
                        {/* Order flow + timeframes folded into the header as one line. */}
                        <span className="pvl-meta">
                          <span
                            className="pvl-meta-flow"
                            data-cap={t("priceChart.pv.flowCap")}
                            title={pvResult.volume.real ? t("priceChart.pv.flowTipReal") : t("priceChart.pv.flowTipEst")}
                          >
                            {/* Mini half-circle gauge: green = buyers share, red = sellers, needle at the split. */}
                            {(() => {
                              const f = Math.min(1, Math.max(0, pvResult.volume.buyPct / 100));
                              const a = Math.PI * (1 - f);
                              const px = 14 + 11 * Math.cos(a), py = 14 - 11 * Math.sin(a);
                              const nx = 14 + 8 * Math.cos(a), ny = 14 - 8 * Math.sin(a);
                              return (
                                <svg className="pvl-gauge" width="35" height="20" viewBox="0 0 28 16" aria-hidden="true">
                                  <path d={`M3 14 A11 11 0 0 1 ${px.toFixed(2)} ${py.toFixed(2)}`} className="pvl-gauge-buy" />
                                  <path d={`M${px.toFixed(2)} ${py.toFixed(2)} A11 11 0 0 1 25 14`} className="pvl-gauge-sell" />
                                  <line x1="14" y1="14" x2={nx.toFixed(2)} y2={ny.toFixed(2)} className="pvl-gauge-needle" />
                                  <circle cx="14" cy="14" r="1.6" className="pvl-gauge-hub" />
                                </svg>
                              );
                            })()}
                            <span className={pvResult.volume.buyPct >= pvResult.volume.sellPct ? "pvl-meta-up pvl-meta-lead" : "pvl-meta-up"}>
                              {t("priceChart.vol.buyersPct", { pct: pvResult.volume.buyPct })}
                            </span>
                            <span className="pvl-meta-dot">·</span>
                            <span className={pvResult.volume.sellPct > pvResult.volume.buyPct ? "pvl-meta-down pvl-meta-lead" : "pvl-meta-down"}>
                              {t("priceChart.vol.sellersPct", { pct: pvResult.volume.sellPct })}
                            </span>
                            <span className="pvl-desc pvl-desc--soft">
                              {pvResult.volume.bias === "bull" ? t("priceChart.pv.buyersControl") : pvResult.volume.bias === "bear" ? t("priceChart.pv.sellersControl") : t("priceChart.pv.even")}
                            </span>
                          </span>
                          {pvMtf.length > 0 && (
                            <span className="pvl-meta-tfs" data-cap={t("priceChart.pv.timeframes")}>
                              {pvMtf.map((m) => {
                                const pct = m.strength === null ? 0 : m.bias === "bear" ? 100 - m.strength : m.bias === "bull" ? m.strength : 50;
                                return (
                                  <span
                                    key={`${m.label}:${m.bias}`}
                                    className={`pvl-meta-tf pvl-meta-tf--${m.bias}${m.iv === interval ? " pvl-meta-tf--live" : ""}`}
                                    title={`${m.label}: ${m.bias === "bull" ? t("priceChart.pv.bullishLc") : m.bias === "bear" ? t("priceChart.pv.bearishLc") : t("priceChart.pv.mixedLc")}${m.strength === null ? "" : ` · ${Math.round(pct)}%`}`}
                                  >
                                    {/* Tiny ring gauge: fill = how strongly that timeframe leans. */}
                                    <span className="pvl-ring" style={{ ["--ring-p" as string]: `${Math.max(pct, 6) * 3.6}deg` }} aria-hidden="true" />
                                    {m.label}
                                  </span>
                                );
                              })}
                              {(() => {
                                const up = pvMtf.filter((m) => m.bias === "bull").length;
                                const dn = pvMtf.filter((m) => m.bias === "bear").length;
                                const txt = up > dn ? t("priceChart.pv.nOfBullish", { n: up, total: pvMtf.length }) : dn > up ? t("priceChart.pv.nOfBearish", { n: dn, total: pvMtf.length }) : t("priceChart.pv.mixedLc");
                                return <span className="pvl-desc pvl-desc--soft">{txt}</span>;
                              })()}
                            </span>
                          )}
                        </span>
                      </span>
                    </div>
                    {/* The 7 checks as diverging segment bars: bearish cells
                        light up to the left of centre, bullish to the right. */}
                    <div className="pvsb" role="list" aria-label={t("chart.indicators")}>
                      {ROWS.map((name, r) => {
                        const b = pvResult.checks[r];
                        const s = pvResult.checkStrength[r] ?? 0.5;
                        const d = (s - 0.5) * 2; // -1 … 1
                        const lit = b === "neutral" ? 0 : Math.max(1, Math.round(Math.abs(d) * PV_SEG));
                        const side = d < 0 ? "bear" : "bull";
                        const v = tileVal(r).replace(/\s*[↑↓▲▼]$/, "");
                        const label = r === 3 ? `RSI ${pvResult.checkReadout[3]?.big ?? ""}`.trim() : name;
                        return (
                          <button
                            key={name}
                            type="button"
                            role="listitem"
                            className={`pvsb-row pvsb-row--${b}`}
                            onClick={() => openRow(r)}
                            aria-label={`${label}: ${v}`}
                            title={t(`priceChart.pv.rowDesc.${r}`, PV_ROW_DESC[r])}
                          >
                            <span className="pvsb-name">{label}</span>
                            <span className="pvsb-bar" aria-hidden="true" style={{ ["--row" as string]: r }}>
                              {(() => {
                                // k = distance from centre (1…PV_SEG). Lit cells ramp up in
                                // brightness toward the tip; the tip pulses; the next cell
                                // out flickers like a needle jittering.
                                const cell = (k: number, half: "l" | "r") => {
                                  const active = (half === "l" ? "bear" : "bull") === side;
                                  const on = active && k <= lit;
                                  const tip = on && k === lit;
                                  const ghost = active && lit > 0 && k === lit + 1;
                                  const cls = `pvsb-cell${on ? " pvsb-cell--on" : ""}${tip ? " pvsb-cell--tip" : ""}${ghost ? " pvsb-cell--ghost" : ""}`;
                                  const st = on || ghost
                                    ? { ["--i" as string]: on ? 0.45 + 0.55 * (k / lit) : 0, animationDelay: `${r * 60 + k * 35}ms` }
                                    : undefined;
                                  return <span key={`${half}${k}`} className={cls} style={st} />;
                                };
                                return (
                                  <>
                                    {Array.from({ length: PV_SEG }, (_, i) => cell(PV_SEG - i, "l"))}
                                    <span className="pvsb-cell pvsb-cell--mid" />
                                    {Array.from({ length: PV_SEG }, (_, i) => cell(i + 1, "r"))}
                                    <span className="pvsb-sweep" />
                                  </>
                                );
                              })()}
                            </span>
                            <span key={`${v}:${b}`} className="pvsb-val">
                              {v}{b === "bull" ? " ▲" : b === "bear" ? " ▼" : ""}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })()}
            {pvCardOpen && !pvHudOn && (<>
            {/* Phones: a slim trial line just above the track record
                (the header stays exactly as it was). */}
            {pvTrialLeftMs !== null && (() => {
              const left = pvTrialLeftLabel(pvTrialLeftMs);
              return (
                <button type="button" className="pv-trial-line" onClick={() => openProVisionPaywall({ reason: "trial-active", coin })}>
                  <span className="pv-trial-line-icon" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
                  </span>
                  <span className="pv-trial-line-text">
                    <strong>{t("priceChart.trial.enjoyingPv")}</strong>
                    <em>{t("priceChart.trial.leftThen", { left, price: pvPrice })}</em>
                  </span>
                  <span className="pv-trial-line-cta">{t("priceChart.trial.keepIt")}</span>
                </button>
              );
            })()}
            {/* Track record: every signal on the loaded history. A signal
                "worked" if price moved one average candle range its way
                before touching its invalidation level (within 20 candles). */}
            {(() => {
              const st = pvResult.stats;
              const per = st.perTradePct;
              const paid = (per ?? 0) > 0;
              const fmtP = (v: number | null, plus = true) => (v === null ? "—" : `${v > 0 && plus ? "+" : ""}${v.toFixed(2)}%`);
              const ratio = st.avgWinPct !== null && st.avgLossPct ? Math.abs(st.avgWinPct / st.avgLossPct) : null;
              // Most recent trades first-to-last, each as a small tile.
              const recent = pvResult.signals.slice(-10);
              return (
                <div className="pvt">
                  <div className="pvt-head">
                    <span className="pvt-title">
                      {t("priceChart.tr.title")}
                      <span className="pvt-src">{t("priceChart.tr.src", { chart: pvResult.signalSource ? t("priceChart.tr.srcChart", { src: pvResult.signalSource }) : t("priceChart.tr.thisChart"), count: st.total })}</span>
                    </span>
                    {st.trades > 0 && (
                      <span className={`pvt-bottom pvt-bottom--${paid ? "good" : "bad"}`}>
                        {t(paid ? "priceChart.tr.paidOff" : "priceChart.tr.lostMoney", { per: fmtP(per) })}
                      </span>
                    )}
                  </div>

                  <div className="pvt-strip">
                    <span className="pvt-kv"><span className="pvt-k">{t("priceChart.tr.hitRate")}</span><span className="pvt-v">{st.winRate === null ? "—" : `${st.winRate}%`}</span></span>
                    <span className="pvt-kv"><span className="pvt-k">{t("priceChart.tr.wonLost")}</span><span className="pvt-v"><span className="pvt-g">{st.worked}</span> / <span className="pvt-r">{st.failed}</span>{st.open ? <span className="pvt-dim"> · {t("priceChart.tr.nOpen", { n: st.open })}</span> : null}</span></span>
                    <span className="pvt-kv"><span className="pvt-k">{t("priceChart.tr.avgWin")}</span><span className="pvt-v pvt-g">{fmtP(st.avgWinPct)}</span></span>
                    <span className="pvt-kv"><span className="pvt-k">{t("priceChart.tr.avgLoss")}</span><span className="pvt-v pvt-r">{fmtP(st.avgLossPct, false)}</span></span>
                    <span className="pvt-kv"><span className="pvt-k" title={t("priceChart.tr.winLossTip")}>{t("priceChart.tr.winLoss")}</span><span className="pvt-v">{ratio === null ? "—" : `${ratio.toFixed(1)} : 1`}</span></span>
                  </div>

                  {recent.length > 0 && (
                    <div className="pvt-trades" aria-label={t("priceChart.tr.recentAria")}>
                      <span className="pvt-k">{t("priceChart.tr.lastN", { n: recent.length })}</span>
                      <span className="pvt-tiles">
                        {recent.map((s) => {
                          const res = s.pnlPct === null ? "open" : s.pnlPct > 0 ? "win" : "loss";
                          const when = new Date(s.time * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
                          return (
                            <span
                              key={s.time}
                              className={`pvt-tile pvt-tile--${res}`}
                              title={`${s.side === "buy" ? t("priceChart.promo.buy") : t("priceChart.promo.sell")} · ${when} · ${s.pnlPct === null ? t("priceChart.tr.stillOpen") : fmtP(s.pnlPct)}`}
                            >
                              <span className="pvt-tile-side">{s.side === "buy" ? "▲" : "▼"}</span>
                              <span className="pvt-tile-pnl">{s.pnlPct === null ? t("priceChart.tr.open") : fmtP(s.pnlPct)}</span>
                            </span>
                          );
                        })}
                      </span>
                    </div>
                  )}

                  <details className="pvt-how">
                    <summary>{t("priceChart.tr.howTitle")}</summary>
                    <p>
                      {pvResult.barSec <= 300 && !pvResult.signalSource
                        ? `${t("priceChart.tr.howShort")} `
                        : `${t("priceChart.tr.howLong")} `}
                      {t("priceChart.tr.howRules")}
                    </p>
                  </details>
                </div>
              );
            })()}
            {/* Range mode's own track record (1h and above). */}
            {pvResult.rangeStats.trades > 0 && (
              <div className="pv-group">
                <span className="pv-group-label">{t("priceChart.tr.rangeTitle")}</span>
                <div className="pv-pnl">
                  <div className="pv-pnl-cell">
                    <span className="pv-pnl-label">{t("priceChart.tabs.trades")}</span>
                    <span className="pv-pnl-val">{pvResult.rangeStats.trades}</span>
                  </div>
                  <div className="pv-pnl-cell">
                    <span className="pv-pnl-label">{t("priceChart.tr.hitRate")}</span>
                    <span className="pv-pnl-val">{pvResult.rangeStats.winRate === null ? "—" : `${pvResult.rangeStats.winRate}%`}</span>
                  </div>
                  <div className="pv-pnl-cell">
                    <span className="pv-pnl-label">{t("priceChart.tr.perTrade")}</span>
                    <span className={`pv-pnl-val ${(pvResult.rangeStats.perTradePct ?? 0) > 0 ? "pv-stat-val--bull" : "pv-stat-val--bear"}`}>
                      {pvResult.rangeStats.perTradePct === null ? "—" : `${pvResult.rangeStats.perTradePct > 0 ? "+" : ""}${pvResult.rangeStats.perTradePct.toFixed(2)}%`}
                    </span>
                  </div>
                </div>
                <span className="pv-note">
                  {t("priceChart.tr.rangeNote")}
                </span>
              </div>
            )}
            </>)}
          </div>
        )}
        <ProVisionGuide open={pvGuideOpen && pvActive} onClose={() => setPvGuideOpen(false)} />
        {/* Phones, Advance Chart: Signal Check details in a bottom sheet. */}
        {pvAdvSheetMode && (
          <BottomSheet
            open={pvAdvSheetOpen && !!pvResult}
            // ✕ or swipe down → back to the minimised icon (which pops).
            onClose={() => { setPvAdvSheetOpen(false); setPvDockPop((k) => k + 1); }}
            title={t("priceChart.pv.sheetTitle", { name: COINS.find((c) => c.symbol === coin)?.name ?? coin })}
            ariaLabel={t("priceChart.pv.title")}
            className="pv-adv-sheet"
          >
            <div className="pv-adv-sheet-body">{renderPvHud("card")}</div>
          </BottomSheet>
        )}
        <BottomSheet
          open={!!pvTileOpen}
          onClose={() => setPvTileOpen(null)}
          title={<>{pvTileOpen?.label}</>}
          ariaLabel={pvTileOpen?.label ?? t("priceChart.km.signalDetail")}
          desktopModal
        >
          {pvTileOpen && (
            <div className="pv-detail">
              <span className={`pv-verdict pv-verdict--${pvTileOpen.bias}`}>{pvTileOpen.value}</span>
              <p className="pv-detail-text">{pvTileOpen.detail}</p>
            </div>
          )}
        </BottomSheet>

        {/* Mobile web/iOS only — desktop keeps both of these up in
            .chart-header-right instead (see isDesktopWidth guards there).
            Same quickIntervalPills constant, just relocated + the
            fullscreen button merged onto its trailing end as one row.
            Also suppressed for forceHideHeader (MobileSymbolSheet) — that
            embed has its own mss-interval-row + Full Chart button already. */}
        {!isFullscreen && !isDesktopWidth && !forceHideHeader && !useBarHeader && (
          <div className="chart-mobile-interval-fs-row">
            {quickIntervalPills}
            <button
              type="button"
              className="chart-depth-btn chart-mobile-interval-fs-btn"
              onClick={toggleFullscreen}
              title={t("priceChart.c.fullscreen")}
              data-tooltip={t("priceChart.c.fullscreen")}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            </button>
          </div>
        )}

        {/* What's happening (ProVision summary + chart moments) first… */}
        <div ref={eventCardsSlotRef} className="chart-event-slot" />

        {/* Phones #trade: Signal Check content right on the page, under the
            "what's happening" slider — calm, stacked, no card chrome. */}
        {/* Two tiles side by side — Signal Check and Consensus, each a
            title, one line and a small ring; tapping one grows it to full
            width and opens its full view in place (tap the header again
            to shrink back). */}
        {pvInSheet && (() => {
          const items = consensusItemsRef.current;
          const read = items.filter((i) => !i.locked && i.tone !== null);
          const bearN = read.filter((i) => i.tone === "bear").length;
          const bullN = read.filter((i) => i.tone === "bull").length;
          const lead = bearN > bullN ? "bear" : bullN > bearN ? "bull" : "neutral";
          const agree = lead === "bear" ? bearN : lead === "bull" ? bullN : read.length - bearN - bullN;
          const pvOn = !!(pvActive && pvResult);
          const pvScore = pvOn ? Math.max(0, Math.min(100, pvResult!.bullStrength)) : 0;
          const pvReason = pvGate.access.lockReason(coin);
          // ── Kalshi-style market card ──
          // Headline probability: ProVision's bull strength (or the tools'
          // split without it), shown as the chance of the leading side.
          const bullPct = pvOn ? pvScore : read.length ? Math.round((bullN / read.length) * 100) : 50;
          const bearPct = 100 - bullPct;
          const leadSide: "bull" | "bear" = bullPct >= 50 ? "bull" : "bear";
          const chance = leadSide === "bull" ? bullPct : bearPct;
          const latest = [...chartEvts].sort((a, b) => b.time - a.time)[0];
          // History line: ProVision's bull strength over recent candles.
          const series = pvOn ? (pvResult!.scoreSeries ?? []).slice(-60) : [];
          const spark = (() => {
            if (series.length < 2) return null;
            const W = 300, H = 56;
            const x = (i: number) => (i / (series.length - 1)) * W;
            const y = (v: number) => 4 + (1 - Math.max(0, Math.min(100, v)) / 100) * (H - 8);
            const d = series.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
            return (
              <svg className="km-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                <line x1="0" x2={W} y1={y(50)} y2={y(50)} className="km-spark-mid" />
                <path d={`${d} L${W} ${H} L0 ${H} Z`} className="km-spark-area" />
                <path d={d} className="km-spark-line" />
                <circle cx={x(series.length - 1)} cy={y(series[series.length - 1])} r="3.5" className="km-spark-dot" />
              </svg>
            );
          })();
          const coinName = COINS.find((c) => c.symbol === coin)?.name ?? coin;
          const kmReady = !loading && (!pvActive || !!pvResult || kmWaitedOut);
          if (!kmReady) {
            return (
              <div className="sb-wrap">
                <div className="km km--loading" role="status" aria-label={t("priceChart.km.loading", { name: coinName })}>
                  <div className="km-head">
                    <span className="km-q">
                      <img
                        className="km-logo"
                        src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
                        alt=""
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                      />
                      {t("priceChart.whatsNext", { name: coinName })}
                    </span>
                    <span className="km-tf">{INTERVAL_SHORT[interval]}</span>
                  </div>
                  <div className="km-skel km-skel--big" />
                  <div className="km-skel km-skel--spark" />
                  <div className="km-skel km-skel--bar" />
                  <div className="km-loading-foot">
                    <span className="km-spinner" aria-hidden="true" />
                    {t("priceChart.c.agentThinking")}
                  </div>
                </div>
              </div>
            );
          }
          const scoreboard = (
            <div className={`km km--${leadSide}`}>
              <div className="km-head">
                <span className="km-q">
                  <img
                    className="km-logo"
                    src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
                    alt=""
                    onError={(e) => { e.currentTarget.style.display = "none"; }}
                  />
                  {t("priceChart.whatsNext", { name: coinName })}
                </span>
                <span className="km-tf"><i className="km-live" aria-hidden="true" />{t("priceChart.live")} · {INTERVAL_SHORT[interval]}</span>
              </div>
              <div className="km-big">
                <b>{chance}%</b>
                <span className="km-big-label">{leadSide === "bull" ? t("priceChart.km.chanceBull") : t("priceChart.km.chanceBear")}</span>
                {read.length > 0 && <span className="km-agree">{t("priceChart.km.toolsAgree", { n: agree, total: read.length })}</span>}
              </div>
              {spark}
              {/* One split bar: bullish share (left) vs bearish (right). */}
              <div className="km-gauge" role="img" aria-label={t("priceChart.km.gaugeAria", { bull: bullPct, bear: bearPct })} style={{ ["--split" as string]: `${bullPct}%` }}>
                <div className="km-gauge-labels">
                  <span className={`km-gauge-side km-gauge-side--bull${leadSide === "bull" ? " km-gauge-side--lead" : ""}`}>
                    {t("priceChart.c.bullish")} <b>{bullPct}%</b>
                  </span>
                  <span className={`km-gauge-side km-gauge-side--bear${leadSide === "bear" ? " km-gauge-side--lead" : ""}`}>
                    <b>{bearPct}%</b> {t("priceChart.c.bearish")}
                  </span>
                </div>
                <div className="km-gauge-track" aria-hidden="true">
                  <span className="km-gauge-marker" />
                </div>
              </div>
              {/* Foot: the latest chart moment, and one quiet link that opens
                  the full analysis (Signal Check + Consensus tabs). */}
              <div className="km-foot">
                <span className="km-news">{latest ? latest.title : ""}</span>
                <button
                  type="button"
                  className="km-more"
                  onClick={() => { hapticTap(); setInsightOpen(pvOn ? "pv" : "cns"); }}
                >
                  {t("priceChart.km.seeFull")}
                </button>
              </div>
            </div>
          );
          return (
            <div className="sb-wrap">
              {scoreboard}
              {/* Full analysis: one sheet, Signal Check / Consensus tabs. */}
              <BottomSheet
                open={insightOpen !== null}
                onClose={() => setInsightOpen(null)}
                title={t("priceChart.whatsNext", { name: coinName })}
                ariaLabel={t("priceChart.km.fullAnalysis")}
                floating
              >
                <div className="km-sheet">
                  <div className="km-seg" role="tablist" aria-label={t("priceChart.km.analysis")}>
                    <button type="button" role="tab" aria-selected={insightOpen === "pv"} className={`km-seg-btn${insightOpen === "pv" ? " km-seg-btn--on" : ""}`} onClick={() => setInsightOpen("pv")}>
                      {t("priceChart.km.pvSignal")}
                    </button>
                    <button type="button" role="tab" aria-selected={insightOpen === "cns"} className={`km-seg-btn${insightOpen === "cns" ? " km-seg-btn--on" : ""}`} onClick={() => setInsightOpen("cns")}>
                      {t("priceChart.km.consensus")}
                    </button>
                  </div>
                  {insightOpen === "pv" && (pvOn ? (
                    renderPvHud("pro")
                  ) : (
                    <div className="km-sheet-empty">
                      <p>{t("priceChart.km.partOfPv")}</p>
                      <button
                        type="button"
                        className="km-more"
                        onClick={() => {
                          setInsightOpen(null);
                          if (pvReason && !pvActive) openProVisionPaywall({ reason: pvReason, coin });
                          else if (!pvActive) pvGate.toggle(coin);
                        }}
                      >
                        {pvReason ? t("priceChart.km.tryPv") : t("priceChart.km.turnOnPv")}
                      </button>
                    </div>
                  ))}
                  {insightOpen === "cns" && (
                    <ConsensusStrip
                      coinName={coinName}
                      timeframe={INTERVAL_SHORT[interval]}
                      items={items}
                      variant="panel"
                    />
                  )}
                </div>
              </BottomSheet>
            </div>
          );
        })()}

        {/* …then the big "Trade BTC" button → Paper Trade (mobile). */}
        {!isDesktopWidth && !isFullscreen && !pageMode && onOpenPaperTrade && !phoneCmcPage && (
          <button type="button" className="chart-trade-cta" onClick={onOpenPaperTrade}>
            {t("priceChart.tradeCoin", { coin })}
            <span className="chart-trade-cta-p" aria-hidden="true">P</span>
          </button>
        )}

        {fsDockSheet}
        {fsFlatSheet}
        {indSheetOpen && (
          <BottomSheet open onClose={() => setIndSheetOpen(false)} title={<>{t("chart.indicators", "Indicators")}</>} ariaLabel={t("chart.indicators", "Indicators")}>
              <div className="interval-sheet-list">
                <div className="cts-chips cts-chips--menu">
                  {fsQuickIndicators.map((ind) => (
                    <button
                      type="button"
                      key={ind.key}
                      className={`cts-chip${ind.checked ? " active" : ""}`}
                      onClick={() => { hapticTap(); ind.onToggle(); }}
                    >
                      <span className="cts-chip-dot" style={{ background: ind.color }} />
                      {ind.label}
                      {ind.pro && !isPaid && <span className="interval-sheet-item-pro">PRO</span>}
                    </button>
                  ))}
                </div>
              </div>
          </BottomSheet>
        )}
        {/* Advance chart (mobile): the range bar (which normally hosts this)
            isn't rendered here, so the custom range picker mounts itself. */}
        {fsDockFlat && goToOpen && (
          <ChartGoTo onClose={() => setGoToOpen(false)} onGoToDate={goToDate} onGoToRange={goToRange} />
        )}
        {intervalSheetPortal}
        {toolsSheetPortal}
        <IndicatorPicker
          open={toolsIndOpen}
          onClose={() => setToolsIndOpen(false)}
          enabled={libIndicators}
          onToggle={(id) => { hapticTap(); toggleLibIndicator(id); }}
          builtIn={pickerBuiltIn}
          hideIds={["rsi", "macd"]}
          isPaid={isPaid}
          onUpgrade={() => { setToolsIndOpen(false); onOpenUpgrade?.("pro"); }}
        />
        {statsSheetOpen && (
          <BottomSheet open onClose={() => setStatsSheetOpen(false)} title={<>{t("priceChart.stats.title", { coin })}</>} ariaLabel={t("priceChart.stats.title", { coin })}>
              <div className="chart-stats-sheet chart-bar-stats">
                <div className="chart-bar-stat">
                  <span className="chart-bar-stat-label">{t("priceChart.stats.change", { iv: INTERVAL_SHORT[interval] })}</span>
                  <span className={`chart-bar-stat-value${dayChangePercent === null ? "" : dayChangePercent >= 0 ? " up" : " down"}`}>
                    {dayChangeAbs !== null && dayChangePercent !== null
                      ? `${dayChangeAbs >= 0 ? "+" : "-"}${formatLivePrice(Math.abs(dayChangeAbs))} / ${dayChangePercent >= 0 ? "+" : ""}${dayChangePercent.toFixed(2)}%`
                      : "—"}
                  </span>
                </div>
                <div className="chart-bar-stat">
                  <span className="chart-bar-stat-label">{t("priceChart.stats.high", { iv: INTERVAL_SHORT[interval] })}</span>
                  <span className="chart-bar-stat-value">{displayDayHigh !== null ? formatLivePrice(displayDayHigh) : "—"}</span>
                </div>
                <div className="chart-bar-stat">
                  <span className="chart-bar-stat-label">{t("priceChart.stats.low", { iv: INTERVAL_SHORT[interval] })}</span>
                  <span className="chart-bar-stat-value">{displayDayLow !== null ? formatLivePrice(displayDayLow) : "—"}</span>
                </div>
                {headerStats}
                {quoteVolume24h !== undefined && (
                  <div className="chart-bar-stat">
                    <span className="chart-bar-stat-label">{t("priceChart.vol24h")}</span>
                    <span className="chart-bar-stat-value">{formatCompactVolume(quoteVolume24h)}</span>
                  </div>
                )}
              </div>
          </BottomSheet>
        )}
        {dateRangeSheetOpen && (
          <BottomSheet open onClose={() => setDateRangeSheetOpen(false)} title={<>{t("priceChart.dateRange")}</>} ariaLabel={t("priceChart.dateRange")}>
              <div className="date-range-sheet-list">
                {RANGE_PRESETS.map((x) => (
                  <button
                    key={x.key}
                    type="button"
                    className={`date-range-sheet-item${activeRangePreset?.key === x.key ? " active" : ""}`}
                    onClick={() => { setDateRangeSheetOpen(false); applyRangePreset(x); }}
                  >
                    <span className="date-range-sheet-label">{x.label}</span>
                    <span className="date-range-sheet-sub">{t(`chartBar.rangeTip.${x.key}`, x.tip)}</span>
                    {activeRangePreset?.key === x.key && <span className="chart-style-check">✓</span>}
                  </button>
                ))}
                <button
                  type="button"
                  className="date-range-sheet-item"
                  onClick={() => { setDateRangeSheetOpen(false); setGoToOpen(true); }}
                >
                  <span className="date-range-sheet-label">{t("priceChart.custom")}</span>
                  <span className="date-range-sheet-sub">{t("priceChart.customSub")}</span>
                </button>
              </div>
          </BottomSheet>
        )}

        {showDepthProfile && (
          <OrderBookProfileModal
            coin={coin}
            onClose={() => setShowDepthProfile(false)}
          />
        )}

        {showAstroChart && (
          <AstroSuggestions
            coin={coin}
            theme={theme}
            onClose={() => setShowAstroChart(false)}
          />
        )}

        {showGann && gannCycles.length > 0 && (
          <div className="gann-cycles-strip">
            <span className="gann-cycles-label">
              {t("chart.gannCyclesLabel")}
            </span>
            {gannCycles.map((gc) => (
              <span
                key={gc.label}
                className={`gann-cycle-pill${gc.isPast ? " gann-cycle-pill--past" : ""}`}
              >
                {gc.label} ·{" "}
                {new Date(gc.timestamp * 1000).toLocaleDateString(
                  i18n.language,
                  { month: "short", day: "numeric" },
                )}
              </span>
            ))}
          </div>
        )}

        <div className="sub-charts">
          <div
            className={`sub-chart-panel${showRSI ? "" : " sub-chart-panel--hidden"}`}
          >
            <div className="sub-chart-header">
              <span className="sub-chart-title">{t("chart.rsi14")}</span>
              <div className="sub-chart-legend">
                <span className="sub-chart-legend-item legend-rsi">
                  ── {t("chart.rsiLegend")}
                </span>
                <span className="sub-chart-legend-item legend-ob">
                  ▬ {t("chart.rsiOB")}
                </span>
                <span className="sub-chart-legend-item legend-os">
                  ▬ {t("chart.rsiOS")}
                </span>
              </div>
            </div>
            <div
              ref={rsiContainerRef}
              className="chart-canvas-wrap"
              style={{ width: "100%", height: "130px" }}
            />
          </div>

          <div
            className={`sub-chart-panel${showMACD ? "" : " sub-chart-panel--hidden"}`}
          >
            <div className="sub-chart-header">
              <span className="sub-chart-title">{t("chart.macd1269")}</span>
              <div className="sub-chart-legend">
                <span className="sub-chart-legend-item legend-macd">
                  ── {t("chart.macdLegend")}
                </span>
                <span className="sub-chart-legend-item legend-signal">
                  ── {t("chart.signalLegend")}
                </span>
              </div>
            </div>
            <div
              ref={macdContainerRef}
              className="chart-canvas-wrap"
              style={{ width: "100%", height: "130px" }}
            />
          </div>
        </div>

        {isFullscreen ? null : (!isDesktopWidth && !aiReadOpen) ? null
          // Desktop chart page: hidden until "Analyze Chart" (under the chart) is clicked.
          : (tradeDesktopLean && !aiCtaOn && !aiReadOpen) ? null : !isPaid ? (
          <div className="chart-ai-placeholder">
            <div className="chart-ai-placeholder-preview" aria-hidden="true">
              <div className="chart-ai-placeholder-header">
                <div className="cap-badge" />
                <div className="cap-title" />
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <div className="cap-pill" />
                  <div className="cap-pill" />
                </div>
              </div>
              <div className="cap-line cap-line--full" />
              <div className="cap-line cap-line--three-quarter" />
              <div className="cap-line" style={{ width: "88%" }} />
            </div>
            <div className="chart-ai-placeholder-overlay">
              <div className="cap-overlay-left">
                <div className="cap-overlay-header">
                  <span className="cap-overlay-title">{t("priceChart.aiChartRead")}</span>
                  <span className="cap-overlay-ai-badge">AI</span>
                  <span className="cap-overlay-tier-badge">PRO</span>
                  <span className="aiqw-live-badge"><span className="aiqw-live-dot" />{t("priceChart.live")}</span>
                </div>
                <div className="cap-overlay-features">
                  {/* Both former banners' features, in one list. */}
                  {[
                    t("priceChart.ai.f1"),
                    t("priceChart.ai.f2"),
                    t("priceChart.ai.f3"),
                    t("priceChart.ai.f4"),
                  ].map(f => (
                    <span key={f} className="cap-overlay-feature">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                      {f}
                    </span>
                  ))}
                </div>
              </div>
              <button
                className="cap-overlay-btn"
                onClick={() => onOpenUpgrade?.("pro")}
              >
                <span className="cap-btn-full">{t("priceChart.ai.upgradeNow")}</span>
                <span className="cap-btn-short">{t("priceChart.c.upgrade")}</span>
              </button>
            </div>
          </div>
        ) : !aiReadOpen ? (
          // On request: nothing is generated or shown until the viewer asks
          // for it — the pattern AI call (which spends AI quota) only runs
          // from here, not on every chart load.
          <button type="button" className="ai-read-cta" onClick={openAiRead}>
            <span className="ai-read-cta-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z" />
              </svg>
            </span>
            <span className="ai-read-cta-text">
              <span className="ai-read-cta-title">{t("priceChart.aiChartRead")}</span>
              <span className="ai-read-cta-sub">{t("priceChart.ai.ctaSub", { coin, iv: INTERVAL_SHORT[interval] })}</span>
            </span>
            <span className="ai-read-cta-btn">{t("priceChart.ai.analyze")}</span>
          </button>
        ) : (displayPatternInsight || (displayBanner && !isFullscreen)) ? (
          <div className={`ai-read ai-read--${displayBanner?.sentiment ?? displayPatternInsight?.type ?? "neutral"}`}>
            <div className="ai-read-head">
              <span className="ai-read-head-title">
                <span className="ai-read-spark">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z" /></svg>
                </span>
                {t("priceChart.aiChartRead")}
                <span className="ai-read-head-ctx">{coin} · {INTERVAL_SHORT[interval]}</span>
              </span>
              <span className="ai-read-head-right">
                {(bannerAt ?? patternInsightAt) !== null && (
                  <span className="ai-read-updated">
                    {t("priceChart.c.lastUpdated")} {formatClockTime((bannerAt ?? patternInsightAt) as number)}
                  </span>
                )}
                <span className="aiqw-live-badge"><span className="aiqw-live-dot" />{t("priceChart.live")}</span>
                <button type="button" className="ai-read-close" aria-label={t("priceChart.ai.hide")} onClick={() => { setAiReadOpen(false); setAiCtaOn(false); }}>✕</button>
              </span>
            </div>

            <div className="ai-read-body">
              {displayBanner && !isFullscreen && (
                <div
                  className={`ai-read-col ai-read-trend${isDesktopWidth ? "" : " interval-banner--tappable"}`}
                  role={isDesktopWidth ? undefined : "button"}
                  tabIndex={isDesktopWidth ? undefined : 0}
                  onClick={isDesktopWidth ? undefined : () => setPatternInsightSheetOpen(true)}
                  onKeyDown={isDesktopWidth ? undefined : (e) => { if (e.key === "Enter" || e.key === " ") setPatternInsightSheetOpen(true); }}
                >
                  <span className="ai-read-label">{t("priceChart.ai.trend")}</span>
                  <span className={`ai-read-chip ai-read-chip--${displayBanner.sentiment}`}>
                    {displayBanner.sentiment === "bullish" ? "▲" : displayBanner.sentiment === "bearish" ? "▼" : "●"} {displayBanner.title}
                  </span>
                  <p className="ai-read-text pi-fade-in">{displayBanner.body}</p>
                  {zoneDivergenceSentence && (
                    <p className={`ai-read-note chart-hero-zone-sentence--${intervalSignal ?? divergence?.type ?? "neutral"}`}>
                      {zoneDivergenceSentence}
                    </p>
                  )}
                </div>
              )}
              {displayPatternInsight && (
                <div className="ai-read-col ai-read-pattern">
                  <span className="ai-read-label">{t("priceChart.ai.pattern")}</span>
                  <span className={`ai-read-chip ai-read-chip--${displayPatternInsight.type}`}>
                    {displayPatternInsight.name}
                  </span>
                  <p key={`summary-${displayPatternInsight.name}`} className="ai-read-summary pi-fade-in">
                    {displayPatternInsight.summary}
                  </p>
                  <p key={`narrative-${displayPatternInsight.name}`} className="ai-read-text pi-fade-in pi-fade-in--d1">
                    {displayPatternInsight.narrative}
                  </p>
                </div>
              )}
            </div>

            {displayPatternInsight && (
              <div className="ai-read-next">
                <span className="ai-read-next-label">{t("chart.nextMove")}</span>
                <p key={`nextmove-${displayPatternInsight.name}`} className="ai-read-next-text pi-fade-in pi-fade-in--d2">
                  {displayPatternInsight.nextMove}
                </p>
              </div>
            )}
          </div>
        ) : null}

        {showPredictionModal && predictionPath && chartPrediction && (
          <PredictionModal
            candles={lastCandlesRef.current}
            prediction={predictionPath}
            chartPrediction={chartPrediction}
            coin={coin}
            interval={interval}
            theme={theme}
            divergence={
              divergence
                ? {
                    type: divergence.type,
                    pivots: divergence.pivots.map((p) => ({
                      time: p.time,
                      price: p.price,
                    })),
                  }
                : null
            }
            onClose={() => setShowPredictionModal(false)}
          />
        )}

        {zoneAnalysis && (
          <ZoneAnalysisModal
            coin={coin}
            interval={interval}
            candles={zoneAnalysis.candles}
            loading={zoneAnalysis.loading}
            error={zoneAnalysis.error}
            result={zoneAnalysis.result}
            theme={theme}
            onClose={() => setZoneAnalysis(null)}
          />
        )}
      </div>

      {sideColumn && !isFullscreen && <aside className="pcc-side">{sideColumn}</aside>}

      {/* #chart (compact, non-fullscreen) renders its own inline version
          above instead (chart-compact-inline), mobile and desktop both —
          this modal only stays for pageMode/fullscreen now. */}
      {/* Compact view: a full-screen 15-min Over / Under round (practice
          money) — same everywhere it's opened from. */}
      {showCompactView && (
        <CompactPriceView coin={coin} theme={theme} onClose={() => setShowCompactView(false)} />
      )}

      {/* Watchlist/TopMoversCarousel (App.tsx) — rendered here, inside
          .price-chart-container itself, below the chart but outside the
          fullscreen/scroll wrapper above, so fullscreen mode doesn't drag
          them along with it. */}
      {!isFullscreen && children}
    </div>
  );
};
