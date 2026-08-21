import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CoinSymbol, fetchBn } from "../services/coinglass";
import { useAuth } from "../contexts/AuthContext";
import { hasAccess } from "../services/supabase";
import "../styles/OrderBook.css";

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
}

type Exchange = "Binance" | "Kraken" | "OKX" | "Coinbase";

const EXCHANGES: Exchange[] = ["Binance", "Kraken", "OKX", "Coinbase"];

const SIZE_FILTERS = [
  { label: "All",    value: 0       },
  { label: ">$5K",   value: 5_000   },
  { label: ">$10K",  value: 10_000  },
  { label: ">$50K",  value: 50_000  },
  { label: ">$100K", value: 100_000 },
];

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

function toCumulative(pairs: [number, number][]): Level[] {
  let cum = 0;
  return pairs.map(([price, size]) => {
    cum += size;
    return { price, size, usdValue: price * size, total: cum };
  });
}

async function fetchBinance(coin: string) {
  const sym = BINANCE_SYM[coin] ?? `${coin}USDT`;
  const d = await fetchBn(`/api/v3/depth?symbol=${sym}&limit=100`);
  const parse = (raw: [string, string][]) =>
    toCumulative(raw.map(([p, s]) => [parseFloat(p), parseFloat(s)]));
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
    toCumulative(raw.map(([p, s]) => [parseFloat(p), parseFloat(s)]));
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
    toCumulative(raw.map(([p, s]) => [parseFloat(p), parseFloat(s)]));
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
    toCumulative(raw.slice(0, 100).map(([p, s]) => [parseFloat(p), parseFloat(s)]));
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

function recompute(levels: Level[]): Level[] {
  let cum = 0;
  return levels.map(l => { cum += l.size; return { ...l, total: cum }; });
}

function fmtPrice(p: number): string {
  if (p >= 10000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1000)  return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}

function fmtSize(s: number): string {
  if (s >= 1000) return s.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return s.toFixed(4);
}

function fmtUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function OrderBook({ coin, onHide, onOpenUpgrade }: OrderBookProps) {
  const { tier } = useAuth();
  const isPaid = hasAccess(tier, "pro");
  const { t } = useTranslation();
  const [exchange, setExchange] = useState<Exchange>("Binance");
  const [minUsd, setMinUsd] = useState(0);
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

  const displayBids = recompute(minUsd ? bids.filter(l => l.usdValue >= minUsd) : bids);
  const displayAsks = recompute(minUsd ? asks.filter(l => l.usdValue >= minUsd) : asks);

  const maxTotal = Math.max(
    displayBids[displayBids.length - 1]?.total ?? 1,
    displayAsks[displayAsks.length - 1]?.total ?? 1,
  );

  const bestBid  = bids[0]?.price ?? 0;
  const bestAsk  = asks[0]?.price ?? 0;
  const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0;
  const spread   = bestAsk && bestBid ? bestAsk - bestBid : 0;
  const spreadPct = spread && midPrice ? (spread / midPrice) * 100 : 0;

  return (
    <div className="ob-card">
      {onHide && (
        <button className="ob-hide-btn" onClick={onHide} title="Hide order book">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      )}

      <div className="ob-header">
        <h3 className="ob-title">{t("orderBook.title")}</h3>
      </div>

      <div className="ob-exchange-row">
        <select
          className="ob-ex-select"
          value={exchange}
          onChange={e => setExchange(e.target.value as Exchange)}
        >
          {EXCHANGES.map(ex => <option key={ex} value={ex}>{ex}</option>)}
        </select>
      </div>

      <div className="ob-filter-row">
        {SIZE_FILTERS.map(f => {
          const locked = f.value >= 50_000 && !isPaid;
          return (
            <button
              key={f.value}
              className={`ob-filter-btn${minUsd === f.value ? " active" : ""}${locked ? " ob-filter-btn--locked" : ""}`}
              onClick={() => {
                if (locked) { onOpenUpgrade?.(); return; }
                setMinUsd(f.value);
              }}
            >
              {f.label}
              {f.value >= 50_000 && <span className="tier-badge tier-badge--pro">P</span>}
            </button>
          );
        })}
      </div>

      {loading && <div className="ob-loading">{t("orderBook.loading")}</div>}
      {!loading && unavailable && (
        <div className="ob-loading">{t("orderBook.unavailable", { coin, exchange })}</div>
      )}

      {!loading && !unavailable && (
        <div className="ob-body">
          <div className="ob-col-headers">
            <span>{t("orderBook.colPrice")}</span>
            <span>{t("orderBook.colSize")}</span>
            <span>{t("orderBook.colValue")}</span>
          </div>

          {/* Bids — column-reverse so best bid sits near mid-row */}
          <div className="ob-section ob-section--bids">
            {displayBids.map((lvl, i) => (
              <div key={i} className="ob-row">
                <div className="ob-fill ob-fill--bid" style={{ width: `${(lvl.total / maxTotal) * 100}%` }} />
                <span className="ob-cell ob-price ob-price--bid">{fmtPrice(lvl.price)}</span>
                <span className="ob-cell ob-size">{fmtSize(lvl.size)}</span>
                <span className="ob-cell ob-usd">{fmtUsd(lvl.usdValue)}</span>
              </div>
            ))}
          </div>

          <div className="ob-mid-row">
            <span className="ob-mid-price">{fmtPrice(midPrice)}</span>
            <span className="ob-spread-label">{fmtPrice(spread)} ({spreadPct.toFixed(3)}%)</span>
          </div>

          {/* Asks — best ask at top */}
          <div className="ob-section ob-section--asks">
            {displayAsks.map((lvl, i) => (
              <div key={i} className="ob-row">
                <div className="ob-fill ob-fill--ask" style={{ width: `${(lvl.total / maxTotal) * 100}%` }} />
                <span className="ob-cell ob-price ob-price--ask">{fmtPrice(lvl.price)}</span>
                <span className="ob-cell ob-size">{fmtSize(lvl.size)}</span>
                <span className="ob-cell ob-usd">{fmtUsd(lvl.usdValue)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
