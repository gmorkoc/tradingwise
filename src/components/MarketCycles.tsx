// Phones, Bitcoin page: "Market Cycles" (CoinMarketCap app layout) —
// status cards, then the Puell Multiple, Pi Cycle Top and Rainbow charts.
//
// Data: blockchain.info daily series (CORS-open, back to 2009):
//  • miners-revenue → Puell Multiple = today's revenue ÷ its 365-day average
//  • market-price   → Pi Cycle Top (111-day SMA vs 2 × 350-day SMA) and the
//    Rainbow chart (log price fitted against log time, 9 bands around it).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, ColorType, LineSeries, AreaSeries, BaselineSeries, LineStyle, PriceScaleMode,
  type IChartApi, type UTCTimestamp,
} from "lightweight-charts";
import "../styles/MarketCycles.css";

type Pt = { time: UTCTimestamp; value: number };
type Range = "30" | "365" | "all";
const RANGES: { id: Range; label: string }[] = [
  { id: "30", label: "30d" },
  { id: "365", label: "1y" },
  { id: "all", label: "All" },
];

// ── Data ────────────────────────────────────────────────────────────────
let btcDailyPromise: Promise<{ price: Pt[]; revenue: Pt[] }> | null = null;
function loadBtcDaily() {
  if (!btcDailyPromise) {
    const get = (chart: string) =>
      fetch(`https://api.blockchain.info/charts/${chart}?timespan=all&sampled=false&format=json&cors=true`)
        .then((r) => r.json())
        .then((d: { values: { x: number; y: number }[] }) =>
          d.values.filter((v) => v.y > 0).map((v) => ({ time: v.x as UTCTimestamp, value: v.y })));
    btcDailyPromise = Promise.all([get("market-price"), get("miners-revenue")])
      .then(([price, revenue]) => ({ price, revenue }))
      .catch((e) => { btcDailyPromise = null; throw e; });
  }
  return btcDailyPromise;
}

const sma = (pts: Pt[], n: number): Pt[] => {
  const out: Pt[] = [];
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    sum += pts[i].value;
    if (i >= n) sum -= pts[i - n].value;
    if (i >= n - 1) out.push({ time: pts[i].time, value: sum / n });
  }
  return out;
};

const GENESIS = Date.UTC(2009, 0, 3) / 1000;
const daysSince = (t: number) => Math.max(1, (t - GENESIS) / 86400);

// Rainbow: least-squares fit of log10(price) = a·ln(days) + b, then bands
// at fixed log10 offsets around it (low → high).
const RAINBOW = [
  { name: "Fire sale", color: "#5b8def" },
  { name: "BUY!", color: "#5fb8e8" },
  { name: "Accumulate", color: "#5ec98b" },
  { name: "Still cheap", color: "#a7d65a" },
  { name: "HODL!", color: "#f2e15b" },
  { name: "Is this a bubble?", color: "#f7bf4f" },
  { name: "FOMO intensifies", color: "#f39a4a" },
  { name: "Sell. Seriously, sell!", color: "#ea6a4a" },
  { name: "Maximum bubble", color: "#d6453d" },
];
const BAND_LO = -0.55;   // log10 offset of the bottom edge of band 0
const BAND_STEP = 0.125; // each band's height in log10
function fitRainbow(price: Pt[]) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of price) {
    const x = Math.log(daysSince(p.time)), y = Math.log10(p.value);
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const b = (sy - a * sx) / n;
  return (t: number, offset: number) => Math.pow(10, a * Math.log(daysSince(t)) + b + offset);
}

const HALVINGS = [
  { t: Date.UTC(2012, 10, 28) / 1000, label: "1. Halving" },
  { t: Date.UTC(2016, 6, 9) / 1000, label: "2. Halving" },
  { t: Date.UTC(2020, 4, 11) / 1000, label: "3. Halving" },
  { t: Date.UTC(2024, 3, 20) / 1000, label: "4. Halving" },
];

const fmtUsdFull = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
// Axis labels like CMC: $1M, $10K, $100, $1, $0.01.
const fmtAxisUsd = (v: number) =>
  v >= 1e9 ? `$${+(v / 1e9).toPrecision(3)}B` : v >= 1e6 ? `$${+(v / 1e6).toPrecision(3)}M` : v >= 1e3 ? `$${+(v / 1e3).toPrecision(3)}K` : v >= 1 ? `$${+v.toPrecision(3)}` : `$${+v.toPrecision(2)}`;
const usdFormat = { type: "custom" as const, formatter: fmtAxisUsd, minMove: 0.0001 };
const numFormat = { type: "custom" as const, formatter: (v: number) => `${+v.toPrecision(3)}`, minMove: 0.0001 };
// CMC's colours.
const C_BLUE = "#3861fb";
const C_GREEN = "#16c784";
const cut = (pts: Pt[], range: Range) => {
  if (range === "all" || !pts.length) return pts;
  const from = pts[pts.length - 1].time - Number(range) * 86400;
  return pts.filter((p) => p.time >= from);
};

// ── One chart box ───────────────────────────────────────────────────────
function CycleChart({ theme, build, deps, overlay, dotted }: {
  theme: "dark" | "light";
  /** CMC rainbow look: dotted horizontal grid lines. */
  dotted?: boolean;
  build: (chart: IChartApi) => void;
  deps: unknown[];
  overlay?: (chart: IChartApi) => React.ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const light = theme === "light";
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: light ? "#616e85" : "#a1a7bb", fontSize: 10, attributionLogo: false },
      grid: {
        vertLines: { color: "transparent" },
        horzLines: dotted
          ? { color: light ? "rgba(13,20,33,0.55)" : "rgba(255,255,255,0.4)", style: LineStyle.Dotted }
          : { color: light ? "rgba(15,23,42,0.05)" : "rgba(255,255,255,0.05)" },
      },
      rightPriceScale: { borderColor: "transparent", mode: PriceScaleMode.Logarithmic },
      leftPriceScale: { borderColor: "transparent", mode: PriceScaleMode.Logarithmic },
      timeScale: { borderColor: "transparent", fixLeftEdge: true, fixRightEdge: true },
      crosshair: { horzLine: { visible: false, labelVisible: false } },
      handleScroll: false,
      handleScale: false,
    });
    let disposed = false;
    try { build(c); c.timeScale().fitContent(); } catch { /* bad data — leave empty */ }
    setChart(c);
    // Overlay positions follow layout changes.
    const ro = new ResizeObserver(() => requestAnimationFrame(() => { if (!disposed) setTick((t) => t + 1); }));
    ro.observe(el);
    return () => { disposed = true; ro.disconnect(); setChart(null); c.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, ...deps]);
  return (
    <div className="mcyc-chart">
      <div ref={boxRef} className="mcyc-chart-box" />
      {chart && overlay?.(chart)}
    </div>
  );
}

function RangeTabs({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div className="mcyc-seg" role="tablist">
      {RANGES.map((r) => (
        <button key={r.id} type="button" role="tab" aria-selected={value === r.id} className={`mcyc-seg-btn${value === r.id ? " mcyc-seg-btn--on" : ""}`} onClick={() => onChange(r.id)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

// Card title with CMC's ⓘ (tooltip text on press / hover).
const Title = ({ text, tip }: { text: string; tip: string }) => (
  <h3 className="mcyc-bh">
    {text}
    <span className="mcyc-bh-i" title={tip} aria-label={tip}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
    </span>
  </h3>
);

const Legend = ({ items }: { items: { label: string; color: string }[] }) => (
  <div className="mcyc-legend">
    {items.map((i) => <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>)}
  </div>
);

// ── Section ─────────────────────────────────────────────────────────────
export function MarketCycles({ coin, theme }: { coin: string; theme: "dark" | "light" }) {
  const [data, setData] = useState<{ price: Pt[]; revenue: Pt[] } | null>(null);
  const [error, setError] = useState(false);
  const [puellRange, setPuellRange] = useState<Range>("all");
  const [piRange, setPiRange] = useState<Range>("all");
  const [rbRange, setRbRange] = useState<Range>("all");

  useEffect(() => {
    if (coin !== "BTC") return;
    let alive = true;
    loadBtcDaily().then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [coin]);

  const calc = useMemo(() => {
    if (!data) return null;
    const ma365 = sma(data.revenue, 365);
    const revAt = new Map(data.revenue.map((p) => [p.time, p.value]));
    const puell: Pt[] = ma365.map((m) => ({ time: m.time, value: (revAt.get(m.time) ?? m.value) / m.value }));
    const ma111 = sma(data.price, 111);
    const ma350x2 = sma(data.price, 350).map((p) => ({ time: p.time, value: p.value * 2 }));
    const band = fitRainbow(data.price);
    const last = data.price[data.price.length - 1];
    const lastLog = Math.log10(last.value) - Math.log10(band(last.time, 0));
    const zone = Math.max(0, Math.min(RAINBOW.length - 1, Math.floor((lastLog - BAND_LO) / BAND_STEP)));
    return { puell, ma111, ma350x2, band, zone, last };
  }, [data]);

  if (coin !== "BTC") return null;
  const isLight = theme === "light";
  const priceGrey = isLight ? "#a6b0c3" : "#5b6378";
  // The page's own background (the rainbow's "below the bands" fill) —
  // the blocks have no card colour of their own any more.
  const pageBg = isLight ? "#ffffff" : "#000000";

  const puellNow = calc?.puell[calc.puell.length - 1]?.value ?? null;
  // Marker on a log scale 0.2 … 8 (undervalued < 0.5, overvalued > 4).
  const puellPos = puellNow === null ? 0 : Math.max(0, Math.min(1, Math.log(puellNow / 0.2) / Math.log(40)));
  const pi111 = calc?.ma111[calc.ma111.length - 1]?.value ?? null;
  const pi350 = calc?.ma350x2[calc.ma350x2.length - 1]?.value ?? null;
  const piTop = pi111 !== null && pi350 !== null && pi111 >= pi350;

  return (
    <section id="coin-sec-cycles" className="mcyc" aria-label="Bitcoin market cycles">
      <h2 className="mcyc-h">Bitcoin Market Cycles</h2>
      {error ? (
        <p className="mcyc-note">Cycle data couldn't load right now.</p>
      ) : !calc ? (
        <div className="mcyc-skel"><span /><span /></div>
      ) : (
        <>
          {/* Status cards — swipe sideways. */}
          <div className="mcyc-cards">
            <div className="mcyc-card">
              <span className="mcyc-card-k">Puell Multiple Status</span>
              <strong className="mcyc-card-v">{puellNow!.toFixed(4)}</strong>
              <div className="mcyc-meter" aria-hidden="true">
                <div className="mcyc-meter-bar" />
                <i style={{ left: `${(puellPos * 100).toFixed(1)}%` }} />
              </div>
              <div className="mcyc-meter-cap"><span>Undervalued</span><span>Overvalued</span></div>
            </div>
            <div className="mcyc-card">
              <span className="mcyc-card-k">Pi Cycle Top Indicator</span>
              <div className="mcyc-card-pair">
                <span><em>111DMA</em><b>{fmtUsdFull(Math.round(pi111!))}</b></span>
                <span><em>350DMA × 2</em><b>{fmtUsdFull(Math.round(pi350!))}</b></span>
              </div>
              <span className={`mcyc-badge${piTop ? " mcyc-badge--hot" : ""}`}>{piTop ? "Top signal" : "No top signal"}</span>
            </div>
            <div className="mcyc-card">
              <span className="mcyc-card-k">Rainbow Chart</span>
              <strong className="mcyc-card-v mcyc-card-v--zone">
                <i style={{ background: RAINBOW[calc.zone].color }} />
                {RAINBOW[calc.zone].name}
              </strong>
              <span className="mcyc-card-sub">Price {fmtUsdFull(Math.round(calc.last.value))}</span>
            </div>
          </div>

          {/* Puell Multiple */}
          <div className="mcyc-block">
            <Title text="Puell Multiple" tip="Daily miner revenue ÷ its 365-day average. Under 0.5 has marked cycle bottoms; over 4, cycle tops." />
            <RangeTabs value={puellRange} onChange={setPuellRange} />
            <Legend items={[
              { label: "Puell Multiple", color: "#3861fb" },
              { label: "Undervalued", color: "#9fe3c0" },
              { label: "Overvalued", color: "#f5b5b5" },
              { label: "Bitcoin Price", color: priceGrey },
            ]} />
            <CycleChart
              theme={theme}
              deps={[puellRange, calc]}
              build={(c) => {
                const p = cut(calc.puell, puellRange);
                if (!p.length) return;
                const t0 = p[0].time, t1 = p[p.length - 1].time;
                const flat = (v: number): Pt[] => [{ time: t0, value: v }, { time: t1, value: v }];
                c.priceScale("left").applyOptions({ visible: true });
                // Over- / undervalued bands on the Puell (right) scale.
                c.addSeries(BaselineSeries, {
                  priceFormat: numFormat,
                  baseValue: { type: "price", price: 4 },
                  topFillColor1: "rgba(234,57,67,0.14)", topFillColor2: "rgba(234,57,67,0.14)", topLineColor: "transparent",
                  bottomFillColor1: "transparent", bottomFillColor2: "transparent", bottomLineColor: "transparent",
                  lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
                }).setData(flat(12));
                c.addSeries(BaselineSeries, {
                  priceFormat: numFormat,
                  baseValue: { type: "price", price: 0.5 },
                  bottomFillColor1: "rgba(22,199,132,0.14)", bottomFillColor2: "rgba(22,199,132,0.14)", bottomLineColor: "transparent",
                  topFillColor1: "transparent", topFillColor2: "transparent", topLineColor: "transparent",
                  lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
                }).setData(flat(0.25));
                c.addSeries(LineSeries, { priceScaleId: "left", priceFormat: usdFormat, color: priceGrey, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
                  .setData(cut(data!.price, puellRange));
                c.addSeries(LineSeries, { priceFormat: numFormat, color: C_BLUE, lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
                  .setData(p);
              }}
            />
          </div>

          {/* Pi Cycle Top */}
          <div className="mcyc-block">
            <Title text="Pi Cycle Top Indicator" tip="The 111-day average crossing above 2 × the 350-day average has marked past cycle tops." />
            <RangeTabs value={piRange} onChange={setPiRange} />
            <Legend items={[
              { label: "111DMA", color: C_BLUE },
              { label: "350DMA × 2", color: C_GREEN },
              { label: "Bitcoin Price", color: priceGrey },
            ]} />
            <CycleChart
              theme={theme}
              deps={[piRange, calc]}
              build={(c) => {
                c.addSeries(LineSeries, { priceFormat: usdFormat, color: priceGrey, lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
                  .setData(cut(data!.price, piRange));
                c.addSeries(LineSeries, { priceFormat: usdFormat, color: C_GREEN, lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
                  .setData(cut(calc.ma350x2, piRange));
                c.addSeries(LineSeries, { priceFormat: usdFormat, color: C_BLUE, lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
                  .setData(cut(calc.ma111, piRange));
              }}
            />
          </div>

          {/* Rainbow */}
          <div className="mcyc-block">
            <Title text="Bitcoin Rainbow Price Chart Indicator" tip="A log curve fitted to Bitcoin's whole price history, split into 9 colour bands from Fire sale to Maximum bubble." />
            <RangeTabs value={rbRange} onChange={setRbRange} />
            <Legend items={[
              { label: "Bitcoin Price", color: isLight ? "#0d1421" : "#ffffff" },
              { label: `Now: ${RAINBOW[calc.zone].name}`, color: RAINBOW[calc.zone].color },
            ]} />
            <CycleChart
              theme={theme}
              deps={[rbRange, calc]}
              dotted
              build={(c) => {
                const pr = cut(data!.price, rbRange);
                if (!pr.length) return;
                // Band edges on a weekly grid (smooth curves, light data).
                const step = rbRange === "all" ? 7 * 86400 : 86400;
                const times: UTCTimestamp[] = [];
                for (let t = pr[0].time; t <= pr[pr.length - 1].time; t = (t + step) as UTCTimestamp) times.push(t);
                times.push(pr[pr.length - 1].time);
                // Top band first: each band fills down to the bottom and the
                // next (lower) one paints over it → stacked rainbow.
                for (let i = RAINBOW.length - 1; i >= 0; i--) {
                  const top = BAND_LO + (i + 1) * BAND_STEP;
                  c.addSeries(AreaSeries, {
                    priceFormat: usdFormat,
                    lineColor: "transparent", topColor: RAINBOW[i].color, bottomColor: RAINBOW[i].color,
                    lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
                  }).setData(times.map((t) => ({ time: t, value: calc.band(t, top) })));
                }
                // Clear below the lowest band.
                c.addSeries(AreaSeries, {
                  priceFormat: usdFormat,
                  lineColor: "transparent", topColor: pageBg, bottomColor: pageBg,
                  lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
                }).setData(times.map((t) => ({ time: t, value: calc.band(t, BAND_LO) })));
                c.addSeries(LineSeries, { priceFormat: usdFormat, color: isLight ? "#0d1421" : "#ffffff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
                  .setData(pr);
                c.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.04 } });
              }}
              overlay={(c) => {
                const h = HALVINGS.map((x) => ({ ...x, x: c.timeScale().timeToCoordinate(x.t as UTCTimestamp) }))
                  .filter((x) => x.x !== null);
                return (
                  <>
                    {h.map((x) => (
                      <span key={x.t} className="mcyc-halving" style={{ left: x.x! }}>
                        <span>{x.label}</span>
                      </span>
                    ))}
                  </>
                );
              }}
            />
          </div>
        </>
      )}
    </section>
  );
}
