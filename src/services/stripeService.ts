import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabase";

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

export const PRICE_IDS = {
  pro:   import.meta.env.VITE_STRIPE_PRO_PRICE_ID   as string,
  elite: import.meta.env.VITE_STRIPE_ELITE_PRICE_ID as string,
};

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${session.access_token}`,
  };
}

// A rejected edge function doesn't always come back as JSON — an expired
// session gets a plain-text "Unauthorized" 401 (Supabase's own gateway,
// before the function body even runs), a cold-start/gateway failure can
// be an HTML error page, etc. Parsing straight to JSON in that case throws
// a raw "Unexpected token..." SyntaxError that used to leak into the UI
// verbatim (setError(e.message)) instead of a message a user could act
// on. This centralizes the fetch+parse so every caller below gets a
// sane, typed error either way.
async function callBillingFn<T>(path: string, body: unknown): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${FN_BASE}/${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  const raw = await res.text();
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* not JSON, handled below */ }

  if (!res.ok) {
    if (res.status === 401) throw new Error("Your session has expired — please sign in again and retry.");
    throw new Error((data && data.error) || raw || `Request failed (${res.status})`);
  }
  if (data === null) throw new Error("Unexpected response from server — please try again.");
  if (data.error) throw new Error(data.error);
  return data as T;
}

export async function redirectToCheckout(priceId: string): Promise<void> {
  // Apple Guideline 3.1.1: a digital subscription must go through In-App
  // Purchase on iOS, never an external payment flow — this is the actual
  // mechanism that would load Stripe Checkout inside the app, so it's
  // blocked here unconditionally rather than trusting every caller (e.g.
  // UpgradeModal's isIAPAvailable() check) to have gated it correctly.
  // isIAPAvailable() can go false on a real iOS device if a build-time env
  // var is ever missing/misconfigured — this still can't be bypassed by that.
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {
    throw new Error("Purchases on iOS go through the App Store, not this screen. Please try again in a moment.");
  }
  const { url } = await callBillingFn<{ url: string }>("create-checkout", { priceId, origin: window.location.origin });
  window.location.href = url;
}

export async function redirectToBillingPortal(): Promise<void> {
  const { url } = await callBillingFn<{ url: string }>("billing-portal", { origin: window.location.origin });
  window.location.href = url;
}

export async function previewUpgrade(newPriceId: string): Promise<{ amountDue: number; currency: string; scheduledAt?: string }> {
  return callBillingFn("preview-upgrade", { newPriceId });
}

export async function upgradePlan(newPriceId: string): Promise<{ isUpgrade: boolean; scheduledAt?: string; paymentSucceeded?: boolean }> {
  return callBillingFn("upgrade-plan", { newPriceId });
}

export async function reactivateSubscription(): Promise<void> {
  await callBillingFn("reactivate-subscription", {});
}

export async function cancelSubscription(): Promise<{ accessUntil: string }> {
  return callBillingFn("cancel-subscription", {});
}
