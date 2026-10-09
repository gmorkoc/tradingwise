import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { useTranslation } from "react-i18next";
import { CoinSymbol, fetchBn } from "../services/coinglass";
import "../styles/OrderBook.css";

// Gates the two dropdowns below (precision, exchange) to a native bottom
// sheet instead of a small desktop-style popover — a floating menu that
// size is awkward to tap precisely on a phone, where a full-width sheet
// with large rows is the platform's own convention (same reasoning as
// TradingAgent.tsx's IS_IOS_NATIVE for its swipe-to-delete).
const IS_IOS_NATIVE = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

interface OrderBookProps {
  coin: CoinSymbol;
  onHide?: () => void;
  onOpenUpgrade?: () => void;
}

interface Level {
  price: number;
  size: number;
  usdValue: number;
  total: number;
  cumUsd: number;
}

type Exchange = "Binance" | "Kraken" | "OKX" | "Coinbase";

const EXCHANGES: Exchange[] = ["Binance", "Kraken", "OKX", "Coinbase"];

// Price-bucket grouping increments — same concept as a real exchange's
// own order book "aggregation" dropdown (Binance/Coinbase/etc. all have
// one): coarser values merge nearby price levels into one row so a thin,
// noisy book reads as a cleaner ladder. A flat list tuned for BTC
// (0.01-100) is nonsense for a ~$2-3 coin like NEAR — a $0.01 bucket
// there is ~0.5% of the price, so it was merging dozens of real levels
// into a handful of rows and looked like the book was nearly empty, even
// at the "finest" setting. Scale the whole ladder to the coin's own
// current price instead, keeping the same 1/5/10/50/100-style ratios so
// each option still means "roughly this much coarser than the last."
const PRECISION_RATIOS = [1, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
// The finest tick a coin's price magnitude gets, in decimal PLACES, not a
// continuous price-ratio formula — an earlier version derived this from
// floor(log10(price)) directly, which was anchored to reproduce BTC's
// 0.01 exactly but compounds into absurd values for anything under $1
// (DOGE at $0.08 produced a "finest" tick of 0.00000001 — eight decimal
// places, far beyond the exchange's own real tick size and useless as a
// grouping option). A bounded lookup table instead, same idea as
// fmtPrice's own magnitude bucketing further down this file, caps it at
// a sane 6 decimal places for even the cheapest coins.
function finestDecimalPlaces(price: number): number {
  if (price >= 10000) return 2;
  if (price >= 100)   return 3;
  if (price >= 1)     return 4;
  if (price >= 0.01)  return 5;
  return 6;
}
function precisionLadder(price: number): number[] {
  const decimals = price && isFinite(price) && price > 0 ? finestDecimalPlaces(price) : 2;
  const base = Math.pow(10, -decimals);
  return PRECISION_RATIOS.map((r) => Number((r * base).toFixed(decimals)));
}
// toFixed never uses scientific notation (unlike plain String(), which
// renders anything below 1e-6 as "1e-8" — unreadable in a dropdown) —
// just trims the trailing zeros toFixed(8) otherwise always pads in.
function fmtPrecisionLabel(v: number): string {
  return v.toFixed(8).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

const BINANCE_SYM: Record<string, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", XRP: "XRPUSDT", SOL: "SOLUSDT",
  DOGE: "DOGEUSDT", ADA: "ADAUSDT", SUI: "SUIUSDT", BNB: "BNBUSDT",
};
const KRAKEN_SYM: Record<string, string> = {
  BTC: "XBTUSD", ETH: "ETHUSD", XRP: "XRPUSD", SOL: "SOLUSD",
  DOGE: "DOGEUSD", ADA: "ADAUSD", SUI: "SUIUSD", BNB: "BNBUSD",
};
const OKX_SYM: Record<string, string> = {
  BTC: "BTC-USDT", ETH: "ETH-USDT", XRP: "XRP-USDT", SOL: "SOL-USDT",
  DOGE: "DOGE-USDT", ADA: "ADA-USDT", SUI: "SUI-USDT", BNB: "BNB-USDT",
};
const COINBASE_SYM: Record<string, string> = {
  BTC: "BTC-USD", ETH: "ETH-USD", XRP: "XRP-USD", SOL: "SOL-USD",
  DOGE: "DOGE-USD", ADA: "ADA-USD", SUI: "SUI-USD", BNB: "BNB-USD",
};

function toLevels(pairs: [number, number][]): Level[] {
  return pairs.map(([price, size]) => ({ price, size, usdValue: price * size, total: 0, cumUsd: 0 }));
}

async function fetchBinance(coin: string) {
  const sym = BINANCE_SYM[coin] ?? `${coin}USDT`;
  const d = await fetchBn(`/api/v3/depth?symbol=${sym}&limit=100`);
  const parse = (raw: [string, string][]) =>
    toLevels(raw.map(([p, s]) => [parseFloat(p), parseFloat(s)]));
  return {
    bids: parse([...d.bids].sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))),
    asks: parse([...d.asks].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))),
  };
}

async function fetchKraken(coin: string) {
  const sym = KRAKEN_SYM[coin] ?? `${coin}USD`;
  const res = await fetch(`https://api.kraken.com/0/public/Depth?pair=${sym}&count=100`);
  if (!res.ok) throw new Error("unavailable");
  const d = await res.json();
  if (d.error?.length) throw new Error("unavailable");
  const book = Object.values(d.result)[0] as { bids: string[][]; asks: string[][] };
  const parse = (raw: string[][]) =>
    toLevels(raw.map(([p, s]) => [parseFloat(p), parseFloat(s)]));
  return { bids: parse(book.bids), asks: parse(book.asks) };
}

async function fetchOKX(coin: string) {
  const sym = OKX_SYM[coin] ?? `${coin}-USDT`;
  const res = await fetch(`https://www.okx.com/api/v5/market/books?instId=${sym}&sz=50`);
  if (!res.ok) throw new Error("unavailable");
  const d = await res.json();
  const book = d.data?.[0];
  if (!book) throw new Error("unavailable");
  const parse = (raw: string[][]) =>
    toLevels(raw.map(([p, s]) => [parseFloat(p), parseFloat(s)]));
  return { bids: parse(book.bids), asks: parse(book.asks) };
}

async function fetchCoinbase(coin: string) {
  const sym = COINBASE_SYM[coin] ?? `${coin}-USD`;
  const res = await fetch(
    `https://api.exchange.coinbase.com/products/${sym}/book?level=2`
  );
  if (!res.ok) throw new Error("unavailable");
  const d = await res.json();
  const parse = (raw: [string, string, number][]) =>
    toLevels(raw.slice(0, 100).map(([p, s]) => [parseFloat(p), parseFloat(s)]));
  return { bids: parse(d.bids), asks: parse(d.asks) };
}

async function fetchBook(exchange: Exchange, coin: string) {
  switch (exchange) {
    case "Binance":  return fetchBinance(coin);
    case "Kraken":   return fetchKraken(coin);
    case "OKX":      return fetchOKX(coin);
    case "Coinbase": return fetchCoinbase(coin);
  }
}

// Merges raw levels into tick-size buckets (ceil for asks — rounds toward
// the spread from above; floor for bids — rounds toward the spread from
// below), same convention a real exchange's own depth-aggregation uses.
// Bucket keys are built from a fixed-decimal STRING, not the raw float —
// floating-point noise (82606.8800000001 vs 82606.88) would otherwise
// silently split one real bucket into two near-duplicate Map entries.
function groupLevels(levels: Level[], tick: number, side: "bid" | "ask"): Level[] {
  const buckets = new Map<string, { price: number; size: number }>();
  for (const l of levels) {
    const raw = side === "ask" ? Math.ceil(l.price / tick) * tick : Math.floor(l.price / tick) * tick;
    const price = Math.round(raw * 1e8) / 1e8;
    const key = price.toFixed(8);
    const existing = buckets.get(key);
    if (existing) existing.size += l.size;
    else buckets.set(key, { price, size: l.size });
  }
  const sorted = Array.from(buckets.values())
    .sort((a, b) => (side === "ask" ? a.price - b.price : b.price - a.price));
  let cum = 0;
  let cumUsd = 0;
  return sorted.map((b) => {
    cum += b.size;
    cumUsd += b.price * b.size;
    return { price: b.price, size: b.size, usdValue: b.price * b.size, total: cum, cumUsd };
  });
}

function fmtPrice(p: number): string {
  if (p >= 10000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1000)  return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}

function fmtSize(s: number): string {
  if (s >= 1000) return s.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return s.toFixed(s >= 1 ? 4 : 6);
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Small generic pill dropdown — custom (not a native <select>) so it can
// show a checkmark next to the current value and match the rest of this
// redesigned header, same as the reference UI's own size/exchange pickers.
function PillSelect<T extends string | number>({
  title, value, options, labelFor, onChange,
}: {
  title: string;
  value: T;
  options: readonly T[];
  labelFor: (v: T) => string;
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The native bottom sheet below closes via its own backdrop tap, not
    // this — a document-level mousedown listener would also fire for the
    // synthetic click a real touch produces, closing the sheet the instant
    // it opens.
    if (!open || IS_IOS_NATIVE) return;
    const onDocDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  const optionList = (onPick: (v: T) => void) => options.map((opt) => (
    <button
      key={String(opt)}
      type="button"
      className={`ob-pill-option${opt === value ? " ob-pill-option--selected" : ""}`}
      onClick={() => onPick(opt)}
    >
      {labelFor(opt)}
      {opt === value && <span className="ob-pill-check">✓</span>}
    </button>
  ));

  return (
    <div className="ob-pill" ref={ref}>
      <button type="button" className={`ob-pill-btn${open ? " ob-pill-btn--open" : ""}`} onClick={() => setOpen((v) => !v)}>
        <span>{labelFor(value)}</span>
        <svg width="9" height="6" viewBox="0 0 10 6" className={`ob-pill-caret${open ? " ob-pill-caret--open" : ""}`}>
          <path d="M0 0l5 6 5-6z" fill="currentColor" />
        </svg>
      </button>
      {open && !IS_IOS_NATIVE && (
        <div className="ob-pill-menu">
          {optionList((opt) => { onChange(opt); setOpen(false); })}
        </div>
      )}
      {open && IS_IOS_NATIVE && createPortal(
        <div className="ob-sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="ob-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="ob-sheet-header">
              <span className="ob-sheet-title">{title}</span>
              <button type="button" className="ob-sheet-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>
            <div className="ob-sheet-options">
              {optionList((opt) => { onChange(opt); setOpen(false); })}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

interface Trade {
  id: number;
  price: number;
  qty: number;
  time: number;
  side: "buy" | "sell";
}

export function OrderBook({ coin, onHide }: OrderBookProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<"orderbook" | "trades">("orderbook");
  const [exchange, setExchange] = useState<Exchange>("Binance");
  const [precision, setPrecision] = useState<number | null>(null);
  const [bids, setBids] = useState<Level[]>([]);
  const [asks, setAsks] = useState<Level[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setUnavailable(false);
    setLoading(true);
    setBids([]);
    setAsks([]);

    async function poll() {
      try {
        const book = await fetchBook(exchange, coin);
        setBids(book.bids);
        setAsks(book.asks);
        setLoading(false);
      } catch {
        setUnavailable(true);
        setLoading(false);
      }
    }

    poll();
    const id = setInterval(poll, 2500);
    return () => clearInterval(id);
  }, [exchange, coin]);

  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradesLoading, setTradesLoading] = useState(true);
  const [tradesUnavailable, setTradesUnavailable] = useState(false);

  useEffect(() => {
    if (activeTab !== "trades") return;
    setTradesLoading(true);
    setTradesUnavailable(false);
    let cancelled = false;

    async function poll() {
      try {
        const sym = BINANCE_SYM[coin] ?? `${coin}USDT`;
        const raw: Array<{ a: number; p: string; q: string; T: number; m: boolean }> =
          await fetchBn(`/api/v3/aggTrades?symbol=${sym}&limit=40`);
        if (cancelled) return;
        const mapped: Trade[] = raw
          .map((r) => ({
            id: r.a,
            price: parseFloat(r.p),
            qty: parseFloat(r.q),
            time: r.T,
            // Binance's "m" = "was the buyer the maker" — if true, the
            // taker (the trade that actually just executed) was a seller
            // hitting the bid; if false, the taker was a buyer hitting
            // the ask. Trade-tape convention: color by the TAKER's side.
            side: r.m ? ("sell" as const) : ("buy" as const),
          }))
          .reverse();
        setTrades(mapped);
        setTradesLoading(false);
      } catch {
        if (!cancelled) { setTradesUnavailable(true); setTradesLoading(false); }
      }
    }

    poll();
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeTab, coin]);

  const bestBid  = bids[0]?.price ?? 0;
  const bestAsk  = asks[0]?.price ?? 0;
  const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0;
  const spread   = bestAsk && bestBid ? bestAsk - bestBid : 0;
  const spreadBps = spread && midPrice ? (spread / midPrice) * 10000 : 0;

  const ladder = precisionLadder(midPrice || bestBid || bestAsk);
  // Defaults to (and resets to) the new coin's own finest option whenever
  // the coin changes — without this, switching from BTC to a cheap coin
  // like NEAR kept whatever absolute number (e.g. 0.01) was selected
  // before, which is now the COARSEST entry on the new ladder instead of
  // the finest, reproducing the exact "book looks nearly empty" bug this
  // whole rescale was meant to fix.
  useEffect(() => {
    setPrecision(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin]);
  const activePrecision = precision ?? ladder[0];

  const displayBids = groupLevels(bids, activePrecision, "bid");
  const displayAsks = groupLevels(asks, activePrecision, "ask");

  const maxTotal = Math.max(
    displayBids[displayBids.length - 1]?.total ?? 1,
    displayAsks[displayAsks.length - 1]?.total ?? 1,
  );

  return (
    <div className="ob-card">
      {onHide && (
        <button className="ob-hide-btn" onClick={onHide} title="Hide order book">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      )}

      <div className="ob-tabs">
        <button
          type="button"
          className={`ob-tab${activeTab === "orderbook" ? " ob-tab--active" : ""}`}
          onClick={() => setActiveTab("orderbook")}
        >
          {t("orderBook.title", "Order book")}
          {activeTab === "orderbook" && <span className="ob-tab-close" aria-hidden="true">✕</span>}
        </button>
        <button
          type="button"
          className={`ob-tab${activeTab === "trades" ? " ob-tab--active" : ""}`}
          onClick={() => setActiveTab("trades")}
        >
          Recent trades
          {activeTab === "trades" && <span className="ob-tab-close" aria-hidden="true">✕</span>}
        </button>
        {/* Visual parity with the reference design only — this app doesn't
            have a generic multi-panel tab system to add a new one into. */}
        <button type="button" className="ob-tab-add" title="Add panel" aria-label="Add panel">+</button>
        <button type="button" className="ob-expand-btn" title="Expand" aria-label="Expand">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
      </div>

      {activeTab === "orderbook" ? (
        <>
          <div className="ob-dropdown-row">
            <PillSelect title="Precision" value={activePrecision} options={ladder} labelFor={fmtPrecisionLabel} onChange={setPrecision} />
            <PillSelect title="Exchange" value={exchange} options={EXCHANGES} labelFor={(v) => v} onChange={setExchange} />
          </div>

          {loading && <div className="ob-loading">{t("orderBook.loading")}</div>}
          {!loading && unavailable && (
            <div className="ob-loading">{t("orderBook.unavailable", { coin, exchange })}</div>
          )}

          {!loading && !unavailable && (
            <div className="ob-body">
              <div className="ob-col-headers">
                <span>Price (USD)</span>
                <span>Amount ({coin})</span>
                <span>Total ({coin})</span>
              </div>

              {/* Asks — best ask nearest the spread row, at the bottom of this section */}
              <div className="ob-section ob-section--asks">
                {displayAsks.map((lvl) => (
                  <div key={lvl.price} className="ob-row">
                    <div className="ob-fill ob-fill--ask" style={{ width: `${(lvl.total / maxTotal) * 100}%` }} />
                    <span className="ob-cell ob-price ob-price--ask">{fmtPrice(lvl.price)}</span>
                    <span className="ob-cell ob-size">{fmtSize(lvl.size)}</span>
                    <span className="ob-cell ob-size">{fmtSize(lvl.total)}</span>
                  </div>
                ))}
              </div>

              <div className="ob-mid-row">
                <span className="ob-mid-price">{fmtPrice(midPrice)}</span>
                <span className="ob-spread-label">Spread {fmtPrice(spread)} ({spreadBps.toFixed(4)} bps)</span>
              </div>

              {/* Bids — column-reverse so best bid sits near mid-row */}
              <div className="ob-section ob-section--bids">
                {displayBids.map((lvl) => (
                  <div key={lvl.price} className="ob-row">
                    <div className="ob-fill ob-fill--bid" style={{ width: `${(lvl.total / maxTotal) * 100}%` }} />
                    <span className="ob-cell ob-price ob-price--bid">{fmtPrice(lvl.price)}</span>
                    <span className="ob-cell ob-size">{fmtSize(lvl.size)}</span>
                    <span className="ob-cell ob-size">{fmtSize(lvl.total)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="ob-body ob-body--trades">
          <div className="ob-col-headers ob-col-headers--trades">
            <span>Price (USD)</span>
            <span>Amount ({coin})</span>
            <span>Time</span>
          </div>
          {tradesLoading && <div className="ob-loading">{t("orderBook.loading")}</div>}
          {!tradesLoading && tradesUnavailable && (
            <div className="ob-loading">{t("orderBook.unavailable", { coin, exchange: "Binance" })}</div>
          )}
          {!tradesLoading && !tradesUnavailable && (
            <div className="ob-section">
              {trades.map((tr) => (
                <div key={tr.id} className="ob-row ob-row--trade">
                  <span className={`ob-cell ob-price ob-price--${tr.side === "buy" ? "bid" : "ask"}`}>{fmtPrice(tr.price)}</span>
                  <span className="ob-cell ob-size">{fmtSize(tr.qty)}</span>
                  <span className="ob-cell ob-size ob-trade-time">{fmtTime(tr.time)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
