import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logAccountEvent } from "../_shared/accountEvents.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// RevenueCat entitlement identifiers (configured in the RevenueCat
// dashboard) mapped to this app's tier system — same role as PRICE_TIER in
// the Stripe webhook, and must match ENTITLEMENT_TIER in
// src/services/revenuecat.ts on the client.
const ENTITLEMENT_TIER: Record<string, string> = {
  pro: "pro",
  elite: "elite",
};

const TIER_RANK: Record<string, number> = { pro: 1, elite: 2 };

// Prefer the highest-ranked entitlement rather than whichever comes first
// in the array — a subscriber can briefly hold more than one active
// entitlement (e.g. mid-upgrade), and elite should always win over pro.
function tierFromEntitlements(entitlementIds: string[] | undefined): string | null {
  if (!entitlementIds) return null;
  let best: string | null = null;
  for (const id of entitlementIds) {
    const tier = ENTITLEMENT_TIER[id];
    if (tier && (TIER_RANK[tier] ?? 0) > (best ? TIER_RANK[best] : -1)) best = tier;
  }
  return best;
}

interface RevenueCatEvent {
  type: string;
  app_user_id: string;
  entitlement_ids?: string[];
  product_id?: string;
  expiration_at_ms?: number | null;
  environment?: "SANDBOX" | "PRODUCTION";
}

async function updateProfile(userId: string, fields: Record<string, unknown>) {
  // app_user_id was set to the Supabase user id at Purchases.configure/logIn
  // time (see initRevenueCat in src/services/revenuecat.ts) — profiles.id
  // *is* the RevenueCat app_user_id, no separate mapping table needed.
  await supabaseAdmin.from("profiles").update(fields).eq("id", userId);
}

Deno.serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${Deno.env.get("REVENUECAT_WEBHOOK_SECRET")}`;
  // RevenueCat authenticates webhooks with a shared-secret Authorization
  // header you set in its dashboard (not a signature scheme like Stripe's).
  if (auth !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await req.json();
  const event = body.event as RevenueCatEvent;
  const userId = event.app_user_id;

  switch (event.type) {
    case "INITIAL_PURCHASE": {
      const tier = tierFromEntitlements(event.entitlement_ids);
      const fields: Record<string, unknown> = { subscription_status: "active" };
      if (tier) fields.tier = tier;
      if (event.expiration_at_ms) fields.subscription_end_at = new Date(event.expiration_at_ms).toISOString();
      await updateProfile(userId, fields);
      await logAccountEvent(supabaseAdmin, userId, "subscription_started", { tier, provider: "apple" });
      break;
    }

    case "RENEWAL": {
      const tier = tierFromEntitlements(event.entitlement_ids);
      const fields: Record<string, unknown> = { subscription_status: "active" };
      if (tier) fields.tier = tier;
      if (event.expiration_at_ms) fields.subscription_end_at = new Date(event.expiration_at_ms).toISOString();
      await updateProfile(userId, fields);
      await logAccountEvent(supabaseAdmin, userId, "payment_succeeded", { tier, provider: "apple" });
      break;
    }

    case "PRODUCT_CHANGE": {
      const { data: before } = await supabaseAdmin.from("profiles").select("tier").eq("id", userId).single();
      const tier = tierFromEntitlements(event.entitlement_ids);
      const fields: Record<string, unknown> = { subscription_status: "active" };
      if (tier) fields.tier = tier;
      if (event.expiration_at_ms) fields.subscription_end_at = new Date(event.expiration_at_ms).toISOString();
      await updateProfile(userId, fields);
      if (tier && before && tier !== before.tier) {
        await logAccountEvent(supabaseAdmin, userId, "tier_changed", { from: before.tier, to: tier, provider: "apple" });
      }
      break;
    }

    case "UNCANCELLATION": {
      const tier = tierFromEntitlements(event.entitlement_ids);
      const fields: Record<string, unknown> = { subscription_status: "active" };
      if (tier) fields.tier = tier;
      if (event.expiration_at_ms) fields.subscription_end_at = new Date(event.expiration_at_ms).toISOString();
      await updateProfile(userId, fields);
      await logAccountEvent(supabaseAdmin, userId, "subscription_reactivated", { provider: "apple" });
      break;
    }

    case "CANCELLATION": {
      // Auto-renew turned off — access continues until expiration_at_ms,
      // the EXPIRATION event (below) is what actually downgrades the tier.
      await updateProfile(userId, { subscription_status: "canceling" });
      await logAccountEvent(supabaseAdmin, userId, "subscription_cancel_scheduled", { provider: "apple" });
      break;
    }

    case "EXPIRATION": {
      await updateProfile(userId, {
        tier: "free",
        subscription_status: "canceled",
        subscription_end_at: null,
      });
      await logAccountEvent(supabaseAdmin, userId, "subscription_canceled", { provider: "apple" });
      break;
    }

    case "BILLING_ISSUE": {
      await updateProfile(userId, { subscription_status: "past_due" });
      await logAccountEvent(supabaseAdmin, userId, "payment_failed", { provider: "apple" });
      break;
    }

    case "SUBSCRIPTION_PAUSED": {
      await updateProfile(userId, { subscription_status: "canceling" });
      break;
    }

    // TRANSFER (purchase moved to a different app_user_id) and TEST events
    // are intentionally unhandled — TRANSFER is rare enough for this app's
    // single-Apple-ID-per-account model to not be worth the complexity yet.
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
