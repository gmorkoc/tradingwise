import { useEffect } from "react";
import { supabase, hasAccess, type Tier, type Profile } from "../services/supabase";

interface FireRow {
  coin: string;
  direction: "buy" | "sell";
  score: number;
  signals: { id: string; label: string; value: number }[];
  price: number;
}

const MAX_SCORE = 7;
function confidenceOf(score: number): "low" | "medium" | "high" {
  if (score >= 6) return "high";
  if (score >= 5) return "medium";
  return "low";
}
const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

// Shows the buy/sell-signal toast anywhere in the web app the instant a new
// buy_signal_fires row lands, independent of whether a push notification
// actually got delivered — browser push subscriptions can silently go
// stale (see the buy-signal-scan commit for the full story), but a live
// Realtime subscription while the tab is open doesn't depend on one at
// all. Reuses the exact "push-toast" CustomEvent PushToast.tsx already
// renders (normally dispatched from the native push-received listener in
// pushNotifications.ts) instead of building a second toast UI.
//
// Realtime has no server-side recipient filtering (unlike the edge
// function's own push path) — every INSERT reaches every subscribed
// client, so direction/mute/min-confidence preferences are re-applied here
// to match what the user actually asked to be notified about.
export function useBuySignalRealtime(tier: Tier, profile: Profile | null): void {
  useEffect(() => {
    if (!hasAccess(tier, "elite")) return; // matches BuySignals.tsx's own gate — no point alerting for a panel they can't open

    const channel = supabase
      .channel("buy-signal-fires-toast")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "buy_signal_fires" },
        (payload) => {
          const row = payload.new as FireRow;
          const directionKey = row.direction === "buy" ? "notify_buy_signals" : "notify_sell_signals";
          if (profile && profile[directionKey] === false) return;
          if (profile?.signal_muted_coins?.includes(row.coin)) return;
          const confidence = confidenceOf(row.score);
          const minRank = CONFIDENCE_RANK[profile?.signal_min_confidence ?? "low"] ?? 0;
          if (CONFIDENCE_RANK[confidence] < minRank) return;

          const label = row.direction === "buy" ? "Possible Buy Zone" : "Possible Sell Zone";
          window.dispatchEvent(new CustomEvent("push-toast", {
            detail: {
              title: `${row.coin} — ${label}`,
              body: row.signals.map(s => s.label).join(" · "),
              // price/signals as real structured data (not the FCM-style
              // string-only payload the native push path is stuck with) —
              // lets PushToast render each signal as its own clear row
              // with the coin's logo, instead of one run-on joined string.
              data: {
                type: "buy_signal", coin: row.coin, direction: row.direction,
                price: row.price, signals: row.signals, score: row.score, maxScore: MAX_SCORE, confidence,
              },
            },
          }));
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [tier, profile]);
}
