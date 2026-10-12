import "../styles/FloatingNavBar.css";

interface Props {
  signalsOpen: boolean;
  onSearch: () => void;
  searchOpen: boolean;
  onOpenProfile: () => void;
  profileOpen: boolean;
  // Mirrors TradingAgent's own trigger dot — see the "trading-agent-
  // unread-change" event App.tsx listens for.
  agentUnread: boolean;
  // Asset/portfolio calculator — moved here from the desktop header's own
  // trigger (.mch-portfolio, App.tsx), so it's reachable the same way on
  // every width instead of only showing up on wide desktop.
  onOpenCalculator: () => void;
  calculatorOpen: boolean;
  // Trading Agent is Elite-only (a live chat agent burns AI quota too fast
  // for Pro's weekly limit) — the orb stays visible here as a teaser rather
  // than disappearing, same pattern as BuySignals' own gated trigger, but a
  // locked tap needs to surface the upgrade prompt instead of silently
  // dispatching into a component that will just no-op.
  agentLocked: boolean;
  // Opens the dedicated Elite upsell card (EliteUpsellModal), not the
  // generic multi-tier UpgradeModal — Agent Ready is the one reason shown.
  onAgentLocked: () => void;
}

// Built from basic shape primitives (circle/rect/line) only, deliberately
// — a hand-authored multi-point fill "d" path is easy to get subtly wrong
// with no way to catch it without actually rendering it. Primitives can't
// have that failure mode: a circle is a circle. The exceptions (Profile's
// person glyph, Search's magnifying glass line+circle aside, Signals'
// trend line) reuse exact path data already proven to render correctly
// elsewhere in this codebase (AccountMenu.tsx/AuthModal.tsx for Profile),
// not new hand-derived ones.
//
// Order: Signals, Calculator | Agent (raised, see the return below) |
// Search, Profile — Calculator moved up to 2nd, Profile replaces Daily
// Brief as the last icon (Daily Brief no longer has a nav trigger at all;
// it auto-docks on page load now and floats above this bar on its own,
// see DailyBrief.tsx/.css).
function useItems({
  signalsOpen, onOpenCalculator, calculatorOpen, onSearch, searchOpen, onOpenProfile, profileOpen,
}: Omit<Props, "agentUnread" | "agentLocked" | "onAgentLocked">) {
  return [
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
      label: "Calculator",
      icon: (
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      ),
      action: onOpenCalculator,
      isActive: calculatorOpen,
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
      label: "Profile",
      // Same person glyph AccountMenu.tsx/AuthModal.tsx already use.
      icon: (
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      ),
      action: onOpenProfile,
      isActive: profileOpen,
    },
  ];
}

export function FloatingNavBar({
  signalsOpen, onSearch, searchOpen,
  onOpenProfile, profileOpen, agentUnread, onOpenCalculator, calculatorOpen,
  agentLocked, onAgentLocked,
}: Props) {
  const items = useItems({ signalsOpen, onSearch, searchOpen, onOpenProfile, profileOpen, onOpenCalculator, calculatorOpen });
  const leftItems = items.slice(0, 2);
  const rightItems = items.slice(2);

  const renderItem = (item: (typeof items)[number]) => (
    <button
      key={item.label}
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
      className="fnb-bar"
      aria-label="Quick navigation"
    >
      {leftItems.map(renderItem)}
      <button
        type="button"
        className="fnb-item fnb-agent-item"
        onClick={() => {
          if (agentLocked) { onAgentLocked(); return; }
          window.dispatchEvent(new CustomEvent("toggle-trading-agent"));
        }}
        aria-label="Trading Agent"
      >
        <span className="fnb-item-icon-wrap">
          <span className="ta-trigger-orb fnb-agent-orb-inline" />
          {agentUnread && <span className="fnb-agent-dot fnb-agent-dot--inline" />}
        </span>
      </button>
      {rightItems.map(renderItem)}
    </nav>
  );
}
