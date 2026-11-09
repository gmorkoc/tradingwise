// Plan prices to show on screen. On the iOS app they come from the App
// Store (RevenueCat), already in the user's currency and country price —
// Apple requires the shown price to match what's charged. On the web, and
// until the store answers, the US list prices below are used.
import { useEffect, useState } from "react";
import { getIAPPlans, getProVisionIAPPackage, isIAPAvailable } from "../services/revenuecat";

export interface StorePrices {
  /** Pro, per month */
  pro: string;
  /** Elite, per month */
  elite: string;
  /** ProVision, per year */
  provision: string;
}

export const LIST_PRICES: StorePrices = { pro: "$30.99", elite: "$59.99", provision: "$99" };

// One store lookup per app session, shared by every screen.
let cached: StorePrices | null = null;
let pending: Promise<StorePrices> | null = null;

function loadStorePrices(): Promise<StorePrices> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = Promise.all([getIAPPlans(), getProVisionIAPPackage()])
      .then(([plans, pv]) => {
        const next: StorePrices = {
          pro: plans.find((p) => p.tier === "pro")?.priceString ?? LIST_PRICES.pro,
          elite: plans.find((p) => p.tier === "elite")?.priceString ?? LIST_PRICES.elite,
          provision: pv?.priceString ?? LIST_PRICES.provision,
        };
        // Only keep it if the store actually answered (retry next time if not).
        if (plans.length || pv) cached = next;
        return next;
      })
      .catch(() => LIST_PRICES)
      .finally(() => { pending = null; });
  }
  return pending;
}

export function useStorePrices(): StorePrices {
  const [prices, setPrices] = useState<StorePrices>(cached ?? LIST_PRICES);
  useEffect(() => {
    if (!isIAPAvailable()) return;
    let alive = true;
    loadStorePrices().then((p) => { if (alive) setPrices(p); });
    return () => { alive = false; };
  }, []);
  return prices;
}
