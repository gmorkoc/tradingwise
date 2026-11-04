// Desktop chart page: CoinMarketCap-style line chart (Price or Market cap).
// Green above the range's opening value, red below (a baseline chart),
// dotted opening line with its value on the left, volume bars underneath,
// a faint coinhintz watermark, and an all-time overview strip below.
// Data: CoinGecko market_chart (prices / market caps / volumes).
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createChart, ColorType, BaselineSeries, HistogramSeries, AreaSeries, LineStyle, PriceScaleMode, TickMarkType,
  type IChartApi, type ISeriesApi, type UTCTimestamp, type Time,
} from "lightweight-charts";

// Axis labels like CMC: "2:00 AM", "4 Nov", "Jan", "2024".
// Year / month / day marks sit on UTC midnights — read them in UTC, or
// west-of-UTC viewers see "Dec 31" and every year labelled one early.
// Clock times stay local.
const tickFmt = (time: Time, type: TickMarkType) => {
  const d = new Date((time as number) * 1000);
  switch (type) {
    case TickMarkType.Year: return String(d.getUTCFullYear());
    case TickMarkType.Month: return d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    case TickMarkType.DayOfMonth: return `${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`;
    default: return d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
  }
};
import { getCoinGeckoId, fetchBn, COINS } from "../services/coinglass";
import { fetchBrief } from "./DailyBrief";
import { getMacroEvents } from "../services/macroEvents";
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
// Bitstamp returns the last `limit` candles up to `end` (it ignores `start`
// when `end` is given). Each page's end is known up front, so all pages
// are fetched at once (Bitstamp is slow; one after another took ages).
async function bitstamp(coin: string, step: number, from: number, to: number) {
  const PAGE = 1000 * step;
  const pages = Math.min(12, Math.max(1, Math.ceil((to - from) / PAGE)));
  type Row = { timestamp: string; close: string; volume: string };
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => to - i * PAGE).map(async (end) => {
      const res = await fetch(`https://www.bitstamp.net/api/v2/ohlc/${coin.toLowerCase()}usd/?step=${step}&limit=1000&end=${end}`);
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { data?: { ohlc?: Row[] } };
      return j.data?.ohlc ?? [];
    }),
  );
  const price: Pt[] = [], vol: Pt[] = [];
  results.flat().forEach((r) => {
    const t = +r.timestamp;
    if (t < from || t > to) return;
    const c = +r.close;
    price.push({ time: t as UTCTimestamp, value: c });
    vol.push({ time: t as UTCTimestamp, value: +r.volume * c });
  });
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
// Custom window from the strip's two handles: [from, to] (unix s).
async function loadCustom(coin: string, from: number, to: number): Promise<Series3> {
  const key = `${coin}:custom:${from}:${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.data;
  const now = Math.floor(Date.now() / 1000);
  const span = to - from;
  const step = span <= 2 * DAY ? 900 : span <= 14 * DAY ? 3600 : span <= 90 * DAY ? 14400 : DAY;
  let data: Series3;
  if (from > now - YEAR + DAY) {
    data = await geckoChart(coin, `market_chart/range?vs_currency=usd&from=${from}&to=${to}`)
      .catch(async () => ({ ...(await history(coin, step, from, to)), mcap: [] }));
  } else {
    data = { ...(await history(coin, step, from, to)), mcap: [] };
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

// ── Chart events: what moved the market ─────────────────────────────────
// Milestones: well-known, dated market events (curated). `coins` limits a
// milestone to those coins; without it, it shows on every coin's chart.
// kinds: milestone (curated, blue flag) · news (green page) · macro (US
// economic calendar, amber) · moment (price moments the chart detected:
// breakouts, support/resistance crosses — purple).
type ChartEvent = { t: number; title: string; kind: "milestone" | "news" | "macro" | "moment"; url?: string; source?: string; body?: string };
const MILESTONES: { d: string; title: string; coins?: string[] }[] = [
  { d: "2012-11-28", title: "First Bitcoin halving — block reward cut to 25 BTC", coins: ["BTC"] },
  { d: "2013-11-27", title: "Bitcoin crosses $1,000 for the first time", coins: ["BTC"] },
  { d: "2014-02-24", title: "Mt. Gox goes offline, later files for bankruptcy" },
  { d: "2015-07-30", title: "Ethereum mainnet launches", coins: ["ETH"] },
  { d: "2016-07-09", title: "Second Bitcoin halving — reward cut to 12.5 BTC", coins: ["BTC"] },
  { d: "2016-07-20", title: "Ethereum hard-forks after The DAO hack", coins: ["ETH"] },
  { d: "2017-08-01", title: "Bitcoin Cash splits from Bitcoin", coins: ["BTC"] },
  { d: "2017-12-17", title: "Bitcoin peaks near $20K as CME futures launch" },
  { d: "2020-03-12", title: "COVID \"Black Thursday\" crash" },
  { d: "2020-05-11", title: "Third Bitcoin halving — reward cut to 6.25 BTC", coins: ["BTC"] },
  { d: "2020-12-01", title: "Ethereum Beacon Chain (proof of stake) goes live", coins: ["ETH"] },
  { d: "2021-04-14", title: "Coinbase lists on Nasdaq" },
  { d: "2021-09-07", title: "El Salvador makes Bitcoin legal tender", coins: ["BTC"] },
  { d: "2021-11-10", title: "Bitcoin all-time high near $69K", coins: ["BTC"] },
  { d: "2022-05-09", title: "Terra (LUNA/UST) collapse" },
  { d: "2022-09-15", title: "The Merge — Ethereum moves to proof of stake", coins: ["ETH"] },
  { d: "2022-11-11", title: "FTX files for bankruptcy" },
  { d: "2024-01-10", title: "SEC approves spot Bitcoin ETFs" },
  { d: "2024-03-13", title: "Ethereum Dencun upgrade", coins: ["ETH"] },
  { d: "2024-04-20", title: "Fourth Bitcoin halving — reward cut to 3.125 BTC", coins: ["BTC"] },
  { d: "2024-05-23", title: "SEC approves spot Ether ETF filings", coins: ["ETH"] },
  { d: "2024-11-05", title: "US election — crypto rallies" },
  { d: "2024-12-05", title: "Bitcoin crosses $100K for the first time", coins: ["BTC"] },
  { d: "2025-03-06", title: "US Strategic Bitcoin Reserve order signed" },
  { d: "2025-07-18", title: "GENIUS Act (US stablecoin law) signed" },
  { d: "2025-10-06", title: "Bitcoin all-time high near $126K", coins: ["BTC"] },
  { d: "2025-10-10", title: "Record liquidation cascade hits crypto" },
];
const milestonesFor = (coin: string): ChartEvent[] =>
  MILESTONES.filter((m) => !m.coins || m.coins.includes(coin)).map((m) => ({
    t: Math.floor(Date.parse(`${m.d}T12:00:00Z`) / 1000),
    title: m.title,
    kind: "milestone" as const,
  }));
type Mark = { x: number; y: number; ev: ChartEvent; more: number; stackIdx: number };

// Safety net: a chart-library error (e.g. "_internal_state" during a
// teardown) only blanks this chart with a retry, never the whole page.
class CmcChartBoundary extends Component<{ children: ReactNode; resetKey: string }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() { return { err: true }; }
  componentDidCatch(e: Error) { console.warn("[CmcChart] recovered from chart error:", e.message); }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: false });
  }
  render() {
    if (this.state.err) {
      return (
        <div className="cmcc">
          <div className="cmcc-main">
            <div className="cmcc-msg">
              Chart couldn't load.
              <button type="button" className="cmcc-retry" onClick={() => this.setState({ err: false })}>Retry</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function CmcChart(props: Parameters<typeof CmcChartInner>[0]) {
  return (
    <CmcChartBoundary resetKey={`${props.coin}:${props.range}:${props.metric}:${props.log}`}>
      <CmcChartInner {...props} />
    </CmcChartBoundary>
  );
}

function CmcChartInner({ coin, theme, metric, range, log, onAnalyze, moments }: {
  coin: string;
  /** Price moments the main chart detected (time in unix seconds). */
  moments?: { time: number; title: string; body?: string }[];
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

  // Events on the chart: curated milestones + the coin's recent headlines.
  const [news, setNews] = useState<ChartEvent[]>([]);
  useEffect(() => {
    let alive = true;
    setNews([]);
    const name = COINS.find((c) => c.symbol === coin)?.name ?? coin;
    const re = new RegExp(`\\b(${coin}|${name})\\b`, "i");
    fetchBrief()
      .then((items) => {
        if (!alive) return;
        const crypto = items.filter((i) => i.category === "crypto");
        const about = crypto.filter((i) => re.test(i.title));
        // Few headlines about this coin → add general crypto ones too.
        const pick = about.length >= 4 ? about : [...about, ...crypto.filter((i) => !about.includes(i))];
        setNews(pick
          .slice(0, 14)
          .map((i) => ({ t: Math.floor(i.pubDate / 1000), title: i.title, kind: "news" as const, url: i.url, source: i.source })));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [coin]);
  // US economic calendar (this week's releases that already happened).
  const [macro, setMacro] = useState<ChartEvent[]>([]);
  useEffect(() => {
    let alive = true;
    getMacroEvents()
      .then((evs) => {
        if (!alive) return;
        const now = Date.now();
        setMacro(evs
          .filter((e) => e.time <= now)
          .map((e) => ({
            t: Math.floor(e.time / 1000),
            title: e.title,
            kind: "macro" as const,
            body: [e.forecast && `Forecast ${e.forecast}`, e.previous && `Previous ${e.previous}`].filter(Boolean).join(" · ") || undefined,
          })));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const momentEvents = useMemo<ChartEvent[]>(
    () => (moments ?? []).map((m) => ({ t: m.time > 1e12 ? Math.floor(m.time / 1000) : m.time, title: m.title, body: m.body, kind: "moment" as const })),
    [moments],
  );
  const events = useMemo(() => [...milestonesFor(coin), ...news, ...macro, ...momentEvents], [coin, news, macro, momentEvents]);
  const eventsRef = useRef<ChartEvent[]>(events);
  const placeRef = useRef<(() => void) | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [hover, setHover] = useState<Mark | null>(null);
  useEffect(() => {
    eventsRef.current = events;
    placeRef.current?.();
  }, [events]);

  // Timeline picker: the moment the shown range ends at (null = now).
  const [endTs, setEndTs] = useState<number | null>(null);
  // Left handle on the strip: a custom window start (null = the range's own).
  const [startTs, setStartTs] = useState<number | null>(null);
  useEffect(() => { setEndTs(null); setStartTs(null); }, [coin, range]);

  // Range data (refreshes every minute on a live 24h view).
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    const load = () => {
      // Custom window (left handle moved) → that exact span; "All" keeps
      // the full history and the picked end just trims it locally.
      const p = startTs != null
        ? loadCustom(coin, startTs, endTs ?? Math.floor(Date.now() / 1000))
        : loadSeries(coin, range, range === "max" ? null : endTs);
      return p.then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setError(true); });
    };
    load();
    const id = range === "1" && endTs == null && startTs == null ? window.setInterval(load, 60_000) : 0;
    return () => { alive = false; if (id) window.clearInterval(id); };
  }, [coin, range, range === "max" && startTs == null ? null : endTs, startTs]);
  // All-time price history for the overview strip.
  useEffect(() => {
    let alive = true;
    setAll(null);
    loadAllTime(coin).then((p) => { if (alive) setAll(p); }).catch(() => {});
    return () => { alive = false; };
  }, [coin]);

  // "All" with a picked end: the history up to that moment.
  const pts = useMemo(() => {
    const p = data ? (metric === "price" ? data.price : data.mcap) : null;
    return p && range === "max" && startTs == null && endTs != null ? p.filter((x) => x.time <= endTs) : p;
  }, [data, metric, range, endTs, startTs]);
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
    // Guard: never touch this chart once it's been removed (a pending resize
    // frame or an events update can fire after cleanup — the library then
    // throws "_internal_state" and the whole page crashes).
    let disposed = false;
    const place = () => {
      if (disposed) return;
      try { placeInner(); } catch { /* chart mid-teardown — skip this pass */ }
    };
    const placeInner = () => {
      setBaseY(series.priceToCoordinate(base));
      setFrame({ right: chart.priceScale("right").width(), bottom: chart.timeScale().height() });
      // Event icons: on the line at their time (nearest point), clustered
      // by x — up to 2 stacked, the rest as "+N".
      const evs = eventsRef.current;
      const first = pts[0].time, last = pts[pts.length - 1].time;
      const placed: Mark[] = [];
      const cols: { x: number; marks: Mark[] }[] = [];
      [...evs].filter((e) => e.t >= first && e.t <= last).sort((a, b) => a.t - b.t).forEach((ev) => {
        // nearest data point (binary search)
        let lo = 0, hi = pts.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].time < ev.t) lo = mid + 1; else hi = mid; }
        const p = pts[lo];
        const x = chart.timeScale().timeToCoordinate(p.time);
        const y = series.priceToCoordinate(p.value);
        if (x == null || y == null) return;
        const col = cols.find((c) => Math.abs(c.x - x) < 24);
        if (col) {
          if (col.marks.length < 2) {
            // Stack upward, or downward when there's no room above.
            const up = col.marks[0].y - 26 * col.marks.length;
            const m = { x: col.x, y: up >= 13 ? up : col.marks[0].y + 26 * col.marks.length, ev, more: 0, stackIdx: col.marks.length };
            col.marks.push(m); placed.push(m);
          } else {
            col.marks[col.marks.length - 1].more += 1;
          }
        } else {
          const m = { x, y: Math.max(13, y - 22), ev, more: 0, stackIdx: 0 };
          cols.push({ x, marks: [m] }); placed.push(m);
        }
      });
      setMarks(placed);
    };
    placeRef.current = place;
    place();
    const ro = new ResizeObserver(() => requestAnimationFrame(place));
    ro.observe(el);
    return () => {
      disposed = true;
      if (placeRef.current === place) placeRef.current = null;
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
    return () => {
      ro.disconnect();
      // Drop the ref first so nothing reads the chart after it's removed.
      if (navChartRef.current === chart) navChartRef.current = null;
      chart.remove();
    };
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
    // The strip's chart can be mid-teardown during a re-render — never let
    // that crash the page; fall back to the proportional position.
    let x: number | null = null;
    try { x = c.timeScale().timeToCoordinate(clamped as UTCTimestamp); } catch { x = null; }
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
  // "All": the window runs from the very first day to the handle.
  // Window start: the left handle's custom start, else the range's own
  // ("All": the very first day).
  const winStart = startTs ?? (range === "max" ? navFirstRef.current : shownEnd - RANGE_SECS[range]);
  const span = Math.max(0, shownEnd - winStart);
  const minSpan = range === "max" && startTs == null ? 30 * DAY : startTs != null ? 3600 : span;
  void navTick; // re-render when the strip resizes / redraws
  // Which handle is being dragged: "l" (start) or "r" (end).
  const [dragSide, setDragSide] = useState<"l" | "r">("r");
  const leftX = timeToX(winStart);
  const rightX = timeToX(shownEnd);
  const handleX = dragSide === "r" && dragX != null ? dragX : rightX;
  const bandL = dragSide === "l" && dragX != null ? dragX : leftX;
  const pickAt = (x: number) => {
    const t = xToTime(x);
    const w = navRef.current?.clientWidth ?? 1;
    // Released at the far right → back to live.
    setEndTs(x >= w - 6 || t >= nowTs - 3600 ? null : Math.max(t, navFirstRef.current + minSpan));
  };
  const pickStart = (x: number) => {
    const t = xToTime(x);
    // Left handle all the way left on "All" → back to the full history.
    if (range === "max" && x <= 6) { setStartTs(null); return; }
    setStartTs(Math.min(t, shownEnd - 3600));
  };
  const onNavDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Grab whichever handle is closer (within 14px of the left one → left).
    const side = leftX != null && Math.abs(x - leftX) <= 14 && Math.abs(x - leftX) < Math.abs(x - (rightX ?? Infinity)) ? "l" : "r";
    setDragSide(side);
    setDragX(x);
  };
  const onNavMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragX == null) return;
    const box = e.currentTarget.getBoundingClientRect();
    setDragX(Math.min(box.width, Math.max(0, e.clientX - box.left)));
  };
  const onNavUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragX == null) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = Math.min(box.width, Math.max(0, e.clientX - box.left));
    if (dragSide === "l") pickStart(x); else pickAt(x);
    setDragX(null);
    setDragSide("r");
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
        {/* Event icons: blue flag = market milestone, green page = news. */}
        {pts && pts.length > 1 && marks.map((m) => (
          <span key={`${m.ev.kind}:${m.ev.t}:${m.ev.title}`} className="cmcc-ev-wrap" style={{ left: m.x, top: m.y }}>
            <button
              type="button"
              className={`cmcc-ev cmcc-ev--${m.ev.kind}`}
              aria-label={m.ev.title}
              onMouseEnter={() => setHover(m)}
              onMouseLeave={() => setHover((h) => (h === m ? null : h))}
              onFocus={() => setHover(m)}
              onBlur={() => setHover((h) => (h === m ? null : h))}
              onClick={() => { if (m.ev.url) window.open(m.ev.url, "_blank", "noopener,noreferrer"); }}
            >
              {m.ev.kind === "milestone" ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></svg>
              ) : m.ev.kind === "macro" ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
              ) : m.ev.kind === "moment" ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>
              )}
            </button>
            {m.more > 0 && <span className="cmcc-ev-more">+{m.more}</span>}
          </span>
        ))}
        {hover && (
          <div
            className={`cmcc-ev-tip${hover.x > (boxRef.current?.clientWidth ?? 0) - 260 ? " cmcc-ev-tip--left" : ""}`}
            style={{ left: hover.x, top: hover.y }}
            role="tooltip"
          >
            <span className="cmcc-ev-tip-k">
              {hover.ev.kind === "milestone" ? "Market milestone"
                : hover.ev.kind === "macro" ? "US economic data"
                : hover.ev.kind === "moment" ? "Price moment"
                : hover.ev.source ?? "News"}
              {" · "}
              {new Date(hover.ev.t * 1000).toLocaleString("en-US", range === "1" || range === "7"
                ? { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }
                : { day: "numeric", month: "short", year: "numeric" })}
            </span>
            <span className="cmcc-ev-tip-t">{hover.ev.title}</span>
            {hover.ev.body && <span className="cmcc-ev-tip-b">{hover.ev.body}</span>}
            {hover.ev.url && <span className="cmcc-ev-tip-a">Click to read ›</span>}
          </div>
        )}
        {base != null && baseY != null && pts && (
          <span className="cmcc-base" style={{ top: baseY }}>{compact(base)}</span>
        )}
        <span className="cmcc-usd" style={frame ? { bottom: frame.bottom + 4 } : undefined}>USD</span>
      </div>
      <div className="cmcc-foot">
        <div ref={navRef} className="cmcc-nav" />
        <span className="cmcc-nav-frame" aria-hidden="true" />
        {/* Timeline picker: drag the handle (or click the strip) to view that
            moment; release at the far right to go back to live. */}
        <div
          className={`cmcc-nav-hit${dragX != null ? " cmcc-nav-hit--drag" : ""}`}
          onPointerDown={onNavDown}
          onPointerMove={onNavMove}
          onPointerUp={onNavUp}
          onPointerCancel={() => setDragX(null)}
          onDoubleClick={() => { setEndTs(null); setStartTs(null); }}
          role="slider"
          aria-label="Pick a point in time"
          aria-valuemin={navFirstRef.current}
          aria-valuemax={navLastRef.current}
          aria-valuenow={shownEnd}
          aria-valuetext={pickedLabel ?? "Now"}
          tabIndex={0}
          onKeyDown={(e) => {
            // "All" steps a month at a time; other ranges by their own length.
            const step = range === "max" ? 30 * DAY : Math.max(span, DAY);
            if (e.key === "ArrowLeft") setEndTs(Math.max(navFirstRef.current + minSpan, shownEnd - step));
            if (e.key === "ArrowRight") setEndTs(shownEnd + step >= nowTs ? null : shownEnd + step);
            if (e.key === "End") setEndTs(null);
          }}
        >
          {handleX != null && bandL != null && handleX - bandL > 0 && (
            <span className="cmcc-nav-band" style={{ left: bandL, width: handleX - bandL }} />
          )}
          {/* Two handles (CMC): left = window start, right = window end. */}
          {bandL != null && <span className="cmcc-nav-handle cmcc-nav-handle--l" style={{ left: bandL }} />}
          {handleX != null && <span className="cmcc-nav-handle cmcc-nav-handle--r" style={{ left: handleX }} />}
        </div>
        {(pickedLabel || startTs != null) && (
          <button type="button" className="cmcc-live" onClick={() => { setEndTs(null); setStartTs(null); }}>
            {pickedLabel ?? "Custom range"} · Back to now
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
