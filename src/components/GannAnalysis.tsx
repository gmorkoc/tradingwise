import { useState, useEffect, useMemo, useCallback } from "react";
import { coinglass, CoinSymbol } from "../services/coinglass";
import { getGannAnalysis, GannAIResult } from "../services/openai";
import { useAIQuota } from "../hooks/useAIQuota";
import { AIQuotaWall } from "./AIQuotaWall";
import "../styles/GannAnalysis.css";

interface CandlePoint { time: number; open: number; high: number; low: number; close: number; }
interface GannAnalysisProps { coin?: CoinSymbol; currentPrice?: number; onOpenAuth?: () => void; onOpenUpgrade?: () => void; }

// ── Maths ─────────────────────────────────────────────────────────────────

function sq9Level(price: number, rotations: number): number {
  if (price <= 0) return 0;
  const r = Math.sqrt(price) + rotations;
  return Math.max(0, r * r);
}

function naturalUnit(price: number): number {
  const s = Math.sqrt(price);
  const mag = Math.pow(10, Math.floor(Math.log10(s)));
  return Math.round(s / mag) * mag;
}

function daysElapsed(unixSec: number): number {
  return (Date.now() / 1000 - unixSec) / 86400;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ── Constants ──────────────────────────────────────────────────────────────

const WINDOW = 14;
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const GANN_CYCLES = [
  { days: 30,  label: "30D",  tag: "Monthly"   },
  { days: 45,  label: "45D",  tag: "1/8 Year"  },
  { days: 60,  label: "60D",  tag: "2 Months"  },
  { days: 90,  label: "90D",  tag: "Quarter"   },
  { days: 120, label: "120D", tag: "1/3 Year"  },
  { days: 144, label: "144D", tag: "Gann Key"  },
  { days: 180, label: "180D", tag: "Half Year" },
  { days: 270, label: "270D", tag: "3/4 Year"  },
  { days: 360, label: "360D", tag: "Full Year" },
];

const GANN_ANGLES = [
  { ratio: 4,    label: "4×1", deg: "75°",    strong: false },
  { ratio: 2,    label: "2×1", deg: "63.75°", strong: false },
  { ratio: 1,    label: "1×1", deg: "45°",    strong: true  },
  { ratio: 0.5,  label: "1×2", deg: "26.25°", strong: false },
  { ratio: 0.25, label: "1×4", deg: "15°",    strong: false },
];

const fmtPrice = (p: number) =>
  p >= 100 ? p.toLocaleString("en-US", { maximumFractionDigits: 0 }) :
  p >= 1   ? p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) :
  p.toFixed(4);

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

// ── Component ──────────────────────────────────────────────────────────────

export const GannAnalysis: React.FC<GannAnalysisProps> = ({ coin = "BTC", currentPrice = 0, onOpenAuth = () => {}, onOpenUpgrade = () => {} }) => {
  const { exceeded, used, limit, consume, isPaid } = useAIQuota();
  const [candles, setCandles] = useState<CandlePoint[]>([]);
  const [loading, setLoading] = useState(true);

  // Timeline window
  const [windowStart, setWindowStart] = useState<Date>(() => startOfDay(addDays(new Date(), -7)));
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  useEffect(() => {
    setLoading(true);
    coinglass.getHistoricalCandles("4h", coin)
      .then(data => { setCandles(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [coin]);

  // ── Auto-detected swings ──────────────────────────────────────────────────
  const autoSwings = useMemo(() => {
    if (!candles.length) return null;
    let highPrice = -Infinity, lowPrice = Infinity, highTime = 0, lowTime = 0;
    for (const c of candles) {
      if (c.high > highPrice) { highPrice = c.high; highTime = c.time; }
      if (c.low  < lowPrice)  { lowPrice  = c.low;  lowTime  = c.time; }
    }
    return {
      high: { price: highPrice, time: highTime, date: new Date(highTime * 1000) },
      low:  { price: lowPrice,  time: lowTime,  date: new Date(lowTime  * 1000) },
    };
  }, [candles]);

  const swings = autoSwings;

  const price = currentPrice || candles[candles.length - 1]?.close || 0;

  // ── Square of 9 ───────────────────────────────────────────────────────────
  const sq9 = useMemo(() => {
    if (!price) return null;
    const inc = [0.25, 0.5, 0.75, 1.0];
    return {
      above: inc.map(r => ({ deg: r * 360, price: sq9Level(price, r)  })).reverse(),
      below: inc.map(r => ({ deg: r * 360, price: sq9Level(price, -r) })),
    };
  }, [price]);

  // ── Gann angles (for TODAY) ────────────────────────────────────────────────
  const angles = useMemo(() => {
    if (!swings || !price) return null;
    const unitH = naturalUnit(swings.high.price);
    const unitL = naturalUnit(swings.low.price);
    const daysH = daysElapsed(swings.high.time);
    const daysL = daysElapsed(swings.low.time);
    return {
      fromHigh: GANN_ANGLES.map(a => ({ ...a, priceLevel: Math.max(0, swings.high.price - daysH * a.ratio * unitH) })),
      fromLow:  GANN_ANGLES.map(a => ({ ...a, priceLevel: Math.max(0, swings.low.price  + daysL * a.ratio * unitL) })),
      unitH, unitL,
      daysH: Math.round(daysH),
      daysL: Math.round(daysL),
    };
  }, [swings, price]);

  // ── Angle projections for any target date ────────────────────────────────
  const getAngleProjections = useCallback((targetDate: Date) => {
    if (!swings) return null;
    const unitH = naturalUnit(swings.high.price);
    const unitL = naturalUnit(swings.low.price);
    const daysFromHigh = (targetDate.getTime() - swings.high.time * 1000) / 86400000;
    const daysFromLow  = (targetDate.getTime() - swings.low.time  * 1000) / 86400000;
    return {
      fromHigh: GANN_ANGLES.map(a => ({ ...a, priceLevel: Math.max(0, swings.high.price - daysFromHigh * a.ratio * unitH) })),
      fromLow:  GANN_ANGLES.map(a => ({ ...a, priceLevel: Math.max(0, swings.low.price  + daysFromLow  * a.ratio * unitL) })),
      daysFromHigh: Math.round(daysFromHigh),
      daysFromLow:  Math.round(daysFromLow),
    };
  }, [swings]);

  // ── Pivot date map ────────────────────────────────────────────────────────
  const pivotMap = useMemo(() => {
    if (!swings) return new Map<string, { label: string; from: "high" | "low" }[]>();
    const map = new Map<string, { label: string; from: "high" | "low" }[]>();
    const mark = (d: Date, label: string, from: "high" | "low") => {
      const key = startOfDay(d).toISOString();
      map.set(key, [...(map.get(key) || []), { label, from }]);
    };
    for (const c of GANN_CYCLES) {
      mark(addDays(swings.high.date,  c.days), `${c.label} (${c.tag})`, "high");
      mark(addDays(swings.high.date, -c.days), `${c.label} (${c.tag})`, "high");
      mark(addDays(swings.low.date,   c.days), `${c.label} (${c.tag})`, "low");
      mark(addDays(swings.low.date,  -c.days), `${c.label} (${c.tag})`, "low");
    }
    return map;
  }, [swings]);

  // ── Window days ──────────────────────────────────────────────────────────
  const windowDays = useMemo(() =>
    Array.from({ length: WINDOW }, (_, i) => startOfDay(addDays(windowStart, i))),
    [windowStart]
  );

  const today = startOfDay(new Date());
  const goBack    = () => setWindowStart(d => startOfDay(addDays(d, -7)));
  const goForward = () => setWindowStart(d => startOfDay(addDays(d,  7)));
  const goToday   = () => { setWindowStart(startOfDay(addDays(today, -7))); setSelectedDay(null); };

  // ── Upcoming cycles ───────────────────────────────────────────────────────
  const upcomingCycles = useMemo(() => {
    if (!swings) return [];
    const now = new Date();
    const results: { date: Date; daysAway: number; cycle: string; tag: string; from: "high" | "low" }[] = [];
    for (const c of GANN_CYCLES) {
      const dH = addDays(swings.high.date, c.days);
      const dL = addDays(swings.low.date,  c.days);
      if (dH >= now) results.push({ date: dH, daysAway: Math.round((dH.getTime() - now.getTime()) / 86400000), cycle: c.label, tag: c.tag, from: "high" });
      if (dL >= now) results.push({ date: dL, daysAway: Math.round((dL.getTime() - now.getTime()) / 86400000), cycle: c.label, tag: c.tag, from: "low"  });
    }
    return results.sort((a, b) => a.date.getTime() - b.date.getTime()).slice(0, 12);
  }, [swings]);

  const windowRangeLabel = `${fmtDate(windowDays[0])} – ${fmtDate(windowDays[WINDOW - 1])}`;

  // ── AI Analysis ──────────────────────────────────────────────────────────
  const [aiResult, setAiResult] = useState<GannAIResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const runGannAI = async () => {
    if (!swings || !price || !sq9 || !angles) return;
    if (exceeded && !isPaid) return;
    if (!consume()) return;
    setAiLoading(true);
    setAiError(null);
    const res = await getGannAnalysis({
      coin,
      currentPrice: price,
      swingHigh: {
        price: swings.high.price,
        date: swings.high.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        daysAgo: angles.daysH,
        unit: angles.unitH,
      },
      swingLow: {
        price: swings.low.price,
        date: swings.low.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        daysAgo: angles.daysL,
        unit: angles.unitL,
      },
      sq9Above: sq9.above,
      sq9Below: sq9.below,
      anglesFromHigh: angles.fromHigh,
      anglesFromLow:  angles.fromLow,
      upcomingCycles: upcomingCycles.map(c => ({ ...c, date: fmtDate(c.date) })),
    });
    setAiLoading(false);
    if (res.success && res.result) setAiResult(res.result);
    else setAiError(res.error || "Unknown error");
  };

  // Selected day projections
  const selProj = selectedDay ? getAngleProjections(selectedDay) : null;
  const selMarks = selectedDay ? (pivotMap.get(startOfDay(selectedDay).toISOString()) || []) : [];
  const selDaysAway = selectedDay ? Math.round((selectedDay.getTime() - today.getTime()) / 86400000) : 0;
  const selRelLabel = !selectedDay ? "" :
    selDaysAway === 0 ? "Today" :
    selDaysAway > 0 ? `In ${selDaysAway} day${selDaysAway === 1 ? "" : "s"}` :
    `${Math.abs(selDaysAway)} day${Math.abs(selDaysAway) === 1 ? "" : "s"} ago`;

  return (
    <section className="gann-card">
      <div className="gann-header">
        <div className="gann-header-row">
          <div className="gann-header-left">
            <span className="gann-logo">📐</span>
            <div>
              <div className="gann-title">
                Gann Analysis
                <span className="pattern-insight-ai-badge">✦ AI Powered</span>
              </div>
              <div className="gann-sub">Square of 9 · Time Cycles · Gann Angles · Pivot Timeline</div>
            </div>
          </div>
          <div className="gann-header-right">
            <span className="gann-coin-tag">{coin}</span>
            {price > 0 && (
              <span className="gann-price-badge">${fmtPrice(price)}</span>
            )}
          </div>
        </div>
      </div>

      {loading && <div className="gann-loading">Loading candle data…</div>}

      {!loading && (
        <div className="gann-body">

          {/* ── Row: Square of 9 + Timeline ────────────────────────────────── */}
          <div className="gann-row-two">

            {/* Square of 9 */}
            <div className="gann-panel">
              <div className="gann-panel-title">Square of 9</div>
              <p className="gann-panel-sub">Key price levels at 90° rotations from current price</p>
              {sq9 && (
                <div className="gann-sq9">
                  {sq9.above.map(l => (
                    <div key={l.deg} className="gann-sq9-row gann-sq9-row--above">
                      <span className="gann-sq9-deg">{l.deg}°</span>
                      <span className="gann-sq9-price">${fmtPrice(l.price)}</span>
                      <span className="gann-sq9-dist">+{((l.price - price) / price * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                  <div className="gann-sq9-current">
                    <span>● ${fmtPrice(price)}</span>
                    <span className="gann-sq9-current-label">Current Price</span>
                  </div>
                  {sq9.below.map(l => (
                    <div key={l.deg} className="gann-sq9-row gann-sq9-row--below">
                      <span className="gann-sq9-deg">{l.deg}°</span>
                      <span className="gann-sq9-price">${fmtPrice(l.price)}</span>
                      <span className="gann-sq9-dist">{((l.price - price) / price * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Pivot Timeline */}
            <div className="gann-panel">
              <div className="gann-panel-title">Pivot Timeline</div>
              <p className="gann-panel-sub">Tap any day to see Gann angle price predictions for that date</p>

              <div className="gann-tl-nav">
                <button className="gann-tl-nav-btn" onClick={goBack}>← Prev</button>
                <div className="gann-tl-nav-center">
                  <span className="gann-tl-range">{windowRangeLabel}</span>
                  <button className="gann-tl-today-btn" onClick={goToday}>Today</button>
                </div>
                <button className="gann-tl-nav-btn" onClick={goForward}>Next →</button>
              </div>

              <div className="gann-tl-strip">
                {windowDays.map((day, i) => {
                  const key      = startOfDay(day).toISOString();
                  const marks    = pivotMap.get(key) || [];
                  const isToday  = sameDay(day, today);
                  const isPast   = day < today && !isToday;
                  const isSelected = selectedDay ? sameDay(day, selectedDay) : false;
                  const hasHigh  = marks.some(m => m.from === "high");
                  const hasLow   = marks.some(m => m.from === "low");
                  const hasBoth  = hasHigh && hasLow;

                  let cellClass = "gann-tl-cell";
                  if (isSelected)      cellClass += " gann-tl-cell--selected";
                  else if (isToday)    cellClass += " gann-tl-cell--today";
                  else if (isPast)     cellClass += " gann-tl-cell--past";
                  if (hasBoth)         cellClass += " gann-tl-cell--both";
                  else if (hasHigh)    cellClass += " gann-tl-cell--high";
                  else if (hasLow)     cellClass += " gann-tl-cell--low";

                  return (
                    <div
                      key={i}
                      className={cellClass}
                      onClick={() => setSelectedDay(isSelected ? null : day)}
                      title="Click to see Gann predictions"
                    >
                      <span className="gann-tl-dow">{DOW[day.getDay()]}</span>
                      <span className="gann-tl-day">{day.getDate()}</span>
                      <span className="gann-tl-mon">{day.toLocaleDateString("en-US", { month: "short" })}</span>
                      {marks.length > 0 && (
                        <div className="gann-tl-marks">
                          {marks.slice(0, 2).map((m, j) => (
                            <span key={j} className={`gann-tl-mark gann-tl-mark--${m.from}`}>
                              {m.from === "high" ? "H" : "L"}
                            </span>
                          ))}
                          {marks.length > 2 && (
                            <span className="gann-tl-mark gann-tl-mark--more">+{marks.length - 2}</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* ── Day prediction detail ──────────────────────────────── */}
              {selectedDay && selProj && (
                <div className="gann-tl-detail">
                  <div className="gann-tl-detail-header">
                    <span className="gann-tl-detail-date">
                      {selectedDay.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" })}
                    </span>
                    <span className="gann-tl-detail-rel">{selRelLabel}</span>
                  </div>

                  {selMarks.length > 0 && (
                    <div className="gann-tl-detail-cycles">
                      <div className="gann-tl-detail-section-label">⚡ Cycle Confluence</div>
                      <div className="gann-tl-detail-cycle-list">
                        {selMarks.map((m, i) => (
                          <div key={i} className={`gann-tl-detail-cycle gann-tl-detail-cycle--${m.from}`}>
                            {m.from === "high" ? "▼ H" : "▲ L"} {m.label}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="gann-tl-detail-section-label" style={{ marginTop: selMarks.length > 0 ? 10 : 0 }}>
                    📐 Gann Angle Price Projections
                  </div>
                  <div className="gann-tl-detail-angles">
                    <div className="gann-tl-detail-angles-col">
                      <div className="gann-tl-detail-col-head gann-tl-detail-col-head--high">
                        ▼ From High
                        <span className="gann-tl-detail-col-days">
                          {selProj.daysFromHigh >= 0 ? `+${selProj.daysFromHigh}d` : `${selProj.daysFromHigh}d`}
                        </span>
                      </div>
                      {selProj.fromHigh.map(a => (
                        <div key={a.label} className={`gann-tl-detail-angle${a.strong ? " gann-tl-detail-angle--key" : ""}`}>
                          <span className="gann-tl-detail-angle-label">
                            {a.label} <span className="gann-tl-detail-angle-deg">{a.deg}</span>
                          </span>
                          <span className="gann-tl-detail-angle-price">${fmtPrice(a.priceLevel)}</span>
                          {price > 0 && (
                            <span className={`gann-tl-detail-angle-pct ${a.priceLevel > price ? "pos" : "neg"}`}>
                              {a.priceLevel > price ? "+" : ""}{((a.priceLevel - price) / price * 100).toFixed(1)}%
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="gann-tl-detail-angles-col">
                      <div className="gann-tl-detail-col-head gann-tl-detail-col-head--low">
                        ▲ From Low
                        <span className="gann-tl-detail-col-days">
                          {selProj.daysFromLow >= 0 ? `+${selProj.daysFromLow}d` : `${selProj.daysFromLow}d`}
                        </span>
                      </div>
                      {selProj.fromLow.map(a => (
                        <div key={a.label} className={`gann-tl-detail-angle${a.strong ? " gann-tl-detail-angle--key" : ""}`}>
                          <span className="gann-tl-detail-angle-label">
                            {a.label} <span className="gann-tl-detail-angle-deg">{a.deg}</span>
                          </span>
                          <span className="gann-tl-detail-angle-price">${fmtPrice(a.priceLevel)}</span>
                          {price > 0 && (
                            <span className={`gann-tl-detail-angle-pct ${a.priceLevel > price ? "pos" : "neg"}`}>
                              {a.priceLevel > price ? "+" : ""}{((a.priceLevel - price) / price * 100).toFixed(1)}%
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="gann-cal-legend" style={{ marginTop: 10 }}>
                <span className="gann-cal-legend-item gann-cal-legend--high">■ High cycle</span>
                <span className="gann-cal-legend-item gann-cal-legend--low">■ Low cycle</span>
                <span className="gann-cal-legend-item gann-cal-legend--both">■ Both</span>
              </div>
            </div>
          </div>

          {/* ── AI Gann Analysis ─────────────────────────────────────────── */}
          <div className="gann-panel gann-panel--full gann-ai-panel">
            <div className="gann-ai-header">
              <div>
                <div className="gann-panel-title">AI Gann Analysis</div>
                <p className="gann-panel-sub" style={{ margin: 0 }}>GPT-4o analyses all Gann data and delivers a structured prediction</p>
              </div>
              {!exceeded || isPaid ? (
                <button
                  className={`gann-ai-btn${aiLoading ? " gann-ai-btn--loading" : ""}`}
                  onClick={runGannAI}
                  disabled={aiLoading || !swings || !price}
                >
                  {aiLoading ? "Analysing…" : aiResult ? "Refresh" : "✦ Analyse with AI"}
                </button>
              ) : null}
            </div>

            {exceeded && !isPaid && (
              <AIQuotaWall used={used} limit={limit} onOpenUpgrade={onOpenUpgrade} onOpenAuth={onOpenAuth} />
            )}

            {aiError && !exceeded && (
              <div className="gann-ai-error">{aiError}</div>
            )}

            {aiResult && !aiLoading && (!exceeded || isPaid) && (
              <div className="gann-ai-result">
                {/* Sentiment badge + confidence */}
                <div className="gann-ai-sentiment-row">
                  <span className="pattern-insight-ai-badge" style={{ marginRight: "auto" }}>✦ AI Powered</span>
                  <span className={`gann-ai-sentiment gann-ai-sentiment--${aiResult.sentiment}`}>
                    {aiResult.sentiment === "bullish" ? "▲ Bullish" : aiResult.sentiment === "bearish" ? "▼ Bearish" : "● Neutral"}
                  </span>
                  <span className={`gann-ai-confidence gann-ai-confidence--${aiResult.confidence}`}>
                    {aiResult.confidence} confidence
                  </span>
                </div>

                {/* Main analysis */}
                <p className="gann-ai-analysis">{aiResult.analysis}</p>

                {/* Key levels + price target */}
                <div className="gann-ai-grid">
                  <div className="gann-ai-section">
                    <div className="gann-ai-section-title">Key Levels to Watch</div>
                    <div className="gann-ai-levels">
                      {aiResult.keyLevels?.slice(0, 5).map((l, i) => (
                        <div key={i} className={`gann-ai-level gann-ai-level--${l.type}`}>
                          <span className="gann-ai-level-tag">{l.type === "support" ? "S" : "R"}</span>
                          <span className="gann-ai-level-price">${fmtPrice(l.price)}</span>
                          <span className="gann-ai-level-label">{l.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="gann-ai-section">
                    <div className="gann-ai-section-title">Price Target</div>
                    <div className="gann-ai-target">
                      <div className="gann-ai-target-range">
                        <span className="gann-ai-target-low">${fmtPrice(aiResult.priceTarget?.low ?? 0)}</span>
                        <span className="gann-ai-target-arrow">→</span>
                        <span className="gann-ai-target-high">${fmtPrice(aiResult.priceTarget?.high ?? 0)}</span>
                      </div>
                      <div className="gann-ai-target-tf">{aiResult.priceTarget?.timeframe}</div>
                    </div>
                    <div className="gann-ai-section-title" style={{ marginTop: 14 }}>Next Cycle Alert</div>
                    <p className="gann-ai-cycle-alert">{aiResult.nextCycleAlert}</p>
                  </div>
                </div>

                {/* Actionable insight */}
                <div className="gann-ai-insight">
                  <span className="gann-ai-insight-icon">💡</span>
                  <span className="gann-ai-insight-text">{aiResult.actionableInsight}</span>
                </div>
              </div>
            )}
          </div>

        </div>
      )}
    </section>
  );
};
