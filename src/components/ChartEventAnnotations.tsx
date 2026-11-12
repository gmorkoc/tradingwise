import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import i18n from "i18next";
import { useTranslation } from "react-i18next";
import { IChartApi, Time } from "lightweight-charts";
import { CandleDataPoint, COINS, CoinSymbol } from "../services/coinglass";
import { ZoneResult } from "./PriceChart.types";
import "../styles/ChartEventAnnotations.css";
import { BottomSheet } from "./BottomSheet";

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
// Exported for OrderFlowPanel.tsx's "Today's Story" feed — a coarser
// interval's candles (1D/1W) all close at the same hour-of-day, so an
// absolute hour:minute display collided across genuinely different days;
// relative time ("2h ago"/"3d ago") doesn't have that problem.
export function formatRelativeTime(unixSeconds: number): string {
  const deltaSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (deltaSec < 60) return i18n.t("chartEvents.ago.justNow");
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return i18n.t("chartEvents.ago.m", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return i18n.t("chartEvents.ago.h", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return i18n.t("chartEvents.ago.d", { n: days });
  const months = Math.floor(days / 30);
  if (months < 12) return i18n.t("chartEvents.ago.mo", { n: months });
  return i18n.t("chartEvents.ago.y", { n: Math.floor(months / 12) });
}

// "current" event: oversold vs overbought. title/body stay English on the
// event object (other panels match on them) — shown text is translated
// at render via eventTitle / eventBody below.
const isOversold = (ev: ChartEvent) => /oversold/i.test(ev.body);

const TITLE_KEY: Record<string, string> = {
  current: "current",
  "support-break": "supportBreak",
  "resistance-reject": "resistanceReject",
  "resistance-breakout": "resistanceBreakout",
  "support-bounce": "supportBounce",
  "at-support": "atSupport",
  "at-resistance": "atResistance",
};

/** The event's title in the current language (falls back to ev.title). */
export function eventTitle(ev: ChartEvent): string {
  const k = TITLE_KEY[ev.id];
  return k ? i18n.t(`chartEvents.title.${k}`, { defaultValue: ev.title }) : ev.title;
}

/** The event's one-line explanation in the current language (falls back to ev.body). */
export function eventBody(ev: ChartEvent): string {
  const k = TITLE_KEY[ev.id];
  if (!k || !ev.vars) return ev.body;
  const key = ev.id === "current" ? (isOversold(ev) ? "currentOversold" : "currentOverbought") : k;
  return i18n.t(`chartEvents.body.${key}`, { ...ev.vars, defaultValue: ev.body });
}

// Card mood: green for bullish setups, red for bearish ones.
function eventTone(ev: ChartEvent): "bullish" | "bearish" {
  if (ev.id === "current") return isOversold(ev) ? "bullish" : "bearish";
  if (ev.id === "resistance-breakout" || ev.id === "support-bounce" || ev.id === "at-support") return "bullish";
  return "bearish";
}

// Short headline per event kind (the card's big line).
function eventHeadline(ev: ChartEvent): string {
  switch (ev.id) {
    case "current": return isOversold(ev) ? i18n.t("chartEvents.headline.oversold") : i18n.t("chartEvents.headline.overbought");
    case "support-break": return i18n.t("chartEvents.headline.supportBreak");
    case "resistance-reject": return i18n.t("chartEvents.headline.resistanceReject");
    case "resistance-breakout": return i18n.t("chartEvents.headline.resistanceBreakout");
    case "support-bounce": return i18n.t("chartEvents.headline.supportBounce");
    case "at-support": return i18n.t("chartEvents.headline.atSupport");
    case "at-resistance": return i18n.t("chartEvents.headline.atResistance");
    default: return ev.title;
  }
}

// Compact "live activity" strip: direction badge · headline + price over a
// one-line summary · LIVE / time. Mostly white, very small footprint.
function EventCard({ ev, onOpen }: { ev: ChartEvent; onOpen: () => void }) {
  const tone = eventTone(ev);
  const live = ev.id === "current";
  return (
    <div
      className={`chart-event-card cec cec--${tone}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpen(); }}
    >
      <span className="cec-badge" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          {tone === "bullish" ? <path d="M7 17L17 7M9 7h8v8" /> : <path d="M7 7l10 10M17 9v8H9" />}
        </svg>
      </span>
      <span className="cec-main">
        <span className="cec-line1">
          <b>{eventHeadline(ev)}</b>
          <span className="cec-sep">·</span>
          <span className="cec-price">${ev.price.toLocaleString(undefined, { maximumFractionDigits: ev.price >= 100 ? 2 : 6 })}</span>
        </span>
        <span className="cec-line2">{eventBody(ev)}</span>
      </span>
      <span className="cec-side">
        {live ? <span className="cec-live"><i />{i18n.t("chartEvents.live")}</span> : null}
        <span className="cec-time">{formatRelativeTime(ev.time)}</span>
      </span>
    </div>
  );
}

// Full view of one event, in the app's bottom-sheet style.
function EventSheet({ ev, onClose }: { ev: ChartEvent; onClose: () => void }) {
  const tone = eventTone(ev);
  const live = ev.id === "current";
  return (
    <BottomSheet
      open
      onClose={onClose}
      className={`cec-sheet cec--${tone}`}
      ariaLabel={eventHeadline(ev)}
      title={
        <span className="cec-sheet-label">
          {eventTitle(ev)}
          {live && <span className="cec-live"><i />{i18n.t("chartEvents.live")}</span>}
        </span>
      }
    >
        <div className="cec-sheet-body">
          <div className="cec-sheet-row">
            <span className="cec-badge" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                {tone === "bullish" ? <path d="M7 17L17 7M9 7h8v8" /> : <path d="M7 7l10 10M17 9v8H9" />}
              </svg>
            </span>
            <span className="cec-sheet-headline">{eventHeadline(ev)}</span>
          </div>
          <div className="cec-sheet-price">${ev.price.toLocaleString(undefined, { maximumFractionDigits: ev.price >= 100 ? 2 : 6 })}</div>
          <p className="cec-sheet-text">{eventBody(ev)}</p>
          <div className="cec-sheet-meta">
            <span className="cec-sheet-tone"><i />{tone === "bullish" ? i18n.t("chartEvents.bullishSetup") : i18n.t("chartEvents.bearishSetup")}</span>
            <span className="cec-time">{formatRelativeTime(ev.time)}</span>
          </div>
        </div>
    </BottomSheet>
  );
}

export interface ChartEvent {
  id: string;
  time: number;
  price: number;
  title: string;
  body: string;
  /** Values for the translated body (see eventBody). */
  vars?: Record<string, string | number>;
}

// How far back (in candles) a support/resistance crossing can be and
// still count as a "notable moment" worth a dot — without this, the scan
// below keeps walking back through the entire loaded window (up to 90
// candles) and surfaces whatever it finds, even if that's two months
// stale with nothing newer since. Past this window, no event for that
// category is shown at all rather than a stale one.
const RECENT_EVENT_WINDOW = 20;

// How close (as a fraction of price) a close needs to be to a level to
// count as "testing" it right now, rather than just passing nearby.
const PROXIMITY_PCT = 0.005;

// Rule-based, no AI call — templated sentences from data PriceChart.tsx
// already computes locally (srLevels, zone). maxEvents defaults to 3 (the
// on-chart dots' own cap, so the chart doesn't get cluttered — fewer
// dots than 3 is fine if fewer genuine events are found, matching the
// reference); OrderFlowPanel's "Today's Story" feed (PriceChart.tsx's
// onEventsChange) is a scrollable log with no such clutter concern, so
// it calls this with a higher cap to surface more of the scenarios below
// in the same pass instead of only ever seeing 3 of them.
function buildChartEvents(
  candles: CandleDataPoint[],
  srLevels: { support: { price: number }[]; resistance: { price: number }[] },
  zone: ZoneResult | null,
  coin: CoinSymbol,
  maxEvents: number = 3,
): ChartEvent[] {
  if (candles.length < 2) return [];
  const name = COIN_NAME[coin] ?? coin;
  const events: ChartEvent[] = [];
  const last = candles[candles.length - 1];
  const floor = Math.max(1, candles.length - RECENT_EVENT_WINDOW);

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
        vars: { name, price: formatPrice(last.close) },
      });
    }
  }

  const nearestSupport = [...srLevels.support].sort((a, b) => b.price - a.price)[0];
  const nearestResistance = [...srLevels.resistance].sort((a, b) => a.price - b.price)[0];

  // 2. Most recent support break — latest close crossing below a known
  // support level after previously trading above it.
  if (nearestSupport) {
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
            vars: { name, price: formatPrice(nearestSupport.price), count: daysAbove },
          });
        }
        break;
      }
    }
  }

  // 3. Most recent resistance rejection — symmetric case.
  if (nearestResistance) {
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
          vars: { name, price: formatPrice(nearestResistance.price) },
        });
        break;
      }
    }
  }

  // 4. Resistance breakout — the bullish mirror of #2: latest close
  // crossing ABOVE resistance after previously trading below it.
  if (nearestResistance) {
    for (let i = candles.length - 1; i >= floor; i--) {
      const c = candles[i];
      const prev = candles[i - 1];
      if (c.close > nearestResistance.price && prev.close <= nearestResistance.price) {
        let daysBelow = 0;
        for (let j = i - 1; j >= 0 && candles[j].close <= nearestResistance.price; j--) daysBelow++;
        if (daysBelow > 0) {
          events.push({
            id: "resistance-breakout",
            time: c.time,
            price: c.close,
            title: "Resistance Breakout",
            body: `${name} broke above ${formatPrice(nearestResistance.price)}, a price it's mostly stayed under over the past ${daysBelow} candle${daysBelow === 1 ? "" : "s"}.`,
            vars: { name, price: formatPrice(nearestResistance.price), count: daysBelow },
          });
        }
        break;
      }
    }
  }

  // 5. Support bounce — the bullish mirror of #3: latest close crossing
  // back above support after trading below it.
  if (nearestSupport) {
    for (let i = candles.length - 1; i >= floor; i--) {
      const c = candles[i];
      const prev = candles[i - 1];
      if (c.close > nearestSupport.price && prev.close <= nearestSupport.price) {
        events.push({
          id: "support-bounce",
          time: c.time,
          price: c.close,
          title: "Support Bounce",
          body: `${name} bounced off support near ${formatPrice(nearestSupport.price)} and recovered.`,
          vars: { name, price: formatPrice(nearestSupport.price) },
        });
        break;
      }
    }
  }

  // 6/7. Sitting right at a level right now — distinct from an actual
  // break/bounce/rejection above, which all need a CROSSING; this is
  // just "still parked here," which a crossing-only scan would miss
  // entirely on a candle that's hovered near the line without crossing it.
  if (nearestSupport && Math.abs(last.close - nearestSupport.price) / nearestSupport.price < PROXIMITY_PCT) {
    events.push({
      id: "at-support",
      time: last.time,
      price: last.close,
      title: "At Support",
      body: `${name} is testing support near ${formatPrice(nearestSupport.price)}.`,
      vars: { name, price: formatPrice(nearestSupport.price) },
    });
  }
  if (nearestResistance && Math.abs(last.close - nearestResistance.price) / nearestResistance.price < PROXIMITY_PCT) {
    events.push({
      id: "at-resistance",
      time: last.time,
      price: last.close,
      title: "At Resistance",
      body: `${name} is testing resistance near ${formatPrice(nearestResistance.price)}.`,
      vars: { name, price: formatPrice(nearestResistance.price) },
    });
  }

  return events.slice(0, maxEvents);
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
  // OrderFlowPanel.tsx's "Today's Story" feed (App.tsx) — the exact same
  // events this component already computes for its own on-chart dots/
  // cards, just also handed up to a sibling panel that has no other way
  // to reach PriceChart.tsx's internal candles/srLevels/zone state.
  onEventsChange?: (events: ChartEvent[]) => void;
  /** Optional first slide (e.g. the ProVision Signal Check summary). */
  leadCard?: LeadCard | null;
}

export interface LeadCard {
  tone: "bullish" | "bearish" | "neutral";
  title: string;
  value?: string;
  body: string;
  side: string;
  onOpen: () => void;
}
const LEAD_ID = "__lead";

// First slide: same strip look as an event, with its own copy + action.
function LeadEventCard({ card }: { card: LeadCard }) {
  return (
    <div
      className={`chart-event-card cec cec--${card.tone} cec--lead`}
      role="button"
      tabIndex={0}
      onClick={card.onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") card.onOpen(); }}
    >
      <span className="cec-badge" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12h4l3-7 4 14 3-7h4" />
        </svg>
      </span>
      <span className="cec-main">
        <span className="cec-line1">
          <b>{card.title}</b>
          {card.value && <><span className="cec-sep">·</span><span className="cec-price">{card.value}</span></>}
        </span>
        <span className="cec-line2">{card.body}</span>
      </span>
      <span className="cec-side">
        <span className="cec-cta">{card.side}</span>
      </span>
    </div>
  );
}

export function ChartEventAnnotations({ chartRef, seriesRef, candlesRef, srLevels, zone, coin, visible, cardsSlotRef, onEventsChange, leadCard }: Props) {
  // Re-render (and re-translate the cards) when the language changes.
  const { t } = useTranslation();
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

  // onEventsChange (OrderFlowPanel.tsx's feed, App.tsx) deliberately
  // ignores `visible` — that flag only gates the on-chart dots/cards
  // this component itself renders (mobile only, see the visible prop at
  // its PriceChart.tsx call site), but the feed is also the desktop
  // Order Book replacement's only source for this data, which needs it
  // regardless of whether the dots are shown here.
  // onEventsChange is an inline arrow at the PriceChart call site (a new
  // function every render) and it sets parent state with a fresh array —
  // keeping it in the deps re-ran this effect on every parent render,
  // an infinite update loop. Read it through a ref instead.
  const onEventsChangeRef = useRef(onEventsChange);
  onEventsChangeRef.current = onEventsChange;
  useEffect(() => {
    onEventsChangeRef.current?.(buildChartEvents(candlesRef.current ?? [], srLevels, zone, coin, 7));
  }, [srLevels, zone, coin, candlesRef]);

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

  // Same "ignore visible" reasoning as the effect above — the feed still
  // needs to tick even when nothing is visible on-chart to recompute.
  useEffect(() => {
    const id = window.setInterval(() => {
      onEventsChangeRef.current?.(buildChartEvents(candlesRef.current ?? [], srLevels, zone, coin, 7));
    }, 2000);
    return () => window.clearInterval(id);
  }, [srLevels, zone, coin, candlesRef]);

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
  // Slide order: a LIVE event (happening now) first, then the lead card
  // (ProVision + Consensus), then the rest of the events.
  const slideIds = useMemo(() => {
    const ids = events.map((e) => e.id);
    if (!leadCard) return ids;
    const liveIdx = ids.indexOf("current");
    if (liveIdx >= 0) return ["current", LEAD_ID, ...ids.filter((id) => id !== "current")];
    return [LEAD_ID, ...ids];
  }, [events, leadCard]);

  const selectEvent = useCallback((id: string) => {
    setSelectedId(id);
    const container = cardsRef.current;
    const step = cardStep();
    if (!container || !step) return;
    const index = slideIds.indexOf(id);
    if (index < 0) return;
    programmaticScrollRef.current = true;
    container.scrollTo({ left: index * step, behavior: "smooth" });
    window.setTimeout(() => { programmaticScrollRef.current = false; }, 400);
  }, [slideIds, cardStep]);

  const handleCardsScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const container = cardsRef.current;
    const step = cardStep();
    if (!container || !step) return;
    const id = slideIds[Math.round(container.scrollLeft / step)];
    if (id && id !== selectedId) setSelectedId(id);
  }, [slideIds, selectedId, cardStep]);

  // Tapped strip → its full details in a bottom sheet.
  const [sheetEvent, setSheetEvent] = useState<ChartEvent | null>(null);
  if (!visible || (events.length === 0 && !leadCard)) return null;

  // The first slide starts selected.
  const activeId = selectedId && slideIds.includes(selectedId) ? selectedId : slideIds[0];

  const dotsLayer = (
    <div ref={layerRef} className="chart-event-dots-layer">
      {events.map((ev) => {
        const pos = positions[ev.id];
        if (!pos) return null;
        return (
          <button
            key={ev.id}
            type="button"
            className={`chart-event-dot${ev.id === activeId ? " chart-event-dot--active" : ""}`}
            style={{ left: pos.x, top: pos.y }}
            onClick={() => selectEvent(ev.id)}
            aria-label={eventTitle(ev)}
          />
        );
      })}
    </div>
  );

  const cardsAndPager = (
    <>
      <div ref={cardsRef} className="chart-event-cards" onScroll={handleCardsScroll}>
        {slideIds.map((id) => {
          if (id === LEAD_ID) return leadCard ? <LeadEventCard key={id} card={leadCard} /> : null;
          const ev = events.find((e) => e.id === id);
          return ev ? <EventCard key={id} ev={ev} onOpen={() => setSheetEvent(ev)} /> : null;
        })}
      </div>
      {slideIds.length > 1 && (
        <div className="chart-event-dots-pager">
          {slideIds.map((id) => (
            <button
              key={id}
              type="button"
              className={`chart-event-pager-dot${id === activeId ? " chart-event-pager-dot--active" : ""}`}
              onClick={() => selectEvent(id)}
              aria-label={id === LEAD_ID
                ? t("chartEvents.show", { title: leadCard?.title ?? t("chartEvents.summary") })
                : (() => { const ev = events.find((e) => e.id === id); return t("chartEvents.show", { title: ev ? eventTitle(ev) : t("chartEvents.event") }); })()}
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
      {sheetEvent && <EventSheet ev={sheetEvent} onClose={() => setSheetEvent(null)} />}
    </>
  );
}
