import "../styles/FloatingNavBar.css";

interface Props {
  onOpenNotifications: () => void;
  notificationsOpen: boolean;
  unreadNotificationCount: number;
  signalsOpen: boolean;
  onSearch: () => void;
  searchOpen: boolean;
  dailyBriefOpen: boolean;
  onToggleDailyBrief: () => void;
  // Mirrors TradingAgent's own trigger dot — see the "trading-agent-
  // unread-change" event App.tsx listens for.
  agentUnread: boolean;
}

// Built from basic shape primitives (circle/rect/line) only, deliberately
// — a hand-authored multi-point fill "d" path is easy to get subtly wrong
// with no way to catch it without actually rendering it. Primitives can't
// have that failure mode: a circle is a circle. The two exceptions
// (Notifications' bell, Signals' trend line) reuse exact path data already
// proven to render correctly elsewhere in this codebase, not new
// hand-derived ones.
function useItems({
  onOpenNotifications, notificationsOpen, signalsOpen, onSearch, searchOpen, onToggleDailyBrief, dailyBriefOpen,
}: Omit<Props, "unreadNotificationCount" | "agentUnread">) {
  return [
    {
      label: "Notifications",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      ),
      action: onOpenNotifications,
      showsUnreadBadge: true,
      // Driven by the panel's own real open state (reported back up by
      // each component/App.tsx), not "last icon tapped" — so the pill
      // drops the moment the panel actually closes, however it closes
      // (✕ button, backdrop click, Escape), not just on another tap here.
      isActive: notificationsOpen,
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
      label: "Daily Brief",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      ),
      action: onSearch,
      isActive: searchOpen,
    },
  ];
}

export function FloatingNavBar({
  onOpenNotifications, notificationsOpen, unreadNotificationCount, signalsOpen, onSearch, searchOpen,
  dailyBriefOpen, onToggleDailyBrief, agentUnread,
}: Props) {
  const items = useItems({ onOpenNotifications, notificationsOpen, signalsOpen, onSearch, searchOpen, onToggleDailyBrief, dailyBriefOpen });
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
        {item.showsUnreadBadge && unreadNotificationCount > 0 && (
          <span className="fnb-item-badge">{unreadNotificationCount > 9 ? "9+" : unreadNotificationCount}</span>
        )}
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
        onClick={() => window.dispatchEvent(new CustomEvent("toggle-trading-agent"))}
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
