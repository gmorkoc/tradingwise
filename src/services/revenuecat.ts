import { Capacitor } from "@capacitor/core";
import { Purchases, LOG_LEVEL, type PurchasesPackage } from "@revenuecat/purchases-capacitor";
import { supabase, type Tier } from "./supabase";

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// Public SDK key from the RevenueCat dashboard (Project settings → API keys →
// Apple App Store). Safe to ship in the client — it only permits purchase
// operations for this app, same trust level as a Stripe publishable key.
// Empty until that's set up; every function below no-ops until then so
// nothing here can throw for users on a build without it configured yet.
const IOS_API_KEY = import.meta.env.VITE_REVENUECAT_IOS_API_KEY as string | undefined;

// Maps RevenueCat entitlement identifiers (configured in the RevenueCat
// dashboard, NOT the raw App Store Connect product IDs) to this app's tier
// system — same role as PRICE_TIER in the Stripe webhook.
const ENTITLEMENT_TIER: Record<string, Tier> = {
  pro: "pro",
  elite: "elite",
};

let configured = false;

export function isIAPAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios" && !!IOS_API_KEY;
}

/** Call once, after the Supabase user ID is known, so RevenueCat's
 *  app_user_id matches profiles.id 1:1 — no separate ID-mapping table
 *  needed, same idea as Stripe's stripe_customer_id but simpler since we
 *  control the ID instead of Stripe assigning one. */
export async function initRevenueCat(supabaseUserId: string): Promise<void> {
  if (!isIAPAvailable()) return;
  try {
    if (!configured) {
      await Purchases.setLogLevel({ level: LOG_LEVEL.WARN });
      await Purchases.configure({ apiKey: IOS_API_KEY!, appUserID: supabaseUserId });
      configured = true;
    } else {
      await Purchases.logIn({ appUserID: supabaseUserId });
    }
  } catch (err) {
    console.error("RevenueCat init failed:", err);
  }
}

export async function logOutRevenueCat(): Promise<void> {
  if (!configured) return;
  try {
    await Purchases.logOut();
  } catch (err) {
    console.error("RevenueCat logout failed:", err);
  }
}

export interface IAPPlan {
  tier: Tier;
  pkg: PurchasesPackage;
  priceString: string;
}

/** Pulls the "default" offering's packages, matched back to this app's
 *  tiers via each package's entitlement. Returns [] (not a throw) if IAP
 *  isn't configured or offerings haven't been set up in the dashboard yet
 *  — callers should fall back to Stripe checkout in that case. */
export async function getIAPPlans(): Promise<IAPPlan[]> {
  if (!isIAPAvailable()) return [];
  try {
    const offerings = await Purchases.getOfferings();
    const current = offerings.current;
    if (!current) return [];
    const plans: IAPPlan[] = [];
    for (const pkg of current.availablePackages) {
      // Which entitlement a package grants isn't exposed pre-purchase, so
      // match by product identifier instead — App Store Connect product IDs
      // should follow a "..._pro_..." / "..._elite_..." naming convention.
      const id = pkg.product.identifier.toLowerCase();
      const tier: Tier | undefined = id.includes("elite") ? "elite" : id.includes("pro") ? "pro" : undefined;
      if (!tier) continue;
      plans.push({ tier, pkg, priceString: pkg.product.priceString });
    }
    return plans;
  } catch (err) {
    console.error("RevenueCat getOfferings failed:", err);
    return [];
  }
}

export interface PurchaseResult {
  success: boolean;
  cancelled: boolean;
  tier?: Tier;
  error?: string;
}

export async function purchaseIAPPlan(plan: IAPPlan): Promise<PurchaseResult> {
  try {
    const { customerInfo } = await Purchases.purchasePackage({ aPackage: plan.pkg });
    const activeEntitlements = Object.keys(customerInfo.entitlements.active);
    const grantedTier = activeEntitlements
      .map(id => ENTITLEMENT_TIER[id])
      .find((t): t is Tier => !!t);
    return { success: true, cancelled: false, tier: grantedTier ?? plan.tier };
  } catch (err: any) {
    // RevenueCat sets userCancelled on the error for a user-dismissed sheet
    if (err?.userCancelled) return { success: false, cancelled: true };
    return { success: false, cancelled: false, error: err?.message ?? "Purchase failed" };
  }
}

/** Apple requires IAP subscriptions to be cancelled/managed through the
 *  user's Apple ID, not through the app's own UI (Guideline 3.1.1) — the
 *  Stripe billing portal has no record of these subscribers at all. This
 *  opens the native "Manage Subscriptions" screen directly. */
export function openManageSubscriptions(): void {
  window.location.href = "itms-apps://apps.apple.com/account/subscriptions";
}

// Confirms the purchase/restore directly against RevenueCat's own servers
// and writes profiles.tier server-side — called right after a successful
// purchaseIAPPlan/restorePurchases instead of just waiting on RevenueCat's
// webhook, which is async and has no delivery guarantee the UI can rely on
// for "I just paid, why isn't my tier updating?" (see sync-iap-entitlement
// edge function for the authoritative RevenueCat REST lookup).
export async function syncIAPEntitlement(): Promise<{ tier: Tier | null; error?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { tier: null, error: "Not authenticated" };
  try {
    const res = await fetch(`${FN_BASE}/sync-iap-entitlement`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.access_token}`,
      },
    });
    const data = await res.json();
    if (data.error) return { tier: null, error: data.error };
    return { tier: (data.tier as Tier) ?? null };
  } catch (err: any) {
    return { tier: null, error: err?.message ?? "Sync failed" };
  }
}

export async function restorePurchases(): Promise<PurchaseResult> {
  if (!isIAPAvailable()) return { success: false, cancelled: false, error: "Not available" };
  try {
    const { customerInfo } = await Purchases.restorePurchases();
    const activeEntitlements = Object.keys(customerInfo.entitlements.active);
    const restoredTier = activeEntitlements
      .map(id => ENTITLEMENT_TIER[id])
      .find((t): t is Tier => !!t);
    if (!restoredTier) return { success: false, cancelled: false, error: "No active purchases found for this Apple ID" };
    return { success: true, cancelled: false, tier: restoredTier };
  } catch (err: any) {
    return { success: false, cancelled: false, error: err?.message ?? "Restore failed" };
  }
}
