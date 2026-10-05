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
    case "agent_position_close":
      window.dispatchEvent(new CustomEvent("open-trading-agent"));
      break;
  }
}
