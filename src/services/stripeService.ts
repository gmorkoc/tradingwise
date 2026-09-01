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
  const headers = await authHeaders();
  const res = await fetch(`${FN_BASE}/create-checkout`, {
    method: "POST",
    headers,
    body: JSON.stringify({ priceId, origin: window.location.origin }),
  });
  const { url, error } = await res.json();
  if (error) throw new Error(error);
  window.location.href = url;
}

export async function redirectToBillingPortal(): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch(`${FN_BASE}/billing-portal`, {
    method: "POST",
    headers,
    body: JSON.stringify({ origin: window.location.origin }),
  });
  const { url, error } = await res.json();
  if (error) throw new Error(error);
  window.location.href = url;
}

export async function previewUpgrade(newPriceId: string): Promise<{ amountDue: number; currency: string; scheduledAt?: string }> {
  const headers = await authHeaders();
  const res = await fetch(`${FN_BASE}/preview-upgrade`, {
    method: "POST",
    headers,
    body: JSON.stringify({ newPriceId }),
  });
  const { amountDue, currency, scheduledAt, error } = await res.json();
  if (error) throw new Error(error);
  return { amountDue, currency, scheduledAt };
}

export async function upgradePlan(newPriceId: string): Promise<{ isUpgrade: boolean; scheduledAt?: string; paymentSucceeded?: boolean }> {
  const headers = await authHeaders();
  const res = await fetch(`${FN_BASE}/upgrade-plan`, {
    method: "POST",
    headers,
    body: JSON.stringify({ newPriceId }),
  });
  const { error, isUpgrade, scheduledAt, paymentSucceeded } = await res.json();
  if (error) throw new Error(error);
  return { isUpgrade, scheduledAt, paymentSucceeded };
}

export async function reactivateSubscription(): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch(`${FN_BASE}/reactivate-subscription`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  const { error } = await res.json();
  if (error) throw new Error(error);
}

export async function cancelSubscription(): Promise<{ accessUntil: string }> {
  const headers = await authHeaders();
  const res = await fetch(`${FN_BASE}/cancel-subscription`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  const { error, accessUntil } = await res.json();
  if (error) throw new Error(error);
  return { accessUntil };
}
