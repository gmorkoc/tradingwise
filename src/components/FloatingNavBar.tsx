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
function useItems({
  signalsOpen, onOpenDailyBrief, dailyBriefOpen, onSearch, searchOpen, onGoHome, homeActive,
}: Omit<Props, "agentUnread" | "agentLocked" | "onAgentLocked" | "profileOpen">) {
  return [
    {
      label: "Home",
      // Feather Icons' "home".
      icon: (
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
  const raised = signalsOpen || searchOpen || profileOpen || dailyBriefOpen;

  // Sliding highlight (a single shared pill, not a per-button background)
  // that animates from the previously active item to the newly active one
  // — measured in actual pixels off the DOM rather than computed from
  // flex-basis math, since the Agent button sitting between the two
  // halves makes the items' widths not simply "100% / 4".
  const barRef = useRef<HTMLElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const activeLabel = items.find((i) => i.isActive)?.label ?? null;

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
      className={`fnb-item${item.isActive ? " fnb-item--active" : ""}`}
      onClick={item.action}
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
      className={`fnb-bar${raised ? " fnb-bar--raised" : ""}`}
      aria-label="Quick navigation"
    >
      <span
        className="fnb-active-indicator"
        aria-hidden="true"
        style={
          indicator
            ? { transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px`, opacity: 1 }
            : { opacity: 0 }
        }
      />
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
