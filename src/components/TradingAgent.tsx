import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { Keyboard } from "@capacitor/keyboard";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { useAuth } from "../contexts/AuthContext";
import { supabase, hasAccess } from "../services/supabase";
import { CoinSymbol } from "../services/coinglass";
import type { Ticker24h } from "../services/coinglass";
import { AgentChartModal } from "./AgentChartModal";
import { LiquidationGauge } from "./LiquidationGauge";
import { formatLivePrice } from "./PriceChart";
import { OrderBookProfileModal } from "./OrderBookProfile";
import { isWebPushAvailable, isWebPushSubscribed, subscribeWebPush } from "../services/webPush";
import {
  fetchPortfolio, fetchAgentMessages, sendAgentMessage, setActionStatus, executeTrade, executeBasket, closePosition, updateCashBalance, acceptConsent, updatePreferences,
  fetchConversations, deleteConversation, addAgentNote, cancelWatch, confirmWatch, fetchWatchesForConversation, fetchAllWatches, fetchAgentPerformance, synthesizeAgentSpeech,
  AgentMessage, PaperPortfolio, PaperPosition, ConversationSummary, AgentWatch, AgentAction, BalanceUpdate, AgentPerformance, MarketInterval, CoinSnapshot, ShowChartInterval, PreferencesUpdate,
  PositionsListResponse, PositionsListItem, fetchClosedPositions, deleteAgentMessagesFrom,
} from "../services/paperTrading";

// Plain text input (no native number spinner), but still only lets the
// user type digits and a single decimal point — keeps "accepts a number"
// without type="number"'s stepper UI.
const sanitizeAmountInput = (raw: string): string => {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
};
// Estimated net profit/loss if TP/SL hits, for display only — the margin
// the agent proposed, at the live price it proposed it at. Real P&L is
// whatever the actual fill price is at execution/close time.
function estimateNetPnl(action: AgentAction): { profit: number; loss: number } | null {
  if (action.price == null || action.takeProfit == null || action.stopLoss == null) return null;
  const qty = (action.amountUsd * action.leverage) / action.price;
  const profit = action.side === "buy" ? qty * (action.takeProfit - action.price) : qty * (action.price - action.takeProfit);
  const loss = action.side === "buy" ? qty * (action.stopLoss - action.price) : qty * (action.price - action.stopLoss);
  return { profit, loss };
}
const formatPnl = (n: number): string => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
// Mirrors the edge function's own formatUsdAbbrev (trading-agent-reply) —
// same "$1.2B" style a trader actually says out loud, for the voice
// session's market-snapshot card.
const formatAbbrevUsd = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};
const formatMsgTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// crypto.randomUUID() requires a secure context (https, or localhost) —
// it's undefined (not just throwing) when testing over a plain-http local
// network IP, which made the "+ New chat" button silently throw and do
// nothing. Falls back to a manual v4-shaped id in that case.
const newConversationId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};
import "../styles/TradingAgent.css";

// iOS only (native SFSpeechRecognizer via the Capacitor plugin) — same
// scoping as push notifications/RevenueCat IAP elsewhere in this app.
// Desktop/web use the browser's own Web Speech API instead (WEB_SPEECH
// below) — same flow: the spoken words stream into the composer as text.
const NATIVE_SPEECH = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
type WebSpeechCtor = new () => {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null;
  start: () => void; stop: () => void;
};
const WEB_SPEECH_CTOR: WebSpeechCtor | null = NATIVE_SPEECH || typeof window === "undefined"
  ? null
  : ((window as unknown as { SpeechRecognition?: WebSpeechCtor; webkitSpeechRecognition?: WebSpeechCtor }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: WebSpeechCtor }).webkitSpeechRecognition
    ?? null);
// Voice input available at all (native app or a browser with Web Speech).
const SPEECH_AVAILABLE = NATIVE_SPEECH || !!WEB_SPEECH_CTOR;
// Gates the History list's swipe-to-delete gesture — a native iOS table-view
// convention, not something web/desktop users expect from a click-driven
// UI (they keep the always-visible trash-icon button instead).
const IS_IOS_NATIVE = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

// Same in-app-browser treatment DailyBrief.tsx already uses for its news
// links (see openNewsLink there) — native opens via an in-app browser
// (SFSafariViewController on iOS) instead of handing off to the system
// Safari app; web just lets the anchor's own target="_blank" handle it.
const openNewsLink = (e: React.MouseEvent<HTMLAnchorElement>, url: string) => {
  if (Capacitor.isNativePlatform()) {
    e.preventDefault();
    Browser.open({ url });
  }
};

// No-op on web/desktop. Medium rather than Light — Light was hard to feel
// reliably on-device (same tuning already used in PriceChart.tsx).
function hapticTap() {
  if (Capacitor.isNativePlatform()) {
    Haptics.impact({ style: ImpactStyle.Medium }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[hapticTap] Haptics.impact failed:", e);
    });
  }
}

// Same "Nm/h/d ago, then a plain date" convention NotificationsCenter
// already uses, for the History list's per-conversation timestamp.
function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Self-contained global widget (own floating trigger + panel), not wired
// into App.tsx's chart-grid layout like CoinChat's docked sidebar — this
// is intentionally available from anywhere in the app, not just the chart
// page, and mounting it this way keeps the blast radius on App.tsx to one
// line. Desktop: a right-docked slide-in panel. Mobile: a full-screen
// sheet portaled to <body>, same escape-ancestor-transform reasoning as
// CoinChat's mobile panel.
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 641px)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 641px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  return isDesktop;
}

// Crisp outline glyph (SF Symbols "trash" shape) instead of the 🗑 emoji —
// emoji rendering varies enough across devices/fonts that it read as fuzzy
// and off-brand next to the rest of this app's flat vector icons.
function TrashIcon({ size = 20, className, style }: { size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} style={style} xmlns="http://www.w3.org/2000/svg">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6m4-6v6"
        stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// SF Symbols "pin.fill"-ish shape — same crisp-outline convention as
// TrashIcon above, used both as the swipe-right action glyph and as the
// small pinned-row badge.
// Classic thumbtack silhouette (the Slack/Telegram "pin message" glyph) —
// a banded head tapering to a point, not the map/location-marker teardrop
// shape. Always solid (the "filled" prop is kept only so call sites that
// still pass it don't need updating, but it no longer changes anything —
// a pin is either shown or it isn't, there's no outline/filled distinction
// worth drawing at this size).
// `slash` renders this as "Unpin" instead of "Pin" — a diagonal strike
// through the same thumbtack glyph, used wherever the action this icon
// sits on would UNPIN an already-pinned conversation (the swipe/tap
// action, not the small "this one's pinned" row badge, which stays a
// plain pin either way since it's just status, not a button).
function PinIcon({ size = 20, className, style, slash = false }: { size?: number; filled?: boolean; className?: string; style?: React.CSSProperties; slash?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} style={style} xmlns="http://www.w3.org/2000/svg">
      <path d="M14.5 3a1 1 0 0 1 1 1v5.76l2.93 2.94a1 1 0 0 1-.7 1.71H13v4.1l-.86 1.98a.17.17 0 0 1-.28 0L11 18.51v-4.1H6.27a1 1 0 0 1-.7-1.71L8.5 9.76V4a1 1 0 0 1 1-1h5z" />
      {slash && <path d="M3.5 3.5l17 17" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" fill="none" />}
    </svg>
  );
}

// History row swipe-to-delete/swipe-to-pin (iOS native only) — rounded,
// floating pills revealed behind the row as it slides, Material-style per
// the reference design, rather than full-bleed colored rectangles.
// Swiping LEFT past SWIPE_REVEAL_WIDTH and releasing reveals the Delete
// pill (tap it to actually delete); swiping all the way past
// SWIPE_AUTO_DELETE_WIDTH and releasing deletes immediately with no second
// tap, Mail.app-style. Swiping RIGHT mirrors this for Pin/Unpin: past
// SWIPE_REVEAL_WIDTH reveals the pill (Pin or Unpin, whichever applies —
// see PinIcon's `slash` prop), past SWIPE_AUTO_PIN_WIDTH and releasing
// toggles immediately with no second tap, same as delete. Tapping the row
// while a swipe is open (this
// one's or another's) just closes it, same as tapping elsewhere in a real
// swiped-open table view — it never also navigates on that same tap. Only
// one row stays revealed at a time, and only one side at once
// (`revealed`/`onReveal` are lifted to the parent so opening one row/side
// closes any other already open).
//
// Deliberately NOT using React's onTouchStart/onTouchMove/onTouchEnd props
// here — React attaches its root touch listeners as passive by default, so
// e.preventDefault() inside a synthetic touchmove handler silently does
// nothing, and the page's own vertical scroll ends up fighting the drag on
// a real device even though the JS state updates look correct in review.
// Native addEventListener with {passive:false} is the only way to actually
// suppress that scroll once a horizontal drag is detected.
const SWIPE_REVEAL_WIDTH = 76;
const SWIPE_AUTO_DELETE_WIDTH = 180;
const SWIPE_AUTO_PIN_WIDTH = 140;
type RevealSide = "left" | "right" | null;
function ConversationRow({
  conversation, active, pinned, revealed, onReveal, onOpen, onDelete, onTogglePin,
}: {
  conversation: ConversationSummary;
  active: boolean;
  pinned: boolean;
  revealed: RevealSide;
  onReveal: (side: RevealSide) => void;
  onOpen: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  // null while not actively dragging — rendered offset then falls back to
  // the committed `revealed` state instead, which is what makes the row
  // snap-animate back into place with a CSS transition rather than jumping.
  const [dragX, setDragX] = useState<number | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // Mutable mirrors for the native listeners below — they're attached once
  // (empty effect deps) so they always need the CURRENT values, not
  // whatever was current when the listener was first attached.
  const stateRef = useRef({ revealed, dragX, pinned, onReveal, onDelete, onTogglePin });
  stateRef.current = { revealed, dragX, pinned, onReveal, onDelete, onTogglePin };

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    let start: { x: number; y: number; locked: "h" | "v" | null } | null = null;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, locked: null };
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (start.locked === null) {
        // Not enough movement yet to tell a horizontal swipe from the
        // list's own vertical scroll apart — deciding too early misreads
        // an almost-vertical scroll as a swipe attempt. Kept small (not
        // the earlier 8px) so the row actually starts tracking the finger
        // almost immediately instead of feeling like it has a dead zone.
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        start.locked = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      }
      if (start.locked !== "h") return; // let the list scroll normally
      e.preventDefault();
      const base = stateRef.current.revealed === "left" ? -SWIPE_REVEAL_WIDTH
        : stateRef.current.revealed === "right" ? SWIPE_REVEAL_WIDTH
        : 0;
      setDragX(Math.min(SWIPE_AUTO_PIN_WIDTH + 40, Math.max(-SWIPE_AUTO_DELETE_WIDTH - 40, base + dx)));
    };
    const onTouchEnd = () => {
      start = null;
      const x = stateRef.current.dragX;
      if (x == null) return;
      if (x <= -SWIPE_AUTO_DELETE_WIDTH) {
        hapticTap();
        stateRef.current.onDelete();
        setDragX(null);
        return;
      }
      if (x >= SWIPE_AUTO_PIN_WIDTH) {
        hapticTap();
        stateRef.current.onTogglePin();
        stateRef.current.onReveal(null);
        setDragX(null);
        return;
      }
      if (x < 0) {
        const nowRevealed = x < -SWIPE_REVEAL_WIDTH / 2;
        if (nowRevealed !== (stateRef.current.revealed === "left")) hapticTap();
        stateRef.current.onReveal(nowRevealed ? "left" : null);
      } else if (x > 0) {
        const nowRevealed = x > SWIPE_REVEAL_WIDTH / 2;
        if (nowRevealed !== (stateRef.current.revealed === "right")) hapticTap();
        stateRef.current.onReveal(nowRevealed ? "right" : null);
      } else {
        stateRef.current.onReveal(null);
      }
      setDragX(null);
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  const x = dragX ?? (revealed === "left" ? -SWIPE_REVEAL_WIDTH : revealed === "right" ? SWIPE_REVEAL_WIDTH : 0);
  // Fades/scales in over the first 36px of drag instead of popping in at
  // full size the instant the row starts moving — reads as the pill
  // genuinely "appearing" as you swipe, matching the Material-style
  // reference, rather than being an already-fully-formed shape that was
  // simply uncovered. A plain opacity/transform tween (not an animated
  // `width`, which forces layout on every single touchmove frame) is also
  // what actually fixes the jank — this is compositor-only.
  const deleteProgress = Math.min(1, Math.max(0, -x) / 36);
  const pinProgress = Math.min(1, Math.max(0, x) / 36);

  return (
    <div className="ta-history-item-swipe">
      <div className="ta-history-item-swipe-actions ta-history-item-swipe-actions--left">
        <button
          type="button"
          className="ta-history-item-swipe-pin"
          onClick={() => { hapticTap(); onTogglePin(); onReveal(null); }}
          aria-label={pinned ? "Unpin conversation" : "Pin conversation"}
        >
          <PinIcon size={22} slash={pinned} className="ta-history-item-swipe-icon" style={{ transform: `scale(${0.6 + 0.4 * pinProgress})` }} />
        </button>
      </div>
      <div className="ta-history-item-swipe-actions">
        <button
          type="button"
          className="ta-history-item-swipe-delete"
          onClick={() => { hapticTap(); onDelete(); }}
          aria-label="Delete conversation"
        >
          <TrashIcon size={22} className="ta-history-item-swipe-icon" style={{ transform: `scale(${0.6 + 0.4 * deleteProgress})` }} />
        </button>
      </div>
      <div
        ref={rowRef}
        className={`ta-history-item${active ? " ta-history-item--active" : ""}`}
        style={{ transform: `translateX(${x}px)`, transition: dragX == null ? "transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)" : "none", touchAction: "pan-y" }}
      >
        <button
          type="button"
          className="ta-history-item-main"
          onClick={() => { if (revealed) { onReveal(null); return; } onOpen(); }}
        >
          <span className="ta-history-item-preview-row">
            {pinned && <PinIcon size={11} filled className="ta-history-item-pin-badge" />}
            <span className="ta-history-item-preview">{conversation.preview || "(empty)"}</span>
          </span>
          <span className="ta-history-item-meta">{conversation.messageCount} message{conversation.messageCount === 1 ? "" : "s"} · {timeAgo(conversation.updatedAt)}</span>
        </button>
      </div>
    </div>
  );
}

interface Props {
  selectedCoin?: string | null;
  // Mobile-only (FloatingNavBar renders the trigger itself there, raised
  // in the bar's center) — desktop keeps this component's own floating
  // "Agent Ready" button exactly as before, untouched by that mobile work.
  hideTrigger?: boolean;
  // Gates the header's expanding-icon-cluster layout (Concept 4 of the
  // header redesign) — mobile only, by explicit request; desktop keeps
  // the plain row of separate icon buttons untouched.
  isMobile?: boolean;
  // Jumps the main dashboard to one of NAV_SECTIONS (edge function) —
  // powers the "Open <page> →" button a message's navigateTo renders.
  // Same shape as App.tsx's own setActiveSection, just typed loosely here
  // since this component doesn't import SectionId.
  onNavigateToSection?: (section: string) => void;
  // Same live-price map App.tsx already feeds DailyBrief's ticker chips —
  // lets the open-positions card show real unrealized P&L instead of just
  // entry price. Optional: a position still renders fine (just without a
  // P&L figure) before the first ticker fetch resolves.
  coinTickers?: Map<string, Ticker24h>;
  // Called instead of opening the panel when a non-elite user tries to —
  // see the trigger/open gating below. Same prop FloatingNavBar already
  // takes for its own mobile Agent button (agentLocked/onAgentLocked).
  // Opens the dedicated Elite upsell card (EliteUpsellModal), not the
  // generic multi-tier UpgradeModal — Agent Ready is the one reason shown.
  onAgentLocked?: () => void;
  // Opens the app's existing Contact/Feedback form (App.tsx's ContactForm
  // — same destination as the side drawer's "Contact / Feedback" row) —
  // the Hub bottom sheet's "Report an Issue" card, mobile only, reuses it
  // rather than building a second feedback mechanism.
  onReportIssue?: () => void;
  // One-time flashy "try Agent Ready" showcase (App.tsx owns the
  // localStorage flag + timing — this just plays it, anchored to the
  // trigger below, when true). No-ops entirely when hideTrigger is set
  // (mobile), since there's no .ta-trigger here to anchor it to there —
  // FloatingNavBar's own .fnb-agent-item plays the mobile equivalent.
  showIntroShowcase?: boolean;
  // Advance Chart page — the floating trigger reads "Ask Agent ready"
  // there instead of the normal steady-state "Agent ready" (App.tsx
  // passes this based on activeSection), since that page's whole point
  // is asking it to analyze the chart rather than general trading chat.
  // Only the steady-state label changes — the one-time first-use "Agent
  // is connecting" typing sequence stays the same everywhere.
  triggerLabel?: string;
  // Advance Chart page again — tapping the trigger there (while closed)
  // dispatches "request-chart-screenshot" instead of just opening blank;
  // PriceChart.tsx listens for that, captures the chart, and dispatches
  // back "open-trading-agent-with-image" (the same event this component
  // already listens for elsewhere) with the result. Closing an already-
  // open panel still works exactly as a normal toggle either way.
  triggerCapturesChart?: boolean;
}

// Plain monochrome SVG, not an emoji — a colored bell emoji stood out
// jarringly next to this panel's otherwise text-glyph icons (+, ☰, ✕).
// Reused everywhere a watch/alert needs an icon so they all match.
function BellIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "-2px", flexShrink: 0 }}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

// Plain monochrome stacked-bars glyph for the header's "Positions" button —
// same reasoning as BellIcon above, just a trade-ledger shape instead of a
// bell.
function PositionsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "-2px", flexShrink: 0 }}>
      <rect x="3" y="12" width="5" height="9" />
      <rect x="10" y="7" width="5" height="14" />
      <rect x="17" y="3" width="4" height="18" />
    </svg>
  );
}

// Plain inline SVG polyline — no charting library, no canvas, no touch/
// scroll handling of its own (deliberately: this just draws a static
// shape from a fixed array of closes, nothing interactive or resizing
// in response to gestures). Scales to fill a fixed box; a flat/empty
// series (too few points, or a coin with literally no movement) renders
// a flat center line instead of leaving the box blank.
function Sparkline({ closes, width = 130, height = 36 }: { closes: number[]; width?: number; height?: number }) {
  if (closes.length < 2) {
    return (
      <svg width={width} height={height} className="ta-sparkline">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} className="ta-sparkline-flat" />
      </svg>
    );
  }
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const coords = closes.map((c, i) => ({
    x: (i / (closes.length - 1)) * width,
    y: height - ((c - min) / range) * height,
  }));
  const points = coords.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const up = closes[closes.length - 1] >= closes[0];

  // Halftone dot-fill under the line, like a stock-app sparkline — a grid
  // of dots clipped to the area below the curve, fading out with depth.
  // lineYAt interpolates the line's own y between its two nearest real
  // data points, since the dot grid's x spacing won't generally land on
  // one of those points exactly.
  const lineYAt = (x: number) => {
    for (let i = 1; i < coords.length; i++) {
      if (x <= coords[i].x) {
        const a = coords[i - 1];
        const b = coords[i];
        const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
        return a.y + (b.y - a.y) * t;
      }
    }
    return coords[coords.length - 1].y;
  };
  const DOT_SPACING = 4;
  const dots: { x: number; y: number; opacity: number }[] = [];
  for (let x = 0; x <= width; x += DOT_SPACING) {
    const lineY = lineYAt(x);
    const firstRow = Math.ceil(lineY / DOT_SPACING) * DOT_SPACING;
    for (let y = firstRow; y <= height; y += DOT_SPACING) {
      const depth = (y - lineY) / (height - lineY || 1);
      dots.push({ x, y, opacity: Math.max(0, 1 - depth) * 0.55 });
    }
  }

  return (
    <svg width={width} height={height} className={`ta-sparkline ta-sparkline--${up ? "up" : "down"}`}>
      <g className="ta-sparkline-dots">
        {dots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={0.9} opacity={d.opacity} />
        ))}
      </g>
      <polyline points={points} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Renders a real, tappable list of the user's open or closed positions —
// set server-side (positionsList, see trading-agent-reply/index.ts) when
// the user asks to actually SEE their positions rather than ask a prose
// question about them. Tapping a row expands it in place (local state, no
// round-trip) into the full detail: entry/current-or-exit price, size,
// leverage, P&L, and open/close dates. Live P&L for an "open" item comes
// from the same coinTickers map the positions card above already uses;
// "closed" items show the already-known realized P&L directly.
function PositionsListCard({ list, coinTickers, onClosePosition, closingKey }: {
  list: PositionsListResponse;
  coinTickers?: Map<string, Ticker24h>;
  // Only ever passed from the dedicated Positions view (TradingAgent's
  // header-triggered full-screen view, not the chat-triggered card) —
  // lets "open" rows actually be closed from here too, same action as the
  // portfolio header's own Close button.
  onClosePosition?: (item: PositionsListItem) => void;
  closingKey?: string | null;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const { status, items } = list;

  if (items.length === 0) {
    return (
      <div className="ta-positions-list">
        <span className="ta-positions-list-label">{status === "open" ? "Open Positions" : "Closed Positions"}</span>
        <p className="ta-positions-list-empty">{status === "open" ? "No open positions right now." : "No closed positions yet."}</p>
      </div>
    );
  }

  return (
    <div className="ta-positions-list">
      <div className="ta-positions-list-head">
        <span className="ta-positions-list-label">{status === "open" ? "Open Positions" : "Closed Positions"}</span>
        <span className="ta-positions-list-hint">Tap a position for full details</span>
      </div>
      {items.map((item, i) => {
        const isOpenRow = expanded === i;
        const livePrice = status === "open" ? coinTickers?.get(item.coin)?.price : undefined;
        const pnl = status === "open"
          ? (livePrice && livePrice > 0 ? (livePrice - item.avgEntryPrice) * item.qty * (item.side === "short" ? -1 : 1) : null)
          : (item.realizedPnl ?? null);
        return (
          <div key={`${item.coin}:${item.market}:${i}`} className="ta-positions-list-item">
            <button type="button" className="ta-positions-list-row" onClick={() => setExpanded(isOpenRow ? null : i)}>
              <span className="ta-positions-list-coin">{item.coin}</span>
              <span className="ta-positions-list-qty">{item.qty} @ ${item.avgEntryPrice.toLocaleString()}</span>
              {pnl != null && (
                <span className={`ta-position-pnl${pnl >= 0 ? " positive" : " negative"}`}>
                  {pnl >= 0 ? "+" : "-"}${Math.abs(pnl).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              )}
              {status === "closed" && item.closeReason && (
                <span className="ta-positions-list-tag">{item.closeReason.replace("_", " ")}</span>
              )}
              <span className={`ta-positions-list-chevron${isOpenRow ? " ta-positions-list-chevron--open" : ""}`}>▾</span>
            </button>
            {status === "open" && item.market === "futures" && item.liquidationPrice != null && livePrice && livePrice > 0 && (
              <div className="ta-positions-list-gauge">
                <LiquidationGauge
                  side={item.side}
                  entryPrice={item.avgEntryPrice}
                  liquidationPrice={item.liquidationPrice}
                  takeProfitPrice={item.takeProfitPrice ?? null}
                  currentPrice={livePrice}
                />
              </div>
            )}
            {isOpenRow && (
              <div className="ta-positions-list-detail">
                <div className="ta-proposal-detail">
                  <span>Side</span>
                  <strong>{item.market === "futures" ? `${item.side === "long" ? "LONG" : "SHORT"} ${item.leverage}x` : "SPOT"}</strong>
                </div>
                <div className="ta-proposal-detail">
                  <span>Size</span>
                  <strong>{item.qty} {item.coin}</strong>
                </div>
                <div className="ta-proposal-detail">
                  <span>Entry</span>
                  <strong>${item.avgEntryPrice.toLocaleString()}</strong>
                </div>
                <div className="ta-proposal-detail">
                  <span>{status === "open" ? "Current" : "Exit"}</span>
                  <strong>
                    {status === "open"
                      ? (livePrice ? formatLivePrice(livePrice) : "—")
                      : (item.exitPrice != null ? `$${item.exitPrice.toLocaleString()}` : "—")}
                  </strong>
                </div>
                <div className="ta-proposal-detail">
                  <span>P&L</span>
                  <strong className={pnl != null ? (pnl >= 0 ? "ta-proposal-tp" : "ta-proposal-sl") : undefined}>
                    {pnl != null ? `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
                  </strong>
                </div>
                <div className="ta-proposal-detail">
                  <span>Opened</span>
                  <strong>{item.openedAt ? new Date(item.openedAt).toLocaleString() : "—"}</strong>
                </div>
                {status === "closed" && (
                  <div className="ta-proposal-detail">
                    <span>Closed</span>
                    <strong>{item.closedAt ? new Date(item.closedAt).toLocaleString() : "—"}</strong>
                  </div>
                )}
                {status === "open" && onClosePosition && (
                  <button
                    type="button"
                    className="ta-position-close ta-positions-list-close"
                    onClick={(e) => { e.stopPropagation(); onClosePosition(item); }}
                    disabled={closingKey === `${item.coin}:${item.market}`}
                  >
                    {closingKey === `${item.coin}:${item.market}` ? "Closing…" : "Close Position"}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Single-trade proposal card, rendered in the normal message feed for any
// turn that proposes one — voice-dictated turns land here too now (the
// reply is a normal message bubble regardless of how it was sent), so
// there's no separate voice-only rendering of this to keep in sync.
function ActionProposalCard({
  message, executingId, onConfirm, onDismiss,
}: {
  message: AgentMessage;
  executingId: number | null;
  onConfirm: (m: AgentMessage) => void;
  onDismiss: (m: AgentMessage) => void;
}) {
  const action = message.action;
  if (!action) return null;
  const pnl = estimateNetPnl(action);
  return (
    <div className={`ta-proposal ta-proposal--${message.actionStatus}`}>
      <div className="ta-proposal-row">
        <span className={`ta-proposal-side ta-proposal-side--${action.side}`}>
          {action.market === "futures"
            ? (action.side === "buy" ? "▲ LONG" : "▼ SHORT")
            : (action.side === "buy" ? "▲ BUY" : "▼ SELL")}
        </span>
        <span className="ta-proposal-coin">{action.coin}</span>
        <span className="ta-proposal-market">
          {action.market === "futures" ? `FUTURES ${action.leverage}x` : "SPOT"}
        </span>
      </div>
      <div className="ta-proposal-details">
        <div className="ta-proposal-detail">
          <span>{action.market === "futures" ? "Margin" : "Cost"}</span>
          <strong>${action.amountUsd.toLocaleString()}</strong>
        </div>
        {action.market === "futures" && (
          <div className="ta-proposal-detail">
            <span>Notional</span>
            <strong>${(action.amountUsd * action.leverage).toLocaleString()}</strong>
          </div>
        )}
        {action.takeProfit != null && (
          <div className="ta-proposal-detail">
            <span>Take Profit</span>
            <strong className="ta-proposal-tp">
              ${action.takeProfit.toLocaleString()}
              {pnl && <span className="ta-proposal-pnl"> ({formatPnl(pnl.profit)})</span>}
            </strong>
          </div>
        )}
        {action.stopLoss != null && (
          <div className="ta-proposal-detail">
            <span>Stop Loss</span>
            <strong className="ta-proposal-sl">
              ${action.stopLoss.toLocaleString()}
              {pnl && <span className="ta-proposal-pnl"> ({formatPnl(pnl.loss)})</span>}
            </strong>
          </div>
        )}
      </div>
      {action.reason && <p className="ta-proposal-reason">{action.reason}</p>}
      {message.actionStatus === "pending" ? (
        <div className="ta-proposal-actions">
          <button
            type="button"
            className="ta-proposal-confirm"
            onClick={() => onConfirm(message)}
            disabled={executingId === message.id}
          >
            {executingId === message.id ? "Executing…" : "Confirm"}
          </button>
          <button type="button" className="ta-proposal-dismiss" onClick={() => onDismiss(message)}>
            Dismiss
          </button>
        </div>
      ) : (
        <span className="ta-proposal-status">
          {message.actionStatus === "confirmed" ? "✓ Executed" : "Dismissed"}
        </span>
      )}
    </div>
  );
}

export function TradingAgent({ selectedCoin, hideTrigger, isMobile, coinTickers, onNavigateToSection, onAgentLocked, onReportIssue, showIntroShowcase, triggerLabel = "Agent ready", triggerCapturesChart }: Props) {
  const { user, tier, profile } = useAuth();
  const isDesktop = useIsDesktop();

  // Elite-only (not Pro) — a live chat agent burns through the AI quota far
  // faster than any other AI feature, so gating it at Pro would make Pro's
  // 100/week limit disappear in a handful of messages. Free/Pro users see
  // the trigger and can open the panel's shell, but any actual use gates to
  // the upgrade flow instead — same tier check FloatingNavBar already
  // applies to its own mobile Agent button (agentLocked={!hasAccess(tier,
  // "elite")}), just enforced here too so every entry point (this
  // component's own trigger, "open-trading-agent"/"toggle-trading-agent"
  // dispatches from notifications/GlobalSearch/FloatingNavBar) is covered
  // centrally rather than trusting each caller.
  const canUseAgent = !!user && hasAccess(tier, "elite");

  // Deliberately NOT persisted to localStorage (unlike portfolioCollapsed
  // below) — localStorage survives a full close+relaunch (a fresh WebView/
  // JS process), so persisting this reopened the panel automatically even
  // after the user had genuinely closed the app, not just backgrounded it.
  // Plain in-memory state gives exactly the wanted behavior for free: a
  // real background→foreground cycle (the process stays alive) leaves this
  // untouched, so the panel is still open if it was open right before
  // minimizing; a true close+reopen is a new process that starts closed.
  const [open, setOpen] = useState(false);

  // One-time flashy showcase (App.tsx owns the localStorage flag/timing,
  // this just plays the animation for ~5s once it flips true and stops
  // early if the user taps the trigger — see the button's onClick below).
  const [showcasePlaying, setShowcasePlaying] = useState(false);
  useEffect(() => {
    // hideTrigger (mobile) means this component never renders .ta-trigger
    // at all — without this check the callout below would still render,
    // floating with nothing to point at (FloatingNavBar's own
    // .fnb-agent-item is what plays this on mobile instead).
    if (!showIntroShowcase || hideTrigger) return;
    setShowcasePlaying(true);
    const id = window.setTimeout(() => setShowcasePlaying(false), 5200);
    return () => window.clearTimeout(id);
  }, [showIntroShowcase, hideTrigger]);

  // Tapping a watch-triggered/position-closed push notification (web or
  // native — see webPush.ts/pushNotifications.ts's "agent_watch"/
  // "agent_position_close" routing) dispatches this so the panel actually
  // opens instead of the tap just focusing/launching the app with nothing
  // else happening.
  useEffect(() => {
    const onOpen = () => {
      if (!canUseAgent) { onAgentLocked?.(); return; }
      setOpen(true);
    };
    window.addEventListener("open-trading-agent", onOpen);
    return () => window.removeEventListener("open-trading-agent", onOpen);
  }, [canUseAgent, onAgentLocked]);

  // "Ask Agent Ready" button (PriceChart.tsx, Advance Chart page) listener
  // moved below handleSend's own definition — see the comment there (it
  // calls handleSend directly, which isn't declared yet at this point in
  // the file; a plain `const` isn't hoisted the way a function
  // declaration would be).

  // FloatingNavBar's own raised Agent button (mobile, see hideTrigger
  // above) dispatches this on tap instead of calling setOpen directly —
  // it's a toggle (open AND close), unlike "open-trading-agent" above
  // (notification taps should always open, never accidentally close an
  // already-open panel).
  useEffect(() => {
    const onToggle = () => {
      if (!canUseAgent) { onAgentLocked?.(); return; }
      setOpen((v) => !v);
    };
    window.addEventListener("toggle-trading-agent", onToggle);
    return () => window.removeEventListener("toggle-trading-agent", onToggle);
  }, [canUseAgent, onAgentLocked]);

  // Browser notifications require an explicit user action to request
  // (see webPush.ts) — agent-watch-scan already sends a web push the
  // moment a watch triggers or a position auto-closes, but without this
  // prompt most desktop users would never have a subscription row at all,
  // so that push would have nobody to deliver to.
  const [webPushSubscribed, setWebPushSubscribed] = useState(true); // assume yes until checked, so the prompt never flashes on native/unsupported
  const [webPushPrompting, setWebPushPrompting] = useState(false);
  const [webPushError, setWebPushError] = useState<string | null>(null);
  useEffect(() => {
    if (isWebPushAvailable()) isWebPushSubscribed().then(setWebPushSubscribed);
  }, []);
  const handleEnableWebPush = async () => {
    if (!user) return;
    setWebPushPrompting(true);
    setWebPushError(null);
    const result = await subscribeWebPush(user.id);
    setWebPushSubscribed(result.ok);
    if (!result.ok) setWebPushError(result.error ?? "Couldn't enable browser notifications");
    setWebPushPrompting(false);
  };

  // Collapses the whole cash+positions block (not just positions) down to
  // a single header row — remembered across reopens, same persistence
  // pattern as `open`.
  const [portfolioCollapsed, setPortfolioCollapsed] = useState(
    () => localStorage.getItem("tradingAgentPortfolioCollapsed") === "true"
  );
  useEffect(() => {
    localStorage.setItem("tradingAgentPortfolioCollapsed", String(portfolioCollapsed));
  }, [portfolioCollapsed]);

  // A short "connecting" sequence plays over the panel every time it
  // opens, before the actual chat/onboarding content underneath is
  // revealed — same orb as the trigger button, just scaled up and
  // centered, with a staged label rather than jumping straight to ready.
  const [panelIntro, setPanelIntro] = useState(false);
  const [panelIntroLabel, setPanelIntroLabel] = useState("");
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const typeOut = (text: string, speed: number) => new Promise<void>((resolve) => {
      let i = 0;
      setPanelIntroLabel("");
      const tick = () => {
        if (cancelled) return resolve();
        i++;
        setPanelIntroLabel(text.slice(0, i));
        if (i >= text.length) resolve(); else setTimeout(tick, speed);
      };
      tick();
    });
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    setPanelIntro(true);
    (async () => {
      // Deliberately always "Agent ready" here, never triggerLabel — the
      // panel-open intro orb is a different moment from the floating
      // trigger pill (which DOES say "Ask Agent ready" on this page);
      // once the panel is open the "ask" already happened.
      await typeOut("Agent ready", 45);
      await sleep(1400);
      if (!cancelled) setPanelIntro(false);
    })();

    return () => { cancelled = true; };
  }, [open]);

  // One-time entrance sequence, held off until after the rest of the app
  // has rendered (window "load", not just this component mounting — this
  // widget is mounted as part of App.tsx's own first render, so without
  // this it would pop in alongside everything else instead of after it).
  // Phases: hidden (nothing shown yet) -> pop (bare orb) -> expanding
  // (pill opens, label types out) -> ready (settled, permanent).
  type Phase = "hidden" | "pop" | "expanding" | "ready";
  const [phase, setPhase] = useState<Phase>("hidden");
  const [label, setLabel] = useState("");
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    const begin = () => { if (!cancelledRef.current) setPhase("pop"); };
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    const onLoad = () => { loadTimer = setTimeout(begin, 400); };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    return () => {
      cancelledRef.current = true;
      window.removeEventListener("load", onLoad);
      if (loadTimer) clearTimeout(loadTimer);
    };
  }, []);

  useEffect(() => {
    if (phase !== "pop") return;
    const t = setTimeout(() => { if (!cancelledRef.current) setPhase("expanding"); }, 600);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== "expanding") return;
    const firstUse = localStorage.getItem("tradingAgentFirstUseDone") !== "true";
    const typeText = (text: string, speed = 38) => new Promise<void>((resolve) => {
      let i = 0;
      setLabel("");
      const tick = () => {
        if (cancelledRef.current) return resolve();
        i++;
        setLabel(text.slice(0, i));
        if (i >= text.length) resolve(); else setTimeout(tick, speed);
      };
      tick();
    });
    const eraseText = (from: string, speed = 22) => new Promise<void>((resolve) => {
      let i = from.length;
      const tick = () => {
        if (cancelledRef.current) return resolve();
        i--;
        setLabel(from.slice(0, Math.max(0, i)));
        if (i <= 0) resolve(); else setTimeout(tick, speed);
      };
      tick();
    });
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    (async () => {
      if (firstUse) {
        await typeText("Agent is connecting");
        await sleep(900);
        await eraseText("Agent is connecting");
        await typeText(triggerLabel);
        localStorage.setItem("tradingAgentFirstUseDone", "true");
      } else {
        setLabel(triggerLabel);
      }
      if (!cancelledRef.current) setPhase("ready");
    })();
  }, [phase]);

  // The effect above only ever runs once (the entrance animation, gated
  // on `phase`) — triggerLabel can change later on its own as the user
  // navigates to/from the Advance Chart page, without this component
  // remounting (it's mounted once at the App.tsx root). Once the
  // entrance has settled, just swap the label directly — no need to
  // replay "Agent is connecting" typing again for a plain text change.
  useEffect(() => {
    if (phase === "ready") setLabel(triggerLabel);
  }, [triggerLabel, phase]);

  const [portfolio, setPortfolio] = useState<PaperPortfolio | null>(null);
  const [performance, setPerformance] = useState<AgentPerformance | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [watches, setWatches] = useState<Map<string, AgentWatch>>(new Map());
  // Every watch across every conversation, for the dedicated watchlist
  // view — distinct from `watches` above, which is only the current
  // conversation's (used for inline chips in the feed).
  const [allWatches, setAllWatches] = useState<AgentWatch[]>([]);
  const [showWatches, setShowWatches] = useState(false);
  // Dedicated Positions view — same "header icon opens a full alternate
  // view" pattern as History/Watchlist above, so open/closed positions are
  // browsable directly without having to ask the agent for them in chat.
  // Open items come straight from `portfolio` (already kept live); closed
  // ones are fetched lazily, once, the first time this view opens.
  const [showPositions, setShowPositions] = useState(false);
  const [positionsTab, setPositionsTab] = useState<"open" | "closed">("open");
  const [closedPositions, setClosedPositions] = useState<PositionsListItem[] | null>(null);
  const [loadingClosedPositions, setLoadingClosedPositions] = useState(false);
  // Manual refresh (pull-to-refresh + a tap button) — neither open nor
  // closed positions update live on their own (no realtime subscription
  // the way chat messages get; a liquidation/TP/SL only ever lands here
  // once this view is re-fetched), so this is the only way to see a
  // position the watcher cron already closed in the background.
  const [refreshingPositions, setRefreshingPositions] = useState(false);
  const positionsListRef = useRef<HTMLDivElement>(null);
  const [positionsPullY, setPositionsPullY] = useState(0);
  const POSITIONS_PULL_THRESHOLD = 56;
  // Mobile-only header redesign (isMobile prop) — the 4 action icons
  // collapse into a single "Hub" button that slides up a bottom sheet
  // with four big labelled cards. Desktop's header is untouched (separate
  // render branch below, no hub-sheet logic at all).
  const [hubOpen, setHubOpen] = useState(false);
  // Mobile hub row: fade its right edge while there are more icons to
  // scroll to (hidden once scrolled to the end, or when everything fits).
  const [hubMoreRight, setHubMoreRight] = useState(false);
  const hubRowRef = useRef<HTMLDivElement | null>(null);
  const updateHubFade = (el: HTMLDivElement) => {
    setHubMoreRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
  };
  const [draft, setDraft] = useState("");
  // While the user is actively typing, the Send button shows "…"; it
  // switches back to "Send" once they pause (700ms with no keystrokes).
  const [typing, setTyping] = useState(false);
  const typingTimerRef = useRef<number | null>(null);
  const noteTyping = () => {
    setTyping(true);
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => setTyping(false), 700);
  };
  useEffect(() => () => { if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current); }, []);
  // "Ask Agent Ready" button on the Advance Chart page — a chart
  // screenshot (data: URL) attached to the NEXT message sent, shown as a
  // thumbnail above the composer until then. Not persisted into chat
  // history beyond that one send (insertMessage only stores `content`,
  // same as every other turn) — reopening/scrolling back won't show it
  // again, just the reply that analyzed it.
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  // Own silence detection, not just trusting the native plugin's own
  // endpointing (inconsistent across devices/OS versions in partialResults
  // mode) — reset on every new partial result, and firing stop()s the
  // session if 2s pass with nothing new, same as the user going quiet.
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Browser (Web Speech) recognizer while recording on desktop/web.
  const webRecRef = useRef<InstanceType<WebSpeechCtor> | null>(null);
  // Hidden file input behind the paperclip (attach an image).
  const attachInputRef = useRef<HTMLInputElement>(null);
  // The agent's own real reasoning text, streamed in live as it arrives —
  // not a simulated/templated indicator, the actual narration tokens the
  // model generates from the real market data it just fetched.
  const [liveThinking, setLiveThinking] = useState("");
  const [executingId, setExecutingId] = useState<number | null>(null);
  // The agent's proposed interval is a default, not the final answer — the
  // user can change it right on the proposal card before confirming, so
  // each pending watch message tracks its own (possibly edited) choice
  // here rather than always reading m.watch.interval back out.
  const [watchIntervalDrafts, setWatchIntervalDrafts] = useState<Record<number, MarketInterval>>({});
  const [cancellingWatchId, setCancellingWatchId] = useState<string | null>(null);
  const [closingPosition, setClosingPosition] = useState<string | null>(null);
  const [editingCash, setEditingCash] = useState(false);
  const [cashDraft, setCashDraft] = useState("");
  const [savingCash, setSavingCash] = useState(false);
  const [error, setError] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);
  // Scrolled to the end on every `draft` change while listening (see the
  // effect below) so the live transcript "slides" to keep the newest words
  // in view — an overwritten `.value` doesn't auto-follow the caret the way
  // real typing does, so without this the visible window just stayed
  // pinned to whatever showed first and the rest kept growing off-screen.
  const composerInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Consent (the risk disclaimer) is the only remaining gate — asked once
  // per account, ever, by the portfolio row's persistent
  // consent_accepted_at. Starting balance/typical trade size/leverage/focus
  // coins used to be a required 4-step form asked at the start of every
  // new conversation; they're now picked up naturally from conversation
  // instead (see the opener effect and handleSend's preferencesUpdate
  // handling below) — safe defaults already apply if never mentioned at all.
  const needsConsent = !portfolio?.consentAcceptedAt;

  // Conversations — ChatGPT-style: a history list (newest first), "+ New"
  // starts a fresh conversation_id, each past one can be reopened or
  // deleted. Current conversation id lives only in memory; nothing routes
  // on it, so a reload always lands on a fresh conversation (same as
  // opening a brand-new chat), with history still reachable from the list.
  const [conversationId, setConversationId] = useState<string>(newConversationId);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // Which conversation's row currently has a swipe revealed, and on which
  // side (iOS native only — see ConversationRow) — lifted up here rather
  // than kept local to each row so opening one row's swipe closes any
  // other that was already open, same as a real table view only ever
  // reveals one.
  const [revealedRow, setRevealedRow] = useState<{ id: string; side: "left" | "right" } | null>(null);
  // Pinned conversation ids — client-side only (localStorage), not synced
  // to the backend. This is a per-device "keep this at the top of my own
  // History list" preference, not conversation data itself, so it doesn't
  // need a schema change or to follow the account across devices.
  const PINNED_KEY = "tradingAgentPinnedConversations";
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(PINNED_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set(); }
  });
  const togglePin = (id: string) => {
    setPinnedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(PINNED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };
  // Pinned conversations first (in their own recency order), then
  // everything else in its own recency order — conversations itself is
  // already sorted newest-first by fetchConversations, so a stable
  // partition preserves that within each group.
  const sortedConversations = conversations.length === 0 ? conversations
    : [...conversations.filter((c) => pinnedIds.has(c.id)), ...conversations.filter((c) => !pinnedIds.has(c.id))];
  // "Here's how you delete one" demo — auto-reveal the top row's swipe
  // (reusing the exact same revealedRow mechanism/animation a real swipe
  // would, not a separate fake animation) and then auto-hide it again a
  // moment later, teaching the gesture exists without a tutorial screen.
  // With a short list (<=2 conversations) there's little else to look at
  // and not much risk of it feeling repetitive, so it plays EVERY time
  // History is opened in that case. Once the list grows past that, it
  // drops back to a genuine one-time-ever hint (localStorage-gated, plus a
  // ref so re-opening History quickly while it's still mid-flight can't
  // restart it) rather than nagging on every open indefinitely.
  const SWIPE_HINT_KEY = "tradingAgentSwipeHintShown";
  const swipeHintPlayedRef = useRef(false);
  useEffect(() => {
    if (!showHistory || !IS_IOS_NATIVE || sortedConversations.length === 0) return;
    const alwaysShow = sortedConversations.length <= 2;
    if (!alwaysShow) {
      if (swipeHintPlayedRef.current || localStorage.getItem(SWIPE_HINT_KEY)) return;
      swipeHintPlayedRef.current = true;
      localStorage.setItem(SWIPE_HINT_KEY, "true");
    }
    const firstId = sortedConversations[0].id;
    const openTimer = setTimeout(() => {
      setRevealedRow({ id: firstId, side: "left" });
      hapticTap();
    }, 600);
    const closeTimer = setTimeout(() => {
      setRevealedRow((cur) => (cur?.id === firstId ? null : cur));
    }, 2000);
    return () => { clearTimeout(openTimer); clearTimeout(closeTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHistory, conversations.length]);

  const loadAll = useCallback(async (convId: string) => {
    if (!user) return;
    const [p, m, w, perf] = await Promise.all([
      fetchPortfolio(user.id), fetchAgentMessages(user.id, convId), fetchWatchesForConversation(user.id, convId),
      fetchAgentPerformance(user.id),
    ]);
    setPortfolio(p);
    setMessages(m);
    setWatches(new Map(w.map((x) => [x.id, x])));
    setPerformance(perf);
    return m;
  }, [user]);

  const loadConversations = useCallback(async () => {
    if (!user) return;
    setConversations(await fetchConversations(user.id));
  }, [user]);

  useEffect(() => {
    if (open && user) loadAll(conversationId).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open, user, conversationId, loadAll]);

  // Loaded eagerly on open (not just when the History tab is tapped) so
  // the "continue last conversation" suggestion below has something to
  // check against right away, on a brand-new empty conversation, instead
  // of only becoming available after the user has already gone digging
  // through History once.
  useEffect(() => {
    if (open && user) loadConversations().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open, user, loadConversations]);
  // Newest conversation that isn't the one currently open and actually has
  // messages in it (a conversation with 0 messages is just this same empty
  // one re-fetched before its own first message landed — nothing to
  // "continue" there).
  const lastConversation = conversations.find((c) => c.id !== conversationId && c.messageCount > 0) ?? null;

  const [acceptingConsent, setAcceptingConsent] = useState(false);
  const handleAcceptConsent = async () => {
    if (!user || acceptingConsent) return;
    setAcceptingConsent(true);
    setError("");
    try {
      await acceptConsent(user.id);
      await loadAll(conversationId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that — please try again.");
    } finally {
      setAcceptingConsent(false);
    }
  };
  // Casual, friendly variants — picked at random each time so a user
  // starting several fresh conversations doesn't see the exact same canned
  // line over and over (reads as a script rather than a buddy saying hi).
  // Each takes the user's nickname/username (nullable — a profile row can
  // still have no username set) and folds it in naturally where it fits
  // that specific greeting's shape, rather than always tacking it on in
  // the same spot. Still carries the same substance every time (coin/
  // budget ask, fully optional, can defer), just a different wrapper.
  const OPENER_GREETINGS: Array<(name: string | null) => string> = [
    (name) => `Hello${name ? `, ${name}` : ""}! How are you doing? Got a coin in mind, or a budget/typical trade size you want me working with? Totally optional — otherwise just hit me with whatever's on your mind.`,
    (name) => `Hi${name ? ` ${name}` : ""}, how are you doing? Coin you're eyeing, or a budget you want me to keep in mind? No pressure — ask away whenever.`,
    (name) => `Hello${name ? `, ${name}` : ""}! How's it going? If there's a coin on your radar or a budget you want me working with, let me know. Or don't — we can figure it out as we go.`,
    (name) => `Hi${name ? ` ${name}` : ""}, how are you doing today? Got a coin you're thinking about, or a budget/trade size in mind? Happy to work with whatever you've got, or we can just dive straight in.`,
  ];
  // Fires once per brand-new, zero-message conversation (after consent is
  // already on file) — a warm, plain-spoken opener instead of the old
  // gated form, inviting a coin/budget but never blocking the composer on
  // it. Guarded by a ref (not state) so it can't double-fire from a
  // re-render while the one-time insert is in flight.
  const openerSentRef = useRef(false);
  useEffect(() => {
    if (!user || needsConsent || messages.length > 0 || openerSentRef.current) return;
    openerSentRef.current = true;
    (async () => {
      try {
        // Before minting a brand-new conversation + greeting, check for an
        // existing unused one (greeting-only, never actually replied to —
        // messageCount<=1) and reuse it instead. Without this, every fresh
        // mount of this panel (cold app launch, reload, etc.) piled up yet
        // another throwaway "Hello..." conversation that only ever had the
        // agent's own opener in it, cluttering History with near-identical
        // entries nobody ever continued.
        const existing = await fetchConversations(user.id);
        const reusable = existing.find((c) => c.messageCount <= 1 && c.id !== conversationId);
        if (reusable) {
          // openerSentRef stays true — this mount's opener duty is done by
          // redirecting, not inserting. The conversationId-change effect
          // elsewhere loads this conversation's existing single greeting
          // on its own; nothing left for this effect to do or re-check.
          setConversationId(reusable.id);
          return;
        }
        const nickname = profile?.username?.trim() || null;
        const greeting = OPENER_GREETINGS[Math.floor(Math.random() * OPENER_GREETINGS.length)](nickname);
        await addAgentNote(user.id, conversationId, greeting);
        await loadAll(conversationId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, needsConsent, messages.length, conversationId, profile?.username]);

  // Agent-authored messages can land at any time, not just while the panel
  // is open and a reply is actively streaming — agent-watch-scan posts a
  // confirmation message in the background (a watch triggering, a position
  // auto-closing) whenever its cron fires, regardless of what the user is
  // doing elsewhere in the app. This is what lets the trigger button
  // surface that with an unread dot instead of it sitting silently until
  // the panel happens to be reopened. Refs (not state) carry the latest
  // open/conversationId into the handler so the channel only subscribes
  // once per user instead of resubscribing on every state change.
  const [unread, setUnread] = useState(false);
  // Lets FloatingNavBar's raised Agent button show the same unread dot
  // this component's own trigger does, without lifting `unread` state up
  // to App.tsx — same event-bus convention the rest of this cross-
  // component signaling already uses (open-trading-agent, etc.).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("trading-agent-unread-change", { detail: { unread } }));
  }, [unread]);
  const openRef = useRef(open);
  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    openRef.current = open;
    if (open) {
      setUnread(false);
    } else {
      // Closing the panel mid-recording or mid-speech should stop both
      // rather than silently continuing in the background.
      sendAbortControllerRef.current?.abort();
      stopSpeaking();
      SpeechRecognition.stop().catch(() => { /* wasn't listening */ });
      setHubOpen(false);
    }
  }, [open]);
  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`agent-messages-watch-${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_messages", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const row = payload.new as { role: "user" | "agent"; conversation_id: string };
          if (row.role !== "agent") return;
          if (openRef.current && row.conversation_id === conversationIdRef.current) {
            loadAll(conversationIdRef.current).catch(() => {});
          } else {
            setUnread(true);
          }
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, loadAll]);

  // capacitor.config.ts sets Keyboard resize:'none' globally, so this
  // fixed-position panel never shrinks for the keyboard on its own —
  // whatever's at the bottom (a "Continue" button, the composer's send
  // button) just ends up hidden underneath it, only reachable after
  // tapping away to dismiss the keyboard first.
  //
  // Deliberately padding-bottom, NOT pulling the panel's own `bottom` up
  // (what CoinChat.tsx does for its fixed sheet) — this panel is a plain
  // DOM overlay inside the same single WebView as the rest of the app
  // (Capacitor has no separate native layer here), so shrinking its box
  // from the bottom opens a real gap in the DOM that briefly shows the
  // page underneath (the price chart) the instant the keyboard's own
  // dismiss animation uncovers that strip of screen, before keyboardDidHide
  // fires and closes the gap back up. Padding keeps the panel's own box
  // permanently pinned to the true screen edges (inset:0 never changes) —
  // it only resizes what's visible INSIDE that fully opaque box, so nothing
  // behind it is ever exposed, during a keyboard transition or otherwise.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    // Adding padding-bottom shrinks the feed's clientHeight without
    // touching its scrollTop — the scroll position that was previously
    // "at the bottom" is now short of the new, smaller bottom, leaving the
    // latest message hidden behind the keyboard until the user manually
    // scrolls. Re-scrolling to bottom on both the "will" (fires
    // immediately, keeps it from visibly lagging the keyboard's own slide-
    // up) and "did" (fires once the keyboard animation — and this panel's
    // own padding transition — has actually finished, correcting for any
    // layout settling the first call ran ahead of) events covers both ends
    // of the transition.
    const scrollFeedToBottom = () => {
      feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "auto" });
    };
    const showSub = Keyboard.addListener("keyboardWillShow", (info) => {
      if (panelRef.current) panelRef.current.style.paddingBottom = `${info.keyboardHeight}px`;
      scrollFeedToBottom();
    });
    const didShowSub = Keyboard.addListener("keyboardDidShow", scrollFeedToBottom);
    // keyboardWillHide, not keyboardDidHide — this panel's outer box stays
    // pinned via inset:0 regardless of padding (see the comment above this
    // effect), so unlike the bottom-shifting approach this padding change
    // was never unsafe to start early. Resetting it on "will" instead lets
    // the CSS transition (see .ta-panel in TradingAgent.css) run IN SYNC
    // with the keyboard's own dismiss animation; waiting for "did" meant
    // the composer only started sliding back down once the keyboard had
    // already fully disappeared, which read as a late, disconnected jump
    // — most visible right after sending a message, since tapping Send
    // blurs the composer input and dismisses the keyboard immediately.
    const hideSub = Keyboard.addListener("keyboardWillHide", () => {
      if (panelRef.current) panelRef.current.style.paddingBottom = "";
    });
    return () => {
      showSub.then((s) => s.remove());
      didShowSub.then((s) => s.remove());
      hideSub.then((s) => s.remove());
    };
  }, []);

  // liveThinking is in the deps too, not just messages/sending — without
  // it, the feed only jumped to the bottom once a message was added or
  // sending toggled, so the narration streaming in live (liveThinking
  // updates many times per response, well before the message itself
  // lands) kept growing past the visible area with no scroll following
  // it. "auto" (instant), not "smooth" — chunks can arrive every ~50-100ms
  // during streaming, faster than a smooth scroll animation can finish,
  // which looked stuttery; instant keeps new text visible the moment it
  // renders, same as other chat apps' live-streaming scroll behavior.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "auto" });
  }, [messages, sending, liveThinking]);

  // Same "keep the newest content in view" idea as the feed scroll above,
  // just horizontal — the composer input's value is overwritten wholesale
  // on every partial result (not typed character-by-character), so the
  // browser never gets the normal "caret moved, follow it" signal that
  // keeps a real typed input scrolled to the right spot on its own.
  useEffect(() => {
    if (!listening) return;
    const el = composerInputRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [draft, listening]);

  const handleNewConversation = () => {
    setConversationId(newConversationId());
    setMessages([]);
    setShowHistory(false);
    setShowWatches(false);
    setShowPositions(false);
    openerSentRef.current = false;
  };

  const handleOpenHistory = async () => {
    // showHistory/showWatches/showPositions are independent flags gating
    // alternate views in the same spot — without clearing the others here,
    // going Watches -> History -> (tap a conversation) left showWatches
    // stuck true, so opening a conversation dropped the user back on
    // Notifications instead of the chat they just tapped.
    setShowWatches(false);
    setShowPositions(false);
    setShowHistory(true);
    try { await loadConversations(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const loadAllWatches = useCallback(async () => {
    if (!user) return;
    setAllWatches(await fetchAllWatches(user.id));
  }, [user]);

  const handleOpenWatches = async () => {
    setShowHistory(false);
    setShowPositions(false);
    setShowWatches(true);
    try { await loadAllWatches(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  // Lazily fetched once per panel session, not re-fetched every time this
  // view reopens — a position closing (via this view's own Close button)
  // refreshes it explicitly instead (see handleClosePositionFromList).
  const loadClosedPositions = useCallback(async () => {
    if (!user) return;
    setLoadingClosedPositions(true);
    try {
      setClosedPositions(await fetchClosedPositions(user.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your closed positions — please try again.");
    } finally {
      setLoadingClosedPositions(false);
    }
  }, [user]);

  const handleOpenPositions = async () => {
    setShowHistory(false);
    setShowWatches(false);
    setShowPositions(true);
    if (closedPositions === null) await loadClosedPositions();
  };

  // Refreshes both tabs at once (not just whichever is currently active)
  // so switching tabs right after a manual refresh never shows stale
  // data either. Portfolio carries the live open positions; there's no
  // narrower "just open positions" fetch to call instead.
  const handleRefreshPositions = async () => {
    if (!user || refreshingPositions) return;
    setRefreshingPositions(true);
    try {
      const [p, closed] = await Promise.all([fetchPortfolio(user.id), fetchClosedPositions(user.id)]);
      setPortfolio(p);
      setClosedPositions(closed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't refresh your positions — please try again.");
    } finally {
      setRefreshingPositions(false);
    }
  };

  // Pull-to-refresh on the Positions list — same native addEventListener/
  // passive:false approach ConversationRow's swipe uses and for the same
  // reason (a passive-by-default synthetic touchmove can't actually
  // preventDefault the page's own scroll/bounce once a gesture is
  // detected). Only tracks a pull that starts while already scrolled to
  // the very top — anywhere else it's just a normal scroll.
  const refreshPositionsStateRef = useRef({ refreshingPositions, handleRefreshPositions });
  refreshPositionsStateRef.current = { refreshingPositions, handleRefreshPositions };
  useEffect(() => {
    if (!showPositions) return;
    const el = positionsListRef.current;
    if (!el) return;
    let startY: number | null = null;
    let tracking = false;
    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      tracking = el.scrollTop <= 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!tracking || startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || el.scrollTop > 0) {
        tracking = false;
        setPositionsPullY(0);
        return;
      }
      e.preventDefault();
      setPositionsPullY(Math.min(dy * 0.5, 90));
    };
    const onTouchEnd = () => {
      if (!tracking) return;
      tracking = false;
      startY = null;
      setPositionsPullY((cur) => {
        if (cur >= POSITIONS_PULL_THRESHOLD && !refreshPositionsStateRef.current.refreshingPositions) {
          hapticTap();
          refreshPositionsStateRef.current.handleRefreshPositions();
        }
        return 0;
      });
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [showPositions]);

  // Mirrors handleClosePosition, just resolves the real PaperPosition (with
  // marginUsd/liquidationPrice/etc. closePosition itself doesn't strictly
  // need, but the type does) from `portfolio` by coin+market, since the
  // generic PositionsListItem a card row hands back doesn't carry those.
  const handleClosePositionFromList = async (item: PositionsListItem) => {
    const match = portfolio?.positions.find((p) => p.coin === item.coin && p.market === item.market);
    if (!match) return;
    await handleClosePosition(match);
    // The close just appended a new row to the closed-trades log — refresh
    // the cached list so switching to the Closed tab shows it right away
    // instead of the stale pre-close snapshot.
    if (closedPositions !== null) await loadClosedPositions();
  };

  const handleOpenConversation = async (id: string) => {
    setConversationId(id);
    setShowHistory(false);
    setShowWatches(false);
    setShowPositions(false);
  };

  const handleDeleteConversation = async (id: string) => {
    if (!user) return;
    try {
      await deleteConversation(user.id, id);
      if (id === conversationId) handleNewConversation();
      await loadConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // `overrideContent` lets a tapped clarifying-question option send itself
  // as the next message without the user having to type it — it's just a
  // normal chat turn from the agent's perspective, so no special "answer"
  // plumbing is needed.
  // overrideImage lets a caller (the "Ask Agent Ready" auto-send path
  // below) pass the just-captured screenshot directly instead of going
  // through `pendingImage` state — setPendingImage+handleSend called back
  // to back in the same tick would otherwise read the STALE pre-update
  // state (setState isn't synchronous), silently sending with no image
  // attached. undefined (not passed) means "use whatever's already in
  // pendingImage", same as every normal manual send.
  // Latest handleSend, for callbacks created earlier (e.g. the web speech
  // recognizer's onend) that would otherwise hold a stale copy.
  const handleSendRef = useRef<(content?: string, image?: string | null) => void>(() => {});
  const handleSend = async (overrideContent?: string, overrideImage?: string | null) => {
    // An attached image with no text still sends, with a default question.
    const content = overrideContent ?? (draft.trim() || (pendingImage ? "What do you see in this image?" : ""));
    if (!content || sending) return;
    // Reset immediately (not after the round trip) so a typed message sent
    // while a voice reply would otherwise still be pending doesn't also
    // get spoken aloud — only the question that actually came in by voice
    // does.
    const viaVoice = lastSendWasVoiceRef.current;
    lastSendWasVoiceRef.current = false;
    // Snapshot + clear now (not after the round trip) — same reasoning as
    // draft below: this send "uses up" the pending screenshot regardless
    // of whether the request ultimately succeeds, same as the optimistic
    // draft clear just below.
    const imageForThisSend = overrideImage !== undefined ? overrideImage : pendingImage;
    setPendingImage(null);
    setDraft("");
    // Explicit blur before disabling — on WebKit, disabling an input that
    // still has focus can leave its blinking caret visually stuck in place
    // (a stray rendering artifact, not a real focus) since the OS doesn't
    // always repaint it away immediately once disabled={true} takes effect.
    composerInputRef.current?.blur();
    setSending(true);
    setError("");
    setLiveThinking("");
    // `messages` (pre-send) is passed as history so the agent can resolve
    // context-dependent follow-ups ("notify me when ready to buy" right
    // after discussing a coin) instead of seeing each message in isolation.
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    // Show the user's own message immediately instead of waiting on the
    // full round trip (insert + OpenAI call) — the real row from loadAll()
    // below replaces this local-only one once it resolves, whether that
    // succeeds or fails, so there's never a visible duplicate.
    setMessages((prev) => [...prev, {
      id: -Date.now(),
      conversationId,
      role: "user",
      content,
      action: null,
      basket: null,
      question: null,
      balanceUpdate: null,
      newsSources: null,
      actionStatus: null,
      watch: null,
      watchId: null,
      thoughtProcess: null,
      navigateTo: null,
      positionsList: null,
      imageUrl: imageForThisSend ?? null,
      createdAt: new Date().toISOString(),
    }]);
    // Lets a tap on the "Thinking…" bubble (handleInterruptTyping below)
    // cancel this exact in-flight request.
    const controller = new AbortController();
    sendAbortControllerRef.current = controller;
    try {
      // The resolved agent message already has everything speakLatestAgentReply
      // needs — firing it right here (not awaited) lets speech synthesis
      // start in parallel with the loadAll() reload below instead of
      // waiting on a second full round trip first, closer to how quickly a
      // real person replies after you stop talking.
      let preferencesUpdate: PreferencesUpdate | null = null;
      const agentMsg = await sendAgentMessage(
        user!.id, conversationId, content, history, selectedCoin, setLiveThinking, viaVoice, setLastMarketSnapshot,
        (req) => setChartModal({ coin: req.coin, interval: req.interval }),
        (req) => setOrderBookModalCoin(req.coin),
        controller.signal,
        (update) => { preferencesUpdate = update; },
        imageForThisSend,
      );
      // Applied before loadAll() below refreshes `portfolio`, so that
      // reload already reflects it instead of showing stale data for one
      // extra render — the model's own "reply" text is the user-facing
      // confirmation, this write just needs to actually land.
      if (preferencesUpdate) await updatePreferences(user!.id, preferencesUpdate);
      if (viaVoice) speakLatestAgentReply([agentMsg]);
    } catch (e) {
      // An interrupt (partialResults listener below) aborts this exact
      // request on purpose — the user is already mid-way into their next
      // turn by the time this rejects, so there's nothing to show here.
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : "Something went wrong — please try again.");
      }
    } finally {
      // Chat transcript always gets the full back-and-forth from loadAll
      // regardless of viaVoice — speaking the reply (above) is purely an
      // add-on for a voice-originated question, never a substitute for it.
      // positionsList is a real persisted column (positions_list) now, same
      // as action/basket/navigateTo, so this plain reload is enough on its
      // own — no extra patch-up needed (a prior transient-only version of
      // this field kept getting silently wiped out by this very reload, or
      // by the realtime subscription's own independent reload below,
      // moments after it first rendered).
      await loadAll(conversationId);
      setSending(false);
    }
  };
  handleSendRef.current = handleSend;

  // ── Copy / Edit under messages ─────────────────────────────────────────
  // Copy: puts a message's text on the clipboard ("Copied" for 1.5s).
  // Edit (your own messages): edit in place, then "Save & resend" removes
  // that message and everything after it (screen + database) and sends the
  // edited text, so Agent Ready answers it fresh.
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [pendingResend, setPendingResend] = useState<string | null>(null);
  const copyMessage = async (m: AgentMessage) => {
    try {
      await navigator.clipboard.writeText(m.content);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = m.content;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
    }
    setCopiedId(m.id);
    window.setTimeout(() => setCopiedId((id) => (id === m.id ? null : id)), 1500);
  };
  const saveEdit = async (m: AgentMessage) => {
    const text = editText.trim();
    if (!text || !user || sending) return;
    setEditingId(null);
    setMessages((prev) => prev.filter((x) => x.id < m.id));
    try {
      await deleteAgentMessagesFrom(user.id, conversationId, m.id);
    } catch (err) {
      console.error("Couldn't remove old messages:", err);
    }
    // Sent from an effect (next render) so handleSend sees the trimmed
    // message list as the conversation history.
    setPendingResend(text);
  };
  useEffect(() => {
    if (pendingResend === null || sending) return;
    const text = pendingResend;
    setPendingResend(null);
    handleSendRef.current(text);
  }, [pendingResend, sending]);

  // "Ask Agent Ready" button (PriceChart.tsx, Advance Chart page) —
  // dispatches this with a chart screenshot instead of calling
  // sendAgentMessage directly itself, same reasoning as every other
  // external trigger here: this component owns its own open/draft/send
  // state, nothing outside it should reach in and mutate that directly.
  // Declared here (after handleSend, not up with the other window
  // listeners above) since it calls handleSend directly and a `const`
  // isn't hoisted the way a function declaration would be.
  useEffect(() => {
    const onOpenWithImage = (e: Event) => {
      if (!canUseAgent) { onAgentLocked?.(); return; }
      const detail = (e as CustomEvent<{ imageDataUrl: string; prompt?: string }>).detail;
      if (!detail?.imageDataUrl) return;
      setOpen(true);
      // Auto-send, not pre-filled for review — explicit request: the
      // whole point of tapping the trigger on this page is "analyze what
      // I'm looking at right now", so it sends immediately with the
      // captured screenshot + default prompt, same as if the user had
      // typed it and hit Send themselves.
      handleSend(detail.prompt ?? "Can you analyze this chart?", detail.imageDataUrl);
    };
    window.addEventListener("open-trading-agent-with-image", onOpenWithImage);
    return () => window.removeEventListener("open-trading-agent-with-image", onOpenWithImage);
  }, [canUseAgent, onAgentLocked, handleSend]);

  // Markets page question pills ("Why is the market up today?" …): open
  // the panel and send that question right away.
  useEffect(() => {
    const onOpenWithPrompt = (e: Event) => {
      if (!canUseAgent) { onAgentLocked?.(); return; }
      const prompt = (e as CustomEvent<{ prompt?: string }>).detail?.prompt;
      setOpen(true);
      if (prompt) handleSend(prompt);
    };
    window.addEventListener("open-trading-agent-with-prompt", onOpenWithPrompt);
    return () => window.removeEventListener("open-trading-agent-with-prompt", onOpenWithPrompt);
  }, [canUseAgent, onAgentLocked, handleSend]);

  // Set right before stopping for an explicit Cancel (see handleMicCancel)
  // — the "listeningState: stopped" listener below fires either way (a
  // manual stop and a cancel both end the same native session the same
  // way), and this flag distinguishes the two.
  const speechCancelledRef = useRef(false);
  // Cancels the in-flight trading-agent-reply fetch for the *current*
  // handleSend call — created fresh each call (see handleSend) so an
  // interrupt can only ever abort the request it actually belongs to.
  const sendAbortControllerRef = useRef<AbortController | null>(null);
  // Set right before handleSend fires from a finished voice transcript
  // (below) — read once at the top of handleSend and cleared immediately,
  // so only a question that actually arrived by voice gets a spoken
  // answer back, never a typed one.
  const lastSendWasVoiceRef = useRef(false);
  // Snapshot of `draft` the instant recording starts — restored by Cancel
  // (handleMicCancel below) so dictating over an already-typed draft and
  // then backing out doesn't lose what was there before.
  const draftBeforeRecordingRef = useRef("");
  // True while TTS audio is actually playing — drives the small "Stop
  // speaking" control near the composer and the caption shown there.
  const [speaking, setSpeaking] = useState(false);
  // True only while synthesizeAgentSpeech itself is in flight — the real
  // gap this was missing: handleSend's `sending` turns false the moment
  // the TEXT reply lands (speakLatestAgentReply below is fired without
  // awaiting it), but speech synthesis is a separate network call that can
  // itself take a while. Covers that gap so the "Stop speaking" control
  // doesn't silently go dead for however long synthesis took before audio
  // actually starts.
  const [synthesizing, setSynthesizing] = useState(false);
  // Live numbers (price/RSI/MACD/trend/funding/OI) for whatever coin(s) the
  // latest turn actually resolved — shown as a compact data card under the
  // latest agent message in the feed (see the message-map render below) so
  // a reply isn't audio/text-only. Transient only, never persisted (see
  // sendAgentMessage) — it's live-at-the-moment data, same reasoning as
  // marketSnapshot elsewhere.
  const [lastMarketSnapshot, setLastMarketSnapshot] = useState<CoinSnapshot[] | null>(null);
  // Which coin's chart / order book modal is currently open, if any — at
  // most one of these at a time, triggered either by the server's own
  // showChart/showOrderBook fields or by the snapshot card's own buttons
  // (see the message feed render below).
  const [chartModal, setChartModal] = useState<{ coin: string; interval?: ShowChartInterval } | null>(null);
  const [orderBookModalCoin, setOrderBookModalCoin] = useState<string | null>(null);
  // Brief "Opening Chart…"/"Opening Order Book…" acknowledgment for the
  // snapshot card's two buttons below — on a real device there's a visible
  // beat between the tap and the modal actually painting (data fetch, chart
  // library init), and with no feedback at all in that gap it read as if
  // the button had silently done nothing.
  const [openingNote, setOpeningNote] = useState<string | null>(null);
  const openingNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showOpeningNote = (label: string) => {
    if (openingNoteTimerRef.current) clearTimeout(openingNoteTimerRef.current);
    setOpeningNote(label);
    openingNoteTimerRef.current = setTimeout(() => setOpeningNote(null), 1800);
  };
  // The one <audio> element used to play back synthesized speech — a ref
  // so it survives across renders/calls instead of being recreated (and
  // losing track of what's currently playing) each time.
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);
  // Bumped at the start of every speakLatestAgentReply call — lets a stale,
  // slow-to-resolve call recognize it's been superseded (see there) instead
  // of playing over whatever a newer turn already started.
  const speechGenerationRef = useRef(0);
  // Pausing alone doesn't fire "ended" (where the object URL normally
  // gets revoked in speakLatestAgentReply's cleanup below) — every manual
  // stop path routes through this instead of a bare .pause() so the blob
  // URL is never leaked.
  const stopSpeaking = () => {
    // Also invalidates any synthesis request still in flight (not just
    // whatever's already playing) — every interrupt/exit path routes
    // through here, so this is what stops a pending request from landing
    // late and playing anyway after the user's already moved on.
    speechGenerationRef.current++;
    const el = speechAudioRef.current;
    if (!el) return;
    el.pause();
    if (el.src) URL.revokeObjectURL(el.src);
  };
  // Tap-to-interrupt the typed-chat "Thinking…" bubble (now shared by every
  // send, voice-dictated or typed — there's no separate voice-only
  // "Thinking…" state anymore). Exists because a slow/hung backend reply
  // previously left no way out of "Thinking…" at all — closing the panel
  // was the only escape.
  const handleInterruptTyping = () => {
    sendAbortControllerRef.current?.abort();
    setSending(false);
  };
  const handleInterruptSpeech = () => {
    stopSpeaking();
    setSpeaking(false);
    setSynthesizing(false);
  };

  // Speaks the newest agent message, if the latest message in the
  // freshly-reloaded array is in fact one — it won't be if the request
  // errored before the agent replied, in which case there's nothing to
  // speak. Synthesizes real audio via OpenAI's neural TTS (agent-speech
  // edge function, same class of model ChatGPT's own voice mode uses)
  // rather than any on-device synthesizer — no local iOS voice, however
  // "Enhanced"/"Premium" its quality tier, sounds like a real neural TTS
  // model; it's a different generation of technology entirely. Only ever
  // called for a voice-dictated turn (see handleSend's viaVoice check) —
  // the reply itself already landed in the feed as a normal message bubble
  // via loadAll() by the time this plays, so this is purely an audio
  // add-on, not something the UI depends on to show anything.
  const speakLatestAgentReply = async (msgs: AgentMessage[]) => {
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "agent" || !last.content) return;
    stopSpeaking();
    // synthesizeAgentSpeech has no cancellation — if THIS call's request is
    // slow and a newer turn's speakLatestAgentReply starts (and finishes)
    // in the meantime, this one resolving late would otherwise still play,
    // overlapping whatever's already speaking. Capturing a generation
    // stamp and checking it's still current once the request lands is what
    // lets a stale call discard itself instead of ever reaching audio.play().
    const myGeneration = ++speechGenerationRef.current;
    setSynthesizing(true);
    try {
      const url = await synthesizeAgentSpeech(last.content);
      if (speechGenerationRef.current !== myGeneration) { URL.revokeObjectURL(url); return; }
      setSynthesizing(false);
      const audio = new Audio(url);
      speechAudioRef.current = audio;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        setSpeaking(false);
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      setSpeaking(true);
      await audio.play();
    } catch {
      // Synthesis request failed (offline, server error) — nothing to
      // play, just clear the in-progress flags.
      if (speechGenerationRef.current !== myGeneration) return;
      setSynthesizing(false);
      setSpeaking(false);
    }
  };

  // 4s of no new partial result = treat it as the user going quiet and
  // stop on our own, rather than trusting however long (or whether at
  // all) the native session's own endpointing decides to wait in
  // partialResults mode.
  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
  };
  // The UI used to flip `listening` back off ONLY once the native plugin's
  // own "listeningState: stopped" event arrived — but that event
  // occasionally never fires at all (an audio-session hiccup, a
  // permission edge case, the native side just getting stuck), which left
  // the composer stuck showing the recording bar with no way out: both
  // Cancel and the stop button only ever called SpeechRecognition.stop()
  // and waited on that same event. This recovers the UI immediately and
  // unconditionally the moment the user acts (or the silence timer fires)
  // — stop() is still called so the native session tears down when it
  // can, but nothing here depends on it actually succeeding.
  const stopListening = (markAsVoice: boolean) => {
    clearSilenceTimer();
    setListening(false);
    if (markAsVoice) lastSendWasVoiceRef.current = true;
    if (webRecRef.current) {
      try { webRecRef.current.stop(); } catch { /* already stopped */ }
      webRecRef.current = null;
      return;
    }
    SpeechRecognition.stop().catch(() => { /* already stopped, or hung — UI already recovered either way */ });
  };
  // 4s of no new partial result = treat it as the user going quiet and
  // stop on our own, rather than trusting however long (or whether at
  // all) the native session's own endpointing decides to wait in
  // partialResults mode.
  const armSilenceTimer = () => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => stopListening(true), 4000);
  };

  useEffect(() => {
    if (!NATIVE_SPEECH) return; // web uses WEB_SPEECH_CTOR in startListening instead
    // Writes straight into the composer's own draft — calling a state
    // setter is safe even from this mount-only effect's stale closure
    // (setter identities are stable across renders, unlike a read of
    // `draft` itself would be), so the input shows the transcript growing
    // live as the user speaks, same text they'll review before sending.
    const partialSub = SpeechRecognition.addListener("partialResults", ({ matches }) => {
      setDraft(matches?.[0] ?? "");
      armSilenceTimer();
    });
    const stateSub = SpeechRecognition.addListener("listeningState", ({ status }) => {
      if (status !== "stopped") return;
      clearSilenceTimer();
      setListening(false);
      // The live transcript is already sitting in `draft` (written by
      // partialResults above), and a Cancel has already restored it to the
      // pre-recording value itself (handleMicCancel) before this fires —
      // nothing to finalize here besides tagging a successful (non-
      // cancelled) recording as voice-originated, so handleSend knows to
      // speak the reply once the user actually taps Send (cleared again
      // the moment they edit the composer by hand — see its onChange).
      if (!speechCancelledRef.current) lastSendWasVoiceRef.current = true;
      speechCancelledRef.current = false;
    });
    return () => {
      clearSilenceTimer();
      partialSub.then((h) => h.remove());
      stateSub.then((h) => h.remove());
    };
  }, []);

  // Logged-out only — free-tier users still get the trigger (and can open
  // the panel's shell), gated to the upgrade flow on actual use instead
  // (canUseAgent above). This has to come after every hook above (not as
  // an early return further up) — React requires the exact same hooks, in
  // the exact same order, on every render. A guard placed before some of
  // them meant a user whose auth state resolved *after* sign-in changed
  // the hook count between renders, which is a silent dev-mode warning but
  // a fatal, unrecoverable crash in a production/minified build — exactly
  // what happened here (and the same bug class previously fixed in
  // ProfilePage.tsx, commit 6cb3507).
  // Signed out: still show the floating trigger (same look/animation),
  // just gated — tapping it goes through onAgentLocked, which App.tsx
  // routes to sign-in for signed-out viewers and to the Elite upsell for
  // signed-in non-Elite ones. Nothing else of the agent renders.
  if (!user) {
    return phase !== "hidden" && !hideTrigger ? (
      <button
        type="button"
        className={`ta-trigger${phase === "pop" ? " ta-trigger--collapsed" : ""}`}
        onClick={() => onAgentLocked?.()}
      >
        <span className={`ta-trigger-orb${phase === "pop" ? " ta-trigger-orb--pop" : ""}`} />
        {phase !== "pop" && (
          <span className="ta-trigger-label">
            {label}
            {phase === "expanding" && <span className="ta-trigger-cursor" />}
          </span>
        )}
      </button>
    ) : null;
  }

  const startListening = async () => {
    // Desktop/web: the browser's own speech recognition, same behavior —
    // words stream into the composer as text, left there to review/send.
    if (WEB_SPEECH_CTOR) {
      try {
        const rec = new WEB_SPEECH_CTOR();
        rec.lang = "en-US";
        rec.interimResults = true;
        rec.continuous = false;
        let spoken = "";
        rec.onresult = (e) => {
          let text = "";
          for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
          spoken = text;
          setDraft(text);
          armSilenceTimer();
        };
        // Web: speak instead of typing — once the user stops talking (or
        // taps stop), the transcript is sent as their message right away.
        // Cancel (✕) still discards it.
        rec.onend = () => {
          clearSilenceTimer();
          setListening(false);
          const cancelled = speechCancelledRef.current;
          speechCancelledRef.current = false;
          webRecRef.current = null;
          const text = spoken.trim();
          if (!cancelled && text) {
            setDraft("");
            setTyping(false);
            handleSendRef.current(text);
          }
        };
        rec.onerror = () => { clearSilenceTimer(); setListening(false); webRecRef.current = null; };
        draftBeforeRecordingRef.current = draft;
        setDraft("");
        webRecRef.current = rec;
        setListening(true);
        armSilenceTimer();
        rec.start();
      } catch (err) {
        setListening(false);
        webRecRef.current = null;
        console.error("Speech recognition failed:", err);
      }
      return;
    }
    try {
      const { speechRecognition } = await SpeechRecognition.checkPermissions();
      if (speechRecognition !== "granted") {
        const req = await SpeechRecognition.requestPermissions();
        if (req.speechRecognition !== "granted") return;
      }
      // Snapshot whatever was already typed so Cancel can put it back —
      // recording starts from a clean slate (the input shows the live
      // transcript growing from nothing, not appended to old text).
      draftBeforeRecordingRef.current = draft;
      setDraft("");
      setListening(true);
      armSilenceTimer();
      await SpeechRecognition.start({ language: "en-US", maxResults: 1, partialResults: true });
    } catch (err) {
      setListening(false);
      console.error("Speech recognition failed:", err);
    }
  };

  // Tap to start, tap again (the same button, now showing a stop icon) to
  // stop early — partialResults:true streams words in live as they're
  // recognized (see the "partialResults" listener above) straight into the
  // composer's own input, closer to how ChatGPT's dictation bar shows your
  // words arriving as you speak. Either this manual stop or the plugin's
  // own silence detection ends the native session the same way (the
  // "listeningState" listener above reacts to both identically) — either
  // way the recognized text is simply left sitting in the input for the
  // user to review and send themselves, never auto-sent.
  const handleMicTap = async () => {
    if (listening) {
      stopListening(true);
      return;
    }
    await startListening();
  };

  // Explicit "never mind" — stops the same way handleMicTap's early-stop
  // does, but flags it first (so the transcript isn't mistaken for a real
  // final answer by the "listeningState" listener above, if it happens to
  // fire late) and restores whatever was in the composer before recording
  // started.
  const handleMicCancel = () => {
    speechCancelledRef.current = true;
    setDraft(draftBeforeRecordingRef.current);
    stopListening(false);
  };

  const handleConfirm = async (m: AgentMessage) => {
    if (!m.action || executingId) return;
    setExecutingId(m.id);
    setError("");
    try {
      await executeTrade(user!.id, m.action);
      await setActionStatus(m.id, "confirmed");
      await loadAll(conversationId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trade failed — please try again.");
    } finally {
      setExecutingId(null);
    }
  };

  const handleConfirmBasket = async (m: AgentMessage) => {
    if (!m.basket || executingId) return;
    setExecutingId(m.id);
    setError("");
    try {
      await executeBasket(user!.id, m.basket);
      await setActionStatus(m.id, "confirmed");
      await loadAll(conversationId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Some legs may not have executed — please check your positions.");
    } finally {
      setExecutingId(null);
    }
  };

  const handleConfirmBalanceUpdate = async (m: AgentMessage) => {
    const update: BalanceUpdate | null = m.balanceUpdate;
    if (!update || executingId) return;
    setExecutingId(m.id);
    setError("");
    try {
      await updateCashBalance(user!.id, update.newBalance);
      await setActionStatus(m.id, "confirmed");
      await loadAll(conversationId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update your balance — please try again.");
    } finally {
      setExecutingId(null);
    }
  };

  const handleConfirmWatch = async (m: AgentMessage) => {
    if (!m.watch || executingId) return;
    setExecutingId(m.id);
    setError("");
    try {
      const interval = watchIntervalDrafts[m.id] ?? m.watch.interval;
      await confirmWatch(m.id, user!.id, conversationId, { ...m.watch, interval });
      await loadAll(conversationId);
      if (showWatches) await loadAllWatches();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't set up that watch — please try again.");
    } finally {
      setExecutingId(null);
    }
  };

  const startEditCash = () => {
    if (!portfolio) return;
    setCashDraft(String(portfolio.cashBalance));
    setEditingCash(true);
  };

  const saveCash = async () => {
    const value = Number(cashDraft);
    if (!Number.isFinite(value) || value < 0) {
      setError("Cash balance must be a non-negative number.");
      return;
    }
    setSavingCash(true);
    setError("");
    try {
      await updateCashBalance(user!.id, value);
      await loadAll(conversationId);
      setEditingCash(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update cash balance — please try again.");
    } finally {
      setSavingCash(false);
    }
  };

  const handleClosePosition = async (p: PaperPosition) => {
    const key = `${p.coin}:${p.market}`;
    if (closingPosition) return;
    setClosingPosition(key);
    setError("");
    try {
      await closePosition(user!.id, p);
      await loadAll(conversationId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't close that position — please try again.");
    } finally {
      setClosingPosition(null);
    }
  };

  const handleDismiss = async (m: AgentMessage) => {
    await setActionStatus(m.id, "dismissed");
    await loadAll(conversationId);
  };

  const handleCancelWatch = async (watchId: string) => {
    if (cancellingWatchId) return;
    setCancellingWatchId(watchId);
    setError("");
    try {
      await cancelWatch(watchId);
      await loadAll(conversationId);
      if (showWatches) await loadAllWatches();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't cancel the watch — please try again.");
    } finally {
      setCancellingWatchId(null);
    }
  };

  const panel = (
    <div className="ta-panel" ref={panelRef}>
      {panelIntro && (
        <div className="ta-panel-intro">
          <span className="ta-trigger-orb ta-panel-intro-orb" />
          <span className="ta-panel-intro-label">{panelIntroLabel}</span>
        </div>
      )}
      <div className="ta-head">
        <span className="ta-head-title-row">
          <span className="ta-head-online-badge" aria-hidden="true" />
          <span className="ta-head-title">Agent Ready</span>
        </span>
        {isMobile ? (
          <div className="ta-head-actions">
            <button type="button" className="ta-head-icon-btn ta-head-icon-btn--labelled" onClick={() => setHubOpen(true)} title="Agent actions" aria-label="Agent actions">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
              <span>Menu</span>
            </button>
            {/* Round close button — just the X in a circle, no label. */}
            <button type="button" className="ta-head-close ta-head-close--round" onClick={() => setOpen(false)} title="Close" aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
        ) : (
          <div className="ta-head-actions">
            <button type="button" className="ta-head-icon-btn" onClick={handleNewConversation} title="New chat" aria-label="New chat">
              +
            </button>
            <button type="button" className="ta-head-icon-btn" onClick={handleOpenHistory} title="History" aria-label="History">
              ☰
            </button>
            <button type="button" className="ta-head-icon-btn" onClick={handleOpenWatches} title="Watchlist" aria-label="Watchlist">
              <BellIcon size={16} />
            </button>
            <button type="button" className="ta-head-icon-btn" onClick={handleOpenPositions} title="Positions" aria-label="Positions">
              <PositionsIcon size={16} />
            </button>
            <button type="button" className="ta-head-close" onClick={() => setOpen(false)} title="Close" aria-label="Close">✕</button>
          </div>
        )}
      </div>

      {showHistory ? (
        <div className="ta-history">
          <div className="ta-history-list">
            {sortedConversations.length === 0 && (
              <p className="ta-empty">No past conversations yet.</p>
            )}
            {(() => {
              const renderRow = (c: ConversationSummary) => (
                IS_IOS_NATIVE ? (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === conversationId}
                    pinned={pinnedIds.has(c.id)}
                    revealed={revealedRow?.id === c.id ? revealedRow.side : null}
                    onReveal={(side) => setRevealedRow(side ? { id: c.id, side } : null)}
                    onOpen={() => handleOpenConversation(c.id)}
                    onDelete={() => { setRevealedRow(null); handleDeleteConversation(c.id); }}
                    onTogglePin={() => togglePin(c.id)}
                  />
                ) : (
                  <div key={c.id} className={`ta-history-item${c.id === conversationId ? " ta-history-item--active" : ""}`}>
                    <button type="button" className="ta-history-item-main" onClick={() => handleOpenConversation(c.id)}>
                      <span className="ta-history-item-preview-row">
                        {pinnedIds.has(c.id) && <PinIcon size={11} filled className="ta-history-item-pin-badge" />}
                        <span className="ta-history-item-preview">{c.preview || "(empty)"}</span>
                      </span>
                      <span className="ta-history-item-meta">{c.messageCount} message{c.messageCount === 1 ? "" : "s"} · {timeAgo(c.updatedAt)}</span>
                    </button>
                    <button
                      type="button"
                      className="ta-history-item-pin"
                      onClick={() => togglePin(c.id)}
                      aria-label={pinnedIds.has(c.id) ? "Unpin conversation" : "Pin conversation"}
                      title={pinnedIds.has(c.id) ? "Unpin" : "Pin"}
                    >
                      <PinIcon size={15} slash={pinnedIds.has(c.id)} />
                    </button>
                    <button
                      type="button"
                      className="ta-history-item-delete"
                      onClick={() => handleDeleteConversation(c.id)}
                      aria-label="Delete conversation"
                      title="Delete"
                    >
                      🗑
                    </button>
                  </div>
                )
              );
              // Only split into Pinned/rest once there's actually something
              // to split — a single chat, or a list with no pins at all,
              // just renders flat with no "Pinned" header sitting over
              // nothing (or over everything).
              const showGroups = sortedConversations.length >= 2 && pinnedIds.size > 0;
              if (!showGroups) return sortedConversations.map(renderRow);
              const pinnedRows = sortedConversations.filter((c) => pinnedIds.has(c.id));
              const restRows = sortedConversations.filter((c) => !pinnedIds.has(c.id));
              return (
                <>
                  <p className="ta-watchlist-section-title">Pinned</p>
                  {pinnedRows.map(renderRow)}
                  {restRows.length > 0 && <p className="ta-watchlist-section-title">All chats</p>}
                  {restRows.map(renderRow)}
                </>
              );
            })()}
          </div>
          <button type="button" className="ta-history-back" onClick={() => setShowHistory(false)}>
            Back to chat
          </button>
        </div>
      ) : showWatches ? (() => {
        const active = allWatches.filter((w) => w.active);
        const triggered = allWatches.filter((w) => !w.active && w.triggeredAt);
        return (
          <div className="ta-history">
            <div className="ta-history-list">
              <p className="ta-watchlist-section-title">Active watches</p>
              {active.length === 0 && <p className="ta-empty">No active watches.</p>}
              {active.map((w) => (
                <div key={w.id} className="ta-watchlist-item">
                  <div className="ta-watchlist-item-main">
                    <span className="ta-watchlist-item-coin"><BellIcon /> {w.coin}</span>
                    <span className="ta-watchlist-item-condition">
                      {w.conditionText}
                      {/rsi|macd|volume/i.test(w.conditionText) && (
                        <span className="ta-watch-interval-tag">{w.interval === "1d" ? "Daily" : w.interval}</span>
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ta-watch-cancel"
                    onClick={() => handleCancelWatch(w.id)}
                    disabled={cancellingWatchId === w.id}
                  >
                    {cancellingWatchId === w.id ? "…" : "Cancel"}
                  </button>
                </div>
              ))}

              <p className="ta-watchlist-section-title ta-watchlist-section-title--notifications">Notifications</p>
              {triggered.length === 0 && <p className="ta-empty">No triggered watches yet.</p>}
              {triggered.map((w) => (
                <div key={w.id} className="ta-watchlist-item ta-watchlist-item--triggered">
                  <div className="ta-watchlist-item-main">
                    <span className="ta-watchlist-item-coin"><BellIcon /> {w.coin}</span>
                    <span className="ta-watchlist-item-condition">{w.conditionText}</span>
                    <span className="ta-watchlist-item-time">{w.triggeredAt ? formatMsgTime(w.triggeredAt) : ""}</span>
                  </div>
                  <span className="ta-watch-status">✓ Triggered</span>
                </div>
              ))}
            </div>
            <button type="button" className="ta-history-back" onClick={() => setShowWatches(false)}>
              Back to chat
            </button>
          </div>
        );
      })() : showPositions ? (
        <div className="ta-history">
          <div className="ta-positions-page-head">
            <span className="ta-positions-page-title">Positions</span>
            <button
              type="button"
              className={`ta-positions-refresh-btn${refreshingPositions ? " ta-positions-refresh-btn--spinning" : ""}`}
              onClick={handleRefreshPositions}
              disabled={refreshingPositions}
              title="Refresh"
              aria-label="Refresh positions"
            >
              <svg className="ta-positions-refresh-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              <span>Refresh</span>
            </button>
          </div>
          <div className="ta-positions-view-tabs">
            <button
              type="button"
              className={`ta-positions-view-tab${positionsTab === "open" ? " ta-positions-view-tab--active" : ""}`}
              onClick={() => setPositionsTab("open")}
            >
              Open
            </button>
            <button
              type="button"
              className={`ta-positions-view-tab${positionsTab === "closed" ? " ta-positions-view-tab--active" : ""}`}
              onClick={() => setPositionsTab("closed")}
            >
              Closed
            </button>
          </div>
          <div
            className="ta-positions-pull-indicator"
            style={{
              height: refreshingPositions ? 40 : positionsPullY,
              opacity: refreshingPositions ? 1 : Math.min(1, positionsPullY / POSITIONS_PULL_THRESHOLD),
              transition: positionsPullY === 0 && !refreshingPositions ? "height 0.2s ease" : "none",
            }}
          >
            <span className={`ta-positions-pull-spinner${refreshingPositions ? " ta-positions-pull-spinner--active" : ""}`} />
          </div>
          <div className="ta-history-list" ref={positionsListRef}>
            {positionsTab === "open" ? (
              <PositionsListCard
                list={{
                  status: "open",
                  items: (portfolio?.positions ?? []).map((p) => ({
                    coin: p.coin, market: p.market, side: p.side, qty: p.qty, leverage: p.leverage,
                    avgEntryPrice: p.avgEntryPrice, openedAt: p.updatedAt,
                    liquidationPrice: p.liquidationPrice, takeProfitPrice: p.takeProfitPrice,
                  })),
                }}
                coinTickers={coinTickers}
                onClosePosition={handleClosePositionFromList}
                closingKey={closingPosition}
              />
            ) : loadingClosedPositions ? (
              <p className="ta-empty">Loading your closed positions…</p>
            ) : (
              <PositionsListCard list={{ status: "closed", items: closedPositions ?? [] }} />
            )}
          </div>
          <button type="button" className="ta-history-back" onClick={() => setShowPositions(false)}>
            Back to chat
          </button>
        </div>
      ) : needsConsent ? (
        <div className="ta-onboard">
          <p className="ta-onboard-disclaimer">
            <strong>Paper trading only — simulated money, simulated trades.</strong> This agent is not a registered
            financial or investment advisor, and nothing it says is financial advice. coinhintz is not responsible for
            any losses, simulated or otherwise, from using this feature. We'll only ask you to accept this once —
            you won't see this disclaimer again after today.
          </p>
          {error && <p className="ta-error">{error}</p>}
          <button type="button" className="ta-onboard-continue" onClick={handleAcceptConsent} disabled={acceptingConsent}>
            {acceptingConsent ? "One sec…" : "I understood and agreed!"}
          </button>
        </div>
      ) : (
        <>
          {/* Not messages.length === 0 — the opener greeting itself lands as
              an agent message a moment after this conversation opens, which
              would otherwise make this banner flash and vanish right as the
              greeting arrives. Keyed on "no user message yet" instead, so it
              stays up alongside the greeting until the user actually starts
              typing here (the real point they've committed to this new
              conversation over the old one). */}
          {!messages.some((m) => m.role === "user") && lastConversation && (
            <div className="ta-continue-banner">
              <span className="ta-continue-banner-text">
                Pick up where you left off: <em>"{lastConversation.preview.length > 60 ? `${lastConversation.preview.slice(0, 60)}…` : lastConversation.preview}"</em>
              </span>
              <button
                type="button"
                className="ta-continue-banner-btn"
                onClick={() => handleOpenConversation(lastConversation.id)}
              >
                Continue →
              </button>
            </div>
          )}
          {isWebPushAvailable() && !webPushSubscribed && (
            <div className="ta-webpush-banner">
              <span className="ta-webpush-banner-text">Get a browser alert when a watch or position triggers, even with this closed.</span>
              <button type="button" className="ta-webpush-banner-btn" onClick={handleEnableWebPush} disabled={webPushPrompting}>
                🔔 {webPushPrompting ? "Enabling…" : "Enable"}
              </button>
            </div>
          )}
          {webPushError && <div className="ta-webpush-banner-error">{webPushError}</div>}
          {portfolio && (
            <div className="ta-portfolio">
              <button
                type="button"
                className="ta-portfolio-toggle"
                onClick={() => setPortfolioCollapsed((v) => !v)}
                aria-expanded={!portfolioCollapsed}
              >
                Portfolio
                <span className={`ta-portfolio-toggle-chevron${portfolioCollapsed ? " ta-portfolio-toggle-chevron--collapsed" : ""}`}>
                  ▾
                </span>
              </button>
              {!portfolioCollapsed && (
              <>
              <div className="ta-portfolio-cash">
                <span className="ta-portfolio-label">Cash</span>
                {editingCash ? (
                  <span className="ta-portfolio-cash-edit">
                    <span className="ta-portfolio-cash-prefix">$</span>
                    <input
                      type="text"
                      autoFocus
                      className="ta-portfolio-cash-input"
                      value={cashDraft}
                      disabled={savingCash}
                      onChange={(e) => setCashDraft(sanitizeAmountInput(e.target.value))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveCash();
                        if (e.key === "Escape") setEditingCash(false);
                      }}
                      onBlur={saveCash}
                    />
                  </span>
                ) : (
                  <span className="ta-portfolio-cash-display">
                    <button type="button" className="ta-portfolio-value ta-portfolio-value--editable" onClick={startEditCash}>
                      ${portfolio.cashBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </button>
                    <button type="button" className="ta-portfolio-cash-edit-link" onClick={startEditCash}>
                      Edit
                    </button>
                  </span>
                )}
              </div>
              {performance && performance.totalClosed > 0 && (
                <div className="ta-portfolio-performance">
                  <span className="ta-portfolio-label">Win Rate</span>
                  <span className={`ta-portfolio-winrate${(performance.winRate ?? 0) >= 0.5 ? " ta-portfolio-winrate--good" : " ta-portfolio-winrate--bad"}`}>
                    {Math.round((performance.winRate ?? 0) * 100)}%
                    <span className="ta-portfolio-winrate-detail">
                      ({performance.wins}W–{performance.losses}L)
                    </span>
                  </span>
                </div>
              )}
              {portfolio.positions.length > 0 && (
                <div className="ta-portfolio-positions">
                  <span className="ta-portfolio-positions-label">Current Positions</span>
                  {portfolio.positions.map((p) => {
                    const key = `${p.coin}:${p.market}`;
                    const livePrice = coinTickers?.get(p.coin)?.price;
                    const pnl = livePrice && livePrice > 0
                      ? (livePrice - p.avgEntryPrice) * p.qty * (p.side === "short" ? -1 : 1)
                      : null;
                    return (
                      <div key={key} className="ta-position-wrap">
                        <div className="ta-position">
                          <span className="ta-position-coin">{p.coin}</span>
                          <span className="ta-position-qty">{p.qty} @ ${p.avgEntryPrice.toLocaleString()}</span>
                          {pnl != null && (
                            <span className={`ta-position-pnl${pnl >= 0 ? " positive" : " negative"}`}>
                              {pnl >= 0 ? "+" : "-"}${Math.abs(pnl).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span>
                          )}
                          <button
                            type="button"
                            className="ta-position-close"
                            onClick={() => handleClosePosition(p)}
                            disabled={closingPosition === key}
                          >
                            {closingPosition === key ? "Closing…" : "Close"}
                          </button>
                        </div>
                        {p.market === "futures" && livePrice && livePrice > 0 && (
                          <LiquidationGauge
                            side={p.side}
                            entryPrice={p.avgEntryPrice}
                            liquidationPrice={p.liquidationPrice}
                            takeProfitPrice={p.takeProfitPrice}
                            currentPrice={livePrice}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              </>
              )}
            </div>
          )}

          <div className="ta-feed" ref={feedRef} onClick={() => { if (hubOpen) setHubOpen(false); }}>
            {messages.length === 0 && (
              <p className="ta-empty">
                Try "buy $200 of BTC", "sell half my ETH", or "what do you think about SOL?" — everything here is simulated, no real money or exchange involved.
              </p>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`ta-msg ta-msg--${m.role}${m.positionsList ? " ta-msg--wide" : ""}`}>
                {/* The model is told to keep "reply" to a short verdict separate
                    from the narration, but for a trivial turn (small talk,
                    no real analysis) it sometimes writes the same short text
                    for both instead of a real walkthrough. When they match
                    (normalizing whitespace so a harmless formatting
                    difference doesn't defeat the check), there's no real
                    "thought process" to show — it's just the answer, so
                    render it once as a normal reply bubble, not as the
                    dim/italic thought-process styling. */}
                {m.thoughtProcess && m.content.replace(/\s+/g, " ").trim() !== m.thoughtProcess.replace(/\s+/g, " ").trim() && (
                  <div className="ta-thought-process">
                    <span className="ta-thought-process-label">Thought process</span>
                    <p className="ta-thought-process-text">{m.thoughtProcess}</p>
                  </div>
                )}
                {m.imageUrl && (
                  <img src={m.imageUrl} alt="Chart screenshot" className="ta-msg-image" />
                )}
                {editingId === m.id ? (
                  <div className="ta-msg-edit">
                    <textarea
                      className="ta-msg-edit-input"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(m); }
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      rows={Math.min(6, Math.max(2, Math.ceil(editText.length / 48)))}
                      autoFocus
                    />
                    <div className="ta-msg-edit-actions">
                      <button type="button" className="ta-msg-edit-cancel" onClick={() => setEditingId(null)}>Cancel</button>
                      <button type="button" className="ta-msg-edit-save" onClick={() => saveEdit(m)} disabled={!editText.trim() || sending}>Save &amp; resend</button>
                    </div>
                  </div>
                ) : (
                  <p className="ta-msg-text">{m.content}</p>
                )}
                {editingId !== m.id && (
                  <div className="ta-msg-meta">
                    <span className="ta-msg-time">{formatMsgTime(m.createdAt)}</span>
                    {m.content.trim() && (
                      <span className="ta-msg-actions">
                        <button
                          type="button"
                          className="ta-msg-action"
                          onClick={() => copyMessage(m)}
                          aria-label={copiedId === m.id ? "Copied" : "Copy message"}
                          title={copiedId === m.id ? "Copied" : "Copy"}
                        >
                          {copiedId === m.id ? (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
                          ) : (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                          )}
                        </button>
                        {m.role === "user" && (
                          <button
                            type="button"
                            className="ta-msg-action"
                            onClick={() => { setEditText(m.content); setEditingId(m.id); }}
                            disabled={sending}
                            aria-label="Edit message"
                            title="Edit"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></svg>
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                )}
                {m.newsSources && m.newsSources.length > 0 && (
                  <div className="ta-sources">
                    <span className="ta-sources-label">
                      {m.newsSources.length} {m.newsSources.length === 1 ? "Source" : "Sources"}
                    </span>
                    <div className="ta-sources-list">
                      {m.newsSources.map((n, i) => (
                        <a
                          key={i}
                          className="ta-sources-chip"
                          href={n.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={n.title}
                          onClick={(e) => openNewsLink(e, n.url)}
                        >
                          {n.source}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                {m.action && (
                  <ActionProposalCard message={m} executingId={executingId} onConfirm={handleConfirm} onDismiss={handleDismiss} />
                )}
                {m.basket && (
                  <div className={`ta-proposal ta-proposal--${m.actionStatus}`}>
                    <div className="ta-basket-legs">
                      {m.basket.map((leg, i) => {
                        const pnl = estimateNetPnl(leg);
                        return (
                        <div key={i} className="ta-basket-leg">
                          <div className="ta-proposal-row">
                            <span className={`ta-proposal-side ta-proposal-side--${leg.side}`}>
                              {leg.market === "futures"
                                ? (leg.side === "buy" ? "▲ LONG" : "▼ SHORT")
                                : (leg.side === "buy" ? "▲ BUY" : "▼ SELL")}
                            </span>
                            <span className="ta-proposal-coin">{leg.coin}</span>
                            <span className="ta-proposal-market">
                              {leg.market === "futures" ? `FUTURES ${leg.leverage}x` : "SPOT"}
                            </span>
                          </div>
                          <div className="ta-proposal-details">
                            <div className="ta-proposal-detail">
                              <span>{leg.market === "futures" ? "Margin" : "Cost"}</span>
                              <strong>${leg.amountUsd.toLocaleString()}</strong>
                            </div>
                            {leg.takeProfit != null && (
                              <div className="ta-proposal-detail">
                                <span>Take Profit</span>
                                <strong className="ta-proposal-tp">
                                  ${leg.takeProfit.toLocaleString()}
                                  {pnl && <span className="ta-proposal-pnl"> ({formatPnl(pnl.profit)})</span>}
                                </strong>
                              </div>
                            )}
                            {leg.stopLoss != null && (
                              <div className="ta-proposal-detail">
                                <span>Stop Loss</span>
                                <strong className="ta-proposal-sl">
                                  ${leg.stopLoss.toLocaleString()}
                                  {pnl && <span className="ta-proposal-pnl"> ({formatPnl(pnl.loss)})</span>}
                                </strong>
                              </div>
                            )}
                          </div>
                          {leg.reason && <p className="ta-proposal-reason">{leg.reason}</p>}
                        </div>
                        );
                      })}
                    </div>
                    <div className="ta-basket-total">
                      <span>Total</span>
                      <strong>${m.basket.reduce((sum, leg) => sum + leg.amountUsd, 0).toLocaleString()} across {m.basket.length} {m.basket.length === 1 ? "name" : "names"}</strong>
                    </div>
                    {m.actionStatus === "pending" ? (
                      <div className="ta-proposal-actions">
                        <button
                          type="button"
                          className="ta-proposal-confirm"
                          onClick={() => handleConfirmBasket(m)}
                          disabled={executingId === m.id}
                        >
                          {executingId === m.id ? "Executing…" : "Confirm All"}
                        </button>
                        <button type="button" className="ta-proposal-dismiss" onClick={() => handleDismiss(m)}>
                          Dismiss
                        </button>
                      </div>
                    ) : (
                      <span className="ta-proposal-status">
                        {m.actionStatus === "confirmed" ? "✓ Executed" : "Dismissed"}
                      </span>
                    )}
                  </div>
                )}
                {m.positionsList && (
                  <PositionsListCard list={m.positionsList} coinTickers={coinTickers} />
                )}
                {m.balanceUpdate && (
                  <div className={`ta-proposal ta-proposal--${m.actionStatus}`}>
                    <div className="ta-proposal-row">
                      <span className="ta-proposal-badge">Update Balance</span>
                    </div>
                    <div className="ta-proposal-details">
                      <div className="ta-proposal-detail">
                        <span>New cash balance</span>
                        <strong>${m.balanceUpdate.newBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>
                      </div>
                    </div>
                    {m.balanceUpdate.reason && <p className="ta-proposal-reason">{m.balanceUpdate.reason}</p>}
                    {m.actionStatus === "pending" ? (
                      <div className="ta-proposal-actions">
                        <button
                          type="button"
                          className="ta-proposal-confirm"
                          onClick={() => handleConfirmBalanceUpdate(m)}
                          disabled={executingId === m.id}
                        >
                          {executingId === m.id ? "Updating…" : "Confirm"}
                        </button>
                        <button type="button" className="ta-proposal-dismiss" onClick={() => handleDismiss(m)}>
                          Dismiss
                        </button>
                      </div>
                    ) : (
                      <span className="ta-proposal-status">
                        {m.actionStatus === "confirmed" ? "✓ Updated" : "Dismissed"}
                      </span>
                    )}
                  </div>
                )}
                {m.question && (
                  <div className="ta-question">
                    <p className="ta-question-prompt">{m.question.prompt}</p>
                    {m.question.options.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        className="ta-question-option"
                        disabled={sending || m.id !== messages[messages.length - 1]?.id}
                        onClick={() => handleSend(opt.label)}
                      >
                        <span className="ta-question-option-label">{opt.label}</span>
                        <span className="ta-question-option-desc">{opt.description}</span>
                      </button>
                    ))}
                  </div>
                )}
                {/* Hidden once confirmed — the live watchId chip just below
                    takes over as the authoritative "it's active" display
                    (with its own Cancel/triggered state), so this proposal
                    card would otherwise just be a stale duplicate of it. */}
                {m.watch && m.actionStatus !== "confirmed" && (
                  <div className={`ta-proposal ta-proposal--${m.actionStatus}`}>
                    <div className="ta-proposal-row">
                      <span className="ta-proposal-badge"><BellIcon /> Watch</span>
                    </div>
                    <div className="ta-proposal-details">
                      <div className="ta-proposal-detail">
                        <span>{m.watch.coin}</span>
                        <strong>{m.watch.condition}</strong>
                      </div>
                    </div>
                    {/* Only meaningful for an indicator-based condition — a
                        plain price level has no timeframe to pick. */}
                    {m.actionStatus === "pending" && /rsi|macd|volume/i.test(m.watch.condition) && (
                      <div className="ta-watch-interval">
                        <span className="ta-watch-interval-label">Timeframe</span>
                        <div className="ta-watch-interval-options">
                          {(["1h", "4h", "1d"] as MarketInterval[]).map((iv) => (
                            <button
                              key={iv}
                              type="button"
                              className={`ta-watch-interval-btn${(watchIntervalDrafts[m.id] ?? m.watch!.interval) === iv ? " ta-watch-interval-btn--active" : ""}`}
                              onClick={() => setWatchIntervalDrafts((prev) => ({ ...prev, [m.id]: iv }))}
                            >
                              {iv === "1d" ? "Daily" : iv}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {m.actionStatus === "pending" ? (
                      <div className="ta-proposal-actions">
                        <button
                          type="button"
                          className="ta-proposal-confirm"
                          onClick={() => handleConfirmWatch(m)}
                          disabled={executingId === m.id}
                        >
                          {executingId === m.id ? "Setting up…" : "Confirm"}
                        </button>
                        <button type="button" className="ta-proposal-dismiss" onClick={() => handleDismiss(m)}>
                          Dismiss
                        </button>
                      </div>
                    ) : (
                      <span className="ta-proposal-status">Dismissed</span>
                    )}
                  </div>
                )}
                {m.watchId && watches.get(m.watchId) && (() => {
                  const w = watches.get(m.watchId)!;
                  return (
                    <div className={`ta-watch${w.active ? "" : w.triggeredAt ? " ta-watch--triggered" : " ta-watch--cancelled"}`}>
                      <span className="ta-watch-text">
                        <BellIcon /> Watching <strong>{w.coin}</strong> — {w.conditionText}
                        {/rsi|macd|volume/i.test(w.conditionText) && (
                          <span className="ta-watch-interval-tag">{w.interval === "1d" ? "Daily" : w.interval}</span>
                        )}
                      </span>
                      {w.active ? (
                        <button
                          type="button"
                          className="ta-watch-cancel"
                          onClick={() => handleCancelWatch(w.id)}
                          disabled={cancellingWatchId === w.id}
                        >
                          {cancellingWatchId === w.id ? "…" : "Cancel"}
                        </button>
                      ) : (
                        <span className="ta-watch-status">{w.triggeredAt ? "✓ Triggered" : "Cancelled"}</span>
                      )}
                    </div>
                  );
                })()}
                {m.navigateTo && (
                  <button
                    type="button"
                    className="ta-navigate-btn"
                    onClick={() => { onNavigateToSection?.(m.navigateTo!.section); setOpen(false); }}
                  >
                    Open {m.navigateTo.label} →
                  </button>
                )}
                {/* Live numbers (price/RSI/MACD/funding/OI) for whatever
                    coin(s) this reply actually resolved — previously shown
                    only inside the now-removed full-screen voice overlay,
                    which meant a voice-dictated turn's reply had nowhere to
                    show this at all; now it renders right under whichever
                    reply produced it, same as any other card. Scoped to the
                    LAST agent message only (there's one snapshot in state,
                    not one per message), same as the old overlay's
                    `latestMsg` check. */}
                {m.role === "agent" && m.id === messages[messages.length - 1]?.id &&
                  lastMarketSnapshot && lastMarketSnapshot.length > 0 && (
                  <div className="ta-snapshot">
                    {lastMarketSnapshot.slice(0, 3).map((s) => (
                      <div key={s.coin} className="ta-snapshot-card">
                        <div className="ta-snapshot-head">
                          <span className="ta-snapshot-coin">{s.coin}</span>
                          <span className="ta-snapshot-price">
                            ${s.price.toLocaleString(undefined, { maximumFractionDigits: s.price < 1 ? 6 : 2 })}
                          </span>
                          {s.trend && (
                            <span className={`ta-snapshot-trend ta-snapshot-trend--${s.trend}`}>
                              {s.trend === "up" ? "▲" : s.trend === "down" ? "▼" : "—"} {s.trend}
                            </span>
                          )}
                        </div>
                        {s.recentCloses && s.recentCloses.length > 1 && (
                          <Sparkline closes={s.recentCloses} />
                        )}
                        <div className="ta-snapshot-row">
                          <span>RSI {s.rsi != null ? s.rsi.toFixed(1) : "n/a"}</span>
                          <span>MACD {s.macdHist != null ? (s.macdHist >= 0 ? "▲" : "▼") : "n/a"}</span>
                          {s.fundingRatePct != null && (
                            <span>Funding {s.fundingRatePct >= 0 ? "+" : ""}{s.fundingRatePct.toFixed(3)}%</span>
                          )}
                          {s.openInterestUsd != null && (
                            <span>OI {formatAbbrevUsd(s.openInterestUsd)}</span>
                          )}
                        </div>
                        <div className="ta-snapshot-actions">
                          <button
                            type="button"
                            className="ta-snapshot-action-btn"
                            onClick={() => { showOpeningNote(`Opening ${s.coin} Chart…`); setChartModal({ coin: s.coin }); }}
                          >
                            Chart
                          </button>
                          <button
                            type="button"
                            className="ta-snapshot-action-btn"
                            onClick={() => { showOpeningNote(`Opening ${s.coin} Order Book…`); setOrderBookModalCoin(s.coin); }}
                          >
                            Order Book
                          </button>
                        </div>
                        {openingNote && <span className="ta-snapshot-opening-note">{openingNote}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {sending && (
              <div className="ta-msg ta-msg--agent">
                <button
                  type="button"
                  className="ta-msg-text ta-typing ta-typing--interruptible"
                  onClick={handleInterruptTyping}
                  aria-label="Tap to interrupt"
                >
                  <span className="ta-thinking-orb" />
                  <span className="ta-thinking-copy">
                    <span className="ta-thinking-label">
                      {liveThinking || "Thinking…"}
                    </span>
                    <span className="ta-thinking-interrupt-hint">Tap to interrupt</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {error && <p className="ta-error">{error}</p>}

          {/* Replaces the old full-screen overlay's "tap anywhere to
              interrupt" — the reply is already sitting in the feed above by
              the time audio plays (loadAll() already ran), so this is purely
              a way to cut off playback early, not something the UI depends
              on to show anything. */}
          {(speaking || synthesizing) && (
            <button type="button" className="ta-speaking-pill" onClick={handleInterruptSpeech}>
              🔊 {synthesizing && !speaking ? "Getting audio ready…" : "Speaking — tap to stop"}
            </button>
          )}

          {pendingImage && (
            <div className="ta-pending-image">
              <img src={pendingImage} alt="Chart screenshot to analyze" />
              <button
                type="button"
                className="ta-pending-image-remove"
                onClick={() => setPendingImage(null)}
                aria-label="Remove attached image"
                title="Remove attached image"
              >
                ✕
              </button>
            </div>
          )}
          <div className={`ta-composer${listening ? " ta-composer--recording" : ""}`}>
            {listening && SPEECH_AVAILABLE && (
              <button
                type="button"
                className="ta-composer-cancel"
                onClick={handleMicCancel}
                aria-label="Cancel recording"
                title="Cancel recording"
              >
                ✕
              </button>
            )}
            {listening && (
              <span className="ta-composer-waveform" aria-hidden="true">
                {Array.from({ length: 8 }).map((_, i) => <span key={i} className="ta-composer-waveform-bar" />)}
              </span>
            )}
            {/* The real input stays visible and IS the live transcript —
                a native text input auto-scrolls to keep its caret in view
                as you type past the visible width, which is exactly the
                "slides to show the newest words" behavior wanted here; a
                separate read-only element overwritten each time doesn't
                get that for free (see the scrollLeft effect above, which
                covers the one gap: a value set programmatically, with no
                real caret, doesn't auto-follow on its own). */}
            {/* Input + Send share one field box (.ta-composer-field) so the
                Send button reads as embedded inside the input. */}
            <div className="ta-composer-field">
            {/* Attach an image (chart screenshot etc.) — it shows as the
                pending thumbnail above and goes with the next message. */}
            <button
              type="button"
              className="ta-composer-attach"
              onClick={() => attachInputRef.current?.click()}
              disabled={sending || listening}
              aria-label="Attach an image"
              title="Attach an image"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref={attachInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                // Downscale big photos (max 1600px, JPEG) so the upload stays small.
                const reader = new FileReader();
                reader.onload = () => {
                  const img = new Image();
                  img.onload = () => {
                    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
                    const c = document.createElement("canvas");
                    c.width = Math.round(img.width * scale);
                    c.height = Math.round(img.height * scale);
                    c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
                    setPendingImage(c.toDataURL("image/jpeg", 0.85));
                  };
                  img.src = String(reader.result);
                };
                reader.readAsDataURL(file);
              }}
            />
            <input
              ref={composerInputRef}
              className="ta-composer-input"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); lastSendWasVoiceRef.current = false; noteTyping(); }}
              onKeyDown={(e) => { if (e.key === "Enter") { setTyping(false); handleSend(); } }}
              onFocus={() => { if (hubOpen) setHubOpen(false); }}
              placeholder={listening ? "Listening…" : "Tell the agent what to do…"}
              disabled={sending || listening}
            />
            {/* Mic and Send live inside the pill too, at its right end. */}
            {SPEECH_AVAILABLE && (
              <button
                type="button"
                className={`ta-composer-mic${listening ? " ta-composer-mic--active" : ""}`}
                onClick={handleMicTap}
                disabled={sending}
                aria-label={listening ? "Stop recording" : "Speak to the agent"}
                title={listening ? "Stop recording" : "Speak to the agent"}
              >
                {listening ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="2" width="6" height="11" rx="3" />
                    <path d="M5 10a7 7 0 0 0 14 0" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                    <line x1="8" y1="22" x2="16" y2="22" />
                  </svg>
                )}
              </button>
            )}
            {!listening && (
              <button
                type="button"
                className="ta-composer-send"
                onClick={() => { setTyping(false); handleSend(); }}
                disabled={sending || (!draft.trim() && !pendingImage)}
                aria-label="Send"
                title="Send"
              >
                {sending || (typing && draft.trim())
                  ? <span className="ta-send-dots" aria-label={sending ? "Sending" : "Typing"}><i /><i /><i /></span>
                  : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 19V5" />
                      <path d="M5 12l7-7 7 7" />
                    </svg>
                  )}
              </button>
            )}
            </div>
          </div>
        </>
      )}

      {/* Mobile-only Hub row (isMobile + hubOpen) — appears inline in the
          header instead of a bottom sheet now; each circular icon fades/
          scales in with an increasing delay (ta-hub-row-item's own
          --i-tied animation-delay) so they visibly land one after another
          rather than all at once. Re-rendered fresh (conditional mount)
          every time hubOpen flips true, so the entrance replays each
          time the row opens. Tapping an icon runs the real action, same
          handlers the desktop row's icons already use, and closes it. */}
      {isMobile && hubOpen && (
        <div
          className={`ta-hub-row${hubMoreRight ? " ta-hub-row--more" : ""}`}
          ref={(el) => {
            hubRowRef.current = el;
            if (el) requestAnimationFrame(() => updateHubFade(el));
          }}
          onScroll={(e) => updateHubFade(e.currentTarget)}
        >
          <button type="button" className="ta-hub-row-item" style={{ "--i": 0 } as React.CSSProperties} onClick={() => { handleNewConversation(); setHubOpen(false); }}>
            <span className="ta-hub-circle">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
            </span>
            <span className="ta-hub-circle-label">New</span>
          </button>
          <button type="button" className="ta-hub-row-item" style={{ "--i": 1 } as React.CSSProperties} onClick={() => { handleOpenHistory(); setHubOpen(false); }}>
            <span className="ta-hub-circle">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
            </span>
            <span className="ta-hub-circle-label">History</span>
          </button>
          <button type="button" className="ta-hub-row-item" style={{ "--i": 2 } as React.CSSProperties} onClick={() => { handleOpenWatches(); setHubOpen(false); }}>
            <span className="ta-hub-circle"><BellIcon size={20} /></span>
            <span className="ta-hub-circle-label">Watch</span>
          </button>
          <button type="button" className="ta-hub-row-item" style={{ "--i": 3 } as React.CSSProperties} onClick={() => { handleOpenPositions(); setHubOpen(false); }}>
            <span className="ta-hub-circle"><PositionsIcon size={20} /></span>
            <span className="ta-hub-circle-label">Positions</span>
          </button>
          <button type="button" className="ta-hub-row-item" style={{ "--i": 4 } as React.CSSProperties} onClick={() => { onReportIssue?.(); setHubOpen(false); }}>
            <span className="ta-hub-circle">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            </span>
            <span className="ta-hub-circle-label">Report</span>
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      {phase !== "hidden" && !hideTrigger && (
        <button
          type="button"
          className={`ta-trigger${open ? " ta-trigger--open" : ""}${phase === "pop" ? " ta-trigger--collapsed" : ""}${showcasePlaying ? " ta-trigger--showcase" : ""}`}
          onClick={() => {
            if (!canUseAgent) { onAgentLocked?.(); return; }
            setShowcasePlaying(false);
            if (triggerCapturesChart && !open) {
              window.dispatchEvent(new CustomEvent("request-chart-screenshot"));
              return;
            }
            setOpen((v) => !v);
          }}
        >
          {showcasePlaying && (
            <>
              <span className="ta-trigger-ring ta-trigger-ring--1" aria-hidden="true" />
              <span className="ta-trigger-ring ta-trigger-ring--2" aria-hidden="true" />
              <span className="ta-trigger-ring ta-trigger-ring--3" aria-hidden="true" />
              <span className="ta-trigger-sparkle ta-trigger-sparkle--1" aria-hidden="true" />
              <span className="ta-trigger-sparkle ta-trigger-sparkle--2" aria-hidden="true" />
              <span className="ta-trigger-sparkle ta-trigger-sparkle--3" aria-hidden="true" />
            </>
          )}
          <span className={`ta-trigger-orb${phase === "pop" ? " ta-trigger-orb--pop" : ""}${showcasePlaying ? " ta-trigger-orb--showcase" : ""}`} />
          {unread && !open && <span className="ta-trigger-dot" />}
          {!open && phase !== "pop" && (
            <span className="ta-trigger-label">
              {label}
              {phase === "expanding" && <span className="ta-trigger-cursor" />}
            </span>
          )}
        </button>
      )}
      {showcasePlaying && !open && (
        <div className="ta-trigger-callout" role="status">
          <span className="ta-trigger-callout-sparkle" aria-hidden="true">✨</span>
          Meet Agent Ready — your AI trading copilot
        </div>
      )}
      {open && isDesktop && createPortal(<div className="ta-backdrop" onClick={() => setOpen(false)} />, document.body)}
      {open && (isDesktop ? panel : createPortal(panel, document.body))}
      {chartModal && createPortal(
        <AgentChartModal coin={chartModal.coin} initialInterval={chartModal.interval} onClose={() => setChartModal(null)} />,
        document.body,
      )}
      {orderBookModalCoin && createPortal(
        <OrderBookProfileModal coin={orderBookModalCoin as CoinSymbol} onClose={() => setOrderBookModalCoin(null)} />,
        document.body,
      )}
    </>
  );
}
