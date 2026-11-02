// Trade page (#trade) section tabs under the coin header, TradingView-style:
// Overview (the chart page itself) · News · Technicals · Seasonals ·
// Markets · Fundamentals. Everything except Overview
// renders its own panel in place of the chart (the chart stays mounted).
import { useEffect, useMemo, useState } from "react";
import { coinglass, fetchBn, getCoinGeckoId, COINS, type CandleDataPoint } from "../services/coinglass";
import { calcEMA, calcRSIArray } from "../services/indicators";
import { fetchBrief, type BriefItem } from "./DailyBrief";
import "../styles/CoinPageTabs.css";

export type CoinPageTab = "overview" | "news" | "technicals" | "seasonals" | "markets" | "fundamentals";

export const COIN_PAGE_TABS: { id: CoinPageTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "news", label: "News" },
  { id: "technicals", label: "Technicals" },
  { id: "seasonals", label: "Seasonals" },
  { id: "markets", label: "Markets" },
  { id: "fundamentals", label: "Fundamentals" },
];

const coinName = (sym: string) => COINS.find((c) => c.symbol === sym)?.name ?? sym;

const fmtUsd = (v: number | null | undefined, digits = 2): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: a < 1 ? 6 : digits })}`;
};
const fmtNum = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
};

// ── Tab bar ─────────────────────────────────────────────────────────────
export function CoinPageTabBar({ tab, onChange }: { tab: CoinPageTab; onChange: (t: CoinPageTab) => void }) {
  return (
    <div className="cpt-bar" role="tablist" aria-label="Coin sections">
      {COIN_PAGE_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          className={`cpt-tab${tab === t.id ? " cpt-tab--active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Content ─────────────────────────────────────────────────────────────
export function CoinPageTabContent({ tab, coin }: {
  tab: CoinPageTab;
  coin: string;
  onOpenAuth?: () => void;
  onOpenUpgrade?: (plan?: "pro" | "elite") => void;
}) {
  if (tab === "overview") return null;
  return (
    <div className="cpt-panel" role="tabpanel">
      {tab === "news" && <NewsTab coin={coin} />}
      {tab === "technicals" && <TechnicalsTab coin={coin} />}
      {tab === "seasonals" && <SeasonalsTab coin={coin} />}
      {tab === "markets" && <MarketsTab coin={coin} />}
      {tab === "fundamentals" && <FundamentalsTab coin={coin} />}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="cpt-loading" role="status">
      <span className="cpt-spin" aria-hidden="true" />
      {label}
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="cpt-empty">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

// ── News: latest crypto headlines mentioning this coin ─────────────────
function NewsTab({ coin }: { coin: string }) {
  const [items, setItems] = useState<BriefItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    setItems(null);
    fetchBrief().then((all) => { if (alive) setItems(all); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [coin]);
  const name = coinName(coin);
  const { matched, others } = useMemo(() => {
    const list = (items ?? []).filter((i) => i.category === "crypto");
    const re = new RegExp(`\\b(${coin}|${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`, "i");
    const m = list.filter((i) => re.test(i.title));
    return { matched: m, others: list.filter((i) => !m.includes(i)).slice(0, 12) };
  }, [items, coin, name]);
  if (!items) return <Loading label={`Loading ${name} news…`} />;
  const rows = matched.length ? matched : others;
  if (!rows.length) return <Empty title="No news right now" text="Check back in a bit — headlines refresh every few minutes." />;
  return (
    <div className="cpt-section">
      <h2 className="cpt-h">{matched.length ? `${name} news` : "Latest crypto news"}</h2>
      {!matched.length && <p className="cpt-note">No {name}-specific headlines right now — here's the latest across crypto.</p>}
      <div className="cpt-news">
        {rows.map((n) => (
          <a key={n.url} className="cpt-news-item" href={n.url} target="_blank" rel="noreferrer">
            {n.thumbnail ? <img src={n.thumbnail} alt="" loading="lazy" /> : <span className="cpt-news-thumb" aria-hidden="true" />}
            <span className="cpt-news-text">
              <strong>{n.title}</strong>
              <span>{n.source} · {timeAgo(n.pubDate)}</span>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
function timeAgo(ms: number): string {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ── Technicals: oscillators + moving averages → buy/sell summary ────────
type Signal = "buy" | "sell" | "neutral";
interface TechRow { name: string; value: string; signal: Signal }
interface MaRow extends TechRow { distPct: number }
interface TechData {
  px: number;
  oscillators: TechRow[];
  mas: MaRow[];
  rsi: { v: number | null; series: number[] };
  stoch: { k: number; hi: number; lo: number };
  macd: { line: number | null; signal: number | null; hist: number[] };
  mom: { pct: number; closes: number[] };
}
const SPARK_N = 48;
const sigOf = (px: number, lvl: number): Signal => (px > lvl ? "buy" : px < lvl ? "sell" : "neutral");
function technicalsFor(c: CandleDataPoint[]): TechData {
  const close = c.map((x) => x.close);
  const px = close[close.length - 1];
  // RSI (14) history
  const rsiSeries = calcRSIArray(c).slice(-SPARK_N).filter((v): v is number => v !== null);
  const rsi = rsiSeries.length ? rsiSeries[rsiSeries.length - 1] : null;
  // Stochastic %K(14)
  const last14 = c.slice(-14);
  const hi = Math.max(...last14.map((x) => x.high)), lo = Math.min(...last14.map((x) => x.low));
  const k = hi > lo ? ((px - lo) / (hi - lo)) * 100 : 50;
  // MACD (12, 26, 9) history for the histogram
  const e12 = calcEMA(close, 12), e26 = calcEMA(close, 26);
  const macdArr = close.map((_, i) => e12[i] - e26[i]).filter((v) => Number.isFinite(v));
  const sigArr = calcEMA(macdArr, 9);
  const hist = macdArr.map((v, i) => v - sigArr[i]).filter((v) => Number.isFinite(v)).slice(-SPARK_N);
  const macdLine = macdArr.length ? macdArr[macdArr.length - 1] : null;
  const lastSig = sigArr[sigArr.length - 1];
  const macdSig = Number.isFinite(lastSig) ? lastSig : null;
  // Momentum (10) as % change
  const ref = close.length > 10 ? close[close.length - 11] : px;
  const momPct = ref ? ((px - ref) / ref) * 100 : 0;
  const oscillators: TechRow[] = [
    { name: "RSI (14)", value: rsi === null ? "—" : rsi.toFixed(1), signal: rsi === null ? "neutral" : rsi < 30 ? "buy" : rsi > 70 ? "sell" : rsi > 55 ? "buy" : rsi < 45 ? "sell" : "neutral" },
    { name: "Stochastic %K (14)", value: k.toFixed(1), signal: k < 20 ? "buy" : k > 80 ? "sell" : "neutral" },
    { name: "MACD (12, 26)", value: macdLine === null ? "—" : macdLine.toFixed(2), signal: macdLine === null || macdSig === null ? "neutral" : macdLine > macdSig ? "buy" : "sell" },
    { name: "Momentum (10)", value: `${momPct >= 0 ? "+" : ""}${momPct.toFixed(2)}%`, signal: momPct > 0 ? "buy" : momPct < 0 ? "sell" : "neutral" },
  ];
  const mas: MaRow[] = [10, 20, 30, 50, 100, 200].flatMap((n) => {
    if (close.length < n) return [];
    const ema = calcEMA(close, n);
    const e = ema[ema.length - 1];
    const sma = close.slice(-n).reduce((a, b) => a + b, 0) / n;
    return [
      { name: `EMA (${n})`, value: fmtUsd(e), signal: sigOf(px, e), distPct: ((px - e) / e) * 100 },
      { name: `SMA (${n})`, value: fmtUsd(sma), signal: sigOf(px, sma), distPct: ((px - sma) / sma) * 100 },
    ];
  });
  return {
    px, oscillators, mas,
    rsi: { v: rsi, series: rsiSeries },
    stoch: { k, hi, lo },
    macd: { line: macdLine, signal: macdSig, hist },
    mom: { pct: momPct, closes: close.slice(-SPARK_N) },
  };
}
function verdictOf(rows: TechRow[]) {
  const b = rows.filter((r) => r.signal === "buy").length;
  const s = rows.filter((r) => r.signal === "sell").length;
  const n = rows.length - b - s;
  const score = rows.length ? (b - s) / rows.length : 0; // -1 … 1
  const label = score > 0.5 ? "Strong buy" : score > 0.1 ? "Buy" : score < -0.5 ? "Strong sell" : score < -0.1 ? "Sell" : "Neutral";
  return { b, s, n, score, label };
}
const toneOfScore = (score: number): Signal => (score > 0.1 ? "buy" : score < -0.1 ? "sell" : "neutral");
const sigLabel = (s: Signal) => (s === "buy" ? "Buy" : s === "sell" ? "Sell" : "Neutral");

// Overall verdict on a 5-step sell→buy scale, a plain-language read, and
// a sell/neutral/buy split for each indicator group.
function TechSummary({ data }: { data: TechData }) {
  const all = verdictOf([...data.oscillators, ...data.mas]);
  const pos = ((all.score + 1) / 2) * 100;
  const above = data.mas.filter((m) => m.signal === "buy").length;
  const below = data.mas.filter((m) => m.signal === "sell").length;
  const r = data.rsi.v;
  const rsiWord = r === null ? "unavailable" : r < 30 ? `oversold (${r.toFixed(0)})` : r > 70 ? `overbought (${r.toFixed(0)})` : `neutral (${r.toFixed(0)})`;
  const macdWord = data.macd.line === null || data.macd.signal === null ? "" : data.macd.line > data.macd.signal ? " and MACD is above its signal line" : " and MACD is below its signal line";
  const maWord = above >= below ? `above ${above} of ${data.mas.length}` : `below ${below} of ${data.mas.length}`;
  return (
    <div className="tch-hero">
      <div className="tch-hero-main">
        <span className="tch-kicker">Overall signal</span>
        <strong className={`tch-verdict cpt-tone--${toneOfScore(all.score)}`}>{all.label}</strong>
        <p className="tch-read">
          Price is {maWord} moving averages, RSI is {rsiWord}{macdWord}. Momentum is {data.mom.pct >= 0 ? "up" : "down"} {Math.abs(data.mom.pct).toFixed(1)}% over 10 bars.
        </p>
      </div>
      <div className="tch-hero-side">
        <div className="tch-scale" aria-label={`Overall: ${all.label}`}>
          <div className="tch-scale-track">
            <span className="tch-scale-seg tch-scale-seg--ss" />
            <span className="tch-scale-seg tch-scale-seg--s" />
            <span className="tch-scale-seg tch-scale-seg--n" />
            <span className="tch-scale-seg tch-scale-seg--b" />
            <span className="tch-scale-seg tch-scale-seg--bb" />
            <span className="tch-scale-marker" style={{ left: `${pos}%` }} />
          </div>
          <div className="tch-scale-labels">
            <span>Strong sell</span><span>Sell</span><span>Neutral</span><span>Buy</span><span>Strong buy</span>
          </div>
        </div>
        <TechSplit title="Oscillators" rows={data.oscillators} />
        <TechSplit title="Moving averages" rows={data.mas} />
      </div>
    </div>
  );
}
function TechSplit({ title, rows }: { title: string; rows: TechRow[] }) {
  const v = verdictOf(rows);
  const t = rows.length || 1;
  return (
    <div className="tch-split">
      <div className="tch-split-head">
        <span>{title}</span>
        <strong className={`cpt-tone--${toneOfScore(v.score)}`}>{v.label}</strong>
      </div>
      <div className="tch-split-bar" aria-hidden="true">
        <span className="tch-split-s" style={{ width: `${(v.s / t) * 100}%` }} />
        <span className="tch-split-n" style={{ width: `${(v.n / t) * 100}%` }} />
        <span className="tch-split-b" style={{ width: `${(v.b / t) * 100}%` }} />
      </div>
      <div className="tch-split-counts">
        <span className="cpt-tone--sell">{v.s} sell</span>
        <span>{v.n} neutral</span>
        <span className="cpt-tone--buy">{v.b} buy</span>
      </div>
    </div>
  );
}

// Tiny line chart. `zones` shade value bands; `lines` draw dashed guides.
function Spark({ values, min, max, cls, zones = [], lines = [], dots = [] }: {
  values: number[]; min?: number; max?: number; cls: string;
  zones?: { from: number; to: number; cls: string }[]; lines?: number[]; dots?: number[];
}) {
  const W = 240, H = 64, P = 4;
  if (values.length < 2) return null;
  const lo = min ?? Math.min(...values), hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => P + (1 - (v - lo) / span) * (H - 2 * P);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="tch-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {zones.map((z) => <rect key={z.cls} x="0" width={W} y={y(z.to)} height={Math.max(0, y(z.from) - y(z.to))} className={z.cls} />)}
      {lines.map((l) => <line key={l} x1="0" x2={W} y1={y(l)} y2={y(l)} className="tch-spark-guide" />)}
      <path d={`${d} L${W} ${H} L0 ${H} Z`} className={`tch-spark-area ${cls}`} />
      <path d={d} className={`tch-spark-line ${cls}`} />
      {dots.map((i) => <circle key={i} cx={x(i)} cy={y(values[i])} r="3.2" className={`tch-spark-dot ${cls}`} />)}
    </svg>
  );
}
function MacdBars({ hist }: { hist: number[] }) {
  const W = 240, H = 64;
  if (!hist.length) return null;
  const m = Math.max(...hist.map(Math.abs)) || 1;
  const bw = W / hist.length;
  return (
    <svg className="tch-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="tch-spark-guide" />
      {hist.map((v, i) => {
        const h = (Math.abs(v) / m) * (H / 2 - 3);
        const prev = i ? hist[i - 1] : v;
        const fading = Math.abs(v) < Math.abs(prev);
        return (
          <rect key={i} x={i * bw + bw * 0.15} width={bw * 0.7} y={v >= 0 ? H / 2 - h : H / 2} height={Math.max(0.5, h)}
            className={`tch-bar tch-bar--${v >= 0 ? "up" : "down"}${fading ? " tch-bar--fade" : ""}`} />
        );
      })}
    </svg>
  );
}
function OscCard({ row, caption, children }: { row: TechRow | undefined; caption: string; children: React.ReactNode }) {
  if (!row) return null;
  return (
    <div className="tch-card">
      <div className="tch-card-head">
        <span className="tch-card-name">{row.name}</span>
        <span className={`tch-chip tch-chip--${row.signal}`}>{sigLabel(row.signal)}</span>
      </div>
      <strong className="tch-card-value">{row.value}</strong>
      <div className="tch-card-viz">{children}</div>
      <p className="tch-card-cap">{caption}</p>
    </div>
  );
}
function Oscillators({ data }: { data: TechData }) {
  const [rsiRow, stochRow, macdRow, momRow] = data.oscillators;
  const r = data.rsi.v;
  const { k, hi, lo } = data.stoch;
  const h = data.macd.hist;
  const hLast = h[h.length - 1] ?? 0, hPrev = h[h.length - 2] ?? hLast;
  const macdCap = hLast >= 0
    ? Math.abs(hLast) >= Math.abs(hPrev) ? "Bullish and strengthening — bars growing above zero." : "Still bullish, but bars are shrinking."
    : Math.abs(hLast) >= Math.abs(hPrev) ? "Bearish and strengthening — bars growing below zero." : "Still bearish, but selling pressure is easing.";
  const closes = data.mom.closes;
  return (
    <div className="tch-cards">
      <OscCard row={rsiRow} caption={r === null ? "Not enough data." : r < 30 ? "Oversold — sellers may be running out of steam." : r > 70 ? "Overbought — buyers may be stretched." : "Between 30 and 70 — no extreme either way."}>
        <Spark values={data.rsi.series} min={0} max={100} cls="tch-c-violet"
          zones={[{ from: 0, to: 30, cls: "tch-zone-buy" }, { from: 70, to: 100, cls: "tch-zone-sell" }]} lines={[30, 70]} dots={[data.rsi.series.length - 1]} />
      </OscCard>
      <OscCard row={stochRow} caption={`Price sits ${k.toFixed(0)}% of the way up its 14-bar range.`}>
        <div className="tch-range">
          <div className="tch-range-track">
            <span className="tch-range-zone tch-range-zone--low" />
            <span className="tch-range-zone tch-range-zone--high" />
            <span className="tch-range-marker" style={{ left: `${Math.min(100, Math.max(0, k))}%` }} />
          </div>
          <div className="tch-range-labels">
            <span>Low {fmtUsd(lo)}</span>
            <span>High {fmtUsd(hi)}</span>
          </div>
        </div>
      </OscCard>
      <OscCard row={macdRow} caption={macdCap}>
        <MacdBars hist={h} />
      </OscCard>
      <OscCard row={momRow} caption={`${data.mom.pct >= 0 ? "Up" : "Down"} ${Math.abs(data.mom.pct).toFixed(2)}% versus 10 bars ago.`}>
        <Spark values={closes} cls={data.mom.pct >= 0 ? "tch-c-up" : "tch-c-down"} dots={closes.length > 10 ? [closes.length - 11, closes.length - 1] : [closes.length - 1]} />
      </OscCard>
    </div>
  );
}
// Price vs each moving average: how far above (green, right) or below
// (red, left) the price sits, in %.
function MaLadder({ px, rows }: { px: number; rows: MaRow[] }) {
  const max = Math.max(0.5, ...rows.map((r) => Math.abs(r.distPct)));
  const above = rows.filter((r) => r.signal === "buy").length;
  return (
    <div className="tch-ma">
      <div className="tch-ma-head">
        <span className="cpt-table-title">Moving averages</span>
        <span className="tch-ma-sub">Price {fmtUsd(px)} is above <b>{above}</b> of {rows.length}</span>
      </div>
      <div className="tch-ma-axis" aria-hidden="true"><span>Price below</span><span>Price above</span></div>
      <div className="tch-ma-list">
        {rows.map((r) => (
          <div key={r.name} className="tch-ma-row">
            <span className="tch-ma-name">{r.name}</span>
            <span className="tch-ma-val">{r.value}</span>
            <div className="tch-ma-bar" aria-hidden="true">
              <span className="tch-ma-mid" />
              <span className={`tch-ma-fill tch-ma-fill--${r.distPct >= 0 ? "up" : "down"}`} style={{ width: `${(Math.abs(r.distPct) / max) * 50}%` }} />
            </div>
            <span className={`tch-ma-pct cpt-tone--${r.signal}`}>{r.distPct >= 0 ? "+" : ""}{r.distPct.toFixed(2)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
const TECH_FRAMES: { id: "1h" | "4h" | "1day" | "1week"; label: string }[] = [
  { id: "1h", label: "1 hour" }, { id: "4h", label: "4 hours" }, { id: "1day", label: "1 day" }, { id: "1week", label: "1 week" },
];
function TechnicalsTab({ coin }: { coin: string }) {
  const [frame, setFrame] = useState<(typeof TECH_FRAMES)[number]["id"]>("1day");
  const [data, setData] = useState<ReturnType<typeof technicalsFor> | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null); setErr(false);
    coinglass.getHistoricalCandles(frame, coin)
      .then((c) => { if (alive) { if (c.length < 30) setErr(true); else setData(technicalsFor(c)); } })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [coin, frame]);
  return (
    <div className="cpt-section">
      <div className="cpt-row-head">
        <h2 className="cpt-h">Technicals · {coinName(coin)}</h2>
        <div className="cpt-seg" role="tablist" aria-label="Timeframe">
          {TECH_FRAMES.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={frame === f.id} className={`cpt-seg-btn${frame === f.id ? " cpt-seg-btn--on" : ""}`} onClick={() => setFrame(f.id)}>{f.label}</button>
          ))}
        </div>
      </div>
      {err ? <Empty title="Not enough data" text="This coin doesn't have enough candles on this timeframe yet." /> : !data ? <Loading label="Reading indicators…" /> : (
        <>
          <TechSummary data={data} />
          <span className="cpt-table-title">Oscillators</span>
          <Oscillators data={data} />
          <MaLadder px={data.px} rows={data.mas} />
          <p className="cpt-note">Indicator readings, not financial advice.</p>
        </>
      )}
    </div>
  );
}

// ── Seasonals: monthly returns by year (heatmap) ───────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function SeasonalsTab({ coin }: { coin: string }) {
  const [grid, setGrid] = useState<Map<number, (number | null)[]> | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setGrid(null); setErr(false);
    fetchBn(`/api/v3/klines?symbol=${coin}USDT&interval=1M&limit=120`)
      .then((rows: unknown[][]) => {
        if (!alive) return;
        const g = new Map<number, (number | null)[]>();
        for (const r of rows) {
          const d = new Date(Number(r[0]));
          const o = Number(r[1]), c = Number(r[4]);
          const y = d.getUTCFullYear();
          if (!g.has(y)) g.set(y, new Array(12).fill(null));
          g.get(y)![d.getUTCMonth()] = o > 0 ? ((c - o) / o) * 100 : null;
        }
        setGrid(g);
      })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [coin]);
  if (err) return <Empty title="No seasonal data" text={`${coinName(coin)} isn't listed on Binance, so we can't build its monthly history.`} />;
  if (!grid) return <Loading label="Building monthly history…" />;
  const years = [...grid.keys()].sort((a, b) => b - a);
  const avg = MONTHS.map((_, m) => {
    const vals = years.map((y) => grid.get(y)![m]).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
  const nowM = new Date().getUTCMonth();
  return (
    <div className="cpt-section">
      <h2 className="cpt-h">Seasonals · {coinName(coin)}</h2>
      <p className="cpt-note">Monthly return (open → close) for each year. This month: <strong>{MONTHS[nowM]}</strong> averaged <strong className={avg[nowM] !== null && avg[nowM]! >= 0 ? "cpt-tone--buy" : "cpt-tone--sell"}>{avg[nowM] === null ? "—" : `${avg[nowM]! >= 0 ? "+" : ""}${avg[nowM]!.toFixed(1)}%`}</strong> historically.</p>
      <div className="cpt-heat-wrap">
        <table className="cpt-heat">
          <thead>
            <tr><th>Year</th>{MONTHS.map((m, i) => <th key={m} className={i === nowM ? "cpt-heat-now" : undefined}>{m}</th>)}</tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr key={y}>
                <th>{y}</th>
                {grid.get(y)!.map((v, i) => (
                  <td key={i} style={heatStyle(v)} className={i === nowM ? "cpt-heat-now" : undefined}>{v === null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}</td>
                ))}
              </tr>
            ))}
            <tr className="cpt-heat-avg">
              <th>Avg</th>
              {avg.map((v, i) => <td key={i} style={heatStyle(v)} className={i === nowM ? "cpt-heat-now" : undefined}>{v === null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
function heatStyle(v: number | null): React.CSSProperties | undefined {
  if (v === null) return undefined;
  const a = Math.min(1, Math.abs(v) / 40) * 0.75 + 0.08;
  return { background: v >= 0 ? `rgba(34, 197, 94, ${a})` : `rgba(239, 68, 68, ${a})` };
}

// ── Markets: where it trades (top pairs by volume) ─────────────────────
interface Ticker { market: { name: string; logo?: string }; base: string; target: string; last: number; converted_volume?: { usd?: number }; trust_score?: string | null; trade_url?: string | null }
function MarketsTab({ coin }: { coin: string }) {
  const [rows, setRows] = useState<Ticker[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setRows(null); setErr(false);
    (async () => {
      const id = await getCoinGeckoId(coin);
      if (!id) throw new Error("no id");
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/tickers?include_exchange_logo=true&order=volume_desc`);
      if (!res.ok) throw new Error("tickers");
      const j = await res.json();
      if (alive) setRows((j.tickers ?? []).slice(0, 25));
    })().catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [coin]);
  if (err) return <Empty title="Markets unavailable" text="Couldn't load exchange data right now. Try again in a minute." />;
  if (!rows) return <Loading label="Finding where it trades…" />;
  return (
    <div className="cpt-section">
      <h2 className="cpt-h">Markets · {coinName(coin)}</h2>
      <div className="cpt-table-wrap cpt-table-wrap--scroll">
        <table className="cpt-table">
          <thead><tr><th>#</th><th>Exchange</th><th>Pair</th><th className="cpt-num">Price</th><th className="cpt-num">24h volume</th><th>Trust</th></tr></thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={`${t.market.name}:${t.base}/${t.target}:${i}`}>
                <td className="cpt-dim">{i + 1}</td>
                <td>
                  <span className="cpt-ex">
                    {t.market.logo && <img src={t.market.logo} alt="" loading="lazy" />}
                    {t.market.name}
                  </span>
                </td>
                <td>{t.trade_url ? <a href={t.trade_url} target="_blank" rel="noreferrer">{t.base}/{t.target}</a> : `${t.base}/${t.target}`}</td>
                <td className="cpt-num">{t.last < 1 ? t.last.toPrecision(4) : t.last.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                <td className="cpt-num">{fmtUsd(t.converted_volume?.usd ?? null)}</td>
                <td><span className={`cpt-trust cpt-trust--${t.trust_score ?? "na"}`} aria-label={`Trust ${t.trust_score ?? "unknown"}`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Fundamentals: supply, valuation, records, about ─────────────────────
interface GeckoCoin {
  name: string;
  market_cap_rank?: number;
  description?: { en?: string };
  links?: { homepage?: string[] };
  market_data?: {
    current_price?: { usd?: number };
    market_cap?: { usd?: number };
    fully_diluted_valuation?: { usd?: number };
    total_volume?: { usd?: number };
    circulating_supply?: number;
    total_supply?: number | null;
    max_supply?: number | null;
    ath?: { usd?: number }; ath_date?: { usd?: string }; ath_change_percentage?: { usd?: number };
    atl?: { usd?: number }; atl_date?: { usd?: string }; atl_change_percentage?: { usd?: number };
  };
}
function FundamentalsTab({ coin }: { coin: string }) {
  const [data, setData] = useState<GeckoCoin | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null); setErr(false);
    (async () => {
      const id = await getCoinGeckoId(coin);
      if (!id) throw new Error("no id");
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`);
      if (!res.ok) throw new Error("coin");
      const j = await res.json();
      if (alive) setData(j);
    })().catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [coin]);
  if (err) return <Empty title="Fundamentals unavailable" text="Couldn't load this coin's data right now. Try again in a minute." />;
  if (!data) return <Loading label="Loading fundamentals…" />;
  const m = data.market_data ?? {};
  const circ = m.circulating_supply ?? null, max = m.max_supply ?? m.total_supply ?? null;
  const pct = circ && max ? Math.min(100, (circ / max) * 100) : null;
  const about = (data.description?.en ?? "").replace(/<[^>]+>/g, "").trim();
  const date = (s?: string) => (s ? new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
  return (
    <div className="cpt-section">
      <h2 className="cpt-h">Fundamentals · {data.name}{data.market_cap_rank ? <span className="cpt-rank">#{data.market_cap_rank}</span> : null}</h2>
      <div className="cpt-stats">
        <Stat label="Market cap" value={fmtUsd(m.market_cap?.usd)} />
        <Stat label="Fully diluted value" value={fmtUsd(m.fully_diluted_valuation?.usd)} />
        <Stat label="24h volume" value={fmtUsd(m.total_volume?.usd)} />
        <Stat label="Volume / market cap" value={m.total_volume?.usd && m.market_cap?.usd ? `${((m.total_volume.usd / m.market_cap.usd) * 100).toFixed(2)}%` : "—"} />
      </div>
      <div className="cpt-supply">
        <div className="cpt-supply-head">
          <span>Circulating supply</span>
          <strong>{fmtNum(circ)} {coin}</strong>
        </div>
        {pct !== null && (
          <>
            <span className="cpt-supply-bar"><span style={{ width: `${pct}%` }} /></span>
            <span className="cpt-supply-sub">{pct.toFixed(1)}% of {m.max_supply ? "max" : "total"} supply ({fmtNum(max)})</span>
          </>
        )}
      </div>
      <div className="cpt-stats">
        <Stat label="All-time high" value={fmtUsd(m.ath?.usd)} sub={`${date(m.ath_date?.usd)} · ${m.ath_change_percentage?.usd?.toFixed(1) ?? "—"}% from ATH`} />
        <Stat label="All-time low" value={fmtUsd(m.atl?.usd)} sub={`${date(m.atl_date?.usd)} · +${m.atl_change_percentage?.usd?.toFixed(0) ?? "—"}% since`} />
      </div>
      {about && (
        <div className="cpt-about">
          <span className="cpt-table-title">About {data.name}</span>
          <p>{about.length > 700 ? `${about.slice(0, 700)}…` : about}</p>
          {data.links?.homepage?.[0] && <a href={data.links.homepage[0]} target="_blank" rel="noreferrer">Official website ↗</a>}
        </div>
      )}
    </div>
  );
}
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="cpt-stat">
      <span className="cpt-stat-label">{label}</span>
      <strong className="cpt-stat-value">{value}</strong>
      {sub && <span className="cpt-stat-sub">{sub}</span>}
    </div>
  );
}

