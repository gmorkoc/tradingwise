import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { useAuth } from "../contexts/AuthContext";
import { supabase, hasAccess } from "../services/supabase";
import { CoinSymbol } from "../services/coinglass";
import { AgentChartModal } from "./AgentChartModal";
import { OrderBookProfileModal } from "./OrderBookProfile";
import { isWebPushAvailable, isWebPushSubscribed, subscribeWebPush } from "../services/webPush";
import {
  fetchPortfolio, fetchAgentMessages, sendAgentMessage, setActionStatus, executeTrade, executeBasket, closePosition, updateCashBalance, acceptConsent, updatePreferences,
  fetchConversations, deleteConversation, addAgentNote, cancelWatch, confirmWatch, fetchWatchesForConversation, fetchAllWatches, fetchAgentPerformance, synthesizeAgentSpeech,
  AgentMessage, PaperPortfolio, PaperPosition, ConversationSummary, AgentWatch, AgentAction, BalanceUpdate, AgentPerformance, MarketInterval, CoinSnapshot, ShowChartInterval, PreferencesUpdate,
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
// Desktop/web keep typing only; a Web Speech API path would need its own
// separate handling and isn't added here.
const SPEECH_AVAILABLE = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
// Gates the History list's swipe-to-delete gesture — a native iOS table-view
// convention, not something web/desktop users expect from a click-driven
// UI (they keep the always-visible trash-icon button instead).
const IS_IOS_NATIVE = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

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

// Spoken phrases that mean "I'm finished talking to you," not a real
// chat/trade message — an EXACT match on the whole (normalized) utterance
// only, never a substring check, since several of these ("close", "stop",
// "done") are completely ordinary words inside a real trading instruction
// ("close my BTC position", "stop loss at 80k", "I'm done buying more
// SOL") — those have extra words around them and must still reach the
// agent normally. Matched case/punctuation-insensitively against the
// user's full turn once speech recognition finishes it.
const VOICE_END_PHRASES = new Set([
  "bye", "goodbye", "good bye", "bye bye", "see you", "see ya", "goodnight", "good night",
  "i'm done", "im done", "i am done", "we're done", "were done", "done",
  "that's it", "thats it", "that's all", "thats all", "that'll be all", "thatll be all",
  "close", "stop", "exit", "quit", "end", "end call", "hang up",
  "i'm good", "im good", "all good", "nothing else", "nothing more",
  "thanks bye", "thank you bye", "ok bye", "okay bye", "ok goodbye", "okay goodbye",
]);
function isVoiceEndPhrase(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?,]+$/g, "");
  return VOICE_END_PHRASES.has(normalized);
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
function TrashIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6m4-6v6"
        stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// History row swipe-to-delete (iOS native only) — a rounded, floating
// "Delete" pill revealed behind the row as it slides left, Material-style
// per the reference design, rather than a full-bleed colored rectangle.
// Swiping past SWIPE_REVEAL_WIDTH and releasing reveals the pill (tap it
// to actually delete); swiping all the way past SWIPE_AUTO_DELETE_WIDTH
// and releasing deletes immediately with no second tap, for a fast
// Mail.app-style full swipe too. Tapping the row while a swipe is open
// (this one's or another's) just closes it, same as tapping elsewhere in
// a real swiped-open table view — it never also navigates on that same
// tap. Only one row stays revealed at a time (`revealed`/`onReveal` are
// lifted to the parent so opening one row closes any other already open).
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
function ConversationRow({
  conversation, active, revealed, onReveal, onOpen, onDelete,
}: {
  conversation: ConversationSummary;
  active: boolean;
  revealed: boolean;
  onReveal: (open: boolean) => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  // null while not actively dragging — rendered offset then falls back to
  // the committed `revealed` state instead, which is what makes the row
  // snap-animate back into place with a CSS transition rather than jumping.
  const [dragX, setDragX] = useState<number | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // Mutable mirrors of revealed/dragX/onReveal/onDelete for the native
  // listeners below — they're attached once (empty effect deps) so they
  // always need the CURRENT values, not whatever was current when the
  // listener was first attached.
  const stateRef = useRef({ revealed, dragX, onReveal, onDelete });
  stateRef.current = { revealed, dragX, onReveal, onDelete };

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
      const base = stateRef.current.revealed ? -SWIPE_REVEAL_WIDTH : 0;
      setDragX(Math.min(0, Math.max(-SWIPE_AUTO_DELETE_WIDTH - 40, base + dx)));
    };
    const onTouchEnd = () => {
      start = null;
      const x = stateRef.current.dragX;
      if (x == null) return;
      if (x <= -SWIPE_AUTO_DELETE_WIDTH) {
        hapticTap();
        stateRef.current.onDelete();
      } else {
        const nowRevealed = x < -SWIPE_REVEAL_WIDTH / 2;
        if (nowRevealed !== stateRef.current.revealed) hapticTap();
        stateRef.current.onReveal(nowRevealed);
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

  const x = dragX ?? (revealed ? -SWIPE_REVEAL_WIDTH : 0);
  // Fades/scales in over the first 36px of drag instead of popping in at
  // full size the instant the row starts moving — reads as the pill
  // genuinely "appearing" as you swipe, matching the Material-style
  // reference, rather than being an already-fully-formed shape that was
  // simply uncovered. A plain opacity/transform tween (not an animated
  // `width`, which forces layout on every single touchmove frame) is also
  // what actually fixes the jank — this is compositor-only.
  const revealProgress = Math.min(1, -x / 36);

  return (
    <div className="ta-history-item-swipe">
      <div className="ta-history-item-swipe-actions">
        <button
          type="button"
          className="ta-history-item-swipe-delete"
          style={{ opacity: revealProgress, transform: `scale(${0.7 + 0.3 * revealProgress})` }}
          onClick={() => { hapticTap(); onDelete(); }}
          aria-label="Delete conversation"
        >
          <TrashIcon size={15} />
          Delete
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
          onClick={() => { if (revealed) { onReveal(false); return; } onOpen(); }}
        >
          <span className="ta-history-item-preview">{conversation.preview || "(empty)"}</span>
          <span className="ta-history-item-meta">{conversation.messageCount} message{conversation.messageCount === 1 ? "" : "s"}</span>
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
  // Jumps the main dashboard to one of NAV_SECTIONS (edge function) —
  // powers the "Open <page> →" button a message's navigateTo renders.
  // Same shape as App.tsx's own setActiveSection, just typed loosely here
  // since this component doesn't import SectionId.
  onNavigateToSection?: (section: string) => void;
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

// Three dots that pulse in sequence (CSS-driven, staggered animation-delay
// per dot) instead of a static "…" — used only for the "Listening"/
// "Thinking" placeholder text, never for real recognized/spoken words,
// where movement would just hurt readability. (The rotating/curved-text
// effect around the orb was tried four separate ways — a ring, an
// upright-orbiting word, SVG curved text, plain-CSS curved text — and
// every single one made the orb itself stop rendering on-device for a
// reason never pinned down through code review alone. Reverted for good;
// this is the stable, confirmed-working version.)
function AnimatedDots() {
  return (
    <span className="ta-anim-dots" aria-hidden="true">
      <span className="ta-anim-dot" />
      <span className="ta-anim-dot" />
      <span className="ta-anim-dot" />
    </span>
  );
}

// Single-trade proposal card — extracted out of the text-chat message list
// so the exact same card (and Confirm/Dismiss handlers) can also render
// inside the voice overlay. Previously, a trade proposed during a voice
// session had nowhere to actually show up on screen — the overlay only
// ever had audio + a text caption, so the user heard "I've got the BTC
// trade for you" with nothing to look at or confirm until they backed out
// of voice mode entirely to the text view.
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

export function TradingAgent({ selectedCoin, hideTrigger, onNavigateToSection }: Props) {
  const { user, tier, profile } = useAuth();
  const isDesktop = useIsDesktop();

  // Deliberately NOT persisted to localStorage (unlike portfolioCollapsed
  // below) — localStorage survives a full close+relaunch (a fresh WebView/
  // JS process), so persisting this reopened the panel automatically even
  // after the user had genuinely closed the app, not just backgrounded it.
  // Plain in-memory state gives exactly the wanted behavior for free: a
  // real background→foreground cycle (the process stays alive) leaves this
  // untouched, so the panel is still open if it was open right before
  // minimizing; a true close+reopen is a new process that starts closed.
  const [open, setOpen] = useState(false);

  // Tapping a watch-triggered/position-closed push notification (web or
  // native — see webPush.ts/pushNotifications.ts's "agent_watch"/
  // "agent_position_close" routing) dispatches this so the panel actually
  // opens instead of the tap just focusing/launching the app with nothing
  // else happening.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("open-trading-agent", onOpen);
    return () => window.removeEventListener("open-trading-agent", onOpen);
  }, []);

  // FloatingNavBar's own raised Agent button (mobile, see hideTrigger
  // above) dispatches this on tap instead of calling setOpen directly —
  // it's a toggle (open AND close), unlike "open-trading-agent" above
  // (notification taps should always open, never accidentally close an
  // already-open panel).
  useEffect(() => {
    const onToggle = () => setOpen((v) => !v);
    window.addEventListener("toggle-trading-agent", onToggle);
    return () => window.removeEventListener("toggle-trading-agent", onToggle);
  }, []);

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
        await typeText("Agent ready");
        localStorage.setItem("tradingAgentFirstUseDone", "true");
      } else {
        setLabel("Agent ready");
      }
      if (!cancelledRef.current) setPhase("ready");
    })();
  }, [phase]);

  const [portfolio, setPortfolio] = useState<PaperPortfolio | null>(null);
  const [performance, setPerformance] = useState<AgentPerformance | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [watches, setWatches] = useState<Map<string, AgentWatch>>(new Map());
  // Every watch across every conversation, for the dedicated watchlist
  // view — distinct from `watches` above, which is only the current
  // conversation's (used for inline chips in the feed).
  const [allWatches, setAllWatches] = useState<AgentWatch[]>([]);
  const [showWatches, setShowWatches] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  // Live partial transcript shown in the listening overlay as words come
  // in. Mirrored into a ref too — the native "listeningState: stopped"
  // listener (registered once, see below) needs the true latest value at
  // the moment speech ends, and reading state directly there would see
  // whatever was current when that listener closure was created, not now.
  const [liveTranscript, setLiveTranscript] = useState("");
  const liveTranscriptRef = useRef("");
  // Own silence detection, not just trusting the native plugin's own
  // endpointing (inconsistent across devices/OS versions in partialResults
  // mode) — reset on every new partial result, and firing stop()s the
  // session if 2s pass with nothing new, same as the user going quiet.
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // Which conversation's row currently has its swipe-to-delete revealed
  // (iOS native only — see ConversationRow) — lifted up here rather than
  // kept local to each row so opening one row's swipe closes any other
  // that was already open, same as a real table view only ever reveals one.
  const [revealedRowId, setRevealedRowId] = useState<string | null>(null);
  // "Here's how you delete one" demo — auto-reveal the top row's swipe
  // (reusing the exact same revealedRowId mechanism/animation a real swipe
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
    if (!showHistory || !IS_IOS_NATIVE || conversations.length === 0) return;
    const alwaysShow = conversations.length <= 2;
    if (!alwaysShow) {
      if (swipeHintPlayedRef.current || localStorage.getItem(SWIPE_HINT_KEY)) return;
      swipeHintPlayedRef.current = true;
      localStorage.setItem(SWIPE_HINT_KEY, "true");
    }
    const firstId = conversations[0].id;
    const openTimer = setTimeout(() => {
      setRevealedRowId(firstId);
      hapticTap();
    }, 600);
    const closeTimer = setTimeout(() => {
      setRevealedRowId((cur) => (cur === firstId ? null : cur));
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
    (name) => `Hey${name ? ` ${name}` : ""}, how's it going? Got a coin in mind, or a budget/typical trade size you want me working with? Totally optional — otherwise just hit me with whatever's on your mind.`,
    (name) => `Yo${name ? ` ${name}` : ""}, good to see you again! Coin you're eyeing, or a budget you want me to keep in mind? No pressure — ask away whenever.`,
    (name) => `Hey hey${name ? `, ${name}` : ""} — welcome back! If there's a coin on your radar or a budget you want me working with, let me know. Or don't — we can figure it out as we go.`,
    (name) => `What's up${name ? ` ${name}` : ""}! Got a coin you're thinking about, or a budget/trade size in mind? Happy to work with whatever you've got, or we can just dive straight in.`,
    (name) => `Hey${name ? ` ${name}` : ""}, how ya doing? Throw a coin or budget at me if you've got one in mind — if not, no worries, just ask me anything.`,
    (name) => `Great to have you back${name ? `, ${name}` : ""}! Coin on your mind, or a budget you want me working with? All optional — otherwise just fire away.`,
    (name) => `Hey${name ? ` ${name}` : ""}! Ready when you are — got a coin you're watching, or a budget in mind? Or just jump straight into it, totally up to you.`,
    (name) => `Yo${name ? ` ${name}` : ""}, what's good? Mention a coin or budget if you've got one, or just ask me anything — we'll sort the details as we go.`,
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
    const nickname = profile?.username?.trim() || null;
    const greeting = OPENER_GREETINGS[Math.floor(Math.random() * OPENER_GREETINGS.length)](nickname);
    addAgentNote(user.id, conversationId, greeting)
      .then(() => loadAll(conversationId)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
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
      // Closing the panel is the other way out of a hands-free voice-mode
      // loop, besides the explicit Cancel in handleMicCancel — otherwise
      // it'd keep re-arming the mic in the background after the user
      // navigated away from the panel entirely.
      exitVoiceMode();
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

  const handleNewConversation = () => {
    setConversationId(newConversationId());
    setMessages([]);
    setShowHistory(false);
    setShowWatches(false);
    openerSentRef.current = false;
  };

  const handleOpenHistory = async () => {
    // showHistory/showWatches are two independent flags gating alternate
    // views in the same spot — without clearing the other one here, going
    // Watches -> History -> (tap a conversation) left showWatches stuck
    // true, so opening a conversation dropped the user back on
    // Notifications instead of the chat they just tapped.
    setShowWatches(false);
    setShowHistory(true);
    try { await loadConversations(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const loadAllWatches = useCallback(async () => {
    if (!user) return;
    setAllWatches(await fetchAllWatches(user.id));
  }, [user]);

  const handleOpenWatches = async () => {
    setShowHistory(false);
    setShowWatches(true);
    try { await loadAllWatches(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const handleOpenConversation = async (id: string) => {
    setConversationId(id);
    setShowHistory(false);
    setShowWatches(false);
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
  const handleSend = async (overrideContent?: string) => {
    const content = overrideContent ?? draft.trim();
    if (!content || sending) return;
    // Reset immediately (not after the round trip) so a typed message sent
    // while a voice reply would otherwise still be pending doesn't also
    // get spoken aloud — only the question that actually came in by voice
    // does.
    const viaVoice = lastSendWasVoiceRef.current;
    lastSendWasVoiceRef.current = false;
    setDraft("");
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
      createdAt: new Date().toISOString(),
    }]);
    // Lets a tap on the "Thinking…" overlay (handleInterruptThinking below)
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
      await loadAll(conversationId);
      setSending(false);
    }
  };

  // Always-current ref to handleSend — registered once below in a
  // mount-only effect (so the native listeners aren't torn down and
  // re-added on every render), which would otherwise close over whichever
  // handleSend existed at mount and send with stale conversationId/history.
  const handleSendRef = useRef(handleSend);
  useEffect(() => { handleSendRef.current = handleSend; });
  // Set right before stopping for an explicit Cancel (see handleMicCancel)
  // — the "listeningState: stopped" listener below fires either way (a
  // manual stop and a cancel both end the same native session the same
  // way), and this is what tells it to discard instead of send.
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
  // Hands-free "on the go" mode (ChatGPT voice mode style) — entered by a
  // fresh mic tap, exited by tapping again mid-listen, Cancel, or closing
  // the panel. A ref (not just state) since it's read from inside
  // speakLatestAgentReply's utterance.onend callback, which closes over
  // whatever render created it — the state alone could be stale by the
  // time speech actually finishes a few seconds later.
  const [voiceMode, setVoiceMode] = useState(false);
  const voiceModeRef = useRef(false);
  const enterVoiceMode = () => { voiceModeRef.current = true; setVoiceMode(true); };
  // Drives the overlay's "speaking" sub-state below (listening/thinking/
  // speaking are the three ChatGPT-voice-mode phases shown on the one
  // screen) and the reply text shown while it's being read aloud.
  const [speaking, setSpeaking] = useState(false);
  // True only while synthesizeAgentSpeech itself is in flight — the real
  // gap this was missing: handleSend's `sending` turns false the moment
  // the TEXT reply lands (speakLatestAgentReply below is fired without
  // awaiting it), but speech synthesis is a separate network call that can
  // itself take a while. The overlay's "Thinking…" display covers this
  // gap too (see its fallback branch below), so this needs its own flag —
  // without it, that stretch had no sending/speaking/listening true at
  // all, and the whole "tap anywhere to interrupt" affordance silently
  // went dead for however long synthesis took.
  const [synthesizing, setSynthesizing] = useState(false);
  const [spokenReply, setSpokenReply] = useState("");
  // Live numbers (price/RSI/MACD/trend/funding/OI) for whatever coin(s) the
  // latest turn actually resolved — shown as a compact data card during a
  // voice session so the live interaction isn't audio/text-only. Cleared
  // when voice mode exits so a stale card never lingers into a fresh
  // session. Transient only, never persisted (see sendAgentMessage).
  const [lastMarketSnapshot, setLastMarketSnapshot] = useState<CoinSnapshot[] | null>(null);
  // Which coin's chart / order book modal is currently open, if any — at
  // most one of these at a time, triggered from a snapshot card's own
  // buttons (see the voice overlay JSX below).
  const [chartModal, setChartModal] = useState<{ coin: string; interval?: ShowChartInterval } | null>(null);
  const [orderBookModalCoin, setOrderBookModalCoin] = useState<string | null>(null);
  // Brief "Opening Chart…"/"Opening Order Book…" acknowledgment for the
  // voice-session snapshot card's two buttons below — on a real device
  // there's a visible beat between the tap and the modal actually painting
  // (data fetch, chart library init), and with no feedback at all in that
  // gap it read as if the button had silently done nothing.
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
  // Every exit calls stopSpeaking() itself now (used to be a separate
  // paired call at each of the 3 call sites — easy to forget one, which
  // is exactly the bug where audio kept playing after backing out of
  // voice mode back to the text chat).
  const exitVoiceMode = () => {
    voiceModeRef.current = false;
    setVoiceMode(false);
    setSpeaking(false);
    setSpokenReply("");
    setLastMarketSnapshot(null);
    stopSpeaking();
    // Closing out mid-"Thinking…" (panel close, Cancel) should cancel
    // whatever request is still in flight rather than leave it to resolve
    // into a voice session that's no longer there.
    sendAbortControllerRef.current?.abort();
  };
  // Tap-to-interrupt during "Thinking…" — mirrors handleInterruptSpeech
  // below (same gesture, same place in the overlay). Deliberately tap-only
  // rather than hands-free: starting a second native mic session right
  // before TTS playback begins is what was causing the app to crash (an
  // AVAudioSession conflict between tearing down a recognition session and
  // starting audio playback in quick succession) — see this session's
  // notes. A tap has no such race since nothing else is touching the audio
  // session at that moment. Covers BOTH "Thinking…" sub-phases the overlay
  // can show — waiting on the text reply (sending) and waiting on TTS
  // synthesis of that reply (synthesizing, see speakLatestAgentReply) —
  // stopSpeaking() bumps the generation stamp so a synthesis request still
  // in flight gets silently discarded the moment it lands instead of
  // playing audio for a turn the user already backed out of.
  const handleInterruptThinking = () => {
    sendAbortControllerRef.current?.abort();
    stopSpeaking();
    setSending(false);
    setSynthesizing(false);
    startListening();
  };
  // Same idea as handleInterruptThinking above, minus the startListening()
  // call — that one resumes the mic because it's only ever reachable from
  // inside an active voice session; this is the plain typed-chat "Thinking…"
  // bubble, where restarting the mic would be wrong (the user is typing,
  // not talking). Exists because a slow/hung backend reply previously left
  // no way out of "Thinking…" at all outside of a voice session — closing
  // the panel was the only escape.
  const handleInterruptTyping = () => {
    sendAbortControllerRef.current?.abort();
    setSending(false);
  };
  // Set right before a manual interrupt stops playback early — this is
  // what keeps the ended/error handlers below from ALSO calling
  // startListening() a moment after this does it directly, which would
  // otherwise start two recognition sessions at once.
  const speechInterruptedRef = useRef(false);
  const handleInterruptSpeech = () => {
    speechInterruptedRef.current = true;
    stopSpeaking();
    setSpeaking(false);
    startListening();
  };

  // Speaks the newest agent message, if the latest message in the
  // freshly-reloaded array is in fact one — it won't be if the request
  // errored before the agent replied, in which case there's nothing to
  // speak. Synthesizes real audio via OpenAI's neural TTS (agent-speech
  // edge function, same class of model ChatGPT's own voice mode uses)
  // rather than any on-device synthesizer — no local iOS voice, however
  // "Enhanced"/"Premium" its quality tier, sounds like a real neural TTS
  // model; it's a different generation of technology entirely. In voice
  // mode, finishing playback re-arms the mic automatically (startListening,
  // defined below but already bound by the time this actually runs) so the
  // conversation keeps going hands-free instead of waiting on another
  // manual tap each turn.
  const speakLatestAgentReply = async (msgs: AgentMessage[]) => {
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "agent" || !last.content) return;
    stopSpeaking();
    setSpokenReply(last.content);
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
        if (speechInterruptedRef.current) { speechInterruptedRef.current = false; return; }
        if (voiceModeRef.current) startListening();
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      setSpeaking(true);
      await audio.play();
    } catch {
      // Synthesis request failed (offline, server error) — nothing to
      // play, but the loop still needs to continue rather than stall
      // silently on a turn with no audio.
      if (speechGenerationRef.current !== myGeneration) return;
      setSynthesizing(false);
      setSpeaking(false);
      if (voiceModeRef.current) startListening();
    }
  };

  // 4s of no new partial result = treat it as the user going quiet and
  // stop on our own, rather than trusting however long (or whether at
  // all) the native session's own endpointing decides to wait in
  // partialResults mode.
  const armSilenceTimer = () => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      SpeechRecognition.stop().catch(() => { /* already stopped */ });
    }, 4000);
  };
  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
  };

  useEffect(() => {
    if (!SPEECH_AVAILABLE) return;
    const partialSub = SpeechRecognition.addListener("partialResults", ({ matches }) => {
      const text = matches?.[0] ?? "";
      liveTranscriptRef.current = text;
      setLiveTranscript(text);
      armSilenceTimer();
    });
    const stateSub = SpeechRecognition.addListener("listeningState", ({ status }) => {
      if (status !== "stopped") return;
      clearSilenceTimer();
      setListening(false);
      const transcript = liveTranscriptRef.current.trim();
      const cancelled = speechCancelledRef.current;
      liveTranscriptRef.current = "";
      speechCancelledRef.current = false;
      setLiveTranscript("");
      if (transcript && !cancelled && isVoiceEndPhrase(transcript)) {
        // A closing phrase ("I'm done", "goodbye", "close"...) ends the
        // hands-free loop the same way a manual Cancel tap does — it's
        // not a real chat/trade message, so it never reaches the agent.
        exitVoiceMode();
      } else if (transcript && !cancelled) {
        lastSendWasVoiceRef.current = true;
        handleSendRef.current(transcript);
      }
    });
    return () => {
      clearSilenceTimer();
      partialSub.then((h) => h.remove());
      stateSub.then((h) => h.remove());
    };
  }, []);

  // Pro+ feature — free users don't get the trigger/panel at all. This has
  // to come after every hook above (not as an early return further up) —
  // React requires the exact same hooks, in the exact same order, on
  // every render. A guard placed before some of them meant a user whose
  // tier resolved to pro/elite *after* sign-in changed the hook count
  // between renders, which is a silent dev-mode warning but a fatal,
  // unrecoverable crash in a production/minified build — exactly what
  // happened here (and the same bug class previously fixed in
  // ProfilePage.tsx, commit 6cb3507).
  if (!user || !hasAccess(tier, "pro")) return null;

  // Split from handleMicTap so speakLatestAgentReply's auto-continue (once
  // TTS finishes, in voice mode) can start the next turn's listening
  // directly — going through handleMicTap there would hit its own
  // voice-mode-exit branch below (meant for an actual user tap) and
  // immediately cancel the loop it's trying to continue.
  const startListening = async () => {
    try {
      const { speechRecognition } = await SpeechRecognition.checkPermissions();
      if (speechRecognition !== "granted") {
        const req = await SpeechRecognition.requestPermissions();
        if (req.speechRecognition !== "granted") return;
      }
      liveTranscriptRef.current = "";
      setLiveTranscript("");
      setListening(true);
      enterVoiceMode();
      armSilenceTimer();
      await SpeechRecognition.start({ language: "en-US", maxResults: 1, partialResults: true });
    } catch (err) {
      setListening(false);
      console.error("Speech recognition failed:", err);
    }
  };

  // Tap to start, tap (anywhere on the listening overlay) to stop early —
  // partialResults:true streams words in live as they're recognized (see
  // the "partialResults" listener below, feeding liveTranscript) instead
  // of waiting silently until the end, closer to how ChatGPT's voice mode
  // shows your words arriving as you speak. Either this manual stop or the
  // plugin's own silence detection ends the native session the same way
  // (the "listeningState" listener below reacts to both identically),
  // finalizing whatever's been captured and sending it as the message —
  // unlike handleMicCancel below, which ends it the same way but discards.
  // A third tap, between turns while voice mode is active but not
  // currently listening (the agent replying/speaking), exits the loop —
  // the same "stop it" gesture Cancel is for the other state.
  const handleMicTap = async () => {
    if (listening) {
      try { await SpeechRecognition.stop(); } catch { /* already stopped */ }
      return;
    }
    if (voiceModeRef.current) {
      exitVoiceMode();
      return;
    }
    await startListening();
  };

  // Explicit "never mind" — stops the same way handleMicTap's early-stop
  // does, but flags it first so the listener above discards the transcript
  // instead of sending it. Also the one deliberate way out of hands-free
  // voice mode — the ongoing loop otherwise has no other exit besides
  // closing the panel entirely.
  const handleMicCancel = async () => {
    speechCancelledRef.current = true;
    exitVoiceMode();
    try { await SpeechRecognition.stop(); } catch { /* already stopped */ }
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
          <button type="button" className="ta-head-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
        </div>
      </div>

      {showHistory ? (
        <div className="ta-history">
          <div className="ta-history-list">
            {conversations.length === 0 && (
              <p className="ta-empty">No past conversations yet.</p>
            )}
            {conversations.map((c) => (
              IS_IOS_NATIVE ? (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  active={c.id === conversationId}
                  revealed={revealedRowId === c.id}
                  onReveal={(open) => setRevealedRowId(open ? c.id : null)}
                  onOpen={() => handleOpenConversation(c.id)}
                  onDelete={() => { setRevealedRowId(null); handleDeleteConversation(c.id); }}
                />
              ) : (
                <div key={c.id} className={`ta-history-item${c.id === conversationId ? " ta-history-item--active" : ""}`}>
                  <button type="button" className="ta-history-item-main" onClick={() => handleOpenConversation(c.id)}>
                    <span className="ta-history-item-preview">{c.preview || "(empty)"}</span>
                    <span className="ta-history-item-meta">{c.messageCount} message{c.messageCount === 1 ? "" : "s"}</span>
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
            ))}
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
      })() : needsConsent ? (
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
                    return (
                      <div key={key} className="ta-position">
                        <span className="ta-position-coin">{p.coin}</span>
                        <span className="ta-position-qty">{p.qty} @ ${p.avgEntryPrice.toLocaleString()}</span>
                        <button
                          type="button"
                          className="ta-position-close"
                          onClick={() => handleClosePosition(p)}
                          disabled={closingPosition === key}
                        >
                          {closingPosition === key ? "Closing…" : "Close"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              </>
              )}
            </div>
          )}

          <div className="ta-feed" ref={feedRef}>
            {messages.length === 0 && (
              <p className="ta-empty">
                Try "buy $200 of BTC", "sell half my ETH", or "what do you think about SOL?" — everything here is simulated, no real money or exchange involved.
              </p>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`ta-msg ta-msg--${m.role}`}>
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
                <p className="ta-msg-text">{m.content}</p>
                <span className="ta-msg-time">{formatMsgTime(m.createdAt)}</span>
                {m.newsSources && m.newsSources.length > 0 && (
                  <div className="ta-sources">
                    <span className="ta-sources-label">
                      {m.newsSources.length} {m.newsSources.length === 1 ? "Source" : "Sources"}
                    </span>
                    <div className="ta-sources-list">
                      {m.newsSources.map((n, i) => (
                        <a key={i} className="ta-sources-chip" href={n.url} target="_blank" rel="noopener noreferrer" title={n.title}>
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

          <div className="ta-composer">
            <input
              className="ta-composer-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
              placeholder={listening ? "Listening…" : "Tell the agent what to do…"}
              disabled={sending || listening}
            />
            {SPEECH_AVAILABLE && (
              <button
                type="button"
                className={`ta-composer-mic${listening ? " ta-composer-mic--active" : ""}${voiceMode && !listening ? " ta-composer-mic--voice-mode" : ""}`}
                onClick={handleMicTap}
                disabled={sending}
                aria-label={listening ? "Stop listening" : voiceMode ? "Voice mode active" : "Speak to the agent"}
                title={listening ? "Stop listening" : voiceMode ? "Voice mode active — tap Cancel to stop" : "Speak to the agent"}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="11" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                  <line x1="8" y1="22" x2="16" y2="22" />
                </svg>
              </button>
            )}
            <button type="button" className="ta-composer-send" onClick={() => handleSend()} disabled={sending || !draft.trim()}>
              {sending ? "…" : "Send"}
            </button>
          </div>
        </>
      )}

      {/* One continuous full-panel screen for the whole voice session —
          literally ChatGPT voice mode's model: listen, think, speak, listen
          again, all without ever dropping back to the text chat view in
          between. The chat list underneath keeps recording every turn via
          loadAll exactly as before; it's just not shown again until voice
          mode actually exits (Cancel, re-tapping the mic between turns, or
          closing the panel), at which point the full back-and-forth is
          already sitting there as regular messages. */}
      {voiceMode && (() => {
        // While there's real content to show (live numbers, a trade
        // proposal) the orb shrinks and moves to the top-left instead of
        // sitting centered and competing with that content for space —
        // reverts back to centered once there's nothing to show again
        // (e.g. plain chat, or back to a fresh listen with no proposal
        // pending). Only CSS size/layout changes on the EXISTING elements,
        // no new wrapper around the orb — seeF the orb-wrapper note above
        // for why that specifically keeps breaking it.
        const latestMsg = messages.length > 0 && messages[messages.length - 1].role === "agent" ? messages[messages.length - 1] : null;
        const hasPendingAction = !!(latestMsg?.action && latestMsg.actionStatus === "pending");
        const hasContent = (lastMarketSnapshot && lastMarketSnapshot.length > 0) || hasPendingAction;
        // Covers both "Thinking…" sub-phases (waiting on the text reply,
        // then waiting on TTS synthesis of it) — see synthesizing's own
        // comment above for why this needs to be two flags, not one.
        const thinking = sending || synthesizing;
        return (
        <div
          className={`ta-listening-overlay${hasContent ? " ta-listening-overlay--compact" : ""}`}
          onClick={listening ? handleMicTap : speaking ? handleInterruptSpeech : thinking ? handleInterruptThinking : undefined}
          role="button"
          aria-label={listening ? "Stop listening and send" : speaking ? "Tap to interrupt" : thinking ? "Tap to interrupt" : "Voice session"}
        >
          <button
            type="button"
            className="ta-listening-cancel"
            onClick={(e) => { e.stopPropagation(); handleMicCancel(); }}
          >
            Cancel
          </button>
          {openingNote && <div className="ta-listening-opening-note">{openingNote}</div>}
          {/* Orb is a direct flex child, untouched, no wrapper div — the
              confirmed-stable version after four separate rotating/
              curved-text attempts around it all broke its rendering on-
              device. Static placeholder text now sits ABOVE the orb (just
              DOM order within the flex column — orb itself still
              completely unchanged) with three pulsing dots instead of a
              plain "…" for a little life without touching the orb again. */}
          <div className="ta-listening-orb-group">
            <p className="ta-listening-transcript">
              {listening
                ? (liveTranscript || <>Listening<AnimatedDots /></>)
                : speaking
                  ? spokenReply
                  : <>Thinking<AnimatedDots /></>}
            </p>
            <span
              className={`ta-trigger-orb ta-listening-orb${
                thinking && !speaking ? " ta-listening-orb--thinking" : speaking ? " ta-listening-orb--speaking" : ""
              }`}
            />
          </div>
          {/* Live numbers for whatever coin(s) the conversation actually
              resolved — the voice session was audio/text-only before this,
              with price/RSI/MACD/funding/OI only ever used server-side to
              write the spoken reply, never shown. Persists across turns
              within one session (cleared on exitVoiceMode) so it's not just
              a flash during "thinking." */}
          {lastMarketSnapshot && lastMarketSnapshot.length > 0 && (
            // No stopPropagation here — the card's own Chart/Order Book
            // buttons already guard themselves individually below, so a
            // blanket stop here only meant tapping the card's inert area
            // (price, RSI row) silently ate the "tap anywhere to
            // interrupt" gesture instead of covering most of the screen.
            <div className="ta-listening-snapshot">
              {lastMarketSnapshot.slice(0, 3).map((s) => (
                <div key={s.coin} className="ta-listening-snapshot-card">
                  <div className="ta-listening-snapshot-head">
                    <span className="ta-listening-snapshot-coin">{s.coin}</span>
                    <span className="ta-listening-snapshot-price">
                      ${s.price.toLocaleString(undefined, { maximumFractionDigits: s.price < 1 ? 6 : 2 })}
                    </span>
                    {s.trend && (
                      <span className={`ta-listening-snapshot-trend ta-listening-snapshot-trend--${s.trend}`}>
                        {s.trend === "up" ? "▲" : s.trend === "down" ? "▼" : "—"} {s.trend}
                      </span>
                    )}
                  </div>
                  {s.recentCloses && s.recentCloses.length > 1 && (
                    <Sparkline closes={s.recentCloses} />
                  )}
                  <div className="ta-listening-snapshot-row">
                    <span>RSI {s.rsi != null ? s.rsi.toFixed(1) : "n/a"}</span>
                    <span>MACD {s.macdHist != null ? (s.macdHist >= 0 ? "▲" : "▼") : "n/a"}</span>
                    {s.fundingRatePct != null && (
                      <span>Funding {s.fundingRatePct >= 0 ? "+" : ""}{s.fundingRatePct.toFixed(3)}%</span>
                    )}
                    {s.openInterestUsd != null && (
                      <span>OI {formatAbbrevUsd(s.openInterestUsd)}</span>
                    )}
                  </div>
                  <div className="ta-listening-snapshot-actions">
                    <button
                      type="button"
                      className="ta-listening-snapshot-action-btn"
                      onClick={(e) => { e.stopPropagation(); showOpeningNote(`Opening ${s.coin} Chart…`); setChartModal({ coin: s.coin }); }}
                    >
                      Chart
                    </button>
                    <button
                      type="button"
                      className="ta-listening-snapshot-action-btn"
                      onClick={(e) => { e.stopPropagation(); showOpeningNote(`Opening ${s.coin} Order Book…`); setOrderBookModalCoin(s.coin); }}
                    >
                      Order Book
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* The actual trade card — previously a trade proposed during a
              voice session had nowhere to show up on screen at all: the
              overlay only ever had audio + a text caption, so hearing
              "I've got the BTC trade for you" left nothing to look at or
              confirm without backing out of voice mode entirely. Same
              card/handlers as the text-chat list (ActionProposalCard). */}
          {hasPendingAction && latestMsg && (
            <div className="ta-listening-proposal" onClick={(e) => e.stopPropagation()}>
              <ActionProposalCard message={latestMsg} executingId={executingId} onConfirm={handleConfirm} onDismiss={handleDismiss} />
            </div>
          )}
          {/* Same headline sources already rendered under a text-chat agent
              bubble (see m.newsSources below) — just also surfaced here so
              a voice session isn't missing the one piece of context that
              otherwise only ever showed up in the chat log after the fact. */}
          {!listening && messages.length > 0 && messages[messages.length - 1].role === "agent" &&
            messages[messages.length - 1].newsSources && messages[messages.length - 1].newsSources!.length > 0 && (
            <div className="ta-listening-news" onClick={(e) => e.stopPropagation()}>
              {messages[messages.length - 1].newsSources!.slice(0, 2).map((n, i) => (
                <a
                  key={i}
                  href={n.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ta-listening-news-item"
                  onClick={(e) => e.stopPropagation()}
                >
                  {n.source}: {n.title}
                </a>
              ))}
            </div>
          )}
          <span className="ta-listening-hint">
            {listening ? "Tap anywhere to stop and send" : speaking || thinking ? "Tap anywhere to interrupt" : ""}
          </span>
        </div>
        );
      })()}
    </div>
  );

  return (
    <>
      {phase !== "hidden" && !hideTrigger && (
        <button
          type="button"
          className={`ta-trigger${open ? " ta-trigger--open" : ""}${phase === "pop" ? " ta-trigger--collapsed" : ""}`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`ta-trigger-orb${phase === "pop" ? " ta-trigger-orb--pop" : ""}`} />
          {unread && !open && <span className="ta-trigger-dot" />}
          {!open && phase !== "pop" && (
            <span className="ta-trigger-label">
              {label}
              {phase === "expanding" && <span className="ta-trigger-cursor" />}
            </span>
          )}
        </button>
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
