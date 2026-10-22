import { useEffect, useRef, useState } from "react";
import { CoinSymbol, fetchBn, isBinanceBanned } from "../services/coinglass";
import type { ChartEvent } from "./ChartEventAnnotations";
import { formatRelativeTime } from "./ChartEventAnnotations";
import { OrderBook } from "./OrderBook";
import "../styles/OrderFlowPanel.css";

// Same symbol map OrderBook.tsx keeps for its own Binance fetch — kept as
// its own small copy here rather than exported/shared, since this panel
// is meant to replace OrderBook.tsx outright (see App.tsx, where the old
// component is commented out, not deleted) and the two aren't meant to
// stay coupled.
const BINANCE_SYM: Record<string, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", XRP: "XRPUSDT", SOL: "SOLUSDT",
  DOGE: "DOGEUSDT", ADA: "ADAUSDT", SUI: "SUIUSDT", BNB: "BNBUSDT",
};

function fmtPrice(p: number): string {
  if (p >= 10000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

// Spread is usually a tiny sub-$1 difference — fmtPrice's own fixed 6
// decimals for that range pads it with trailing zeros ("0.010000") that
// bestBid/bestAsk (real prices, where fixed-width digits matter) don't
// have this problem with. Trims those back to the real precision instead.
function fmtSpread(p: number): string {
  return Number(fmtPrice(p)).toString();
}

// ChartEvent (buildChartEvents, ChartEventAnnotations.tsx) carries no
// sentiment field of its own — these are the only title shapes it ever
// produces, so the mapping is exhaustive by inspection, not a guess.
function eventColor(ev: ChartEvent): string {
  if (ev.title === "Happening now") {
    if (ev.body.includes("overdone to the downside")) return "var(--pc-success)";
    if (ev.body.includes("overdone to the upside")) return "var(--pc-danger)";
    return "var(--color-text-muted)";
  }
  if (ev.title === "Below Support" || ev.title === "Resistance Rejected") return "var(--pc-danger)";
  if (ev.title === "Resistance Breakout" || ev.title === "Support Bounce") return "var(--pc-success)";
  // "At Support"/"At Resistance" — nothing's resolved yet (still just
  // testing the level), so neither bullish nor bearish green/red.
  return "var(--color-text-muted)";
}

interface Props {
  coin: CoinSymbol;
  events: ChartEvent[];
  // Controlled from outside (the 2col layout's Paper Trading/Flow/Book
  // tab switcher, App.tsx) — when passed, this panel's own internal
  // Flow/Book switch (.ofp-header-top) is hidden and `view` always wins,
  // since the outer tabs are the one switcher the user sees. Omit it (as
  // every other call site still does) to keep this panel fully self-
  // contained with its own internal switcher, unchanged.
  view?: "flow" | "orderbook";
}

interface HistoryEntry {
  key: string;
  ev: ChartEvent;
  snapshotAt: number;
}

// How many 15-minute snapshots to keep before dropping the oldest — ~2.5
// days' worth at one snapshot/15min, generous for a single browser
// session (this is in-memory only, not persisted) without growing
// forever on a tab left open indefinitely.
const MAX_HISTORY = 250;
const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;

// Replaces the full bid/ask ladder (OrderBook.tsx, commented out at its
// call site in App.tsx) with a single buyer/seller pressure bar plus a
// real narrative feed — same spot next to the chart, same live Binance
// depth feed, just a different read on it: "who's in control" instead of
// "every resting order," and "what's actually happened" (the same
// support/resistance/zone events already driving the on-chart dots,
// ChartEventAnnotations.tsx) instead of a wall of numbers.
export function OrderFlowPanel({ coin, events, view: controlledView }: Props) {
  // Uncontrolled (every call site except the 2col layout's own Paper
  // Trading/Flow/Book tab switcher, App.tsx) now shows both reads on
  // live depth stacked — Flow Pressure then Order Book, always, no
  // in-panel switcher anymore (there's room for both, so the toggle was
  // just an extra click for no reason). Controlled mode (that outer tab
  // switcher) is unchanged: `view` still picks exactly one, since that
  // case already has its own dedicated "Order Book" tab slot elsewhere
  // and showing both here too would just duplicate it.
  const [internalView] = useState<"flow" | "orderbook">("flow");
  const view = controlledView ?? internalView;
  const showBoth = controlledView === undefined;
  const [bestBid, setBestBid] = useState(0);
  const [bestAsk, setBestAsk] = useState(0);
  const [bidPct, setBidPct] = useState(50);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  // "Today's Story" — a growing log, one snapshot of whatever's live
  // every 15 minutes (plus an immediate one on mount/coin change), not
  // just the current live events overwriting themselves. eventsRef holds
  // the latest `events` prop without restarting the snapshot timer below
  // every time it changes (which happens every ~2s, far more often than
  // the 15-minute cadence this is meant to run at).
  const eventsRef = useRef(events);
  useEffect(() => { eventsRef.current = events; }, [events]);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const takeSnapshot = (evs: ChartEvent[]) => {
    if (evs.length === 0) return;
    const snapshotAt = Date.now();
    const added = evs.map((ev) => ({ key: `${ev.id}-${snapshotAt}`, ev, snapshotAt }));
    setHistory((prev) => [...added, ...prev].slice(0, MAX_HISTORY));
  };

  // The 15-minute cadence itself — a snapshot every tick regardless of
  // whether anything changed since the last one (that repetition is the
  // point: "still happening" at each checkpoint, not just the first time).
  useEffect(() => {
    setHistory([]);
    const id = setInterval(() => takeSnapshot(eventsRef.current), SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [coin]);

  // A mount/coin-change effect can't also see real events yet — events
  // arrive asynchronously, slightly after this component (and
  // ChartEventAnnotations above it) first renders — so without this,
  // the log sits empty for up to 15 minutes after opening a coin that
  // actually has something to show. Snapshots once, the first time real
  // events show up, independent of the periodic timer above.
  const gotFirstRef = useRef(false);
  useEffect(() => { gotFirstRef.current = false; }, [coin]);
  useEffect(() => {
    if (gotFirstRef.current || events.length === 0) return;
    gotFirstRef.current = true;
    takeSnapshot(events);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setUnavailable(false);

    async function poll() {
      if (isBinanceBanned()) {
        if (!cancelled) { setUnavailable(true); setLoading(false); }
        return;
      }
      try {
        const sym = BINANCE_SYM[coin] ?? `${coin}USDT`;
        const d = await fetchBn(`/api/v3/depth?symbol=${sym}&limit=100`);
        if (cancelled) return;
        const bids: [number, number][] = d.bids.map(([p, s]: [string, string]) => [parseFloat(p), parseFloat(s)]);
        const asks: [number, number][] = d.asks.map(([p, s]: [string, string]) => [parseFloat(p), parseFloat(s)]);
        const bidUsd = bids.reduce((sum, [p, s]) => sum + p * s, 0);
        const askUsd = asks.reduce((sum, [p, s]) => sum + p * s, 0);
        const total = bidUsd + askUsd;
        setBestBid(bids.reduce((m, [p]) => Math.max(m, p), 0));
        setBestAsk(asks.reduce((m, [p]) => (m === 0 ? p : Math.min(m, p)), 0));
        setBidPct(total ? Math.round((bidUsd / total) * 100) : 50);
        setLoading(false);
      } catch {
        if (!cancelled) { setUnavailable(true); setLoading(false); }
      }
    }

    poll();
    const id = setInterval(poll, 2500);
    return () => { cancelled = true; clearInterval(id); };
  }, [coin]);

  const spread = bestAsk && bestBid ? bestAsk - bestBid : 0;
  const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0;
  const spreadBps = spread && midPrice ? (spread / midPrice) * 10000 : 0;
  const askPct = 100 - bidPct;

  const flowHeader = (
    <div className="ofp-header">
      <span className="ofp-title">Order Flow Pressure</span>
      <div className="ofp-header-right">
        {!loading && !unavailable && (
          <span className="ofp-spread">Spread {fmtSpread(spread)} ({spreadBps.toFixed(4)} bps)</span>
        )}
        <span className="ptc-live-badge"><span className="ptc-pulse-dot" />LIVE</span>
      </div>
    </div>
  );
  const flowBody = (
    <>
      {loading && (
        <>
          <div className="ofp-skeleton-bar" />
          <div className="ofp-skeleton-labels">
            <span className="ofp-skeleton-label" />
            <span className="ofp-skeleton-label" style={{ width: "110px" }} />
          </div>
        </>
      )}
      {!loading && unavailable && <div className="ofp-loading">Order flow unavailable for {coin}.</div>}

      {!loading && !unavailable && (
        <>
          <div className="ofp-bar">
            <div className="ofp-bar-bid" style={{ width: `${bidPct}%` }} />
            <div className="ofp-bar-ask" style={{ width: `${askPct}%` }} />
          </div>
          <div className="ofp-bar-labels">
            <span className="ofp-bar-label ofp-bar-label--bid">{bidPct}% buyers · {fmtPrice(bestBid)}</span>
            <span className="ofp-bar-label ofp-bar-label--ask">{askPct}% sellers · {fmtPrice(bestAsk)}</span>
          </div>
        </>
      )}

      <div className="ofp-feed-label">Today's Story</div>
      <div className="ofp-feed">
        {history.length === 0 && (
          <div className="ofp-feed-empty">No notable signals on this chart right now.</div>
        )}
        {history.map(({ key, ev }, i) => (
          <div key={key} className="ofp-feed-item" style={{ animationDelay: `${Math.min(i, 8) * 0.07}s` }}>
            <span className="ofp-feed-dot" style={{ background: eventColor(ev) }} />
            <div className="ofp-feed-body">
              <span className="ofp-feed-text"><b>{ev.title}</b> — {ev.body}</span>
              {/* ev.time (unix seconds, buildChartEvents/ChartEventAnnotations.tsx)
                  — when THAT signal actually became true (its own candle's
                  close time), not snapshotAt (when this 15-min tick ran;
                  identical for every event captured in the same tick).
                  Relative, not absolute hour:minute — a coarser interval's
                  candles (1D/1W) all close at the same hour-of-day, so an
                  absolute clock time collided across genuinely different
                  days; "2h ago"/"3d ago" doesn't have that problem. */}
              <span className="ofp-feed-time">{formatRelativeTime(ev.time)}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div className="ob-card ofp-card">
      {showBoth ? (
        <>
          {flowHeader}
          {flowBody}
          {/* Not a tab/toggle anymore — both reads on live depth always
              show, stacked, separated by a plain divider. */}
          <div className="ofp-section-divider" />
          <div className="ofp-header">
            <span className="ofp-title">Order Book</span>
          </div>
          <div className="ofp-ladder-wrap">
            <OrderBook coin={coin} embedded />
          </div>
        </>
      ) : (
        <>
          <div className="ofp-header">
            <span className="ofp-title">{view === "flow" ? "Order Flow Pressure" : "Order Book"}</span>
            <div className="ofp-header-right">
              {view === "flow" && !loading && !unavailable && (
                <span className="ofp-spread">Spread {fmtSpread(spread)} ({spreadBps.toFixed(4)} bps)</span>
              )}
              <span className="ptc-live-badge"><span className="ptc-pulse-dot" />LIVE</span>
            </div>
          </div>
          {view === "flow" && flowBody}
          {view === "orderbook" && (
            <div className="ofp-ladder-wrap">
              <OrderBook coin={coin} embedded />
            </div>
          )}
        </>
      )}
    </div>
  );
}
