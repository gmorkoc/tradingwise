import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { coinglass, CoinSymbol, ExchangeActivity } from "../services/coinglass";
import { BlurGate } from "./MembershipGate";
import { useAuth } from "../contexts/AuthContext";
import { hasAccess } from "../services/supabase";
import "../styles/PredictionEngine.css";


function polarToCart(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function donutSlice(cx: number, cy: number, or_: number, ir: number, a0: number, a1: number): string {
  const g = Math.min(1.8, (a1 - a0) * 0.1);
  const [x1, y1] = polarToCart(cx, cy, or_, a0 + g);
  const [x2, y2] = polarToCart(cx, cy, or_, a1 - g);
  const [x3, y3] = polarToCart(cx, cy, ir,  a1 - g);
  const [x4, y4] = polarToCart(cx, cy, ir,  a0 + g);
  const large = a1 - a0 > 180 ? 1 : 0;
  const f = (n: number) => n.toFixed(2);
  return `M${f(x1)},${f(y1)} A${or_},${or_} 0 ${large} 1 ${f(x2)},${f(y2)} L${f(x3)},${f(y3)} A${ir},${ir} 0 ${large} 0 ${f(x4)},${f(y4)}Z`;
}


interface Props {
  btcData: Partial<{ rsi: number; macd: number; macdSignal: number; fundingRate: number; longShortRatio: number; price: number; fundingAvailable: boolean; longShortAvailable: boolean }> | null;
  coin: CoinSymbol;
  livePrice: number | null;
  onOpenAuth?: () => void;
  onOpenUpgrade?: () => void;
}

interface Signal {
  name: string;
  value: string;
  score: number;
  detail: string;
  icon: string;
}

interface FearGreed {
  value: number;
  label: string;
}

interface PriceTarget {
  label: string;
  bull: number;
  bear: number;
  atr: number;
}

function scoreRSI(rsi: number): number {
  if (rsi > 75) return -2;
  if (rsi > 65) return -1;
  if (rsi > 55) return 0.5;
  if (rsi >= 45) return 0;
  if (rsi >= 35) return -0.5;
  if (rsi >= 25) return 1.5;
  return 2;
}

function scoreMACDCross(macd: number, signal: number): number {
  const diff = macd - signal;
  if (diff > 0 && macd > 0)  return 2;
  if (diff > 0 && macd <= 0) return 1;
  if (diff < 0 && macd < 0)  return -2;
  if (diff < 0 && macd >= 0) return -1;
  return 0;
}

function scoreFundingRate(fr: number): number {
  if (fr > 0.002)  return -2;
  if (fr > 0.001)  return -1;
  if (fr > -0.0001) return 0;
  if (fr > -0.001) return 1;
  return 2;
}

function scoreLSRatio(ls: number): number {
  if (ls > 1.5)  return -1.5;
  if (ls > 1.15) return 1;
  if (ls > 0.9)  return 0;
  if (ls > 0.75) return -0.5;
  return -2;
}

function scoreFearGreed(fg: number): number {
  if (fg >= 80) return -2;
  if (fg >= 65) return -1;
  if (fg >= 45) return 0.5;
  if (fg >= 35) return 0;
  if (fg >= 20) return 1;
  return 2;
}

function scoreVolumePOC(price: number, poc: number): number {
  const pct = (price - poc) / poc;
  if (pct > 0.05)  return -1;
  if (pct > 0.02)  return 0.5;
  if (pct > -0.02) return 1.5;
  if (pct > -0.05) return 0.5;
  return -1;
}

function compositeToPercent(rawSum: number, maxRaw: number): number {
  return Math.round(((rawSum / maxRaw) * 0.5 + 0.5) * 100);
}

function calcATR(candles: { high: number; low: number; close: number }[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / period;
}

function calcPOC(candles: { high: number; low: number; volume?: number }[]): number {
  if (!candles.length) return 0;
  const buckets = new Map<number, number>();
  for (const c of candles) {
    const mid = Math.round((c.high + c.low) / 2 / 100) * 100;
    buckets.set(mid, (buckets.get(mid) ?? 0) + (c.volume ?? 1));
  }
  let maxVol = 0, poc = 0;
  for (const [price, vol] of buckets) {
    if (vol > maxVol) { maxVol = vol; poc = price; }
  }
  return poc;
}

export function PredictionEngine({ btcData, coin, livePrice, onOpenAuth, onOpenUpgrade }: Props) {
  const { t, i18n } = useTranslation();
  const { tier } = useAuth();
  const hasPro = hasAccess(tier, "pro");
  const [fearGreed,       setFearGreed]       = useState<FearGreed | null>(null);
  const [atr4h,           setAtr4h]           = useState(0);
  const [poc4h,           setPoc4h]           = useState(0);
  const [loading,         setLoading]         = useState(true);
  const [exchangeData,    setExchangeData]    = useState<ExchangeActivity[]>([]);
  const [exchLoading,     setExchLoading]     = useState(true);
  const [exchUpdatedAt,   setExchUpdatedAt]   = useState<Date | null>(null);
  const lastFetch    = useRef(0);
  const lastExchFetch = useRef(0);

  const price = livePrice ?? btcData?.price ?? 0;

  useEffect(() => {
    let cancelled = false;
    const loadExch = async () => {
      if (Date.now() - lastExchFetch.current < 60_000) return;
      lastExchFetch.current = Date.now();
      setExchLoading(true);
      const data = await coinglass.getExchangeActivity(coin).catch(() => []);
      if (!cancelled) { setExchangeData(data); setExchLoading(false); setExchUpdatedAt(new Date()); }
    };
    loadExch();
    const id = setInterval(loadExch, 60_000);
    return () => { cancelled = true; clearInterval(id); lastExchFetch.current = 0; };
  }, [coin]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (Date.now() - lastFetch.current < 60_000) return;
      lastFetch.current = Date.now();
      setLoading(true);

      const [fgRes, candles4h] = await Promise.all([
        fetch("https://api.alternative.me/fng/?limit=1").then(r => r.json()).catch(() => null),
        coinglass.getHistoricalCandles("4h", coin).catch(() => []),
      ]);

      if (cancelled) return;

      if (fgRes?.data?.[0]) {
        setFearGreed({ value: parseInt(fgRes.data[0].value), label: fgRes.data[0].value_classification });
      }
      if (candles4h.length) {
        setAtr4h(calcATR(candles4h));
        setPoc4h(calcPOC(candles4h));
      }
      setLoading(false);
    };
    load();
    // Reset the 60s guard too, or the next run (coin switch, or React's
    // dev double-mount) skips loading and the loaders spin forever.
    return () => { cancelled = true; lastFetch.current = 0; };
  }, [coin]);

  const rsi         = btcData?.rsi         ?? 50;
  const macd        = btcData?.macd        ?? 0;
  const macdSig     = btcData?.macdSignal  ?? 0;
  const fundingRate = btcData?.fundingRate ?? 0;
  const lsRatio     = btcData?.longShortRatio ?? 1;
  // No live source answered: show "—" instead of a made-up 0% / 1.00.
  const frKnown     = !!btcData && btcData.fundingAvailable !== false;
  const lsKnown     = !!btcData && btcData.longShortAvailable !== false;
  const fgValue     = fearGreed?.value ?? 50;
  const poc         = poc4h || price;

  const fmtK = (p: number) => p >= 1000 ? `$${(p / 1000).toFixed(1)}k` : `$${p.toFixed(0)}`;

  const s1 = scoreRSI(rsi);
  const s2 = scoreMACDCross(macd, macdSig);
  const s3 = scoreFundingRate(fundingRate);
  const s4 = scoreLSRatio(lsRatio);
  const s5 = scoreFearGreed(fgValue);
  const s6 = scoreVolumePOC(price, poc);

  const rawSum = s1 + s2 + s3 + s4 + s5 + s6;
  const maxRaw = 12;
  const confluenceScore = compositeToPercent(rawSum, maxRaw);

  const atr4hVal  = atr4h || price * 0.02;
  const atr1d     = atr4hVal * 2.5;
  const atr1w     = atr4hVal * 5.5;

  const targets: PriceTarget[] = [
    { label: t("predEngine.target4h"),     bull: price + atr4hVal * 1.5, bear: price - atr4hVal * 1.5, atr: atr4hVal },
    { label: t("predEngine.targetDaily"),  bull: price + atr1d   * 1.0, bear: price - atr1d   * 1.0, atr: atr1d    },
    { label: t("predEngine.targetWeekly"), bull: price + atr1w   * 1.0, bear: price - atr1w   * 1.0, atr: atr1w    },
  ];

  const signals: Signal[] = [
    {
      name: t("predEngine.rsiName"),
      value: rsi.toFixed(1),
      score: s1,
      icon: "📊",
      detail: rsi > 70
        ? t("predEngine.rsiOB",      { rsi: rsi.toFixed(1), price: fmtK(price) })
        : rsi < 30
        ? t("predEngine.rsiOS",      { rsi: rsi.toFixed(1), price: fmtK(price) })
        : rsi < 50
        ? t("predEngine.rsiWeak",    { rsi: rsi.toFixed(1), price: fmtK(price) })
        : t("predEngine.rsiHealthy", { rsi: rsi.toFixed(1), price: fmtK(price) }),
    },
    {
      name: t("predEngine.macdName"),
      value: `${macd >= 0 ? "+" : ""}${macd.toFixed(2)}`,
      score: s2,
      icon: "📈",
      detail: s2 >= 2
        ? t("predEngine.macdBullAbove", { price: fmtK(price) })
        : s2 >= 1
        ? t("predEngine.macdBullBelow", { price: fmtK(price) })
        : s2 <= -2
        ? t("predEngine.macdBearBelow", { price: fmtK(price) })
        : s2 <= -1
        ? t("predEngine.macdBearAbove", { price: fmtK(price) })
        : t("predEngine.macdNeutral",   { price: fmtK(price) }),
    },
    {
      name: t("predEngine.frName"),
      value: frKnown ? `${(fundingRate * 100).toFixed(4)}%` : "—",
      score: s3,
      icon: "💸",
      detail: !frKnown ? "—" : fundingRate > 0.001
        ? t("predEngine.frHigh",    { fr: (fundingRate * 100).toFixed(4), price: fmtK(price) })
        : fundingRate < -0.001
        ? t("predEngine.frLow",     { fr: (Math.abs(fundingRate) * 100).toFixed(4), price: fmtK(price) })
        : t("predEngine.frNeutral", { price: fmtK(price) }),
    },
    {
      name: t("predEngine.lsName"),
      value: lsKnown ? lsRatio.toFixed(2) : "—",
      score: s4,
      icon: "⚖️",
      detail: !lsKnown ? "—" : lsRatio > 1.5
        ? t("predEngine.lsCrowded",  { ls: lsRatio.toFixed(2), price: fmtK(price) })
        : lsRatio > 1.1
        ? t("predEngine.lsBull",     { ls: lsRatio.toFixed(2), price: fmtK(price) })
        : lsRatio < 0.9
        ? t("predEngine.lsBear",     { ls: lsRatio.toFixed(2), price: fmtK(price) })
        : t("predEngine.lsBalanced", { ls: lsRatio.toFixed(2), price: fmtK(price) }),
    },
    {
      name: t("predEngine.fgName"),
      value: fearGreed ? `${fgValue} · ${fearGreed.label}` : "—",
      score: s5,
      icon: "🧠",
      detail: fearGreed
        ? fgValue >= 75
          ? t("predEngine.fgExtreme", { fg: fgValue, price: fmtK(price) })
          : fgValue <= 25
          ? t("predEngine.fgFear",    { fg: fgValue, price: fmtK(price) })
          : fgValue >= 55
          ? t("predEngine.fgGreed",   { fg: fgValue, price: fmtK(price) })
          : t("predEngine.fgMidFear", { fg: fgValue, price: fmtK(price) })
        : t("predEngine.loadingSentiment"),
    },
    {
      name: t("predEngine.pocName"),
      value: poc4h ? `$${poc4h.toLocaleString()}` : "—",
      score: s6,
      icon: "📦",
      detail: poc4h
        ? price > poc4h * 1.03
          ? t("predEngine.pocAbove", { price: fmtK(price), pct: ((price / poc4h - 1) * 100).toFixed(1), poc: fmtK(poc4h) })
          : price < poc4h * 0.97
          ? t("predEngine.pocBelow", { price: fmtK(price), pct: ((poc4h / price - 1) * 100).toFixed(1), poc: fmtK(poc4h) })
          : t("predEngine.pocAt",    { price: fmtK(price), poc: fmtK(poc4h) })
        : t("predEngine.computingVP"),
    },
  ];

  const label = confluenceScore >= 70 ? t("predEngine.strongBull")
    : confluenceScore >= 57 ? t("predEngine.mildBull")
    : confluenceScore >= 43 ? t("predEngine.neutral")
    : confluenceScore >= 30 ? t("predEngine.mildBear")
    : t("predEngine.strongBear");
  const labelClass = confluenceScore >= 57 ? "bull" : confluenceScore <= 43 ? "bear" : "neutral";

  const fmtPrice = (p: number) => `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  return (
    <div className="pe-wrap">
      <div className="pe-header">
        <div>
          <h2 className="pe-title">{t("predEngine.title")}</h2>
          <p className="pe-sub">{t("predEngine.sub", { coin })}</p>
        </div>
        {loading && <span className="pe-loading-badge">{t("predEngine.loading")}</span>}
      </div>

      <div className="pe-gauge-card">
        <div className="pe-gauge-bar-wrap">
          <div className="pe-gauge-track">
            <div className="pe-gauge-fill" style={{ width: `${confluenceScore}%` }} />
            <div className="pe-gauge-pointer" style={{ left: `${confluenceScore}%` }} />
          </div>
          <div className="pe-gauge-labels">
            <span>{t("predEngine.strongBear")}</span>
            <span>{t("predEngine.neutral")}</span>
            <span>{t("predEngine.strongBull")}</span>
          </div>
        </div>
        <div className="pe-score-box">
          <span className="pe-score-num">{confluenceScore}</span>
          <span className="pe-score-slash">/100</span>
          <span className={`pe-score-label pe-score-label--${labelClass}`}>{label}</span>
        </div>
      </div>

      <div className="pe-body">

        <div className="pe-targets-col">
          <div className="pe-targets-label">
            {t("predEngine.priceTargets")}
          </div>
          {/* Needs an account only (any plan, Free included). */}
          <BlurGate requiredTier="free" featureName="Price Targets" onOpenAuth={onOpenAuth ?? (() => {})} onOpenUpgrade={onOpenUpgrade ?? (() => {})}>
            <div className="pe-targets-note">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span>These are <strong>not AI predictions</strong>. Targets are calculated using <strong>ATR (Average True Range)</strong> — a volatility measure derived from the last 14 periods of 4H candle data. Bull &amp; bear levels are set at 1×–1.5× ATR from the current price, scaled to 4H, Daily, and Weekly timeframes.</span>
            </div>
            {targets.map(tgt => {
              const bullPct = price > 0 ? ((tgt.bull - price) / price * 100).toFixed(1) : "0";
              const bearPct = price > 0 ? ((tgt.bear - price) / price * 100).toFixed(1) : "0";
              return (
                <div key={tgt.label} className="pe-target-card">
                  <div className="pe-target-label">{tgt.label}</div>
                  <div className="pe-target-values">
                    <div className="pe-target-bull">
                      <span className="pe-target-arrow">▲</span>
                      {hasPro ? fmtPrice(tgt.bull) : "———"}
                    </div>
                    <div className="pe-target-bear">
                      <span className="pe-target-arrow">▼</span>
                      {hasPro ? fmtPrice(tgt.bear) : "———"}
                    </div>
                  </div>
                  <div className="pe-target-pct">
                    <span className="pe-target-pct-bull">{hasPro ? `+${bullPct}%` : "—"}</span>
                    <span className="pe-target-pct-bear">{hasPro ? `${bearPct}%` : "—"}</span>
                  </div>
                  <div className="pe-target-atr">{t("predEngine.atrLabel")} {hasPro ? fmtPrice(tgt.atr) : "———"}</div>
                </div>
              );
            })}
          </BlurGate>
        </div>

        <div className="pe-signals-card">
          <div className="pe-signals-title">{t("predEngine.signalBreakdown")}</div>
          {signals.map(sig => {
            const dotClass = sig.score >= 1 ? "bull" : sig.score <= -1 ? "bear" : "neutral";
            const markerPct = ((sig.score + 2) / 4) * 100;
            return (
              <div key={sig.name} className={`pe-signal-row pe-signal-row--${dotClass}`}>
                <div className={`pe-signal-icon-wrap pe-signal-icon-wrap--${dotClass}`}>
                  {sig.icon}
                </div>
                <div className="pe-signal-main">
                  <div className="pe-signal-top">
                    <span className="pe-signal-name">{sig.name}</span>
                    <span className="pe-signal-value">{sig.value}</span>
                  </div>
                  <div className="pe-signal-detail">{sig.detail}</div>
                </div>
                <div className="pe-signal-bar-wrap">
                  <div className={`pe-signal-bar-track pe-signal-bar-track--${dotClass}`}
                       style={{ "--bar-pos": `${markerPct}%` } as React.CSSProperties} />
                  <div className="pe-signal-bar-labels">
                    <span>{t("predEngine.bear")}</span>
                    <span>{t("predEngine.bull")}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

      </div>

      <div className="pe-exch-card">
        <div className="pe-exch-header">
          <span className="pe-exch-title">{t("predEngine.exchActivity")}</span>
          <span className="pe-exch-sub">{t("predEngine.exchSub")}</span>
          <span className="pe-exch-updated">
            {exchLoading
              ? t("predEngine.updating")
              : exchUpdatedAt
              ? t("predEngine.updatedAt", { time: exchUpdatedAt.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })
              : ""}
          </span>
        </div>
        {(() => {
          // First load: placeholder rows with NO numbers (they used to read
          // as real "0.0000% Neutral" values while loading).
          const firstLoad = exchLoading && exchangeData.length === 0;
          const exchList: ExchangeActivity[] = firstLoad
            ? ["Binance","OKX","Bybit","Bitget","Coinbase"].map(e => ({ exchange: e, signal: "neutral" as const, fundingRate: 0, fundingPct: "", priceChange: 0, available: false }))
            : exchangeData;
          const reporting = exchList.filter(e => e.available);

          const sigCfg: Record<ExchangeActivity["signal"], { label: string; cls: string; icon: string }> = {
            buying:  { label: t("predEngine.sigBuying"),  cls: "bull",    icon: "▲" },
            selling: { label: t("predEngine.sigSelling"), cls: "bear",    icon: "▼" },
            neutral: { label: t("predEngine.sigNeutral"), cls: "neutral", icon: "—" },
          };

          const sigPalette: Record<ExchangeActivity["signal"], string[]> = {
            buying:  ['#4ade80','#22c55e','#86efac','#16a34a','#34d399'],
            selling: ['#f87171','#ef4444','#fca5a5','#dc2626','#fb923c'],
            neutral: ['#64748b','#94a3b8','#475569','#78909c','#334155'],
          };
          const sigIdx: Partial<Record<string, number>> = {};

          const CX = 200, CY = 200, OR = 186, IR = 108;
          // Equal slices, coloured by each exchange's funding signal. (The old
          // 54/27/8/5/6 "share" was a fixed guess, not live data, so no
          // percentages are shown.) No data → grey.
          let ang = 0;
          const slices = exchList.map(ex => {
            const a0 = ang; ang += 360 / exchList.length;
            const i = sigIdx[ex.signal] ?? 0; if (ex.available) sigIdx[ex.signal] = i + 1;
            const color = ex.available ? sigPalette[ex.signal][i % sigPalette[ex.signal].length] : "rgba(148,163,184,0.28)";
            return { ...ex, a0, a1: ang, color };
          });

          const maxFR = Math.max(0.00005, ...reporting.map(e => Math.abs(e.fundingRate)));

          return (
            <div className="pe-exch-pie-heat-wrap">
              <svg className="pe-exch-svg" viewBox="0 0 400 400">
                {slices.map(s => (
                  <path key={s.exchange} d={donutSlice(CX, CY, OR, IR, s.a0, s.a1)} fill={s.color} />
                ))}
                {slices.map(s => {
                  const mid = (s.a0 + s.a1) / 2;
                  const [tx, ty] = polarToCart(CX, CY, (OR + IR) / 2, mid);
                  return (
                    <g key={`t-${s.exchange}`} style={{ pointerEvents: 'none' }}>
                      <text x={tx} y={ty - 8} textAnchor="middle" dominantBaseline="middle" fill={s.available ? "#fff" : "#94a3b8"} fontSize="12" fontWeight="800">{s.exchange}</text>
                      <text x={tx} y={ty + 9} textAnchor="middle" dominantBaseline="middle" fill={s.available ? "rgba(255,255,255,0.8)" : "#94a3b8"} fontSize="10.5">
                        {s.available ? s.fundingPct : firstLoad ? "…" : "no data"}
                      </text>
                    </g>
                  );
                })}
                {/* Centre: how many exchanges actually reported. */}
                <text x={CX} y={CY - 8} textAnchor="middle" dominantBaseline="middle" fill="currentColor" fontSize="30" fontWeight="800">
                  {firstLoad ? "…" : `${reporting.length}/${exchList.length}`}
                </text>
                <text x={CX} y={CY + 20} textAnchor="middle" dominantBaseline="middle" fill="#94a3b8" fontSize="12">
                  {firstLoad ? "loading" : "reporting"}
                </text>
              </svg>

              <div className="pe-exch-heatgrid">
                <div className="pe-exch-heat-axis">
                  <span>{t("predEngine.selling")}</span>
                  <span className="pe-exch-heat-axis-center">{t("predEngine.frBias")}</span>
                  <span>{t("predEngine.buying")}</span>
                </div>
                {slices.map(ex => {
                  // No data / still loading: plain row, no number, no signal.
                  if (!ex.available) return (
                    <div key={ex.exchange} className={`pe-exch-heat-row pe-exch-heat-row--na${firstLoad ? " pe-exch-heat-row--loading" : ""}`}>
                      <div className="pe-exch-heat-name-wrap">
                        <span className="pe-exch-heat-dot" style={{ background: ex.color }} />
                        <span className="pe-exch-heat-name">{ex.exchange}</span>
                      </div>
                      <div className="pe-exch-heat-stats">
                        {firstLoad
                          ? <span className="pe-exch-heat-skel" aria-hidden="true" />
                          : <span className="pe-exch-heat-badge pe-exch-badge--neutral">No data</span>}
                      </div>
                    </div>
                  );
                  const c = sigCfg[ex.signal];
                  const intensity = Math.abs(ex.fundingRate) / maxFR;
                  const alpha = (0.08 + intensity * 0.3).toFixed(3);
                  const rowBg = ex.fundingRate > 0
                    ? `linear-gradient(90deg, transparent 20%, rgba(74,222,128,${alpha}) 100%)`
                    : ex.fundingRate < 0
                    ? `linear-gradient(270deg, transparent 20%, rgba(248,113,113,${alpha}) 100%)`
                    : 'linear-gradient(90deg, transparent 0%, rgba(100,116,139,0.25) 50%, transparent 100%)';
                  return (
                    <div key={ex.exchange} className="pe-exch-heat-row" style={{ background: rowBg }}>
                      <div className="pe-exch-heat-name-wrap">
                        <span className="pe-exch-heat-dot" style={{ background: ex.color }} />
                        <span className="pe-exch-heat-name">{ex.exchange}</span>
                      </div>
                      <div className="pe-exch-heat-stats">
                        <span className={`pe-exch-heat-fr ${ex.fundingRate >= 0 ? "pos" : "neg"}`}>{ex.fundingPct}</span>
                        <span className={`pe-exch-heat-badge pe-exch-badge--${c.cls}`}>{c.icon} {c.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>

      <p className="pe-disclaimer">
        {t("predEngine.disclaimer")}
      </p>
    </div>
  );
}
