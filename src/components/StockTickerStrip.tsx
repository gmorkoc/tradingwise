import { useEffect, useRef, useState } from "react";
import {
  fetchIndicesAndCommodities, fetchIndexSparklines, hasStockApiKey,
  INDEX_SYMBOLS, type QuoteRow,
} from "../services/marketOverview";
import { fetchKeyIndexFallback, KEY_INDEX_PROXIES } from "../services/alphavantage";
import { usePollWhileVisible } from "../hooks/usePollWhileVisible";
import "../styles/StockTickerStrip.css";

interface TickerChip {
  key: string;
  label: string;
  price: number | null;
  change: number | null;
  percentChange: number | null;
  sparkline?: number[];
}

const BTC_KEY = "BTCUSDT";

// The fixed, always-rendered slot list — same idea as Yahoo's ticker bar:
// the set of chips never changes shape, even if a given symbol's data
// hasn't resolved yet (shows a "—" placeholder instead of disappearing).
const FIXED_SLOTS: { key: string; label: string }[] = [
  ...INDEX_SYMBOLS.map(s => ({ key: s.symbol, label: s.label })),
  { key: BTC_KEY, label: "Bitcoin USD" },
];

function fmtPrice(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtChange(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n >= 0 ? "+" : "-"}${abs}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(2)}%`;
}

// BTC gets its own independent fetch rather than reusing the app's
// globally-selected crypto `coin` state — that state can be any coin the
// user picked elsewhere, and mislabeling it "BTC" here would be wrong.
async function fetchBtcQuote(): Promise<{ price: number; change: number; percentChange: number } | null> {
  try {
    const res = await fetch("https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT");
    if (!res.ok) return null;
    const d = await res.json();
    return {
      price: parseFloat(d.lastPrice),
      change: parseFloat(d.priceChange),
      percentChange: parseFloat(d.priceChangePercent),
    };
  } catch {
    return null;
  }
}

async function fetchBtcSparkline(): Promise<number[] | null> {
  try {
    const res = await fetch("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=26");
    if (!res.ok) return null;
    // Binance kline row shape: [openTime, open, high, low, close, volume, ...] — close is index 4.
    const rows: (string | number)[][] = await res.json();
    return rows.map(r => parseFloat(r[4] as string)).filter(isFinite);
  } catch {
    return null;
  }
}

function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const w = 44, h = 18;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p - min) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg className="sts-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={coords} fill="none" stroke={up ? "#22c55e" : "#ef4444"} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const initialChips: TickerChip[] = FIXED_SLOTS.map(s => ({
  key: s.key, label: s.label, price: null, change: null, percentChange: null,
}));

export function StockTickerStrip() {
  const [chips, setChips] = useState<TickerChip[]>(initialChips);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Prices/% — every 10 minutes, paused while the tab is hidden. TwelveData's
  // free tier is 800 requests/DAY total (shared across every visitor), not
  // just a per-minute cap — a 60s poll left running in one background tab
  // alone is 1,440 requests/day, which blew the whole daily budget by
  // itself. Always writes into the fixed 8 slots; a symbol with no resolved
  // data simply keeps its placeholder state.
  const loadQuotes = () => {
    Promise.all([
      hasStockApiKey ? fetchIndicesAndCommodities() : Promise.resolve(new Map<string, QuoteRow>()),
      fetchBtcQuote(),
    ]).then(([indexQuotes, btc]) => {
      setChips(prev => prev.map(chip => {
        if (chip.key === BTC_KEY) return btc ? { ...chip, ...btc } : chip;
        const q = indexQuotes.get(chip.key);
        return q ? { ...chip, price: q.price, change: q.change, percentChange: q.percentChange } : chip;
      }));
    });
  };
  useEffect(() => { loadQuotes(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  usePollWhileVisible(loadQuotes, 10 * 60_000);

  // Sparklines — decorative, even lower frequency (30min), paused while
  // hidden, never blocks the chips above.
  const loadSparklines = () => {
    Promise.all([
      hasStockApiKey ? fetchIndexSparklines(INDEX_SYMBOLS.map(s => s.symbol)) : Promise.resolve(new Map<string, number[]>()),
      fetchBtcSparkline(),
    ]).then(([sparkMap, btcSpark]) => {
      if (btcSpark && btcSpark.length >= 2) sparkMap.set(BTC_KEY, btcSpark);
      if (sparkMap.size === 0) return;
      setChips(prev => prev.map(c => (sparkMap.has(c.key) ? { ...c, sparkline: sparkMap.get(c.key) } : c)));
    });
  };
  useEffect(() => { loadSparklines(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  usePollWhileVisible(loadSparklines, 30 * 60_000);

  // Fallback for 6 of the 7 index/commodity chips (all but VIX, via ETF
  // proxies) when TwelveData has no data for them — hourly, and only for
  // whichever are CURRENTLY missing, so it never spends Alpha Vantage's
  // shared 25/day budget while TwelveData is working fine. See
  // alphavantage.ts for why VIX specifically has no good proxy.
  const loadKeyIndexFallback = () => {
    const missing = Object.keys(KEY_INDEX_PROXIES).filter(key => {
      const chip = chips.find(c => c.key === key);
      return chip && chip.price == null;
    });
    if (missing.length === 0) return;
    fetchKeyIndexFallback(missing).then(fallbackMap => {
      if (fallbackMap.size === 0) return;
      setChips(prev => prev.map(c => {
        const f = fallbackMap.get(c.key);
        return f ? { ...c, price: f.price, change: f.change, percentChange: f.percentChange } : c;
      }));
    });
  };
  useEffect(() => {
    // Give the primary TwelveData load a head start so we know what's
    // actually missing before spending Alpha Vantage credits on it.
    const id = window.setTimeout(loadKeyIndexFallback, 20_000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  usePollWhileVisible(loadKeyIndexFallback, 60 * 60_000);

  const scrollBy = (dir: 1 | -1) => scrollRef.current?.scrollBy({ left: dir * 240, behavior: "smooth" });

  return (
    <div className="sts-strip">
      <div className="sts-region">
        <span className="sts-region-dot" />
        US Markets <span className="sts-region-chevron">▾</span>
      </div>

      <div className="sts-scroll" ref={scrollRef}>
        {chips.map(c => {
          const hasData = c.price != null && c.change != null && c.percentChange != null;
          const up = hasData && c.percentChange! >= 0;
          return (
            <div key={c.key} className="sts-chip">
              <span className="sts-chip-label">{c.label}</span>
              <div className="sts-chip-row">
                <div className="sts-chip-text">
                  <span className="sts-chip-price">{hasData ? fmtPrice(c.price!) : "—"}</span>
                  {hasData ? (
                    <span className={`sts-chip-pct${up ? " up" : " down"}`}>
                      {fmtChange(c.change!)} {fmtPct(c.percentChange!)}
                    </span>
                  ) : (
                    <span className="sts-chip-pct sts-chip-pct--muted">—</span>
                  )}
                </div>
                {hasData && c.sparkline && c.sparkline.length >= 2 && <Sparkline points={c.sparkline} up={up} />}
              </div>
            </div>
          );
        })}
      </div>

      <div className="sts-nav">
        <button className="sts-nav-btn" onClick={() => scrollBy(-1)} aria-label="Scroll left">‹</button>
        <button className="sts-nav-btn" onClick={() => scrollBy(1)} aria-label="Scroll right">›</button>
      </div>
    </div>
  );
}
