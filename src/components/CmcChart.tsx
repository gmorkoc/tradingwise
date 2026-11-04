// Desktop chart page: CoinMarketCap-style line chart (Price or Market cap).
// Green above the range's opening value, red below (a baseline chart),
// dotted opening line with its value on the left, volume bars underneath,
// a faint coinhintz watermark, and an all-time overview strip below.
// Data: CoinGecko market_chart (prices / market caps / volumes).
import { useEffect, useRef, useState } from "react";
import {
  createChart, ColorType, BaselineSeries, HistogramSeries, AreaSeries, LineStyle, PriceScaleMode, TickMarkType,
  type IChartApi, type ISeriesApi, type UTCTimestamp, type Time,
} from "lightweight-charts";

// Axis labels like CMC: "2:00 AM", "4 Nov", "Jan", "2024".
const tickFmt = (time: Time, type: TickMarkType) => {
  const d = new Date((time as number) * 1000);
  switch (type) {
    case TickMarkType.Year: return String(d.getFullYear());
    case TickMarkType.Month: return d.toLocaleString("en-US", { month: "short" });
    case TickMarkType.DayOfMonth: return `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}`;
    default: return d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
  }
};
import { getCoinGeckoId, fetchBn } from "../services/coinglass";
import "../styles/CmcChart.css";

export type CmcRange = "1" | "7" | "30" | "365" | "max";
export const CMC_RANGES: { id: CmcRange; label: string }[] = [
  { id: "1", label: "24h" },
  { id: "7", label: "1W" },
  { id: "30", label: "1M" },
  { id: "365", label: "1Y" },
  { id: "max", label: "All" },
];
type Pt = { time: UTCTimestamp; value: number };
type Series3 = { price: Pt[]; mcap: Pt[]; vol: Pt[] };

const UP = "#16c784";
const DN = "#ea3943";

const compact = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(4);
};

// market_chart responses, cached per coin+range for a minute (24h) or 10.
const cache = new Map<string, { at: number; data: Series3 }>();
const RANGE_SECS: Record<Exclude<CmcRange, "max">, number> = { "1": 86400, "7": 7 * 86400, "30": 30 * 86400, "365": 365 * 86400 };

const DAY = 86400;
const YEAR = 365 * DAY;
const conv = (arr?: [number, number][]) => {
  const seen = new Set<number>();
  return (arr ?? [])
    .map(([ms, v]) => ({ time: Math.floor(ms / 1000) as UTCTimestamp, value: v }))
    .filter((p) => p.value > 0 && !seen.has(p.time) && (seen.add(p.time), true))
    .sort((a, b) => a.time - b.time);
};
const dedupe = (pts: Pt[]) => {
  const m = new Map<number, Pt>();
  pts.forEach((p) => { if (p.value > 0) m.set(p.time, p); });
  return [...m.values()].sort((a, b) => a.time - b.time);
};

// CoinGecko market_chart — free tier covers the last 365 days only.
async function geckoChart(coin: string, q: string) {
  const id = await getCoinGeckoId(coin);
  if (!id) throw new Error("no id");
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/${q}`);
  if (!res.ok) throw new Error(String(res.status));
  const j = (await res.json()) as { prices?: [number, number][]; market_caps?: [number, number][]; total_volumes?: [number, number][] };
  return { price: conv(j.prices), mcap: conv(j.market_caps), vol: conv(j.total_volumes) };
}

// Older price history (free, no key): Bitstamp (BTC daily back to 2011),
// falling back to Binance klines (2017+) for coins Bitstamp doesn't list.
async function bitstamp(coin: string, step: number, from: number, to: number) {
  const price: Pt[] = [], vol: Pt[] = [];
  let start = from;
  for (let i = 0; i < 12 && start < to; i++) {
    const res = await fetch(`https://www.bitstamp.net/api/v2/ohlc/${coin.toLowerCase()}usd/?step=${step}&limit=1000&start=${start}&end=${to}`);
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { data?: { ohlc?: { timestamp: string; close: string; volume: string }[] } };
    const rows = j.data?.ohlc ?? [];
    if (!rows.length) break;
    rows.forEach((r) => {
      const t = +r.timestamp as UTCTimestamp, c = +r.close;
      price.push({ time: t, value: c });
      vol.push({ time: t, value: +r.volume * c });
    });
    const last = +rows[rows.length - 1].timestamp;
    if (last <= start) break;
    start = last + step;
  }
  if (price.length < 2) throw new Error("no bitstamp data");
  return { price: dedupe(price), vol: dedupe(vol) };
}
async function binance(coin: string, step: number, from: number, to: number) {
  const iv = step >= DAY ? "1d" : step >= 14400 ? "4h" : step >= 3600 ? "1h" : "15m";
  const price: Pt[] = [], vol: Pt[] = [];
  let start = from * 1000;
  for (let i = 0; i < 12 && start < to * 1000; i++) {
    const rows = (await fetchBn(`/api/v3/klines?symbol=${coin}USDT&interval=${iv}&limit=1000&startTime=${start}&endTime=${to * 1000}`)) as (string | number)[][];
    if (!Array.isArray(rows) || !rows.length) break;
    rows.forEach((r) => {
      const t = Math.floor(+r[0] / 1000) as UTCTimestamp;
      price.push({ time: t, value: +r[4] });
      vol.push({ time: t, value: +r[7] });
    });
    const last = +rows[rows.length - 1][0];
    if (last <= start) break;
    start = last + 1;
  }
  if (price.length < 2) throw new Error("no binance data");
  return { price: dedupe(price), vol: dedupe(vol) };
}
async function history(coin: string, step: number, from: number, to: number) {
  try { return await bitstamp(coin, step, from, to); } catch { return await binance(coin, step, from, to); }
}

// Window step per range (≈100–400 points each).
const STEP: Record<CmcRange, number> = { "1": 900, "7": 3600, "30": 14400, "365": DAY, "max": DAY };

// `endTs` (unix s): a moment picked on the timeline — the range ending
// there. Without it: the latest range. Price comes from CoinGecko for the
// last year and Bitstamp/Binance before that; market cap only exists for
// the last year (CoinGecko free tier).
async function loadSeries(coin: string, days: CmcRange, endTs: number | null = null): Promise<Series3> {
  const key = `${coin}:${days}:${endTs ?? "now"}`;
  const ttl = endTs ? 3_600_000 : days === "1" ? 60_000 : 600_000;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const now = Math.floor(Date.now() / 1000);
  let data: Series3;
  if (days === "max") {
    // All-time price history; market cap: the last year.
    const [h, g] = await Promise.all([
      history(coin, DAY, 1293840000, now),
      geckoChart(coin, "market_chart?vs_currency=usd&days=365").catch(() => null),
    ]);
    data = { price: h.price, vol: h.vol, mcap: g?.mcap ?? [] };
  } else if (endTs == null) {
    data = await geckoChart(coin, `market_chart?vs_currency=usd&days=${days}`);
  } else {
    const from = endTs - RANGE_SECS[days];
    const inYear = from > now - YEAR + DAY;
    if (inYear) {
      data = await geckoChart(coin, `market_chart/range?vs_currency=usd&from=${from}&to=${endTs}`)
        .catch(async () => ({ ...(await history(coin, STEP[days], from, endTs)), mcap: [] }));
    } else {
      data = { ...(await history(coin, STEP[days], from, endTs)), mcap: [] };
    }
  }
  cache.set(key, { at: Date.now(), data });
  return data;
}
// All-time overview strip (price, daily).
async function loadAllTime(coin: string): Promise<Pt[]> {
  const key = `${coin}:alltime`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.data.price;
  const h = await history(coin, DAY, 1293840000, Math.floor(Date.now() / 1000));
  cache.set(key, { at: Date.now(), data: { price: h.price, vol: h.vol, mcap: [] } });
  return h.price;
}

export function CmcChart({ coin, theme, metric, range, log, onAnalyze }: {
  coin: string;
  theme: "dark" | "light";
  metric: "price" | "mcap";
  range: CmcRange;
  log: boolean;
  onAnalyze?: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const [data, setData] = useState<Series3 | null>(null);
  const [all, setAll] = useState<Pt[] | null>(null);
  const [error, setError] = useState(false);
  const [baseY, setBaseY] = useState<number | null>(null);
  // Plot-area frame (CMC boxes the plot; price + time axes sit outside).
  const [frame, setFrame] = useState<{ right: number; bottom: number } | null>(null);

  // Timeline picker: the moment the shown range ends at (null = now).
  const [endTs, setEndTs] = useState<number | null>(null);
  useEffect(() => { setEndTs(null); }, [coin, range]);

  // Range data (refreshes every minute on a live 24h view).
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    const load = () => loadSeries(coin, range, endTs).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setError(true); });
    load();
    const id = range === "1" && endTs == null ? window.setInterval(load, 60_000) : 0;
    return () => { alive = false; if (id) window.clearInterval(id); };
  }, [coin, range, endTs]);
  // All-time price history for the overview strip.
  useEffect(() => {
    let alive = true;
    setAll(null);
    loadAllTime(coin).then((p) => { if (alive) setAll(p); }).catch(() => {});
    return () => { alive = false; };
  }, [coin]);

  const pts = data ? (metric === "price" ? data.price : data.mcap) : null;
  const base = pts && pts.length ? pts[0].value : null;

  // Main chart.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !pts || pts.length < 2 || base == null) return;
    const light = theme === "light";
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: light ? "#616e85" : "#a1a7bb",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "transparent" },
        horzLines: { color: light ? "rgba(15,23,42,0.035)" : "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: {
        borderColor: "transparent",
        mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
        scaleMargins: { top: 0.08, bottom: 0.16 },
      },
      timeScale: {
        borderColor: "transparent",
        timeVisible: range === "1" || range === "7",
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: tickFmt,
      },
      crosshair: {
        vertLine: { color: light ? "rgba(15,23,42,0.25)" : "rgba(255,255,255,0.25)", style: LineStyle.Dashed, labelBackgroundColor: light ? "#58667e" : "#323546" },
        horzLine: { color: light ? "rgba(15,23,42,0.25)" : "rgba(255,255,255,0.25)", style: LineStyle.Dashed, labelBackgroundColor: light ? "#58667e" : "#323546" },
      },
      localization: { priceFormatter: (v: number) => (metric === "price" && v < 1 ? v.toPrecision(4) : compact(v)) },
      handleScroll: false,
      handleScale: false,
    });
    const series = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: base },
      topLineColor: UP,
      topFillColor1: "rgba(22,199,132,0.28)",
      topFillColor2: "rgba(22,199,132,0.03)",
      bottomLineColor: DN,
      bottomFillColor1: "rgba(234,57,67,0.03)",
      bottomFillColor2: "rgba(234,57,67,0.28)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    series.setData(pts);
    // Dotted opening line.
    series.createPriceLine({ price: base, color: light ? "rgba(97,110,133,0.55)" : "rgba(161,167,187,0.45)", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false });
    // Volume bars along the bottom.
    if (data && data.vol.length) {
      const vol = chart.addSeries(HistogramSeries, {
        priceScaleId: "vol",
        priceFormat: { type: "volume" },
        color: light ? "rgba(207,214,228,0.75)" : "rgba(255,255,255,0.1)",
        lastValueVisible: false,
        priceLineVisible: false,
      });
      // Light-gray band along the bottom of the plot (CMC).
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
      const first = pts[0].time;
      vol.setData(data.vol.filter((v) => v.time >= first));
    }
    chart.timeScale().fitContent();
    chartRef.current = chart;
    seriesRef.current = series;
    // Keep the left "opening value" label on its line.
    const place = () => {
      setBaseY(series.priceToCoordinate(base));
      setFrame({ right: chart.priceScale("right").width(), bottom: chart.timeScale().height() });
    };
    place();
    const ro = new ResizeObserver(() => requestAnimationFrame(place));
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [pts, base, theme, log, range, metric, data]);

  // Overview strip (all-time, non-interactive).
  useEffect(() => {
    const el = navRef.current;
    // Price history shapes the strip for both metrics (it's a time picker).
    const ap = all;
    if (!el || !ap || ap.length < 2) return;
    const light = theme === "light";
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: light ? "#616e85" : "#a1a7bb", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: light ? "rgba(15,23,42,0.05)" : "rgba(255,255,255,0.05)" }, horzLines: { color: "transparent" } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { borderColor: "transparent", fixLeftEdge: true, fixRightEdge: true, tickMarkFormatter: tickFmt },
      crosshair: { vertLine: { visible: false, labelVisible: false }, horzLine: { visible: false, labelVisible: false } },
      handleScroll: false,
      handleScale: false,
    });
    const s = chart.addSeries(AreaSeries, {
      lineColor: light ? "rgba(97,110,133,0.35)" : "rgba(161,167,187,0.3)",
      topColor: light ? "rgba(97,110,133,0.16)" : "rgba(161,167,187,0.14)",
      bottomColor: "rgba(0,0,0,0)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    s.setData(ap);
    chart.timeScale().fitContent();
    navChartRef.current = chart;
    navFirstRef.current = ap[0].time;
    navLastRef.current = ap[ap.length - 1].time;
    const ro = new ResizeObserver(() => requestAnimationFrame(() => setNavTick((n) => n + 1)));
    ro.observe(el);
    requestAnimationFrame(() => setNavTick((n) => n + 1));
    return () => { ro.disconnect(); chart.remove(); navChartRef.current = null; };
  }, [all, metric, theme]);

  // ── Timeline picker geometry: time ⇄ x on the overview strip ──
  const navChartRef = useRef<IChartApi | null>(null);
  const navFirstRef = useRef(0);
  const navLastRef = useRef(0);
  const [navTick, setNavTick] = useState(0);
  const [dragX, setDragX] = useState<number | null>(null);
  const timeToX = (t: number) => {
    const c = navChartRef.current;
    if (!c) return null;
    const first = navFirstRef.current, last = navLastRef.current;
    const clamped = Math.min(last, Math.max(first, t));
    const x = c.timeScale().timeToCoordinate(clamped as UTCTimestamp);
    if (x != null) return x;
    // Between data points: interpolate across the strip width.
    const w = navRef.current?.clientWidth ?? 0;
    return last > first ? ((clamped - first) / (last - first)) * w : null;
  };
  const xToTime = (x: number) => {
    const first = navFirstRef.current, last = navLastRef.current;
    const w = navRef.current?.clientWidth ?? 1;
    return Math.round(first + (Math.min(w, Math.max(0, x)) / w) * (last - first));
  };
  const nowTs = Math.floor(Date.now() / 1000);
  const shownEnd = endTs ?? nowTs;
  const span = range === "max" ? 0 : RANGE_SECS[range];
  void navTick; // re-render when the strip resizes / redraws
  const handleX = range === "max" ? null : dragX ?? timeToX(shownEnd);
  const bandL = range === "max" || handleX == null ? null : timeToX(shownEnd - span);
  const pickAt = (x: number) => {
    const t = xToTime(x);
    const w = navRef.current?.clientWidth ?? 1;
    // Released at the far right → back to live.
    setEndTs(x >= w - 6 || t >= nowTs - 3600 ? null : Math.max(t, navFirstRef.current + span));
  };
  const onNavDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (range === "max") return;
    const box = e.currentTarget.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragX(e.clientX - box.left);
  };
  const onNavMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragX == null) return;
    const box = e.currentTarget.getBoundingClientRect();
    setDragX(Math.min(box.width, Math.max(0, e.clientX - box.left)));
  };
  const onNavUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragX == null) return;
    const box = e.currentTarget.getBoundingClientRect();
    pickAt(Math.min(box.width, Math.max(0, e.clientX - box.left)));
    setDragX(null);
  };
  const pickedLabel = endTs
    ? new Date(endTs * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })
    : null;

  return (
    <div className="cmcc">
      <div className="cmcc-main">
        {error ? (
          <div className="cmcc-msg">Couldn't load the chart right now.</div>
        ) : !pts ? (
          <div className="cmcc-msg"><span className="cmcc-spin" aria-hidden="true" />Loading…</div>
        ) : pts.length < 2 ? (
          <div className="cmcc-msg">
            {metric === "mcap" ? "Market cap history only goes back one year — pick a later date or switch to Price." : "No data for this period."}
          </div>
        ) : null}
        <div ref={boxRef} className="cmcc-box" />
        {frame && pts && (
          <span className="cmcc-frame" aria-hidden="true" style={{ right: frame.right, bottom: frame.bottom }} />
        )}
        {base != null && baseY != null && pts && (
          <span className="cmcc-base" style={{ top: baseY }}>{compact(base)}</span>
        )}
        {pts && (
          <span className="cmcc-mark" aria-hidden="true" style={frame ? { right: frame.right + 14, bottom: frame.bottom + 44 } : undefined}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M15.5 9a4 4 0 1 0 0 6" /></svg>
            coinhintz
          </span>
        )}
        <span className="cmcc-usd" style={frame ? { bottom: frame.bottom + 4 } : undefined}>USD</span>
      </div>
      <div className="cmcc-foot">
        <div ref={navRef} className="cmcc-nav" />
        <span className="cmcc-nav-frame" aria-hidden="true" />
        {/* Timeline picker: drag the handle (or click the strip) to view that
            moment; release at the far right to go back to live. */}
        <div
          className={`cmcc-nav-hit${range === "max" ? " cmcc-nav-hit--off" : ""}${dragX != null ? " cmcc-nav-hit--drag" : ""}`}
          onPointerDown={onNavDown}
          onPointerMove={onNavMove}
          onPointerUp={onNavUp}
          onPointerCancel={() => setDragX(null)}
          onDoubleClick={() => setEndTs(null)}
          role="slider"
          aria-label="Pick a point in time"
          aria-valuemin={navFirstRef.current}
          aria-valuemax={navLastRef.current}
          aria-valuenow={shownEnd}
          aria-valuetext={pickedLabel ?? "Now"}
          tabIndex={range === "max" ? -1 : 0}
          onKeyDown={(e) => {
            if (range === "max") return;
            const step = Math.max(span, 86400);
            if (e.key === "ArrowLeft") setEndTs(Math.max(navFirstRef.current + span, shownEnd - step));
            if (e.key === "ArrowRight") setEndTs(shownEnd + step >= nowTs ? null : shownEnd + step);
            if (e.key === "End") setEndTs(null);
          }}
        >
          {handleX != null && bandL != null && handleX - bandL > 3 && (
            <span className="cmcc-nav-band" style={{ left: bandL, width: handleX - bandL }} />
          )}
          {handleX != null && <span className="cmcc-nav-handle" style={{ left: handleX }} />}
        </div>
        {pickedLabel && (
          <button type="button" className="cmcc-live" onClick={() => setEndTs(null)}>
            {pickedLabel} · Back to now
          </button>
        )}
        {onAnalyze && (
          <button type="button" className="cmcc-analyze" onClick={onAnalyze}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></svg>
            Analyze Chart
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
