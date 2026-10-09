import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { useAuth } from "../contexts/AuthContext";
import { supabase, hasAccess } from "../services/supabase";
import { COINS, CoinSymbol } from "../services/coinglass";
import { AgentChartModal } from "./AgentChartModal";
import { OrderBookProfileModal } from "./OrderBookProfile";
import { isWebPushAvailable, isWebPushSubscribed, subscribeWebPush } from "../services/webPush";
import {
  fetchPortfolio, fetchAgentMessages, sendAgentMessage, setActionStatus, executeTrade, executeBasket, closePosition, updateCashBalance, acceptConsentAndOnboard,
  fetchConversations, deleteConversation, addAgentNote, cancelWatch, confirmWatch, fetchWatchesForConversation, fetchAllWatches, fetchAgentPerformance, synthesizeAgentSpeech,
  AgentMessage, PaperPortfolio, PaperPosition, ConversationSummary, AgentWatch, AgentAction, BalanceUpdate, AgentPerformance, MarketInterval, CoinSnapshot, ShowChartInterval,
} from "../services/paperTrading";

const DEFAULT_STARTING_BALANCE = 100000;
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

interface Props {
  selectedCoin?: string | null;
  // Mobile-only (FloatingNavBar renders the trigger itself there, raised
  // in the bar's center) — desktop keeps this component's own floating
  // "Agent Ready" button exactly as before, untouched by that mobile work.
  hideTrigger?: boolean;
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

export function TradingAgent({ selectedCoin, hideTrigger }: Props) {
  const { user, tier } = useAuth();
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
  const focusInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Consent and onboarding questions are two separate gates, not one:
  // - Consent (the risk disclaimer) is asked once per account, ever — gated
  //   by the portfolio row's persistent consent_accepted_at.
  // - The onboarding questions (experience/balance/trade size/focus coins/
  //   leverage) are asked at the start of every NEW conversation, win or
  //   lose consent state, so the agent always opens with a current read on
  //   intent/risk appetite rather than trusting answers from weeks ago.
  const needsConsent = !portfolio?.consentAcceptedAt;
  // Free-typed strings, not numbers — a controlled number input that
  // clamps on every keystroke fights the user while typing (can't clear
  // the field, can't type a fresh multi-digit value). Clamping/validation
  // only happens on submit, against the parsed number.
  const [onboardBalance, setOnboardBalance] = useState(String(DEFAULT_STARTING_BALANCE));
  const [onboardTradeSize, setOnboardTradeSize] = useState("500");
  const [onboardAllowLeverage, setOnboardAllowLeverage] = useState(false);
  const [onboardFocusCoins, setOnboardFocusCoins] = useState<string[]>([]);
  const [focusSearch, setFocusSearch] = useState("");
  const [onboarding, setOnboarding] = useState(false);
  // One question at a time, like a guided chat flow, instead of a single
  // static form — each answered step collapses to a dimmed summary line
  // and the next question animates in. 0 = disclaimer, 1 = balance,
  // 2 = trade size, 3 = focus coins, 4 = leverage (final step, submits).
  const [onboardStep, setOnboardStep] = useState(0);
  // Once consent is already on file, a fresh conversation should jump
  // straight past the disclaimer step into the actual questions — but only
  // once portfolio has loaded and only while still sitting on step 0, so
  // this doesn't clobber a flow already in progress.
  useEffect(() => {
    if (portfolio?.consentAcceptedAt && messages.length === 0 && onboardStep === 0) {
      setOnboardStep(1);
    }
  }, [portfolio?.consentAcceptedAt, messages.length, onboardStep]);
  // Brief "typing" beat before each new onboarding question reveals itself
  // — same thinking/typing feeling as the chat composer's typing-dots
  // indicator, so the guided questions read as the agent asking them live
  // rather than a static form just swapping fields.
  const [stepTyping, setStepTyping] = useState(false);
  useEffect(() => {
    if (onboardStep === 0) return;
    setStepTyping(true);
    const t = setTimeout(() => setStepTyping(false), 550);
    return () => clearTimeout(t);
  }, [onboardStep]);
  const [leverageHelpOpen, setLeverageHelpOpen] = useState(false);
  // Asked up front (right after consent) so the balance/trade-size steps
  // that follow can open pre-filled with sensible defaults for that level
  // — but each of those steps still offers its own "not sure?" fallback
  // too, since a pre-filled number isn't the same as being confident in it.
  type ExperienceLevel = "new" | "some" | "experienced";
  const EXPERIENCE_DEFAULTS: Record<ExperienceLevel, { balance: number; riskPct: number }> = {
    new: { balance: 1000, riskPct: 0.01 },
    some: { balance: 10000, riskPct: 0.03 },
    experienced: { balance: 100000, riskPct: 0.05 },
  };
  const [onboardExperience, setOnboardExperience] = useState<ExperienceLevel | null>(null);
  // The other onboarding questions (balance/trade size/focus coins/
  // leverage) deliberately re-ask every new conversation — intent/risk
  // appetite can change chat to chat. Experience level is different: it's
  // just a label picking sensible starting defaults, not something that
  // meaningfully changes day to day, so it's the one step worth letting
  // the user skip for good once they've answered it the first time.
  const REMEMBERED_EXPERIENCE_KEY = "tradingAgentRememberedExperience";
  const [rememberedExperience, setRememberedExperience] = useState<ExperienceLevel | null>(() => {
    const v = localStorage.getItem(REMEMBERED_EXPERIENCE_KEY);
    return v === "new" || v === "some" || v === "experienced" ? v : null;
  });
  const [rememberExperienceChoice, setRememberExperienceChoice] = useState(true);
  const selectExperience = (level: ExperienceLevel, remember: boolean) => {
    const { balance, riskPct } = EXPERIENCE_DEFAULTS[level];
    setOnboardExperience(level);
    setOnboardBalance(String(balance));
    setOnboardTradeSize(String(Math.round(balance * riskPct)));
    setOnboardStep(2);
    if (remember) {
      localStorage.setItem(REMEMBERED_EXPERIENCE_KEY, level);
      setRememberedExperience(level);
    }
  };
  // Bypasses the question entirely once a prior answer is remembered — the
  // user never sees step 1 at all, it just resolves straight through to
  // step 2 with the remembered defaults already applied.
  useEffect(() => {
    if (onboardStep === 1 && rememberedExperience) selectExperience(rememberedExperience, false);
  }, [onboardStep, rememberedExperience]);
  const forgetExperience = () => {
    localStorage.removeItem(REMEMBERED_EXPERIENCE_KEY);
    setRememberedExperience(null);
    setOnboardExperience(null);
    setOnboardStep(1);
  };
  const [balanceHelpOpen, setBalanceHelpOpen] = useState(false);
  const [tradeSizeHelpOpen, setTradeSizeHelpOpen] = useState(false);
  const applyBalanceSuggestion = (amount: number) => {
    setOnboardBalance(String(amount));
    setBalanceHelpOpen(false);
  };
  const applyTradeSizeSuggestion = (pct: number) => {
    const base = Number(onboardBalance) || DEFAULT_STARTING_BALANCE;
    setOnboardTradeSize(String(Math.max(1, Math.round(base * pct))));
    setTradeSizeHelpOpen(false);
  };
  const balanceValid = Number.isFinite(Number(onboardBalance)) && Number(onboardBalance) >= 1;
  const tradeSizeValid = Number.isFinite(Number(onboardTradeSize)) && Number(onboardTradeSize) >= 1;
  // Dropdown + search at once: focusing the input shows a default list
  // (not just once text is typed), and typing narrows that same list —
  // one combobox, not two separate interaction modes.
  const [focusInputOpen, setFocusInputOpen] = useState(false);
  const query = focusSearch.trim().toLowerCase();
  const focusSuggestions = COINS
    .filter((c) =>
      !onboardFocusCoins.includes(c.symbol) &&
      (!query || c.symbol.toLowerCase().startsWith(query) || c.name.toLowerCase().includes(query))
    )
    .slice(0, 4);
  const addFocusCoin = (symbol: string) => {
    setOnboardFocusCoins((prev) => prev.includes(symbol) ? prev : [...prev, symbol]);
    setFocusSearch("");
  };
  const removeFocusCoin = (symbol: string) => {
    setOnboardFocusCoins((prev) => prev.filter((c) => c !== symbol));
  };
  // Takes the leverage choice as a direct argument rather than reading
  // onboardAllowLeverage from state — the leverage step's chip buttons call
  // this immediately on tap (no separate "Start Trading" button), and
  // setState from that same click wouldn't be visible yet in this closure.
  const handleOnboard = async (allowLeverage: boolean) => {
    if (!user || onboarding) return;
    const startingBalance = Number(onboardBalance);
    const typicalTradeUsd = Number(onboardTradeSize);
    if (!Number.isFinite(startingBalance) || startingBalance < 1) {
      setError("Starting paper balance must be at least $1.");
      return;
    }
    if (!Number.isFinite(typicalTradeUsd) || typicalTradeUsd < 1) {
      setError("Typical trade size must be at least $1.");
      return;
    }
    setOnboardAllowLeverage(allowLeverage);
    setOnboarding(true);
    setError("");
    try {
      await acceptConsentAndOnboard(user.id, {
        startingBalance,
        typicalTradeUsd,
        allowLeverage,
        focusCoins: onboardFocusCoins,
      });
      const focusNote = onboardFocusCoins.length ? ` Focused on: ${onboardFocusCoins.join(", ")}.` : "";
      const leverageNote = allowLeverage ? " Leveraged futures trades enabled." : " Spot trading only.";
      const noteContent = `✓ Noted — paper balance $${startingBalance.toLocaleString()}, typical trade size $${typicalTradeUsd.toLocaleString()}.${focusNote}${leverageNote} Simulated only, not financial advice.`;
      await addAgentNote(user.id, conversationId, noteContent);
      // Proactively take the first move instead of sitting idle waiting for
      // a prompt — kicks off the same screening/clarifying-question flow a
      // manual "find me good crypto plays" would, now that it has the
      // focus coins/leverage preference just set to work with.
      setSending(true);
      setLiveThinking("");
      try {
        await sendAgentMessage(
          user.id, conversationId, "What's a good move for me right now?",
          [{ role: "agent", content: noteContent }], selectedCoin,
          setLiveThinking
        );
      } finally {
        setSending(false);
      }
      await loadAll(conversationId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your answers — please try again.");
    } finally {
      setOnboarding(false);
    }
  };

  // Conversations — ChatGPT-style: a history list (newest first), "+ New"
  // starts a fresh conversation_id, each past one can be reopened or
  // deleted. Current conversation id lives only in memory; nothing routes
  // on it, so a reload always lands on a fresh conversation (same as
  // opening a brand-new chat), with history still reachable from the list.
  const [conversationId, setConversationId] = useState<string>(newConversationId);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);

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
    setOnboardStep(0);
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
      const agentMsg = await sendAgentMessage(
        user!.id, conversationId, content, history, selectedCoin, setLiveThinking, viaVoice, setLastMarketSnapshot,
        (req) => setChartModal({ coin: req.coin, interval: req.interval }),
        (req) => setOrderBookModalCoin(req.coin),
        controller.signal,
      );
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
  // session at that moment.
  const handleInterruptThinking = () => {
    sendAbortControllerRef.current?.abort();
    setSending(false);
    startListening();
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
    try {
      const url = await synthesizeAgentSpeech(last.content);
      if (speechGenerationRef.current !== myGeneration) { URL.revokeObjectURL(url); return; }
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
      })() : messages.length === 0 ? (
        <div className="ta-onboard">
          {needsConsent && (
            <>
              <p className="ta-onboard-disclaimer">
                <strong>Paper trading only — simulated money, simulated trades.</strong> This agent is not a registered
                financial or investment advisor, and nothing it says is financial advice. coinhintz is not responsible for
                any losses, simulated or otherwise, from using this feature. We'll only ask you to accept this once —
                you won't see this disclaimer again after today.
              </p>
              {onboardStep === 0 ? (
                <button type="button" className="ta-onboard-continue" onClick={() => setOnboardStep(1)}>
                  I understood and agreed!
                </button>
              ) : (
                <div className="ta-onboard-step ta-onboard-step--done">
                  <span className="ta-onboard-step-check">✓</span> Risk disclaimer accepted
                </div>
              )}
            </>
          )}

          {onboardStep === 1 && (
            <div className="ta-onboard-step ta-onboard-step--active">
              {stepTyping ? (
                <div className="ta-onboard-typing">
                  <span className="ta-thinking-orb" />
                  <span className="ta-onboard-typing-label">Agent typing</span>
                </div>
              ) : (
                <>
                  <p className="ta-onboard-step-question">How would you describe your trading experience?</p>
                  <p className="ta-onboard-field-hint">This just sets sensible starting defaults below — you can change anything afterward.</p>
                  <div className="ta-onboard-chips ta-onboard-chips--wrap">
                    <button type="button" className="ta-onboard-chip" onClick={() => selectExperience("new", rememberExperienceChoice)}>
                      New to trading
                    </button>
                    <button type="button" className="ta-onboard-chip" onClick={() => selectExperience("some", rememberExperienceChoice)}>
                      Some experience
                    </button>
                    <button type="button" className="ta-onboard-chip" onClick={() => selectExperience("experienced", rememberExperienceChoice)}>
                      Very experienced
                    </button>
                  </div>
                  <label className="ta-onboard-remember">
                    <input
                      type="checkbox"
                      checked={rememberExperienceChoice}
                      onChange={(e) => setRememberExperienceChoice(e.target.checked)}
                    />
                    Remember this and skip asking next time
                  </label>
                </>
              )}
            </div>
          )}
          {onboardStep > 1 && (
            <div className="ta-onboard-step ta-onboard-step--done">
              <span className="ta-onboard-step-check">✓</span> Experience: {onboardExperience === "new" ? "New to trading" : onboardExperience === "some" ? "Some experience" : "Very experienced"}
              {rememberedExperience && (
                <button type="button" className="ta-onboard-step-forget" onClick={forgetExperience}>
                  Change
                </button>
              )}
            </div>
          )}

          {onboardStep === 2 && (
            <div className="ta-onboard-step ta-onboard-step--active">
              {stepTyping ? (
                <div className="ta-onboard-typing">
                  <span className="ta-thinking-orb" />
                  <span className="ta-onboard-typing-label">Agent typing</span>
                </div>
              ) : (
                <>
                  <p className="ta-onboard-step-question">How much paper balance do you want to start with, and how much do you typically put into a single trade?</p>

                  <label className="ta-onboard-sublabel" htmlFor="ta-onboard-balance">Starting balance</label>
                  {/* No autoFocus — this step used to only ever be reached
                      via a manual tap on an experience chip, which counted
                      as a real user gesture that justified it. With a
                      remembered experience level, step 1 now auto-advances
                      straight here with zero taps at all (see
                      rememberedExperience's effect), so autofocusing would
                      pop the keyboard the instant the panel opens. */}
                  <div className={`ta-onboard-custom${onboardBalance && !balanceValid ? " ta-onboard-custom--invalid" : ""}`}>
                    <span className="ta-onboard-custom-prefix">$</span>
                    <input
                      id="ta-onboard-balance"
                      type="text"
                      inputMode="decimal"
                      className="ta-onboard-input ta-onboard-input--inline"
                      value={onboardBalance}
                      onChange={(e) => setOnboardBalance(sanitizeAmountInput(e.target.value))}
                      placeholder="Enter an amount"
                    />
                  </div>
                  {onboardBalance && !balanceValid ? (
                    <p className="ta-onboard-field-error">Minimum $1</p>
                  ) : (
                    <p className="ta-onboard-field-hint">Virtual cash, not real money — pre-filled from your experience level, edit freely.</p>
                  )}
                  {balanceHelpOpen ? (
                    <div className="ta-onboard-help">
                      <p className="ta-onboard-help-question">Pick whichever feels right — you can still type any amount afterward.</p>
                      <div className="ta-onboard-chips ta-onboard-chips--wrap">
                        <button type="button" className="ta-onboard-chip" onClick={() => applyBalanceSuggestion(1000)}>
                          New to trading
                        </button>
                        <button type="button" className="ta-onboard-chip" onClick={() => applyBalanceSuggestion(10000)}>
                          Some experience
                        </button>
                        <button type="button" className="ta-onboard-chip" onClick={() => applyBalanceSuggestion(100000)}>
                          Very experienced
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="ta-onboard-help-link" onClick={() => setBalanceHelpOpen(true)}>
                      Still not sure? Get a suggestion
                    </button>
                  )}

                  <label className="ta-onboard-sublabel" htmlFor="ta-onboard-trade-size">Typical trade size</label>
                  <div className={`ta-onboard-custom${onboardTradeSize && !tradeSizeValid ? " ta-onboard-custom--invalid" : ""}`}>
                    <span className="ta-onboard-custom-prefix">$</span>
                    <input
                      id="ta-onboard-trade-size"
                      type="text"
                      inputMode="decimal"
                      className="ta-onboard-input ta-onboard-input--inline"
                      value={onboardTradeSize}
                      onChange={(e) => setOnboardTradeSize(sanitizeAmountInput(e.target.value))}
                      placeholder="Enter an amount"
                    />
                  </div>
                  {onboardTradeSize && !tradeSizeValid ? (
                    <p className="ta-onboard-field-error">Minimum $1</p>
                  ) : (
                    <p className="ta-onboard-field-hint">Used when you ask the agent to act without giving a specific size.</p>
                  )}
                  {tradeSizeHelpOpen ? (
                    <div className="ta-onboard-help">
                      <p className="ta-onboard-help-question">How much of your balance do you want to risk per trade?</p>
                      <div className="ta-onboard-chips ta-onboard-chips--wrap">
                        <button type="button" className="ta-onboard-chip" onClick={() => applyTradeSizeSuggestion(0.01)}>
                          Conservative (~1%)
                        </button>
                        <button type="button" className="ta-onboard-chip" onClick={() => applyTradeSizeSuggestion(0.03)}>
                          Moderate (~3%)
                        </button>
                        <button type="button" className="ta-onboard-chip" onClick={() => applyTradeSizeSuggestion(0.05)}>
                          Aggressive (~5%)
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="ta-onboard-help-link" onClick={() => setTradeSizeHelpOpen(true)}>
                      Still not sure? Get a suggestion
                    </button>
                  )}

                  <button type="button" className="ta-onboard-continue" onClick={() => setOnboardStep(3)} disabled={!balanceValid || !tradeSizeValid}>
                    Continue
                  </button>
                </>
              )}
            </div>
          )}
          {onboardStep > 2 && (
            <div className="ta-onboard-step ta-onboard-step--done">
              <span className="ta-onboard-step-check">✓</span> Starting balance: ${Number(onboardBalance).toLocaleString()}, typical trade: ${Number(onboardTradeSize).toLocaleString()}
            </div>
          )}

          {onboardStep === 3 && (
            <div className="ta-onboard-step ta-onboard-step--active">
              {stepTyping ? (
                <div className="ta-onboard-typing">
                  <span className="ta-thinking-orb" />
                  <span className="ta-onboard-typing-label">Agent typing</span>
                </div>
              ) : (
                <>
                  <p className="ta-onboard-step-question">Any specific coins you want the agent to focus on?</p>
                  <div
                    className="ta-onboard-custom ta-onboard-custom--tags"
                    onClick={() => focusInputRef.current?.focus()}
                  >
                    {onboardFocusCoins.map((c) => (
                      <span key={c} className="ta-focus-pill">
                        {c}
                        <button
                          type="button"
                          className="ta-focus-pill-x"
                          aria-label={`Remove ${c}`}
                          onClick={(e) => { e.stopPropagation(); removeFocusCoin(c); }}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                    <input
                      ref={focusInputRef}
                      type="text"
                      className="ta-onboard-input ta-onboard-input--inline"
                      value={focusSearch}
                      onChange={(e) => setFocusSearch(e.target.value)}
                      onFocus={() => setFocusInputOpen(true)}
                      onBlur={() => setTimeout(() => setFocusInputOpen(false), 150)}
                      placeholder={onboardFocusCoins.length > 0 ? "Add another…" : "Search or pick a coin…"}
                    />
                  </div>
                  {focusInputOpen && focusSuggestions.length > 0 && (
                    <div className="ta-onboard-suggestions">
                      {focusSuggestions.map((c) => (
                        <button
                          key={c.symbol}
                          type="button"
                          className="ta-onboard-suggestion"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => addFocusCoin(c.symbol)}
                        >
                          <strong>{c.symbol}</strong> {c.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="ta-onboard-field-hint">
                    Lets the agent default to these coins when you don't name one — optional, leave empty and it'll ask or use context instead.
                  </p>
                  <button type="button" className="ta-onboard-continue" onClick={() => setOnboardStep(4)}>
                    {onboardFocusCoins.length > 0 ? "Continue" : "Skip"}
                  </button>
                </>
              )}
            </div>
          )}
          {onboardStep > 3 && (
            <div className="ta-onboard-step ta-onboard-step--done">
              <span className="ta-onboard-step-check">✓</span> Focus coins: {onboardFocusCoins.length > 0 ? onboardFocusCoins.join(", ") : "none set"}
            </div>
          )}

          {onboardStep === 4 && (
            <div className="ta-onboard-step ta-onboard-step--active">
              {stepTyping ? (
                <div className="ta-onboard-typing">
                  <span className="ta-thinking-orb" />
                  <span className="ta-onboard-typing-label">Agent typing</span>
                </div>
              ) : (
                <>
                  <p className="ta-onboard-step-question">Last one — want the agent to also propose leveraged long/short futures trades?</p>
                  <p className="ta-onboard-field-hint">
                    Tap one to finish: Spot owns the coin outright, no leverage, no liquidation risk. Leverage adds margin-based long/short trades — bigger moves, but simulated losses can wipe a position faster.
                  </p>
                  {leverageHelpOpen ? (
                    <div className="ta-onboard-help">
                      <p className="ta-onboard-help-question">
                        <strong>Spot</strong> — you simply own the coin. If it goes up you profit, if it drops you lose exactly what you put in, nothing more.
                      </p>
                      <p className="ta-onboard-help-question">
                        <strong>Leverage / futures</strong> — you borrow buying power to control a bigger position with less money, so gains (and losses) are amplified. A "long" profits if price rises, a "short" profits if it falls. If price moves against you far enough, the position can be automatically closed ("liquidated") and your margin is lost. Still simulated money either way — but if you're new, Spot only is the safer way to learn.
                      </p>
                    </div>
                  ) : (
                    <button type="button" className="ta-onboard-help-link" onClick={() => setLeverageHelpOpen(true)}>
                      Not sure what this means?
                    </button>
                  )}
                  {error && <p className="ta-error">{error}</p>}
                  <div className="ta-onboard-toggle-row">
                    <button
                      type="button"
                      className="ta-onboard-chip"
                      onClick={() => handleOnboard(false)}
                      disabled={onboarding}
                    >
                      {onboarding && !onboardAllowLeverage ? "Starting…" : "Spot only"}
                    </button>
                    <button
                      type="button"
                      className="ta-onboard-chip"
                      onClick={() => handleOnboard(true)}
                      disabled={onboarding}
                    >
                      {onboarding && onboardAllowLeverage ? "Starting…" : "Spot + Leverage"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
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
              </div>
            ))}
            {sending && (
              <div className="ta-msg ta-msg--agent">
                <div className="ta-msg-text ta-typing">
                  <span className="ta-thinking-orb" />
                  <span className="ta-thinking-copy">
                    <span className="ta-thinking-label">
                      {liveThinking || "Thinking…"}
                    </span>
                  </span>
                </div>
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
        return (
        <div
          className={`ta-listening-overlay${hasContent ? " ta-listening-overlay--compact" : ""}`}
          onClick={listening ? handleMicTap : speaking ? handleInterruptSpeech : sending ? handleInterruptThinking : undefined}
          role="button"
          aria-label={listening ? "Stop listening and send" : speaking ? "Tap to interrupt" : sending ? "Tap to interrupt" : "Voice session"}
        >
          <button
            type="button"
            className="ta-listening-cancel"
            onClick={(e) => { e.stopPropagation(); handleMicCancel(); }}
          >
            Cancel
          </button>
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
                sending && !speaking ? " ta-listening-orb--thinking" : speaking ? " ta-listening-orb--speaking" : ""
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
                      onClick={(e) => { e.stopPropagation(); setChartModal({ coin: s.coin }); }}
                    >
                      Chart
                    </button>
                    <button
                      type="button"
                      className="ta-listening-snapshot-action-btn"
                      onClick={(e) => { e.stopPropagation(); setOrderBookModalCoin(s.coin); }}
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
            {listening ? "Tap anywhere to stop and send" : speaking || sending ? "Tap anywhere to interrupt" : ""}
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
