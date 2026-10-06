import "../styles/FloatingNavBar.css";

interface Props {
  signalsOpen: boolean;
  onSearch: () => void;
  searchOpen: boolean;
  dailyBriefOpen: boolean;
  onToggleDailyBrief: () => void;
  // Mirrors TradingAgent's own trigger dot — see the "trading-agent-
  // unread-change" event App.tsx listens for.
  agentUnread: boolean;
  // Asset/portfolio calculator — moved here from the desktop header's own
  // trigger (.mch-portfolio, App.tsx), so it's reachable the same way on
  // every width instead of only showing up on wide desktop.
  onOpenCalculator: () => void;
  calculatorOpen: boolean;
  // Trading Agent is Pro+ (TradingAgent.tsx itself renders nothing for
  // free users) — the orb stays visible here as a teaser rather than
  // disappearing, same pattern as BuySignals' own gated trigger, but a
  // locked tap needs to surface the upgrade prompt instead of silently
  // dispatching into a component that will just no-op.
  agentLocked: boolean;
  onOpenUpgrade: () => void;
}

// Built from basic shape primitives (circle/rect/line) only, deliberately
// — a hand-authored multi-point fill "d" path is easy to get subtly wrong
// with no way to catch it without actually rendering it. Primitives can't
// have that failure mode: a circle is a circle. The two exceptions
// (Notifications' bell, Signals' trend line) reuse exact path data already
// proven to render correctly elsewhere in this codebase, not new
// hand-derived ones.
function useItems({
  signalsOpen, onSearch, searchOpen, onToggleDailyBrief, dailyBriefOpen, onOpenCalculator, calculatorOpen,
}: Omit<Props, "agentUnread" | "agentLocked" | "onOpenUpgrade">) {
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
      label: "Daily Brief",
      icon: (
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <line x1="8" y1="9" x2="16" y2="9" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="13" y2="17" />
        </svg>
      ),
      // The bar itself animates away as the brief comes in — see
      // .fnb-bar--brief-open — so this reads as the icon "becoming" the
      // brief rather than a second panel stacking on top of the nav.
      action: onToggleDailyBrief,
      isActive: dailyBriefOpen,
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
  ];
}

export function FloatingNavBar({
  signalsOpen, onSearch, searchOpen,
  dailyBriefOpen, onToggleDailyBrief, agentUnread, onOpenCalculator, calculatorOpen,
  agentLocked, onOpenUpgrade,
}: Props) {
  const items = useItems({ signalsOpen, onSearch, searchOpen, onToggleDailyBrief, dailyBriefOpen, onOpenCalculator, calculatorOpen });
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
      {item.isActive && <span className="fnb-item-label">{item.label}</span>}
    </button>
  );

  // Comparison variant — Agent sits flush in the row as a plain 5th icon
  // (same height/sizing as the other four), not raised above the bar.
  // Swap target if this reads better than the raised-notch version.
  return (
    <nav
      className={`fnb-bar${dailyBriefOpen ? " fnb-bar--brief-open" : ""}`}
      aria-label="Quick navigation"
      aria-hidden={dailyBriefOpen}
    >
      {leftItems.map(renderItem)}
      <button
        type="button"
        className="fnb-item fnb-agent-item"
        onClick={() => {
          if (agentLocked) { onOpenUpgrade(); return; }
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
