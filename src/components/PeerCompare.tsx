import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  /** "page" = the section on the chart page (desktop only); "sheet" = inside
   *  the phone chart's Compare bottom sheet (the sheet shows the title). */
  variant?: "page" | "sheet";
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
  "$" + p.toLocaleString("en-US", { minimumFractionDigits: p >= 1000 ? 0 : p >= 1 ? 2 : 4, maximumFractionDigits: p >= 1000 ? 0 : p >= 1 ? 2 : 4 });
const fmtPct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

function CoinLogo({ symbol }: { symbol: string }) {
  const [err, setErr] = useState(false);
  return err
    ? <span className="pc-logo pc-logo--fallback">{symbol[0]}</span>
    : <img className="pc-logo" src={logo(symbol)} alt="" onError={() => setErr(true)} />;
}

export function PeerCompare({ coin, theme = "light", variant = "page" }: Props) {
  const { t } = useTranslation();
  const peers = useMemo(
    () => COINS.filter(c => c.symbol !== coin && !NO_SPOT.has(c.symbol)).slice(0, PEER_COUNT),
    [coin],
  );
  const [tickers, setTickers] = useState<Map<string, Ticker24h>>(new Map());
  const [selected, setSelected] = useState<string[]>([]);
  const [range, setRange] = useState(RANGES[0]);
  const coinChange = tickers.get(coin)?.change;

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

  return (
    <section className={`pc pc--${theme} pc--${variant}`} aria-label={t("peerCompare.title")}>
      <div className="pc-head">
        <div className="pc-head-text">
          {variant === "page" && <h2 className="pc-title">{t("peerCompare.title")}</h2>}
          <span className="pc-hint">{t("peerCompare.hint", { n: MAX_SELECTED, coin })}</span>
        </div>
        <button
          type="button"
          className={`pc-head-btn${selected.length ? " pc-head-btn--clear" : ""}`}
          onClick={() => setSelected(selected.length ? [] : peers.slice(0, 2).map(p => p.symbol))}
        >
          {selected.length ? `✕ ${t("peerCompare.clear")}` : `⊕ ${t("peerCompare.select")}`}
        </button>
      </div>

      {/* One horizontally scrolling row of checkbox pills: ☐ · logo · ticker
          · price · 24h %. Tap to add/remove from the comparison (a picked pill
          ticks its box in the line colour) — never switches the main chart. */}
      <div className="pc-chips" role="group" aria-label={t("peerCompare.title")}>
        {peers.map(p => {
          const tk = tickers.get(p.symbol);
          const on = selected.includes(p.symbol);
          const color = on ? PEER_COLORS[selected.indexOf(p.symbol)] : undefined;
          const full = !on && selected.length >= MAX_SELECTED;
          const rel = tk && coinChange != null ? tk.change - coinChange : null;
          return (
            <button
              key={p.symbol}
              type="button"
              className={`pc-chip${on ? " pc-chip--on" : ""}`}
              style={color ? ({ "--pc-c": color } as React.CSSProperties) : undefined}
              aria-pressed={on}
              disabled={full}
              title={full ? t("peerCompare.maxCoins", { n: MAX_SELECTED })
                : `${p.name}${rel == null ? "" : ` · ${t("peerCompare.vs", { pct: fmtPct(rel), coin })}`}`}
              onClick={() => toggle(p.symbol)}
            >
              {/* Mini card: ☐ logo TICKER / price / 24h % */}
              <span className="pc-chip-top">
                <CoinLogo symbol={p.symbol} />
                <b>{p.symbol}</b>
                <span className="pc-chip-box" aria-hidden="true">
                  {on && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}
                </span>
              </span>
              <span className="pc-chip-price">{tk ? fmtPrice(tk.price) : "—"}</span>
              <span className={`pc-chip-chg${tk ? (tk.change >= 0 ? " up" : " down") : ""}`}>{tk ? fmtPct(tk.change) : "—"}</span>
            </button>
          );
        })}
      </div>

      {/* Sheet: the chart shows straight away with the current coin, and
          each peer picked is added as another line. Page: only once a peer
          is picked (the main chart already shows the coin). */}
      {(selected.length > 0 || variant === "sheet") && (
        <CompareChart coin={coin} peers={selected} range={range} theme={theme}>
          <div className="pc-ranges" role="tablist" aria-label={t("peerCompare.rangeAria")}>
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
  const { t } = useTranslation();
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
        {loading && <div className="pc-chart-loading">{t("peerCompare.loading")}</div>}
      </div>
    </div>
  );
}
