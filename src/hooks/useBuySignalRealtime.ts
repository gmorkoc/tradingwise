import { useEffect } from "react";
import { supabase, hasAccess, type Tier } from "../services/supabase";

interface FireRow {
  coin: string;
  score: number;
  signals: { id: string; label: string; value: number }[];
  price: number;
}

// Shows the buy-signal toast anywhere in the web app the instant a new
// buy_signal_fires row lands, independent of whether a push notification
// actually got delivered — browser push subscriptions can silently go
// stale (see the buy-signal-scan commit for the full story), but a live
// Realtime subscription while the tab is open doesn't depend on one at
// all. Reuses the exact "push-toast" CustomEvent PushToast.tsx already
// renders (normally dispatched from the native push-received listener in
// pushNotifications.ts) instead of building a second toast UI.
export function useBuySignalRealtime(tier: Tier): void {
  useEffect(() => {
    if (!hasAccess(tier, "elite")) return; // matches BuySignals.tsx's own gate — no point alerting for a panel they can't open

    const channel = supabase
      .channel("buy-signal-fires-toast")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "buy_signal_fires" },
        (payload) => {
          const row = payload.new as FireRow;
          window.dispatchEvent(new CustomEvent("push-toast", {
            detail: {
              title: `${row.coin} — Possible Buy Zone`,
              body: row.signals.map(s => s.label).join(" · "),
              // price/signals as real structured data (not the FCM-style
              // string-only payload the native push path is stuck with) —
              // lets PushToast render each signal as its own clear row
              // with the coin's logo, instead of one run-on joined string.
              data: { type: "buy_signal", coin: row.coin, price: row.price, signals: row.signals },
            },
          }));
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [tier]);
}
