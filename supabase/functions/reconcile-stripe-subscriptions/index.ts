import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logAccountEvent } from "../_shared/accountEvents.ts";

// One-time (re-runnable) repair tool for the 2026-10 incident: the Stripe
// webhook endpoint was Disabled in the Stripe dashboard for an unknown
// stretch of time, so every checkout/renewal/cancellation event during that
// window was dropped — profiles.tier/subscription_status silently never
// updated for anyone who paid while it was off. The endpoint itself is
// fixed now (re-enabled); this backfills anyone still stuck from before
// that, by asking Stripe directly (source of truth) instead of trusting
// whatever's in `profiles` already. Safe to re-run any time — it's a
// reconciliation, not a one-shot migration.
//
// verify_jwt is off for this function (see supabase/config.toml) since it's
// an admin tool, not something any signed-in client should be able to call —
// this header is the substitute check, same pattern as the cron-secret-
// gated functions (btc-price-alert-push etc.), just its own secret since
// this isn't on a cron schedule.
const ADMIN_SECRET = Deno.env.get("RECONCILE_ADMIN_SECRET")!;

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Mirrors stripe-webhook/index.ts's own map exactly — kept in sync by hand,
// same as that file already notes.
const PRICE_TIER: Record<string, string> = {
  [Deno.env.get("STRIPE_PRO_PRICE_ID")   ?? ""]: "pro",
  [Deno.env.get("STRIPE_ELITE_PRICE_ID") ?? ""]: "elite",
  "price_1ThB2pCanYhArG7jTUUYjnSy": "pro",
  "price_1ThB3ACanYhArG7jDp33W6xS": "elite",
};

interface ProfileRow {
  id: string;
  email: string | null;
  tier: string;
  subscription_status: string | null;
  subscription_end_at: string | null;
  stripe_customer_id: string;
}

interface Correction {
  email: string | null;
  customerId: string;
  current: { tier: string; status: string | null };
  correct: { tier: string; status: string; endAt: string };
  reason: string;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-admin-secret") !== ADMIN_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "true";

  const { data: profiles, error } = await supabaseAdmin
    .from("profiles")
    .select("id, email, tier, subscription_status, subscription_end_at, stripe_customer_id")
    .not("stripe_customer_id", "is", null);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const corrections: Correction[] = [];
  const skipped: { email: string | null; customerId: string; reason: string }[] = [];

  for (const profile of (profiles as ProfileRow[])) {
    const subs = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: "all",
      limit: 10,
    });

    if (subs.data.length === 0) {
      skipped.push({ email: profile.email, customerId: profile.stripe_customer_id, reason: "no subscriptions ever created" });
      continue;
    }

    // Prefer a non-canceled subscription (there should only ever be one
    // live at a time per customer); fall back to the most recently updated
    // canceled one if that's all there is.
    const live = subs.data.find(s => s.status !== "canceled");
    const chosen = live ?? subs.data.sort((a, b) => b.canceled_at! - a.canceled_at!)[0];

    const priceId = chosen.items.data[0]?.price.id ?? "";
    const resolvedTier = live ? PRICE_TIER[priceId] : "free";

    if (!resolvedTier) {
      skipped.push({ email: profile.email, customerId: profile.stripe_customer_id, reason: `unresolvable price id ${priceId}` });
      continue;
    }

    const correctStatus = chosen.status;
    const correctEndAt = new Date(chosen.current_period_end * 1000).toISOString();

    const mismatched =
      profile.tier !== resolvedTier ||
      profile.subscription_status !== correctStatus ||
      profile.subscription_end_at !== correctEndAt;

    if (!mismatched) continue;

    corrections.push({
      email: profile.email,
      customerId: profile.stripe_customer_id,
      current: { tier: profile.tier, status: profile.subscription_status },
      correct: { tier: resolvedTier, status: correctStatus, endAt: correctEndAt },
      reason: live ? "active subscription out of sync" : "canceled subscription never synced to free",
    });

    if (apply) {
      await supabaseAdmin
        .from("profiles")
        .update({
          tier: resolvedTier,
          subscription_status: correctStatus,
          subscription_end_at: correctEndAt,
        })
        .eq("id", profile.id);

      await logAccountEvent(supabaseAdmin, profile.id, "tier_reconciled", {
        from: profile.tier, to: resolvedTier, provider: "stripe",
        reason: "webhook endpoint was disabled",
      });
    }
  }

  return new Response(JSON.stringify({
    applied: apply,
    totalProfilesChecked: profiles.length,
    correctionsFound: corrections.length,
    corrections,
    skipped,
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
