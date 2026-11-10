import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, LineSeries, LineStyle, PriceScaleMode, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { coinglass, COINS, fetchCoin24hTickers, type Ticker24h } from "../services/coinglass";
import type { TimeInterval } from "./PriceChart";
import "../styles/PeerCompare.css";

// Chart page: "Peers for comparison" — a row of peer coins (live price, 24h
// change) you can tick to overlay on a % comparison chart against the coin
// you're viewing, like TradingView's compare. Tapping a card (or its ⊕)
// adds/removes it from the comparison; it never changes the main chart.

interface Props {
  coin: string;
  theme?: "dark" | "light";
}

const MAX_SELECTED = 4;
const PEER_COUNT = 12;
const MAIN_COLOR = "#2962ff";
const PEER_COLORS = ["#16a34a", "#f59e0b", "#a855f7", "#ec4899"];
const NO_SPOT = new Set(["HYPE", "GRASS"]);   // no Binance spot pair → no candles/ticker

const RANGES: Array<{ key: string; label: string; interval: TimeInterval; span: number }> = [
  { key: "1D", label: "1D", interval: "5min", span: 86_400 },
  { key: "1W", label: "1W", interval: "1h", span: 7 * 86_400 },
  { key: "1M", label: "1M", interval: "4h", span: 30 * 86_400 },
  { key: "3M", label: "3M", interval: "1day", span: 90 * 86_400 },
  { key: "1Y", label: "1Y", interval: "1day", span: 365 * 86_400 },
];

const logo = (s: string) => `https://assets.coincap.io/assets/icons/${s.toLowerCase()}@2x.png`;
const fmtPrice = (p: number) =>
  p.toLocaleString("en-US", { minimumFractionDigits: p >= 1000 ? 2 : p >= 1 ? 4 : 6, maximumFractionDigits: p >= 1000 ? 2 : p >= 1 ? 4 : 6 });
const fmtPct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

function CoinLogo({ symbol }: { symbol: string }) {
  const [err, setErr] = useState(false);
  return err
    ? <span className="pc-logo pc-logo--fallback">{symbol[0]}</span>
    : <img className="pc-logo" src={logo(symbol)} alt="" onError={() => setErr(true)} />;
}

/** Price with the digits that just changed tinted (like a ticking quote). */
function TickPrice({ price }: { price: number }) {
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<{ from: number; dir: "up" | "down" } | null>(null);
  const text = fmtPrice(price);
  useEffect(() => {
    const p = prev.current;
    prev.current = price;
    if (p == null || p === price) return;
    const a = fmtPrice(p);
    let i = 0;
    while (i < text.length && a[i] === text[i]) i++;
    setFlash({ from: i, dir: price > p ? "up" : "down" });
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [price]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!flash) return <>{text}</>;
  return <>{text.slice(0, flash.from)}<span className={`pc-tick pc-tick--${flash.dir}`}>{text.slice(flash.from)}</span></>;
}

export function PeerCompare({ coin, theme = "light" }: Props) {
  const peers = useMemo(
    () => COINS.filter(c => c.symbol !== coin && !NO_SPOT.has(c.symbol)).slice(0, PEER_COUNT),
    [coin],
  );
  const [tickers, setTickers] = useState<Map<string, Ticker24h>>(new Map());
  const [selected, setSelected] = useState<string[]>([]);
  const [range, setRange] = useState(RANGES[0]);
  const rowRef = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: true });

  // New coin → start fresh (its peers differ).
  useEffect(() => { setSelected([]); }, [coin]);

  // Live-ish prices for the cards: 24h tickers, refreshed every 15s
  // (the service caches for a minute, so this is cheap).
  useEffect(() => {
    let alive = true;
    const load = () => fetchCoin24hTickers(COINS).then(m => { if (alive) setTickers(new Map(m)); }).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const toggle = (s: string) =>
    setSelected(cur => cur.includes(s) ? cur.filter(x => x !== s) : cur.length >= MAX_SELECTED ? cur : [...cur, s]);

  const updateEdges = () => {
    const el = rowRef.current;
    if (!el) return;
    setEdge({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => { updateEdges(); }, [peers, tickers]);
  const scrollBy = (dir: 1 | -1) => rowRef.current?.scrollBy({ left: dir * rowRef.current.clientWidth * 0.8, behavior: "smooth" });

  return (
    <section className={`pc pc--${theme}`} aria-label="Peers for comparison">
      <div className="pc-head">
        <h2 className="pc-title">Peers for comparison</h2>
        <button
          type="button"
          className={`pc-head-btn${selected.length ? " pc-head-btn--clear" : ""}`}
          onClick={() => setSelected(selected.length ? [] : peers.slice(0, 2).map(p => p.symbol))}
        >
          {selected.length ? "✕ Clear comparison" : "⊕ Select to compare"}
        </button>
      </div>

      <div className="pc-row-wrap">
        {edge.left && <button type="button" className="pc-arrow pc-arrow--left" aria-label="Scroll left" onClick={() => scrollBy(-1)}>‹</button>}
        <div className="pc-row" ref={rowRef} onScroll={updateEdges}>
          {peers.map(p => {
            const t = tickers.get(p.symbol);
            const on = selected.includes(p.symbol);
            const color = on ? PEER_COLORS[selected.indexOf(p.symbol)] : undefined;
            const full = !on && selected.length >= MAX_SELECTED;
            return (
              <div
                key={p.symbol}
                className={`pc-card${on ? " pc-card--on" : ""}${full ? " pc-card--full" : ""}`}
                style={color ? ({ "--pc-c": color } as React.CSSProperties) : undefined}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                // Card and ⊕ do the same thing: add/remove it from the
                // comparison (never switch the main chart's coin).
                onClick={() => { if (!full) toggle(p.symbol); }}
                onKeyDown={e => { if ((e.key === "Enter" || e.key === " ") && !full) { e.preventDefault(); toggle(p.symbol); } }}
              >
                <div className="pc-card-top">
                  <CoinLogo symbol={p.symbol} />
                  <div className="pc-card-id">
                    <span className="pc-card-sym">{p.symbol}USD</span>
                    <span className="pc-card-name">{p.name}</span>
                  </div>
                  <button
                    type="button"
                    className={`pc-toggle${on ? " pc-toggle--on" : ""}`}
                    aria-pressed={on}
                    disabled={full}
                    title={full ? `Up to ${MAX_SELECTED} coins` : on ? "Remove from comparison" : "Add to comparison"}
                    onClick={e => { e.stopPropagation(); toggle(p.symbol); }}
                  >
                    {on ? "✓" : "+"}
                  </button>
                </div>
                <div className="pc-card-price">
                  {t ? <><TickPrice price={t.price} /><span className="pc-ccy">USD</span></> : <span className="pc-skel" />}
                </div>
                <div className={`pc-card-chg${t ? (t.change >= 0 ? " up" : " down") : ""}`}>{t ? fmtPct(t.change) : " "}</div>
              </div>
            );
          })}
        </div>
        {edge.right && <button type="button" className="pc-arrow pc-arrow--right" aria-label="Scroll right" onClick={() => scrollBy(1)}>›</button>}
      </div>

      {selected.length > 0 && (
        <CompareChart coin={coin} peers={selected} range={range} theme={theme}>
          <div className="pc-ranges" role="tablist" aria-label="Comparison range">
            {RANGES.map(r => (
              <button key={r.key} type="button" role="tab" aria-selected={r.key === range.key}
                className={`pc-range${r.key === range.key ? " on" : ""}`} onClick={() => setRange(r)}>{r.label}</button>
            ))}
          </div>
        </CompareChart>
      )}
    </section>
  );
}

// ── Comparison chart ─────────────────────────────────────────────────────────
// Every coin as a line in % change from the start of the range (the price
// scale's Percentage mode bases each series on its own first visible value),
// with a legend and last-value tags in each coin's colour.

function CompareChart({ coin, peers, range, theme, children }: {
  coin: string; peers: string[]; range: (typeof RANGES)[number]; theme: "dark" | "light"; children?: React.ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const linesRef = useRef<ISeriesApi<"Line">[]>([]);
  const [legend, setLegend] = useState<Array<{ symbol: string; color: string; pct: number | null }>>([]);
  const [loading, setLoading] = useState(true);
  const coinsKey = [coin, ...peers].join(",");

  // Create the chart once per theme.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const dark = theme === "dark";
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: dark ? "#9ca3af" : "#6b7280", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: dark ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.05)" } },
      rightPriceScale: { mode: PriceScaleMode.Percentage, borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { labelVisible: true }, vertLine: { labelVisible: true } },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; linesRef.current = []; };
  }, [theme]);

  // (Re)load lines when the coins or range change.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let cancelled = false;
    setLoading(true);
    const symbols = coinsKey.split(",");
    Promise.all(symbols.map(s => coinglass.getHistoricalCandles(range.interval, s, range.span).catch(() => [])))
      .then(all => {
        if (cancelled || chartRef.current !== chart) return;
        // Drop old lines.
        linesRef.current.forEach(s => { try { chart.removeSeries(s); } catch { /* gone */ } });
        const made: ISeriesApi<"Line">[] = [];
        const from = Math.floor(Date.now() / 1000) - range.span;
        const leg: typeof legend = [];
        symbols.forEach((s, i) => {
          const color = i === 0 ? MAIN_COLOR : PEER_COLORS[i - 1];
          const pts = all[i].filter(c => (c.time as number) >= from).map(c => ({ time: c.time as UTCTimestamp, value: c.close }));
          const line = chart.addSeries(LineSeries, {
            color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
            crosshairMarkerRadius: 3,
          });
          line.setData(pts);
          // Dotted 0% line, drawn once on the main coin (its first value).
          if (i === 0 && pts.length) line.createPriceLine({ price: pts[0].value, color: "rgba(148,163,184,0.7)", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" });
          made.push(line);
          leg.push({ symbol: s, color, pct: pts.length > 1 ? (pts[pts.length - 1].value / pts[0].value - 1) * 100 : null });
        });
        linesRef.current = made;
        chart.timeScale().fitContent();
        setLegend(leg);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [coinsKey, range, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="pc-chart">
      <div className="pc-chart-bar">
        <div className="pc-legend">
          {legend.map(l => (
            <span key={l.symbol} className="pc-legend-item">
              <CoinLogo symbol={l.symbol} />
              <b>{l.symbol}USD</b>
              <i style={{ color: l.pct == null ? undefined : l.pct >= 0 ? "#16a34a" : "#dc2626" }}>{l.pct == null ? "—" : fmtPct(l.pct)}</i>
              <em style={{ background: l.color }} />
            </span>
          ))}
        </div>
        {children}
      </div>
      <div className="pc-chart-box" ref={boxRef}>
        {loading && <div className="pc-chart-loading">Loading…</div>}
      </div>
    </div>
  );
}
