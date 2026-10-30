import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";

// Single source of truth for "what does tapping a notification do," shared
// by PushToast.tsx (foreground in-app toast), pushNotifications.ts (OS
// notification tap, app backgrounded/killed), and NotificationsCenter.tsx
// (the persisted feed) — all three ultimately react to the same `data`
// payload shape the edge functions attach to every push (see
// supabase/functions/_shared/notificationLog.ts), so routing only needs to
// be correct in one place.
export interface NotificationTapData {
  type?: string;
  url?: string;
  coin?: string;
  commentId?: string;
  strategyId?: string;
  username?: string;
  avatarUrl?: string;
  /** Agent Ready notifications: the chat the alert / close message is in. */
  conversationId?: string;
}

// Agent Ready tap that arrived before the panel was mounted (cold launch
// from a notification) — the panel drains this when it mounts.
let pendingAgentOpen: { conversationId?: string } | null = null;
export function consumePendingAgentOpen(): { conversationId?: string } | null {
  const p = pendingAgentOpen;
  pendingAgentOpen = null;
  return p;
}

export function routeNotificationTap(data: NotificationTapData | null | undefined): void {
  if (!data?.type) return;
  switch (data.type) {
    case "daily_brief":
    case "breaking_news":
      if (data.url) {
        if (Capacitor.isNativePlatform()) Browser.open({ url: data.url });
        else window.open(data.url, "_blank", "noopener");
      }
      break;
    case "upgrade_reminder":
      window.dispatchEvent(new CustomEvent("open-upgrade-modal"));
      break;
    case "coin_mention":
      if (data.coin && data.commentId) {
        window.dispatchEvent(new CustomEvent("open-coin-mention", {
          detail: { coin: data.coin, commentId: parseInt(data.commentId, 10) },
        }));
      }
      break;
    case "strategy_alert":
      if (data.strategyId) {
        window.dispatchEvent(new CustomEvent("open-strategy-alert", {
          detail: { strategyId: data.strategyId, coin: data.coin },
        }));
      }
      break;
    case "buy_signal":
      window.dispatchEvent(new CustomEvent("open-buy-signals", { detail: { coin: data.coin } }));
      break;
    case "price_alert":
      if (data.coin) {
        window.dispatchEvent(new CustomEvent("open-price-alert", { detail: { coin: data.coin } }));
      }
      break;
    case "agent_watch":
    case "agent_position_close": {
      // Open Agent Ready on the chat this alert belongs to. Stash it too in
      // case the panel isn't mounted yet (app launched by the tap).
      const detail = { conversationId: data.conversationId };
      pendingAgentOpen = detail;
      window.dispatchEvent(new CustomEvent("open-trading-agent", { detail }));
      break;
    }
  }
}
