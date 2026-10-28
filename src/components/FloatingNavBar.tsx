import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "../styles/FloatingNavBar.css";

interface Props {
  signalsOpen: boolean;
  onSearch: () => void;
  searchOpen: boolean;
  // No trigger button here anymore (replaced by Home) — Profile is still
  // reachable via AccountMenu elsewhere, so this bar still needs to know
  // when it's open to raise its own z-index above it (see `raised`
  // below), just without rendering its own button for it.
  profileOpen: boolean;
  // Mirrors TradingAgent's own trigger dot — see the "trading-agent-
  // unread-change" event App.tsx listens for.
  agentUnread: boolean;
  // News (Daily Brief) used to auto-open on page load with no way to
  // reopen it once dismissed — this slot used to be the Calculator;
  // Calculator moved into the mobile side menu (icon-strip drawer,
  // App.tsx) instead, and News took over this icon, opening its existing
  // bottom-sheet component (DailyBrief.tsx) straight into "expanded"
  // rather than the small collapsed pill.
  onOpenDailyBrief: () => void;
  dailyBriefOpen: boolean;
  // Trading Agent is Elite-only (a live chat agent burns AI quota too fast
  // for Pro's weekly limit) — the orb stays visible here as a teaser rather
  // than disappearing, same pattern as BuySignals' own gated trigger, but a
  // locked tap needs to surface the upgrade prompt instead of silently
  // dispatching into a component that will just no-op.
  agentLocked: boolean;
  // Opens the dedicated Elite upsell card (EliteUpsellModal), not the
  // generic multi-tier UpgradeModal — Agent Ready is the one reason shown.
  onAgentLocked: () => void;
  // Closes whichever panel is open and returns to the chart page.
  onGoHome: () => void;
  // True only when genuinely at rest on the chart page with nothing else
  // open — not a panel of its own, so it needs its own computed flag
  // rather than mirroring a single piece of open/closed state.
  homeActive: boolean;
  // One-time flashy "try Agent Ready" showcase (App.tsx owns the
  // localStorage flag + timing, shared with TradingAgent.tsx's own
  // desktop .ta-trigger version of this) — anchored to .fnb-agent-item
  // below, the mobile equivalent entry point.
  showAgentShowcase?: boolean;
}

// Built from basic shape primitives (circle/rect/line) only, deliberately
// — a hand-authored multi-point fill "d" path is easy to get subtly wrong
// with no way to catch it without actually rendering it. Primitives can't
// have that failure mode: a circle is a circle. The exceptions (Home's
// roof+walls shape, Search's magnifying glass line+circle aside, Signals'
// trend line) reuse exact path data already proven to render correctly
// elsewhere (Feather Icons' "home"/standard glyphs), not new hand-derived
// ones.
//
// Order: Home, Signals | Agent (raised, see the return below) | Search,
// News (replacing Calculator — see onOpenDailyBrief's own comment) —
// Profile dropped (still reachable via AccountMenu elsewhere; see
// profileOpen's own comment in Props), Home takes its slot as the
// "return to the chart, close whatever's open" action.
// Selection style — flip this one value to switch:
//   "stretch" = stretchy blob: the pill's leading edge reaches the new tab
//               first and the tail catches up, like pulled liquid.
//   "expand"  = only the active tab shows its label; its pill widens to fit.
//   "glass"   = liquid-glass lift/slide pill (iOS 26 style).
const NAV_STYLE = "stretch" as "glass" | "expand" | "stretch";

function useItems({
  signalsOpen, onOpenDailyBrief, dailyBriefOpen, onSearch, searchOpen, onGoHome, homeActive,
}: Omit<Props, "agentUnread" | "agentLocked" | "onAgentLocked" | "profileOpen">) {
  return [
    {
      label: "Home",
      // Feather Icons' "home".
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M9 22V12h6v10" />
        </svg>
      ),
      action: onGoHome,
      isActive: homeActive,
    },
    {
      label: "Signals",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M15 7h6v6" />
        </svg>
      ),
      // BuySignals itself stays mounted in App.tsx (with hideTrigger, so it
      // no longer renders its own header button) — this just triggers the
      // same "open-buy-signals" event it was already listening for.
      action: () => window.dispatchEvent(new CustomEvent("open-buy-signals")),
      isActive: signalsOpen,
    },
    {
      label: "Search",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      ),
      action: onSearch,
      isActive: searchOpen,
    },
    {
      label: "News",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <line x1="8" y1="8" x2="16" y2="8" />
          <line x1="8" y1="12" x2="16" y2="12" />
          <line x1="8" y1="16" x2="12" y2="16" />
        </svg>
      ),
      action: onOpenDailyBrief,
      isActive: dailyBriefOpen,
    },
  ];
}

export function FloatingNavBar({
  signalsOpen, onSearch, searchOpen,
  profileOpen, agentUnread, onOpenDailyBrief, dailyBriefOpen,
  agentLocked, onAgentLocked, onGoHome, homeActive, showAgentShowcase,
}: Props) {
  // Same ~5s one-shot as TradingAgent.tsx's own showcasePlaying — stops
  // early on tap too (see the Agent button's onClick below).
  const [showcasePlaying, setShowcasePlaying] = useState(false);
  useEffect(() => {
    if (!showAgentShowcase) return;
    setShowcasePlaying(true);
    const id = window.setTimeout(() => setShowcasePlaying(false), 5200);
    return () => window.clearTimeout(id);
  }, [showAgentShowcase]);
  const items = useItems({ signalsOpen, onSearch, searchOpen, onGoHome, homeActive, onOpenDailyBrief, dailyBriefOpen });
  const leftItems = items.slice(0, 2);
  const rightItems = items.slice(2);

  // These four panels' own backdrops sit at a much higher z-index than
  // this bar's normal resting value (60) — tall enough to dim the whole
  // screen, including this bar, even though each one is specifically
  // positioned to float just above it (see .gs-docked's own comment).
  // Bumping only while one of them is actually open (rather than raising
  // the bar's z-index globally) keeps it below every OTHER overlay in the
  // app that was never asked to show it underneath — AuthModal, the
  // upgrade/paywall modals, etc.
  // Profile is NOT in this list any more: it's a full-screen page on
  // phones, so the bar should stay underneath it (hidden), not float on top.
  const raised = signalsOpen || searchOpen || dailyBriefOpen;
  void profileOpen;

  // Sliding highlight (a single shared pill, not a per-button background)
  // that animates from the previously active item to the newly active one
  // — measured in actual pixels off the DOM rather than computed from
  // flex-basis math, since the Agent button sitting between the two
  // halves makes the items' widths not simply "100% / 4".
  const barRef = useRef<HTMLElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const activeLabel = items.find((i) => i.isActive)?.label ?? null;

  // ── Liquid-glass selection (matches the native iOS 26 tab bar) ────────
  // Measured off a 240fps recording of the real thing:
  //   rest  → flat grey pill
  //   touch → LIFT: the pill turns into clear glass (fill gone, bright rim,
  //           faint rainbow fringe), ~1.15× wide / 1.2× tall; holding longer
  //           swells it past the bar (~1.3× / 1.45×)
  //   move  → SLIDE: glides to the new tab in ~110ms while lifted; icons it
  //           passes over magnify through it
  //   land  → DROP: shrinks back to the pill and fades clear → grey (~100ms)
  // Position is a spring written straight to the element each frame (no
  // React re-render per frame).
  const glassRef = useRef<HTMLSpanElement>(null);
  const springRef = useRef({ x: 0, w: 0, vx: 0, vw: 0, tx: 0, tw: 0, ready: false, raf: 0 });
  const [pressedLabel, setPressedLabel] = useState<string | null>(null);
  const pressedRef = useRef<string | null>(null);
  const [lifted, setLifted] = useState(false);
  const [held, setHeld] = useState(false);
  const holdTimerRef = useRef(0);
  const dropTimerRef = useRef(0);
  const scheduleDrop = () => {
    window.clearTimeout(dropTimerRef.current);
    dropTimerRef.current = window.setTimeout(() => {
      if (!pressedRef.current && !springRef.current.raf) { setLifted(false); setHeld(false); }
    }, 70);
  };
  // Icons under the moving glass magnify (overlap-weighted).
  const magnify = (x: number, w: number) => {
    const bar = barRef.current;
    if (!bar) return;
    const b = bar.getBoundingClientRect();
    for (const btn of Object.values(itemRefs.current)) {
      if (!btn) continue;
      const r = btn.getBoundingClientRect();
      const l = r.left - b.left - bar.clientLeft;
      const overlap = Math.max(0, Math.min(l + r.width, x + w) - Math.max(l, x)) / r.width;
      const icon = btn.querySelector<HTMLElement>(".fnb-item-icon-wrap");
      if (icon) icon.style.transform = overlap > 0.02 ? `scale(${1 + 0.22 * overlap})` : "";
    }
  };
  const kick = () => {
    const sp = springRef.current;
    if (sp.raf) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const K = 900, D = 56; // ~110ms glide, no visible overshoot
      sp.vx += (K * (sp.tx - sp.x) - D * sp.vx) * dt; sp.x += sp.vx * dt;
      sp.vw += (K * (sp.tw - sp.w) - D * sp.vw) * dt; sp.w += sp.vw * dt;
      const el = glassRef.current;
      if (el) { el.style.width = `${sp.w}px`; el.style.transform = `translateX(${sp.x}px)`; }
      magnify(sp.x, sp.w);
      const done = Math.abs(sp.tx - sp.x) < 0.3 && Math.abs(sp.vx) < 4 && Math.abs(sp.tw - sp.w) < 0.3 && Math.abs(sp.vw) < 4;
      if (done) {
        sp.x = sp.tx; sp.w = sp.tw; sp.vx = sp.vw = 0;
        if (el) { el.style.width = `${sp.w}px`; el.style.transform = `translateX(${sp.x}px)`; }
        sp.raf = 0;
        magnify(sp.x, pressedRef.current ? sp.w : 0);
        scheduleDrop();
        return;
      }
      sp.raf = requestAnimationFrame(step);
    };
    sp.raf = requestAnimationFrame(step);
  };
  const glassTo = (left: number, width: number, jump = false) => {
    const sp = springRef.current;
    sp.tx = left; sp.tw = width;
    if (jump || !sp.ready) {
      sp.x = left; sp.w = width; sp.vx = sp.vw = 0; sp.ready = true;
      const el = glassRef.current;
      if (el) { el.style.width = `${width}px`; el.style.transform = `translateX(${left}px)`; }
      return;
    }
    kick();
  };
  const rectOf = (label: string | null) => {
    const bar = barRef.current;
    const el = label ? itemRefs.current[label] : null;
    if (!bar || !el) return null;
    const b = bar.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { left: r.left - b.left - bar.clientLeft, width: r.width };
  };
  const press = (label: string) => {
    if (NAV_STYLE !== "glass") return;
    pressedRef.current = label;
    setPressedLabel(label);
    setLifted(true);
    window.clearTimeout(dropTimerRef.current);
    window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(() => { if (pressedRef.current) setHeld(true); }, 220);
    const r = rectOf(label);
    if (r) glassTo(r.left, r.width);
    const sp = springRef.current;
    magnify(sp.x, sp.w);
  };
  const release = () => {
    if (!pressedRef.current) return;
    pressedRef.current = null;
    setPressedLabel(null);
    window.clearTimeout(holdTimerRef.current);
    setHeld(false);
    if (!springRef.current.raf) { magnify(0, 0); scheduleDrop(); }
  };
  useEffect(() => () => {
    if (springRef.current.raf) cancelAnimationFrame(springRef.current.raf);
    window.clearTimeout(holdTimerRef.current);
    window.clearTimeout(dropTimerRef.current);
  }, []);
  // Follow the active item (and its size) with the spring.
  useEffect(() => {
    if (NAV_STYLE !== "glass") return;
    if (!indicator) return;
    if (pressedLabel) return; // the press is already steering it
    const sp = springRef.current;
    const moving = sp.ready && (Math.abs(sp.x - indicator.left) > 1 || Math.abs(sp.w - indicator.width) > 1);
    if (moving) setLifted(true); // e.g. navigation from elsewhere: lift, slide, drop
    glassTo(indicator.left, indicator.width);
    if (!moving) { magnify(0, 0); scheduleDrop(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicator?.left, indicator?.width, pressedLabel]);


  // Stretchy blob: first stretch the pill to cover both the old and new
  // tab (leading edge jumps ahead), then pull the tail in with a springy
  // ease so it settles on the new tab.
  const stretchPrevRef = useRef<{ left: number; width: number } | null>(null);
  useEffect(() => {
    if (NAV_STYLE !== "stretch" || !indicator) return;
    const el = glassRef.current;
    if (!el) return;
    const set = (left: number, width: number, transition: string) => {
      el.style.transition = transition;
      el.style.transform = `translateX(${left}px)`;
      el.style.width = `${width}px`;
    };
    const a = stretchPrevRef.current;
    const b = indicator;
    stretchPrevRef.current = b;
    if (!a || Math.abs(a.left - b.left) < 1) {
      set(b.left, b.width, "opacity 0.18s ease");
      return;
    }
    const reach = "transform 0.16s ease-out, width 0.16s ease-out";
    if (b.left > a.left) set(a.left, b.left + b.width - a.left, reach);
    else set(b.left, a.left + a.width - b.left, reach);
    const settle = "cubic-bezier(0.3, 1.5, 0.5, 1)";
    const id = window.setTimeout(() => set(b.left, b.width, `transform 0.34s ${settle}, width 0.34s ${settle}`), 160);
    return () => window.clearTimeout(id);
  }, [indicator?.left, indicator?.width]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const el = activeLabel ? itemRefs.current[activeLabel] : null;
    if (!bar || !el) { setIndicator(null); return; }

    // Position/size only — color/background/backdrop-filter live in CSS
    // (html[data-theme="light"] .fnb-active-indicator below), not here.
    // JS-reading data-theme to pick colors was tried and made things
    // worse: that attribute is set by a plain useEffect in App.tsx, which
    // runs AFTER paint — well after this layout effect — so on a genuine
    // first load this could read data-theme before it was ever set and
    // silently apply the wrong theme's colors (confirmed: light theme
    // rendering as dark theme's white gradient on native). A CSS selector
    // has no such race; the browser always has the current attribute.
    const measure = () => {
      const barRect = bar.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      setIndicator({ left: elRect.left - barRect.left - bar.clientLeft, width: elRect.width });
    };
    measure();

    // ResizeObserver (not a timed/polled guess) so this stays correct for
    // as long as either element's box actually changes, regardless of
    // when the app's own boot sequence finishes settling layout.
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    ro.observe(el);

    return () => ro.disconnect();
  }, [activeLabel]);

  const renderItem = (item: (typeof items)[number]) => (
    <button
      key={item.label}
      ref={(el) => { itemRefs.current[item.label] = el; }}
      type="button"
      className={`fnb-item${item.isActive ? " fnb-item--active" : ""}${pressedLabel === item.label ? " fnb-item--pressed" : ""}`}
      onClick={item.action}
      onPointerDown={() => press(item.label)}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={() => { if (pressedRef.current === item.label) release(); }}
      aria-label={item.label}
      aria-current={item.isActive ? "page" : undefined}
    >
      <span className="fnb-item-icon-wrap">
        {item.icon}
      </span>
      <span className="fnb-item-label">{item.label}</span>
    </button>
  );

  // Comparison variant — Agent sits flush in the row as a plain 5th icon
  // (same height/sizing as the other four), not raised above the bar.
  // Swap target if this reads better than the raised-notch version.
  return (
    <nav
      ref={barRef}
      className={`fnb-bar${raised ? " fnb-bar--raised" : ""}${NAV_STYLE !== "glass" ? ` fnb-bar--${NAV_STYLE}` : ""}`}
      aria-label="Quick navigation"
    >
      <span
        ref={glassRef}
        className={`fnb-active-indicator fnb-glass${lifted ? " fnb-glass--lift" : ""}${held ? " fnb-glass--hold" : ""}`}
        aria-hidden="true"
        style={{ opacity: indicator ? 1 : 0 }}
      >
        <span className="fnb-glass-body" />
      </span>
      {leftItems.map(renderItem)}
      <button
        type="button"
        className={`fnb-item fnb-agent-item${showcasePlaying ? " fnb-agent-item--showcase" : ""}`}
        onClick={() => {
          if (agentLocked) { onAgentLocked(); return; }
          setShowcasePlaying(false);
          window.dispatchEvent(new CustomEvent("toggle-trading-agent"));
        }}
        aria-label="Trading Agent"
      >
        <span className="fnb-item-icon-wrap">
          {showcasePlaying && (
            <>
              <span className="fnb-agent-ring fnb-agent-ring--1" aria-hidden="true" />
              <span className="fnb-agent-ring fnb-agent-ring--2" aria-hidden="true" />
              <span className="fnb-agent-ring fnb-agent-ring--3" aria-hidden="true" />
            </>
          )}
          <span className={`ta-trigger-orb fnb-agent-orb-inline${showcasePlaying ? " fnb-agent-orb-inline--showcase" : ""}`} />
          {agentUnread && <span className="fnb-agent-dot" />}
        </span>
      </button>
      {rightItems.map(renderItem)}
      {showcasePlaying && (
        <div className="fnb-agent-callout" role="status">
          <span className="fnb-agent-callout-sparkle" aria-hidden="true">✨</span>
          Meet Agent Ready — your AI trading copilot
        </div>
      )}
    </nav>
  );
}
