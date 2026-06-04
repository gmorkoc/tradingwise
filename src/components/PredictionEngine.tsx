import { useState, useEffect, useRef } from "react";
import { coinglass, CoinSymbol } from "../services/coinglass";
import "../styles/PredictionEngine.css";

interface Props {
  btcData: Partial<{ rsi: number; macd: number; macdSignal: number; fundingRate: number; longShortRatio: number; price: number }> | null;
  coin: CoinSymbol;
  livePrice: number | null;
}

interface Signal {
  name: string;
  value: string;
  score: number;   // -2 to +2
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

export function PredictionEngine({ btcData, coin, livePrice }: Props) {
  const [fearGreed, setFearGreed]   = useState<FearGreed | null>(null);
  const [atr4h,     setAtr4h]       = useState(0);
  const [poc4h,     setPoc4h]       = useState(0);
  const [loading,   setLoading]     = useState(true);
  const lastFetch = useRef(0);

  const price = livePrice ?? btcData?.price ?? 0;

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
    return () => { cancelled = true; };
  }, [coin]);

  const rsi         = btcData?.rsi         ?? 50;
  const macd        = btcData?.macd        ?? 0;
  const macdSig     = btcData?.macdSignal  ?? 0;
  const fundingRate = btcData?.fundingRate ?? 0;
  const lsRatio     = btcData?.longShortRatio ?? 1;
  const fgValue     = fearGreed?.value ?? 50;
  const poc         = poc4h || price;

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
    { label: "4H Target",  bull: price + atr4hVal * 1.5, bear: price - atr4hVal * 1.5, atr: atr4hVal  },
    { label: "Daily Target", bull: price + atr1d   * 1.0, bear: price - atr1d   * 1.0, atr: atr1d     },
    { label: "Weekly Target",bull: price + atr1w   * 1.0, bear: price - atr1w   * 1.0, atr: atr1w     },
  ];

  const signals: Signal[] = [
    {
      name: "RSI (14)",
      value: rsi.toFixed(1),
      score: s1,
      icon: "📊",
      detail: rsi > 70 ? "Overbought — pullback risk" : rsi < 30 ? "Oversold — bounce potential" : rsi < 50 ? "Weakening momentum" : "Healthy momentum",
    },
    {
      name: "MACD Cross",
      value: `${macd >= 0 ? "+" : ""}${macd.toFixed(2)}`,
      score: s2,
      icon: "📈",
      detail: s2 >= 1 ? "Bullish crossover with positive histogram" : s2 <= -1 ? "Bearish crossover — downward pressure" : "Neutral — watch for crossover",
    },
    {
      name: "Funding Rate",
      value: `${(fundingRate * 100).toFixed(4)}%`,
      score: s3,
      icon: "💸",
      detail: fundingRate > 0.001 ? "Longs paying — crowded trade" : fundingRate < -0.001 ? "Shorts paying — contrarian bullish" : "Balanced — no clear bias",
    },
    {
      name: "Long/Short Ratio",
      value: lsRatio.toFixed(2),
      score: s4,
      icon: "⚖️",
      detail: lsRatio > 1.5 ? "Heavily long — squeeze risk" : lsRatio > 1.1 ? "Slight long bias — healthy" : lsRatio < 0.9 ? "Short bias — contrarian buy" : "Balanced positioning",
    },
    {
      name: "Fear & Greed",
      value: fearGreed ? `${fgValue} · ${fearGreed.label}` : "—",
      score: s5,
      icon: "🧠",
      detail: fgValue >= 75 ? "Extreme greed — top caution" : fgValue <= 25 ? "Extreme fear — dip opportunity" : fgValue >= 55 ? "Greed phase — momentum continues" : "Fear zone — risk/reward improving",
    },
    {
      name: "Volume Profile POC",
      value: poc4h ? `$${poc4h.toLocaleString()}` : "—",
      score: s6,
      icon: "📦",
      detail: poc4h ? (price > poc4h * 1.03 ? "Above POC — extended, watch support" : price < poc4h * 0.97 ? "Below POC — potential mean reversion" : "Price at POC — high acceptance zone") : "Computing…",
    },
  ];

  const label = confluenceScore >= 70 ? "Strong Bull" : confluenceScore >= 57 ? "Mild Bull" : confluenceScore >= 43 ? "Neutral" : confluenceScore >= 30 ? "Mild Bear" : "Strong Bear";
  const labelClass = confluenceScore >= 57 ? "bull" : confluenceScore <= 43 ? "bear" : "neutral";

  const fmtPrice = (p: number) => `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  return (
    <div className="pe-wrap">
      <div className="pe-header">
        <div>
          <h2 className="pe-title">Multi-Signal Confluence Engine</h2>
          <p className="pe-sub">Composite score from 6 independent signals · {coin}/USD</p>
        </div>
        {loading && <span className="pe-loading-badge">Loading…</span>}
      </div>

      {/* Gauge */}
      <div className="pe-gauge-card">
        <div className="pe-gauge-bar-wrap">
          <div className="pe-gauge-track">
            <div className="pe-gauge-fill" style={{ width: `${confluenceScore}%` }} />
            <div className="pe-gauge-pointer" style={{ left: `${confluenceScore}%` }} />
          </div>
          <div className="pe-gauge-labels">
            <span>Strong Bear</span>
            <span>Neutral</span>
            <span>Strong Bull</span>
          </div>
        </div>
        <div className="pe-score-box">
          <span className="pe-score-num">{confluenceScore}</span>
          <span className="pe-score-slash">/100</span>
          <span className={`pe-score-label pe-score-label--${labelClass}`}>{label}</span>
        </div>
      </div>

      {/* Price targets */}
      <div className="pe-targets-row">
        {targets.map(t => (
          <div key={t.label} className="pe-target-card">
            <div className="pe-target-label">{t.label}</div>
            <div className="pe-target-values">
              <div className="pe-target-bull">
                <span className="pe-target-arrow">▲</span>
                {fmtPrice(t.bull)}
              </div>
              <div className="pe-target-bear">
                <span className="pe-target-arrow">▼</span>
                {fmtPrice(t.bear)}
              </div>
            </div>
            <div className="pe-target-atr">ATR {fmtPrice(t.atr)}</div>
          </div>
        ))}
      </div>

      {/* Signal breakdown */}
      <div className="pe-signals-card">
        <div className="pe-signals-title">Signal Breakdown</div>
        {signals.map(sig => {
          const pip = Math.round(sig.score);
          const dotClass = sig.score >= 1 ? "bull" : sig.score <= -1 ? "bear" : "neutral";
          return (
            <div key={sig.name} className="pe-signal-row">
              <span className="pe-signal-icon">{sig.icon}</span>
              <div className="pe-signal-main">
                <div className="pe-signal-top">
                  <span className="pe-signal-name">{sig.name}</span>
                  <span className="pe-signal-value">{sig.value}</span>
                </div>
                <div className="pe-signal-detail">{sig.detail}</div>
              </div>
              <div className="pe-signal-score">
                <div className="pe-pips">
                  {[-2, -1, 0, 1, 2].map(v => (
                    <div
                      key={v}
                      className={`pe-pip pe-pip--${v < 0 ? "bear" : v > 0 ? "bull" : "neutral"}${
                        (v < 0 && pip <= v) || (v > 0 && pip >= v) || (v === 0 && pip === 0) ? " pe-pip--active" : ""
                      }`}
                    />
                  ))}
                </div>
                <div className={`pe-signal-dot pe-signal-dot--${dotClass}`} />
              </div>
            </div>
          );
        })}
      </div>

      <p className="pe-disclaimer">
        For informational purposes only. Not financial advice. Past signal correlations do not guarantee future results.
      </p>
    </div>
  );
}
