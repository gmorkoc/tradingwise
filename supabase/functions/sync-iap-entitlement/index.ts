import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logAccountEvent } from "../_shared/accountEvents.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Same mapping as revenuecat-webhook's ENTITLEMENT_TIER — kept in sync
// manually since these are two separate Deno deployments.
const ENTITLEMENT_TIER: Record<string, string> = {
  pro: "pro",
  elite: "elite",
};

const TIER_RANK: Record<string, number> = { pro: 1, elite: 2 };

interface RCEntitlement {
  expires_date: string | null;
}

// Called right after a client-side IAP purchase/restore completes, instead
// of relying solely on RevenueCat's webhook (async, and — as of this
// writing — was silently never landing for real purchases: the client
// would confirm a successful purchase with Apple but profiles.tier never
// updated because the webhook wasn't firing). This asks RevenueCat's own
// servers directly what the subscriber's entitlements actually are right
// now — authoritative, and doesn't depend on webhook delivery at all.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    ).auth.getUser(token);

    if (authError || !user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    // app_user_id was set to this same Supabase user id at
    // Purchases.configure/logIn time (see initRevenueCat in
    // src/services/revenuecat.ts) — profiles.id *is* the RevenueCat
    // app_user_id, no separate mapping table needed.
    const rcRes = await fetch(`https://api.revenuecat.com/v1/subscribers/${user.id}`, {
      headers: { Authorization: `Bearer ${Deno.env.get("REVENUECAT_SECRET_KEY")}` },
    });

    if (!rcRes.ok) {
      const text = await rcRes.text();
      return new Response(JSON.stringify({ error: `RevenueCat lookup failed (${rcRes.status}): ${text}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rcData = await rcRes.json();
    const entitlements = (rcData?.subscriber?.entitlements ?? {}) as Record<string, RCEntitlement>;
    const now = Date.now();

    // Prefer the highest-ranked *currently active* entitlement — a
    // subscriber can hold more than one at once (e.g. an old plan hasn't
    // expired yet after upgrading), and elite should always win over pro.
    let tier: string | null = null;
    let expiresAtMs: number | null = null;
    let bestRank = -1;
    for (const [entId, ent] of Object.entries(entitlements)) {
      const expiresMs = ent.expires_date ? new Date(ent.expires_date).getTime() : null;
      const active = expiresMs === null || expiresMs > now;
      if (!active) continue;
      const mappedTier = ENTITLEMENT_TIER[entId];
      if (!mappedTier) continue;
      const rank = TIER_RANK[mappedTier] ?? 0;
      if (rank > bestRank) { bestRank = rank; tier = mappedTier; expiresAtMs = expiresMs; }
    }

    if (!tier) {
      return new Response(JSON.stringify({ tier: null }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: before } = await supabaseAdmin
      .from("profiles")
      .select("tier")
      .eq("id", user.id)
      .single();

    await supabaseAdmin
      .from("profiles")
      .update({
        tier,
        subscription_status: "active",
        subscription_end_at: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
      })
      .eq("id", user.id);

    if (before && before.tier !== tier) {
      await logAccountEvent(
        supabaseAdmin, user.id,
        before.tier === "free" ? "subscription_started" : "tier_changed",
        before.tier === "free" ? { tier, provider: "apple" } : { from: before.tier, to: tier, provider: "apple" },
      );
    }

    return new Response(JSON.stringify({ tier }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
