import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IChartApi, Time } from "lightweight-charts";
import { CandleDataPoint, COINS, CoinSymbol } from "../services/coinglass";
import { ZoneResult } from "./PriceChart.types";
import "../styles/ChartEventAnnotations.css";

const COIN_NAME: Record<string, string> = Object.fromEntries(
  COINS.map((c) => [c.symbol, c.name]),
);

// Duplicated from PriceChart.tsx's formatLivePrice (not imported from
// there — PriceChart.tsx imports this component, so importing back from
// it would create a circular module dependency).
function formatPrice(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(6)}`;
}

// event.time is unix seconds (see coinglass.ts's CandleDataPoint).
function formatRelativeTime(unixSeconds: number): string {
  const deltaSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (deltaSec < 60) return "just now";
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export interface ChartEvent {
  id: string;
  time: number;
  price: number;
  title: string;
  body: string;
}

// How far back (in candles) a support/resistance crossing can be and
// still count as a "notable moment" worth a dot — without this, the scan
// below keeps walking back through the entire loaded window (up to 90
// candles) and surfaces whatever it finds, even if that's two months
// stale with nothing newer since. Past this window, no event for that
// category is shown at all rather than a stale one.
const RECENT_EVENT_WINDOW = 20;

// Rule-based, no AI call — templated sentences from data PriceChart.tsx
// already computes locally (srLevels, zone). Capped at 3 so the chart
// doesn't get cluttered; fewer dots than 3 is fine if fewer genuine
// events are found, matching the reference (2 dots, not a fixed count).
function buildChartEvents(
  candles: CandleDataPoint[],
  srLevels: { support: { price: number }[]; resistance: { price: number }[] },
  zone: ZoneResult | null,
  coin: CoinSymbol,
): ChartEvent[] {
  if (candles.length < 2) return [];
  const name = COIN_NAME[coin] ?? coin;
  const events: ChartEvent[] = [];
  const last = candles[candles.length - 1];

  // 1. Current state — always present if we have a zone signal.
  if (zone) {
    const oversold = zone.signal === "oversold" || zone.signal === "buy" || zone.signal === "strong-buy";
    const overbought = zone.signal === "overbought" || zone.signal === "sell" || zone.signal === "strong-sell";
    if (oversold || overbought) {
      events.push({
        id: "current",
        time: last.time,
        price: last.close,
        title: "Happening now",
        body: `${name} is trading in ${oversold ? "an oversold" : "an overbought"} zone at ${formatPrice(last.close)}, suggesting the recent move may be ${oversold ? "overdone to the downside" : "overdone to the upside"}.`,
      });
    }
  }

  // 2. Most recent support break — latest close crossing below a known
  // support level after previously trading above it.
  const nearestSupport = [...srLevels.support].sort((a, b) => b.price - a.price)[0];
  if (nearestSupport) {
    const floor = Math.max(1, candles.length - RECENT_EVENT_WINDOW);
    for (let i = candles.length - 1; i >= floor; i--) {
      const c = candles[i];
      const prev = candles[i - 1];
      if (c.close < nearestSupport.price && prev.close >= nearestSupport.price) {
        let daysAbove = 0;
        for (let j = i - 1; j >= 0 && candles[j].close >= nearestSupport.price; j--) daysAbove++;
        if (daysAbove > 0) {
          events.push({
            id: "support-break",
            time: c.time,
            price: c.close,
            title: "Below Support",
            body: `${name} dropped below ${formatPrice(nearestSupport.price)}, a price it's mostly stayed above over the past ${daysAbove} candle${daysAbove === 1 ? "" : "s"}.`,
          });
        }
        break;
      }
    }
  }

  // 3. Most recent resistance rejection — symmetric case.
  const nearestResistance = [...srLevels.resistance].sort((a, b) => a.price - b.price)[0];
  if (nearestResistance) {
    const floor = Math.max(1, candles.length - RECENT_EVENT_WINDOW);
    for (let i = candles.length - 1; i >= floor; i--) {
      const c = candles[i];
      const prev = candles[i - 1];
      if (c.close < nearestResistance.price && prev.close >= nearestResistance.price) {
        events.push({
          id: "resistance-reject",
          time: c.time,
          price: c.close,
          title: "Resistance Rejected",
          body: `${name} was rejected near ${formatPrice(nearestResistance.price)} and pulled back.`,
        });
        break;
      }
    }
  }

  return events.slice(0, 3);
}

interface Props {
  chartRef: React.RefObject<IChartApi | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seriesRef: React.RefObject<any>;
  candlesRef: React.RefObject<CandleDataPoint[]>;
  srLevels: { support: { price: number }[]; resistance: { price: number }[] };
  zone: ZoneResult | null;
  coin: CoinSymbol;
  visible: boolean;
  // DOM node, rendered as a sibling AFTER .chart-dblclick-wrap closes (see
  // PriceChart.tsx), that the cards/pager portal into. Without this, the
  // cards would have to live inside .chart-dblclick-wrap alongside the
  // canvas — but that wrapper is the positioning context every other
  // chart overlay (dots layer here, PredictionOverlay, LineDotFillOverlay)
  // sizes itself against via position:absolute;inset:0. Adding the cards
  // as flow content inside that same wrapper grows its height, which
  // stretches inset:0 on ALL of those overlays past the canvas and down
  // over the cards — the exact "dots/fill bleeding onto the cards" bug.
  // Portaling the cards out keeps the wrapper's height pinned to the
  // canvas only.
  cardsSlotRef: React.RefObject<HTMLDivElement | null>;
}

export function ChartEventAnnotations({ chartRef, seriesRef, candlesRef, srLevels, zone, coin, visible, cardsSlotRef }: Props) {
  const [events, setEvents] = useState<ChartEvent[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const subCleanupRef = useRef<(() => void) | null>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  // true while a dot-tap-triggered scroll is in flight, so the scroll
  // listener (which exists to sync the dot highlight when the USER
  // swipes the cards) doesn't fight the programmatic scrollTo below.
  const programmaticScrollRef = useRef(false);
  // cardsSlotRef.current is null on the first render (refs attach after
  // commit) — mirror it into state once mounted so the portal below
  // actually has somewhere to render into.
  const [cardsSlotEl, setCardsSlotEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    setCardsSlotEl(cardsSlotRef.current);
  }, [cardsSlotRef]);

  // Recompute events whenever the inputs that feed them change.
  useEffect(() => {
    if (!visible) { setEvents([]); return; }
    const next = buildChartEvents(candlesRef.current ?? [], srLevels, zone, coin);
    setEvents(next);
    setSelectedId((prev) => (next.some((e) => e.id === prev) ? prev : next[0]?.id ?? null));
  }, [visible, srLevels, zone, coin, candlesRef]);

  const reposition = useCallback(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    const next: Record<string, { x: number; y: number }> = {};
    for (const ev of events) {
      const x = chart.timeScale().timeToCoordinate(ev.time as Time);
      const y = series.priceToCoordinate(ev.price);
      if (x === null || y === null) continue;
      next[ev.id] = { x, y };
    }
    setPositions(next);
  }, [chartRef, seriesRef, events]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !visible) return;
    if (!subCleanupRef.current) {
      const cb = () => reposition();
      chart.timeScale().subscribeVisibleTimeRangeChange(cb);
      subCleanupRef.current = () => chart.timeScale().unsubscribeVisibleTimeRangeChange(cb);
    }
    reposition();
    return () => {
      subCleanupRef.current?.();
      subCleanupRef.current = null;
    };
  }, [chartRef, visible, reposition]);

  useEffect(() => {
    const el = layerRef.current;
    if (!el || !visible) return;
    const ro = new ResizeObserver(() => reposition());
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible, reposition]);

  // Safety net — the live price line keeps moving as new ticks/candles
  // arrive, which doesn't reliably fire subscribeVisibleTimeRangeChange
  // on its own, so both the "current" event's own data (its time/price
  // was the last candle AT THE MOMENT events was computed) and its
  // on-screen position would otherwise drift stale over time. Cheap to
  // just recompute both periodically instead of chasing every possible
  // trigger for "new data arrived."
  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => {
      setEvents((prev) => {
        const next = buildChartEvents(candlesRef.current ?? [], srLevels, zone, coin);
        const changed = next.length !== prev.length || next.some((e, i) => e.id !== prev[i]?.id || e.time !== prev[i]?.time || e.price !== prev[i]?.price);
        return changed ? next : prev;
      });
      reposition();
    }, 2000);
    return () => window.clearInterval(id);
  }, [visible, reposition, srLevels, zone, coin, candlesRef]);

  // Cards are 88% width with a real margin-gap between them (not 100%
  // flush), so the scroll step per card is each card's own measured
  // offsetWidth + its margin-right — not the container's full width.
  const cardStep = useCallback(() => {
    const container = cardsRef.current;
    const first = container?.children[0] as HTMLElement | undefined;
    if (!first) return 0;
    const style = window.getComputedStyle(first);
    return first.offsetWidth + parseFloat(style.marginRight || "0");
  }, []);

  // Tapping a dot scrolls the card carousel to the matching card
  // (smooth, snaps via CSS scroll-snap); swiping the cards directly is
  // handled by native scroll + the listener below instead.
  const selectEvent = useCallback((id: string) => {
    setSelectedId(id);
    const container = cardsRef.current;
    const step = cardStep();
    if (!container || !step) return;
    const index = events.findIndex((e) => e.id === id);
    if (index < 0) return;
    programmaticScrollRef.current = true;
    container.scrollTo({ left: index * step, behavior: "smooth" });
    window.setTimeout(() => { programmaticScrollRef.current = false; }, 400);
  }, [events, cardStep]);

  const handleCardsScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const container = cardsRef.current;
    const step = cardStep();
    if (!container || !step) return;
    const index = Math.round(container.scrollLeft / step);
    const ev = events[index];
    if (ev && ev.id !== selectedId) setSelectedId(ev.id);
  }, [events, selectedId, cardStep]);

  if (!visible || events.length === 0) return null;

  const selected = events.find((e) => e.id === selectedId) ?? events[0];

  const dotsLayer = (
    <div ref={layerRef} className="chart-event-dots-layer">
      {events.map((ev) => {
        const pos = positions[ev.id];
        if (!pos) return null;
        return (
          <button
            key={ev.id}
            type="button"
            className={`chart-event-dot${ev.id === selected.id ? " chart-event-dot--active" : ""}`}
            style={{ left: pos.x, top: pos.y }}
            onClick={() => selectEvent(ev.id)}
            aria-label={ev.title}
          />
        );
      })}
    </div>
  );

  const cardsAndPager = (
    <>
      <div ref={cardsRef} className="chart-event-cards" onScroll={handleCardsScroll}>
        {events.map((ev) => (
          <div key={ev.id} className="chart-event-card">
            <span className="chart-event-card-title">{ev.title}</span>
            <p className="chart-event-card-body">{ev.body}</p>
            <span className="chart-event-card-time">{formatRelativeTime(ev.time)}</span>
          </div>
        ))}
      </div>
      {events.length > 1 && (
        <div className="chart-event-dots-pager">
          {events.map((ev) => (
            <button
              key={ev.id}
              type="button"
              className={`chart-event-pager-dot${ev.id === selected.id ? " chart-event-pager-dot--active" : ""}`}
              onClick={() => selectEvent(ev.id)}
              aria-label={`Show ${ev.title}`}
            />
          ))}
        </div>
      )}
    </>
  );

  return (
    <>
      {dotsLayer}
      {cardsSlotEl ? createPortal(cardsAndPager, cardsSlotEl) : null}
    </>
  );
}
