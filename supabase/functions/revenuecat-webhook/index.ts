import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logAccountEvent } from "../_shared/accountEvents.ts";
import { PROVISION_ENTITLEMENT } from "../_shared/provision.ts";

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
const rank = (t: string | null | undefined) => (t ? TIER_RANK[t] ?? 0 : 0);

// Prefer the highest-ranked entitlement rather than whichever comes first
// in the array — a subscriber can briefly hold more than one active
// entitlement (e.g. mid-upgrade), and elite should always win over pro.
function tierFromEntitlements(entitlementIds: string[] | undefined): string | null {
  if (!entitlementIds) return null;
  let best: string | null = null;
  for (const id of entitlementIds) {
    const tier = ENTITLEMENT_TIER[id];
    if (tier && rank(tier) > (best ? rank(best) : -1)) best = tier;
  }
  return best;
}

interface RevenueCatEvent {
  type: string;
  app_user_id: string;
  entitlement_ids?: string[];
  product_id?: string;
  new_product_id?: string;
  expiration_at_ms?: number | null;
  cancel_reason?: string;
  transferred_from?: string[];
  transferred_to?: string[];
  environment?: "SANDBOX" | "PRODUCTION";
}

interface TierRow { tier: string; apple_tier: string | null }

async function tierRow(userId: string): Promise<TierRow> {
  const { data } = await supabaseAdmin.from("profiles").select("tier, apple_tier").eq("id", userId).single();
  return { tier: (data?.tier as string) ?? "free", apple_tier: (data?.apple_tier as string | null) ?? null };
}

async function updateProfile(userId: string, fields: Record<string, unknown>) {
  // app_user_id was set to the Supabase user id at Purchases.configure/logIn
  // time (see initRevenueCat in src/services/revenuecat.ts) — profiles.id
  // *is* the RevenueCat app_user_id, no separate mapping table needed.
  await supabaseAdmin.from("profiles").update(fields).eq("id", userId);
}

// ── The rules ────────────────────────────────────────────────────────────
// profiles.apple_tier remembers which tier the Apple subscription gives.
// Apple can always RAISE a tier. It can only LOWER or REMOVE one when the
// user's current tier came from Apple (tier === apple_tier) — so a web
// (Stripe) or admin-granted Elite is never touched by an Apple Pro plan,
// e.g. a TestFlight test purchase that renews every few minutes.

/** An active Apple plan for `tier` (purchase, renewal, uncancel, upgrade). */
async function applyAppleTier(userId: string, tier: string, expirationMs?: number | null) {
  const before = await tierRow(userId);
  const fromApple = before.tier === before.apple_tier;
  const raise = rank(tier) > rank(before.tier);
  const lower = rank(tier) < rank(before.tier) && fromApple;
  const fields: Record<string, unknown> = { apple_tier: tier };
  if (raise || lower) fields.tier = tier;
  // Billing fields describe the plan behind the tier — only touch them when
  // that plan is (now) the Apple one.
  if (raise || lower || fromApple || before.tier === tier) {
    fields.subscription_status = "active";
    if (expirationMs) fields.subscription_end_at = new Date(expirationMs).toISOString();
  }
  await updateProfile(userId, fields);
  if ((raise || lower) && before.tier !== tier) {
    await logAccountEvent(supabaseAdmin, userId,
      before.tier === "free" ? "subscription_started" : "tier_changed",
      before.tier === "free" ? { tier, provider: "apple" } : { from: before.tier, to: tier, provider: "apple" });
  }
}

/** The Apple plan ended (expiry, refund, moved to another account). */
async function endAppleTier(userId: string, ended: string | null, reason: string) {
  const before = await tierRow(userId);
  // Apple-backed: tier came from Apple. Older rows (no apple_tier yet):
  // fall back to "the ending plan is at least as high as the current tier".
  const fromApple = before.apple_tier
    ? before.tier === before.apple_tier
    : !ended || rank(ended) >= rank(before.tier);
  if (!fromApple) {
    await updateProfile(userId, { apple_tier: null });
    await logAccountEvent(supabaseAdmin, userId, "subscription_canceled", { tier: ended, provider: "apple", reason, kept_higher_tier: true });
    return;
  }
  await updateProfile(userId, { tier: "free", apple_tier: null, subscription_status: "canceled", subscription_end_at: null });
  await logAccountEvent(supabaseAdmin, userId, "subscription_canceled", { tier: ended ?? before.tier, provider: "apple", reason });
}

// A refund arrives as CANCELLATION (cancel_reason CUSTOMER_SUPPORT) with
// access already over — not as an EXPIRATION.
const isRefundOrEnded = (e: RevenueCatEvent) =>
  e.cancel_reason === "CUSTOMER_SUPPORT" || (!!e.expiration_at_ms && e.expiration_at_ms <= Date.now());

Deno.serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  const secret = Deno.env.get("REVENUECAT_WEBHOOK_SECRET");
  // Fail closed: with no secret configured, "Bearer undefined" would match.
  if (!secret) return new Response("Webhook not configured", { status: 500 });
  const expected = `Bearer ${secret}`;
  // RevenueCat authenticates webhooks with a shared-secret Authorization
  // header you set in its dashboard (not a signature scheme like Stripe's).
  if (auth !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await req.json();
  const event = body.event as RevenueCatEvent;
  const userId = event.app_user_id;
  const ok = () => new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });

  // ── Purchase moved between accounts (restore on another login) ────────
  // The old account(s) lose the Apple plan; the new one gets it.
  if (event.type === "TRANSFER") {
    const tier = tierFromEntitlements(event.entitlement_ids);
    const hasPv = (event.entitlement_ids ?? []).includes(PROVISION_ENTITLEMENT);
    for (const from of event.transferred_from ?? []) {
      if (!from || from.startsWith("$RCAnonymousID")) continue;
      await endAppleTier(from, tier, "transferred");
      if (hasPv) await updateProfile(from, { provision_status: "canceled", provision_end_at: null });
    }
    for (const to of event.transferred_to ?? []) {
      if (!to || to.startsWith("$RCAnonymousID")) continue;
      if (tier) await applyAppleTier(to, tier, event.expiration_at_ms);
      if (hasPv) await updateProfile(to, { provision_status: "active" });
    }
    return ok();
  }

  // ProVision plan events (its own product + entitlement) only ever touch
  // the provision_* columns — never tier / subscription_*. Without this an
  // EXPIRATION of ProVision would downgrade a Pro/Elite user to free.
  const isProvision =
    (event.entitlement_ids ?? []).includes(PROVISION_ENTITLEMENT) ||
    (event.product_id ?? "").toLowerCase().includes("provision");
  if (isProvision) {
    const endAt = event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : undefined;
    switch (event.type) {
      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "PRODUCT_CHANGE":
      case "UNCANCELLATION":
        await updateProfile(userId, { provision_status: "active", ...(endAt ? { provision_end_at: endAt } : {}) });
        await logAccountEvent(supabaseAdmin, userId,
          event.type === "INITIAL_PURCHASE" ? "subscription_started" : event.type === "RENEWAL" ? "payment_succeeded" : "subscription_reactivated",
          { tier: "provision", provider: "apple" });
        break;
      case "CANCELLATION":
        if (isRefundOrEnded(event)) {
          // Refunded: access ends now.
          await updateProfile(userId, { provision_status: "canceled", provision_end_at: null });
          await logAccountEvent(supabaseAdmin, userId, "subscription_canceled", { tier: "provision", provider: "apple", reason: "refund" });
        } else {
          await updateProfile(userId, { provision_status: "canceling" });
        }
        break;
      case "EXPIRATION":
        await updateProfile(userId, { provision_status: "canceled", provision_end_at: null });
        await logAccountEvent(supabaseAdmin, userId, "subscription_canceled", { tier: "provision", provider: "apple" });
        break;
      case "BILLING_ISSUE":
        await updateProfile(userId, { provision_status: "past_due" });
        break;
    }
    return ok();
  }

  const tier = tierFromEntitlements(event.entitlement_ids);

  switch (event.type) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION": {
      // A renewal on a lower product after an Apple downgrade lowers the
      // tier here (only if the tier came from Apple).
      if (tier) await applyAppleTier(userId, tier, event.expiration_at_ms);
      if (event.type === "RENEWAL") await logAccountEvent(supabaseAdmin, userId, "payment_succeeded", { tier, provider: "apple" });
      if (event.type === "UNCANCELLATION") await logAccountEvent(supabaseAdmin, userId, "subscription_reactivated", { provider: "apple" });
      break;
    }

    case "PRODUCT_CHANGE": {
      // Upgrades apply right away. Downgrades (Elite → Pro) only take
      // effect at the next renewal on Apple's side, so the user keeps what
      // they paid for until then — the RENEWAL above applies the lower tier.
      const before = await tierRow(userId);
      if (tier && rank(tier) > rank(before.tier)) await applyAppleTier(userId, tier, event.expiration_at_ms);
      break;
    }

    case "CANCELLATION": {
      if (isRefundOrEnded(event)) {
        // Refund: access ends now (RevenueCat sends no EXPIRATION for it).
        await endAppleTier(userId, tier, "refund");
        break;
      }
      // Auto-renew turned off — access continues until expiration_at_ms,
      // the EXPIRATION event is what actually ends it.
      const before = await tierRow(userId);
      if (before.tier === before.apple_tier) await updateProfile(userId, { subscription_status: "canceling" });
      await logAccountEvent(supabaseAdmin, userId, "subscription_cancel_scheduled", { provider: "apple" });
      break;
    }

    case "EXPIRATION": {
      await endAppleTier(userId, tier, "expired");
      break;
    }

    case "BILLING_ISSUE": {
      const before = await tierRow(userId);
      if (before.tier === before.apple_tier) await updateProfile(userId, { subscription_status: "past_due" });
      await logAccountEvent(supabaseAdmin, userId, "payment_failed", { provider: "apple" });
      break;
    }

    case "SUBSCRIPTION_PAUSED": {
      const before = await tierRow(userId);
      if (before.tier === before.apple_tier) await updateProfile(userId, { subscription_status: "canceling" });
      break;
    }

    // TEST events: nothing to do.
  }

  return ok();
});
