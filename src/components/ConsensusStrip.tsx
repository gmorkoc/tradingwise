// "coinhintz consensus" — every analysis tool's read on the current coin and
// timeframe in one place. Desktop: a sell→buy meter with one dot per tool.
// Phones: a card with a "3/4" ring and one row per tool. Locked tools show
// next to the ones the user has (each opens its own upsell / tool on tap).
import { useEffect, useRef, useState } from "react";
import { BottomSheet } from "./BottomSheet";
import "../styles/ConsensusStrip.css";

export type ConsensusTone = "bull" | "bear" | "neutral";

export interface ConsensusItem {
  id: string;
  name: string;
  /** Null = no read right now (locked, or nothing to show yet). */
  tone: ConsensusTone | null;
  /** What this tool says, in its own words ("Bearish", "Lean bullish"…). */
  label: string;
  /** Position on the sell (0) → buy (100) meter; null = not placed. */
  pos: number | null;
  locked?: boolean;
  onClick?: () => void;
  /** Phones' sheet: tapping the row expands this in place instead of
   *  going to the tool (e.g. the full Signal Check, the event list). */
  detail?: React.ReactNode;
}

interface Props {
  coinName: string;
  timeframe: string;
  items: ConsensusItem[];
  /** "panel" = the explained consensus view inline (phone tiles). */
  variant: "meter" | "card" | "panel";
  /** Phones: the line is one tap target that opens the full breakdown. */
  tapToOpen?: boolean;
  /** Phones: no line on the page — only the sheet, opened from elsewhere
   *  (the first slide under the chart) via the "open-consensus-sheet" event. */
  hideLine?: boolean;
  /** Reports the headline + count so other UI can show the same summary. */
  onSummary?: (s: { lead: ConsensusTone; headline: string; countLine: string }) => void;
}

const LockIcon = ({ size = 11 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export function ConsensusStrip({ coinName, timeframe, items, variant, tapToOpen = false, hideLine = false, onSummary }: Props) {
  const [sheetOpen, setSheetOpen] = useState(false);
  // Sheet: which row is expanded in place (ProVision opens first).
  const [expanded, setExpanded] = useState<string | null>(null);
  const openSheet = () => {
    setExpanded(items.find((i) => i.detail && !i.locked)?.id ?? null);
    setSheetOpen(true);
  };
  // Only tools that actually gave a read count — locked ones never drag the
  // number down.
  const read = items.filter((i) => !i.locked && i.tone !== null);
  const bear = read.filter((i) => i.tone === "bear").length;
  const bull = read.filter((i) => i.tone === "bull").length;
  const lead: ConsensusTone = bear > bull ? "bear" : bull > bear ? "bull" : "neutral";
  const agree = lead === "bear" ? bear : lead === "bull" ? bull : read.length - bear - bull;
  const leadWord = lead === "bear" ? "bearish" : lead === "bull" ? "bullish" : "mixed";
  const headline = lead === "neutral" ? "Mixed picture" : `Leaning ${leadWord}`;
  const countLine = read.length
    ? lead === "neutral" ? `${read.length} tools, no clear side` : `${agree} of ${read.length} tools ${leadWord}`
    : "No reads yet";
  const onSummaryRef = useRef(onSummary);
  onSummaryRef.current = onSummary;
  useEffect(() => { onSummaryRef.current?.({ lead, headline, countLine }); }, [lead, headline, countLine]);
  // Opened from elsewhere (the first slide under the chart on phones).
  const openSheetRef = useRef(openSheet);
  openSheetRef.current = openSheet;
  useEffect(() => {
    if (!tapToOpen) return;
    const onOpen = () => openSheetRef.current();
    window.addEventListener("open-consensus-sheet", onOpen);
    return () => window.removeEventListener("open-consensus-sheet", onOpen);
  }, [tapToOpen]);

  // Full breakdown: the ring + one row per tool. Shown on its own
  // (variant "card") or inside the phone bottom sheet. `afterTap` runs
  // first (closes the sheet) so the tool's own view isn't covered.
  const renderCard = (afterTap?: () => void, inSheet = false) => {
    const pct = read.length ? agree / read.length : 0;
    const C = 2 * Math.PI * 26;
    return (
      <section className={`cns-card cns--${lead}${inSheet ? " cns-card--sheet" : ""}`} aria-label="coinhintz consensus">
        <div className="cns-card-head">
          <div className="cns-ring">
            <svg width="60" height="60" viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r="26" className="cns-ring-track" />
              <circle cx="32" cy="32" r="26" className="cns-ring-fill" strokeDasharray={`${(pct * C).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 32 32)" />
            </svg>
            <span className="cns-ring-num">{read.length ? `${agree}/${read.length}` : "–"}</span>
          </div>
          <div className="cns-card-text">
            <span className="cns-kicker">coinhintz consensus · {timeframe}</span>
            <span className="cns-headline">{lead === "neutral" ? `${coinName}: mixed picture` : `${coinName} leans ${leadWord}`}</span>
            <span className="cns-sub">{countLine}</span>
          </div>
        </div>
        <div className="cns-rows">
          {items.map((it) => {
            const expandable = inSheet && !!it.detail && !it.locked;
            const isOpen = expandable && expanded === it.id;
            const tap = expandable
              ? () => setExpanded(isOpen ? null : it.id)
              : it.onClick ? () => { afterTap?.(); it.onClick!(); } : undefined;
            const Tag = tap ? "button" : "div";
            return (
              <div key={it.id} className={`cns-row-wrap${isOpen ? " cns-row-wrap--open" : ""}`}>
                <Tag
                  {...(tap ? { type: "button" as const, onClick: tap, "aria-expanded": expandable ? isOpen : undefined } : {})}
                  className={`cns-row${it.locked ? " cns-row--locked" : ""}`}
                >
                  <span className="cns-row-name">
                    {it.locked ? <span className="cns-lock"><LockIcon /></span> : <span className={`cns-dot cns-dot--${it.tone ?? "none"}`} />}
                    {it.name}
                  </span>
                  <span className={`cns-row-val cns-val--${it.locked ? "locked" : it.tone ?? "none"}`}>
                    {it.label}
                    {tap && <span className={`cns-chev${expandable ? " cns-chev--down" : ""}`} aria-hidden="true">›</span>}
                  </span>
                </Tag>
                {isOpen && <div className="cns-detail">{it.detail}</div>}
              </div>
            );
          })}
        </div>
        <p className="cns-note">Each tool reads the market its own way. Tap any row to see why. Not financial advice.</p>
      </section>
    );
  };
  if (variant === "card") return renderCard();

  // Phones' sheet: consensus only, explained — summary ring + sentence,
  // a sell↔buy map with one dot per tool, an agreement bar, and each tool
  // with what it measures. `close` runs before a tool's own action.
  const renderSheet = (close: () => void) => {
    const pct = read.length ? agree / read.length : 0;
    const C = 2 * Math.PI * 26;
    const neutralN = read.length - bear - bull;
    const pv = items.find((i) => i.id === "pv");
    const pvNote = pv && !pv.locked && pv.tone
      ? pv.tone === lead
        ? " ProVision, the main signal, agrees."
        : lead === "neutral" ? ` ProVision leans ${pv.tone === "bull" ? "bullish" : pv.tone === "bear" ? "bearish" : "neutral"}.` : " ProVision reads it differently."
      : "";
    const sentence = !read.length
      ? `No reads yet for the ${timeframe} chart.`
      : lead === "neutral"
        ? `Tools are split on the ${timeframe} chart — no clear side yet.${pvNote}`
        : `${agree} of ${read.length} tools lean ${leadWord} on the ${timeframe} chart.${pvNote}`;
    const placed = items.filter((i) => !i.locked && i.pos !== null).sort((a, b) => a.pos! - b.pos!);
    let last = -100;
    let flip = false;
    const pins = placed.map((it) => {
      const close2 = it.pos! - last < 14;
      flip = close2 ? !flip : false;
      last = it.pos!;
      return { it, below: flip };
    });
    const ABOUT: Record<string, string> = {
      pv: "Trend + 7 indicators, scored after fees",
      sig: "Market-wide setup scanner (4h)",
      tech: "Classic oscillators & moving averages",
      ai: "Candle patterns, read by AI",
      ev: "Price zones & recent key moments",
      agent: "Ask an AI analyst why",
    };
    return (
      <section className={`cns-x cns--${lead}`} aria-label="Consensus">
        <div className="cns-x-hero">
          <div className="cns-ring">
            <svg width="60" height="60" viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r="26" className="cns-ring-track" />
              <circle cx="32" cy="32" r="26" className="cns-ring-fill" strokeDasharray={`${(pct * C).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 32 32)" />
            </svg>
            <span className="cns-ring-num">{read.length ? `${agree}/${read.length}` : "–"}</span>
          </div>
          <div className="cns-card-text">
            <span className="cns-headline">{headline}</span>
            <span className="cns-x-sentence">{sentence}</span>
          </div>
        </div>

        <div className="cns-x-block">
          <span className="cns-x-label">Where each tool lands</span>
          <div className="cns-x-map">
            <div className="cns-x-track" />
            <span className="cns-x-mid" />
            {pins.map(({ it, below }) => (
              <span key={it.id} className={`cns-x-pin${below ? " cns-x-pin--below" : ""}`} style={{ left: `${Math.max(4, Math.min(96, it.pos!))}%` }}>
                <span className="cns-x-pin-name">{it.name}</span>
                <span className={`cns-x-pin-dot cns-pin-dot--${it.tone ?? "none"}`} />
              </span>
            ))}
          </div>
          <div className="cns-x-scale"><span>Sell</span><span>Neutral</span><span>Buy</span></div>
        </div>

        {read.length > 0 && (
          <div className="cns-x-block">
            <span className="cns-x-label">How much they agree</span>
            <div className="cns-x-split" aria-hidden="true">
              {bear > 0 && <span className="cns-x-split-bear" style={{ flex: bear }} />}
              {neutralN > 0 && <span className="cns-x-split-neutral" style={{ flex: neutralN }} />}
              {bull > 0 && <span className="cns-x-split-bull" style={{ flex: bull }} />}
            </div>
            <div className="cns-x-legend">
              <span><i className="cns-dot cns-dot--bear" />{bear} bearish</span>
              <span><i className="cns-dot cns-dot--neutral" />{neutralN} neutral</span>
              <span><i className="cns-dot cns-dot--bull" />{bull} bullish</span>
            </div>
          </div>
        )}

        <div className="cns-x-block">
          <span className="cns-x-label">The tools</span>
          <div className="cns-rows">
            {items.map((it) => {
              const tap = it.onClick ? () => { close(); it.onClick!(); } : undefined;
              const Tag = tap ? "button" : "div";
              return (
                <Tag key={it.id} {...(tap ? { type: "button" as const, onClick: tap } : {})} className={`cns-row cns-x-row${it.locked ? " cns-row--locked" : ""}`}>
                  <span className="cns-x-row-main">
                    <span className="cns-row-name">
                      {it.locked ? <span className="cns-lock"><LockIcon /></span> : <span className={`cns-dot cns-dot--${it.tone ?? "none"}`} />}
                      {it.name}
                    </span>
                    {ABOUT[it.id] && <span className="cns-x-about">{ABOUT[it.id]}</span>}
                  </span>
                  <span className={`cns-row-val cns-val--${it.locked ? "locked" : it.tone ?? "none"}`}>
                    {it.label}{tap && <span className="cns-chev" aria-hidden="true">›</span>}
                  </span>
                </Tag>
              );
            })}
          </div>
        </div>

        <p className="cns-note">
          How to read this: each dot is one coinhintz tool's read, from sell (left) to buy (right). The more tools on one side, the stronger the agreement. Not financial advice.
        </p>
      </section>
    );
  };
  if (variant === "panel") return renderSheet(() => {});

  // Desktop: one compact line in the Signal Check strip's style — title,
  // verdict, a small inline meter with one dot per tool, each tool's read
  // as plain text, locked tools as quiet purple links. Scrolls sideways if
  // it doesn't fit.
  const placed = items.filter((i) => !i.locked && i.pos !== null);
  const unlocked = items.filter((i) => !i.locked);
  const locked = items.filter((i) => i.locked);
  const arrow = (t: ConsensusTone | null) => (t === "bull" ? "▲" : t === "bear" ? "▼" : "–");
  // Phones: the whole line is one tap target (its parts aren't separate
  // buttons) that opens the full breakdown in a bottom sheet.
  const Item = (tapToOpen ? "span" : "button") as "button";
  const itemProps = (it: ConsensusItem) => (tapToOpen || !it.onClick ? {} : { type: "button" as const, onClick: it.onClick });

  const line = (
    <section
      className={`cns-line cns--${lead}${tapToOpen ? " cns-line--tap" : ""}`}
      aria-label="coinhintz consensus"
      title="Each dot is one coinhintz tool. Not financial advice."
      {...(tapToOpen ? { role: "button", tabIndex: 0, onClick: openSheet, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSheet(); } } } : {})}
    >
      <div className="cns-seg cns-seg--title">
        <span className="cns-line-title">Consensus</span>
        <span className="cns-line-coin">{coinName} · {timeframe}</span>
      </div>
      <div className="cns-seg cns-line-lead">
        <span className="cns-line-dot" aria-hidden="true" />
        {headline}<span className="cns-line-count"> · {countLine}</span>
      </div>
      <div className="cns-seg">
        <span className="cns-mini" aria-hidden="true">
          <span className="cns-mini-mid" />
          {placed.map((it) => (
            <span
              key={it.id}
              className={`cns-mini-dot cns-mini-dot--${it.tone ?? "none"}`}
              style={{ left: `${Math.max(3, Math.min(97, it.pos!))}%` }}
            />
          ))}
        </span>
      </div>
      <div className="cns-seg cns-tools">
        {unlocked.map((it) => {
          const Tag = !tapToOpen && it.onClick ? "button" : "span";
          return (
            <Tag
              key={it.id}
              {...itemProps(it)}
              className="cns-tool"
              title={`${it.name}: ${it.label}`}
            >
              <span className="cns-tool-name">{it.name}</span>
              <span className={`cns-tool-val cns-val--${it.tone ?? "none"}`}>{it.tone ? `${arrow(it.tone)} ` : ""}{it.label}</span>
            </Tag>
          );
        })}
      </div>
      {locked.length > 0 && (
        <div className="cns-seg cns-tools">
          {locked.map((it) => (
            <Item key={it.id} {...itemProps(it)} className="cns-tool cns-tool--locked">
              <LockIcon />
              <span className="cns-tool-name">{it.name}</span>
              <span className="cns-tool-val">{it.label}</span>
            </Item>
          ))}
        </div>
      )}
    </section>
  );

  if (!tapToOpen) return line;
  return (
    <>
      {!hideLine && line}
      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={`What's next for ${coinName}?`}
        ariaLabel={`What's next for ${coinName}?`}
        floating
      >
        {renderSheet(() => setSheetOpen(false))}
      </BottomSheet>
    </>
  );
}
