import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { useAuth } from "../contexts/AuthContext";
import { supabase, hasAccess } from "../services/supabase";
import { COINS } from "../services/coinglass";
import { isWebPushAvailable, isWebPushSubscribed, subscribeWebPush } from "../services/webPush";
import {
  fetchPortfolio, fetchAgentMessages, sendAgentMessage, setActionStatus, executeTrade, executeBasket, closePosition, updateCashBalance, acceptConsentAndOnboard,
  fetchConversations, deleteConversation, addAgentNote, cancelWatch, confirmWatch, fetchWatchesForConversation, fetchAgentPerformance,
  AgentMessage, PaperPortfolio, PaperPosition, ConversationSummary, AgentWatch, AgentAction, BalanceUpdate, AgentPerformance, MarketInterval,
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
}

export function TradingAgent({ selectedCoin }: Props) {
  const { user, tier } = useAuth();
  const isDesktop = useIsDesktop();

  const [open, setOpen] = useState(() => localStorage.getItem("tradingAgentOpen") === "true");
  useEffect(() => {
    localStorage.setItem("tradingAgentOpen", String(open));
  }, [open]);

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
      await typeOut("Connected", 45);
      await sleep(700);
      if (cancelled) return;
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
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
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
  const selectExperience = (level: ExperienceLevel) => {
    const { balance, riskPct } = EXPERIENCE_DEFAULTS[level];
    setOnboardExperience(level);
    setOnboardBalance(String(balance));
    setOnboardTradeSize(String(Math.round(balance * riskPct)));
    setOnboardStep(2);
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
  const openRef = useRef(open);
  const conversationIdRef = useRef(conversationId);
  useEffect(() => { openRef.current = open; if (open) setUnread(false); }, [open]);
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
    const showSub = Keyboard.addListener("keyboardWillShow", (info) => {
      if (panelRef.current) panelRef.current.style.paddingBottom = `${info.keyboardHeight}px`;
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      if (panelRef.current) panelRef.current.style.paddingBottom = "";
    });
    return () => { showSub.then((s) => s.remove()); hideSub.then((s) => s.remove()); };
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  // Pro+ feature — free users don't get the trigger/panel at all.
  if (!user || !hasAccess(tier, "pro")) return null;

  const handleNewConversation = () => {
    setConversationId(newConversationId());
    setMessages([]);
    setShowHistory(false);
    setOnboardStep(0);
  };

  const handleOpenHistory = async () => {
    setShowHistory(true);
    try { await loadConversations(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const handleOpenConversation = async (id: string) => {
    setConversationId(id);
    setShowHistory(false);
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
    try {
      await sendAgentMessage(user!.id, conversationId, content, history, selectedCoin, setLiveThinking);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong — please try again.");
    } finally {
      await loadAll(conversationId);
      setSending(false);
    }
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
        <span className="ta-head-title">✦ Trading Agent <span className="ta-head-badge">AI Powered</span></span>
        <div className="ta-head-actions">
          <button type="button" className="ta-head-icon-btn" onClick={handleNewConversation} title="New chat" aria-label="New chat">
            +
          </button>
          <button type="button" className="ta-head-icon-btn" onClick={handleOpenHistory} title="History" aria-label="History">
            ☰
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
      ) : messages.length === 0 ? (
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
                    <button type="button" className="ta-onboard-chip" onClick={() => selectExperience("new")}>
                      New to trading
                    </button>
                    <button type="button" className="ta-onboard-chip" onClick={() => selectExperience("some")}>
                      Some experience
                    </button>
                    <button type="button" className="ta-onboard-chip" onClick={() => selectExperience("experienced")}>
                      Very experienced
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {onboardStep > 1 && (
            <div className="ta-onboard-step ta-onboard-step--done">
              <span className="ta-onboard-step-check">✓</span> Experience: {onboardExperience === "new" ? "New to trading" : onboardExperience === "some" ? "Some experience" : "Very experienced"}
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
                      autoFocus
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
                {m.role === "agent" && (
                  <div className="ta-msg-sender">
                    <span className="ta-thinking-orb ta-msg-orb" />
                  </div>
                )}
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
                {m.action && (() => {
                  const action = m.action;
                  const pnl = estimateNetPnl(action);
                  return (
                  <div className={`ta-proposal ta-proposal--${m.actionStatus}`}>
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
                    {m.actionStatus === "pending" ? (
                      <div className="ta-proposal-actions">
                        <button
                          type="button"
                          className="ta-proposal-confirm"
                          onClick={() => handleConfirm(m)}
                          disabled={executingId === m.id}
                        >
                          {executingId === m.id ? "Executing…" : "Confirm"}
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
                  );
                })()}
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
                      <span className="ta-proposal-badge">👁 Watch</span>
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
                        👁 Watching <strong>{w.coin}</strong> — {w.conditionText}
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
              placeholder="Tell the agent what to do…"
              disabled={sending}
            />
            <button type="button" className="ta-composer-send" onClick={() => handleSend()} disabled={sending || !draft.trim()}>
              {sending ? "…" : "Send"}
            </button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      {phase !== "hidden" && (
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
    </>
  );
}
