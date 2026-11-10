// Shared price-alert storage, so alerts can be added from anywhere (e.g. the
// Candle Insights "Today's read" levels), not only from the Price Alerts panel.
// The panel (PriceAlerts.tsx) still owns checking prices and showing the
// toast; it re-reads storage when PRICE_ALERTS_EVENT fires.

import { supabase } from "./supabase";
import type { CoinSymbol } from "./coinglass";

export interface PriceAlert {
  id: string;
  coin: CoinSymbol;
  targetPrice: number;
  direction: "above" | "below";
  label: string;
  triggered: boolean;
  createdAt: number;
}

export const PRICE_ALERTS_KEY = "priceAlerts";
export const PRICE_ALERTS_EVENT = "price-alerts-changed";

export function loadPriceAlerts(): PriceAlert[] {
  try {
    const raw = localStorage.getItem(PRICE_ALERTS_KEY);
    if (!raw) return [];
    // Alerts saved before per-coin support didn't store a coin at all —
    // fall back to BTC for those rather than crash on the missing field.
    return (JSON.parse(raw) as PriceAlert[]).map((a) => ({ ...a, coin: a.coin ?? "BTC" }));
  } catch { return []; }
}

export function savePriceAlerts(alerts: PriceAlert[]) {
  try { localStorage.setItem(PRICE_ALERTS_KEY, JSON.stringify(alerts)); } catch { /* quota */ }
}

const sameAlert = (a: PriceAlert, coin: string, price: number, direction: string) =>
  !a.triggered && a.coin === coin && a.direction === direction && Math.abs(a.targetPrice - price) <= price * 1e-6;

/** True when an untriggered alert for this coin/price/direction already exists. */
export function hasPriceAlert(coin: string, price: number, direction: "above" | "below"): boolean {
  return loadPriceAlerts().some((a) => sameAlert(a, coin, price, direction));
}

export function makePriceAlert(coin: CoinSymbol, price: number, direction: "above" | "below"): PriceAlert {
  return {
    id: crypto.randomUUID(),
    coin,
    targetPrice: price,
    direction,
    label: `${direction === "above" ? "↑" : "↓"} $${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    triggered: false,
    createdAt: Date.now(),
  };
}

/**
 * Mirrors an alert into Supabase so the price-alert cron can push a
 * notification even with the app closed (signed-in users only).
 */
export function syncPriceAlertToServer(alert: PriceAlert, userId: string | null | undefined) {
  if (!userId) return;
  supabase.from("price_alerts").insert({
    id: alert.id, user_id: userId, coin: alert.coin, target_price: alert.targetPrice, direction: alert.direction,
  }).then(({ error }) => { if (error) console.error("Saving price alert failed:", error.message); });
}

/**
 * Cancels the untriggered alert(s) for this coin/price/direction — locally
 * and on the server, so the push no longer fires either.
 */
export function removePriceAlert(coin: string, price: number, direction: "above" | "below", userId?: string | null) {
  const list = loadPriceAlerts();
  const gone = list.filter((a) => sameAlert(a, coin, price, direction));
  if (!gone.length) return;
  savePriceAlerts(list.filter((a) => !gone.includes(a)));
  if (userId) supabase.from("price_alerts").delete().in("id", gone.map((a) => a.id)).then(() => {});
  window.dispatchEvent(new Event(PRICE_ALERTS_EVENT));
}

/**
 * Adds an alert from outside the Price Alerts panel. Skips duplicates.
 * Returns false if an identical alert already existed.
 */
export function addPriceAlert(coin: CoinSymbol, price: number, direction: "above" | "below", userId?: string | null): boolean {
  const list = loadPriceAlerts();
  if (list.some((a) => sameAlert(a, coin, price, direction))) return false;
  const alert = makePriceAlert(coin, price, direction);
  savePriceAlerts([...list, alert].sort((a, b) => b.targetPrice - a.targetPrice));
  syncPriceAlertToServer(alert, userId);
  window.dispatchEvent(new Event(PRICE_ALERTS_EVENT));
  return true;
}
