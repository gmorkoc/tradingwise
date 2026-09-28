import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { squarify } from "../utils/treemap";
import "../styles/MarketHeatmap.css";

// CoinGecko's multi-period request suffixes every field with
// "_in_currency" (except the bare 24h one, kept for back-compat) once more
// than one period is requested — fetched together in one call so
// switching the interval tab is instant, no refetch.
type Interval = "1h" | "24h" | "7d" | "30d" | "1y";
const INTERVALS: { key: Interval; label: string }[] = [
  { key: "1h", label: "1H" },
  { key: "24h", label: "1D" },
  { key: "7d", label: "1W" },
  { key: "30d", label: "1M" },
  { key: "1y", label: "1Y" },
];

interface CoinRow {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  price_change_percentage_1h_in_currency: number | null;
  price_change_percentage_24h_in_currency: number | null;
  price_change_percentage_7d_in_currency: number | null;
  price_change_percentage_30d_in_currency: number | null;
  price_change_percentage_1y_in_currency: number | null;
  market_cap: number;
  total_volume: number;
}

function changeForInterval(c: CoinRow, interval: Interval): number {
  const map: Record<Interval, number | null> = {
    "1h": c.price_change_percentage_1h_in_currency,
    "24h": c.price_change_percentage_24h_in_currency,
    "7d": c.price_change_percentage_7d_in_currency,
    "30d": c.price_change_percentage_30d_in_currency,
    "1y": c.price_change_percentage_1y_in_currency,
  };
  return map[interval] ?? 0;
}

// CoinGecko's free tier is a shared, fairly low per-minute quota across
// every visitor hitting /gecko-api — a 429 here is normal under any real
// traffic, not a broken integration. 3-minute cache (vs. the 90s other
// panels use) plus a couple of backed-off retries specifically for 429s
// absorbs that instead of surfacing a raw error on the first hiccup.
const TTL = 180_000;
const cache: Record<string, { data: CoinRow[]; ts: number }> = {};
const COIN_COUNT = 120;
const RETRY_DELAYS_MS = [1500, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Straight to CoinGecko, not through /gecko-api — confirmed live that
// CoinGecko blocks that server-side Vercel proxy (403, empty body) while
// happily allowing this exact same request made directly from a real
// browser origin (200, matches GlobalMarkets.tsx's own already-working
// call to the same endpoint). Not a CORS workaround; CoinGecko's own edge
// is what's rejecting Vercel's outbound IP specifically.
async function fetchCoins(): Promise<CoinRow[]> {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${COIN_COUNT}&page=1&price_change_percentage=1h,24h,7d,30d,1y&sparkline=false`;
  const now = Date.now();
  if (cache[url] && now - cache[url].ts < TTL) return cache[url].data;

  let lastStatus = 0;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) {
      const data = await res.json();
      cache[url] = { data, ts: now };
      return data;
    }
    lastStatus = res.status;
    if (res.status !== 429 || attempt === RETRY_DELAYS_MS.length) break;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  // A still-fresh (if stale) cached response beats a hard error after a
  // rate limit — the heatmap just doesn't reflect the last couple minutes.
  if (cache[url]) return cache[url].data;
  throw new Error(`HTTP ${lastStatus}`);
}

// Stablecoins have no meaningful price change — there's nothing for a
// heatmap to actually show for them, so they're left out entirely rather
// than rendering as a permanent flat gray tile.
const STABLECOINS = new Set([
  "USDT", "USDC", "DAI", "BUSD", "TUSD", "USDS", "USD1", "FDUSD", "USDE", "PYUSD", "GUSD", "USDP", "FRAX",
]);

function fmtPrice(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${n.toPrecision(3)}`;
}

function fmtBig(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString()}`;
}

// Continuous red↔green scale by magnitude, clamped at ±8% for full
// saturation — tuned to sit close to CoinMarketCap's own heatmap tones
// (crimson red / medium green) rather than a generic red-green gradient.
function heatColor(change: number): string {
  const intensity = Math.min(Math.abs(change) / 8, 1);
  if (change >= 0) return `hsl(152, 60%, ${38 - intensity * 12}%)`;
  return `hsl(355, 62%, ${48 - intensity * 14}%)`;
}

interface Tile {
  symbol: string; name: string; image: string;
  price: number; change: number; marketCap: number; volume: number; dominance: number;
}
interface HoverState { tile: Tile; x: number; y: number }

export function MarketHeatmap() {
  const { t } = useTranslation();
  const [coins, setCoins] = useState<CoinRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<HoverState | null>(null);
  const [imgError, setImgError] = useState<Set<string>>(new Set());
  const [changeInterval, setChangeInterval] = useState<Interval>("24h");
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchCoins();
      setCoins(data);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = window.setInterval(load, TTL);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Dominance = this coin's share of the total market cap shown in the
  // heatmap (not all of crypto — just the coins actually rendered here),
  // same convention as the reference's per-tile "Dominance : X%". Shared
  // by both layouts below — only the packing algorithm differs.
  const tiles = useMemo(() => {
    const included = coins.filter(c => !STABLECOINS.has(c.symbol.toUpperCase()) && c.market_cap > 0);
    const totalCap = included.reduce((s, c) => s + c.market_cap, 0);
    return included.map((c): Tile => ({
      symbol: c.symbol.toUpperCase(),
      name: c.name,
      image: c.image,
      price: c.current_price,
      change: changeForInterval(c, changeInterval),
      marketCap: c.market_cap,
      volume: c.total_volume,
      dominance: totalCap > 0 ? (c.market_cap / totalCap) * 100 : 0,
    }));
  }, [coins, changeInterval]);

  // Flat treemap, no sector grouping — matches CoinMarketCap's own crypto
  // heatmap (coinmarketcap.com/crypto-heatmap), which this was asked to
  // follow exactly: one squarified layout across every coin.
  //
  // Raw market cap for layout sizing makes BTC ~5000x bigger than the
  // smallest of these 120 coins — squarify would give it a huge chunk of
  // the canvas and reduce most small-caps to sub-pixel slivers. sqrt()
  // compresses that ratio to ~75x, the standard fix for this exact
  // long-tail-visibility problem: BTC still reads as clearly the biggest,
  // but every coin stays a real, visible, labeled cell instead of
  // disappearing.
  const tileRects = useMemo(() => {
    if (size.width < 10 || size.height < 10 || tiles.length === 0) return [];
    return squarify(tiles.map(t => ({ value: Math.sqrt(t.marketCap), item: t })), 0, 0, size.width, size.height);
  }, [tiles, size]);

  return (
    <div className="mhm-root">
      {/* Title/description live in SectionBanner (App.tsx renders it above
          this for every non-chart section) — this bar is just the
          interval tabs, not a resurrected duplicate header. */}
      <div className="mhm-controls">
        <div className="mhm-interval-toggle" role="group" aria-label={t("marketHeatmap.interval", "Interval")}>
          {INTERVALS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`mhm-view-btn${changeInterval === key ? " active" : ""}`}
              onClick={() => setChangeInterval(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && !loading && (
        <p className="mhm-error">⚠️ {t("marketHeatmap.error", "Couldn't load market data.")} {error}</p>
      )}

      <div className="mhm-canvas" ref={containerRef}>
        {loading && coins.length === 0 && <p className="mhm-loading">{t("marketHeatmap.loading", "Loading…")}</p>}

        {tileRects.map(({ item: tile, x, y, width, height }) => {
          // Font size tracks the tile's AREA (sqrt of it) — proportional to
          // market cap/dominance in a squarified treemap — not its shorter
          // side, which is just incidental packing shape. No upper cap on
          // the "ideal" size: BTC's ~55%+ dominance should render
          // dramatically bigger than an 11% coin's, not flatten out past
          // some fixed ceiling. Box dimensions still hard-clamp the result
          // so text never overflows its own tile.
          const capBasis = Math.sqrt(width * height);
          let symbolSize = Math.max(8, capBasis * 0.17);
          symbolSize = Math.min(symbolSize, width / Math.max(tile.symbol.length, 1) * 1.6, height * 0.42);
          const priceSize = symbolSize * 0.52;
          const smallSize = symbolSize * 0.4;
          const showPrice = width >= 46 && height >= 34;
          const showExtra = width >= 78 && height >= 56;
          return (
            <div
              key={tile.symbol}
              className="mhm-tile"
              style={{
                left: x, top: y, width, height,
                background: heatColor(tile.change),
              }}
              onMouseEnter={(e) => setHover({ tile, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setHover({ tile, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(null)}
            >
              <span className="mhm-tile-symbol" style={{ fontSize: symbolSize }}>{tile.symbol}</span>
              {showPrice && <span className="mhm-tile-price" style={{ fontSize: priceSize }}>{fmtPrice(tile.price)}</span>}
              {showExtra && (
                <>
                  <span className={`mhm-tile-change${tile.change >= 0 ? " up" : " down"}`} style={{ fontSize: smallSize }}>
                    <svg width={smallSize * 0.85} height={smallSize * 0.85} viewBox="0 0 24 24" fill="currentColor">
                      {tile.change >= 0 ? <path d="M12 4l8 12H4z" /> : <path d="M12 20L4 8h16z" />}
                    </svg>
                    {Math.abs(tile.change).toFixed(2)}%
                  </span>
                  <span className="mhm-tile-dominance" style={{ fontSize: smallSize * 0.85, marginTop: smallSize * 1.4 }}>
                    {t("marketHeatmap.dominance", "Dominance")} : {tile.dominance.toFixed(2)}%
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>

      {hover && ReactDOM.createPortal(
        <HoverCard hover={hover} imgError={imgError} onImgError={(symbol) => setImgError((prev) => new Set(prev).add(symbol))} />,
        document.body,
      )}
    </div>
  );
}

// Floats near the cursor rather than inline in the tile — tiles can be a
// few pixels square at the small end of the treemap, nowhere near enough
// room for this. Portaled to <body> to escape .mhm-canvas's overflow:hidden
// and clamped to the viewport so it never runs off-screen near an edge.
const TOOLTIP_OFFSET = 16;
const TOOLTIP_WIDTH = 220;

function HoverCard({ hover, imgError, onImgError }: {
  hover: HoverState; imgError: Set<string>; onImgError: (symbol: string) => void;
}) {
  const { tile, x, y } = hover;
  const left = Math.min(x + TOOLTIP_OFFSET, window.innerWidth - TOOLTIP_WIDTH - 8);
  const top = Math.min(y + TOOLTIP_OFFSET, window.innerHeight - 160);
  const up = tile.change >= 0;

  return (
    <div className="mhm-tooltip" style={{ left, top, width: TOOLTIP_WIDTH }}>
      <div className="mhm-tooltip-head">
        {!imgError.has(tile.symbol) ? (
          <img
            src={tile.image}
            alt=""
            className="mhm-tooltip-icon"
            onError={() => onImgError(tile.symbol)}
          />
        ) : (
          <span className="mhm-tooltip-icon mhm-tooltip-icon--fallback">{tile.symbol[0]}</span>
        )}
        <span className="mhm-tooltip-name">{tile.name}</span>
        <span className="mhm-tooltip-symbol">{tile.symbol}</span>
      </div>
      <div className="mhm-tooltip-row">
        <span className="mhm-tooltip-label">Price</span>
        <span className="mhm-tooltip-price-wrap">
          <span className="mhm-tooltip-price">{fmtPrice(tile.price)}</span>
          <span className={`mhm-tooltip-badge${up ? " up" : " down"}`}>{up ? "▲" : "▼"} {Math.abs(tile.change).toFixed(2)}%</span>
        </span>
      </div>
      <div className="mhm-tooltip-row">
        <span className="mhm-tooltip-label">Market Cap</span>
        <span className="mhm-tooltip-value">{fmtBig(tile.marketCap)}</span>
      </div>
      <div className="mhm-tooltip-row">
        <span className="mhm-tooltip-label">Volume(24h)</span>
        <span className="mhm-tooltip-value">{fmtBig(tile.volume)}</span>
      </div>
    </div>
  );
}
