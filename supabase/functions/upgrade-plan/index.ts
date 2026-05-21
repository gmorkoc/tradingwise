import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PRICE_TIER: Record<string, string> = {
  [Deno.env.get("STRIPE_PRO_PRICE_ID")   ?? ""]: "pro",
  [Deno.env.get("STRIPE_ELITE_PRICE_ID") ?? ""]: "elite",
};

const TIER_RANK: Record<string, number> = {
  [Deno.env.get("STRIPE_PRO_PRICE_ID")   ?? ""]: 1,
  [Deno.env.get("STRIPE_ELITE_PRICE_ID") ?? ""]: 2,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2024-06-20",
    });

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

    const { newPriceId } = await req.json();
    if (!newPriceId) {
      return new Response(JSON.stringify({ error: "newPriceId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();

    if (!profile?.stripe_customer_id) {
      return new Response(JSON.stringify({ error: "No billing account found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: "active",
      limit: 1,
    });

    if (!subscriptions.data.length) {
      return new Response(JSON.stringify({ error: "No active subscription found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const subscription = subscriptions.data[0];
    const currentItem  = subscription.items.data[0];
    const itemId       = currentItem?.id;

    if (!itemId) {
      return new Response(JSON.stringify({ error: "Subscription item not found" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const currentRank = TIER_RANK[currentItem.price.id] ?? 0;
    const newRank     = TIER_RANK[newPriceId] ?? 0;
    const isUpgrade   = newRank > currentRank;

    // Upgrades: charge the prorated difference immediately.
    // Downgrades: create a proration credit applied at next renewal — no immediate charge.
    const updated = await stripe.subscriptions.update(subscription.id, {
      items: [{ id: itemId, price: newPriceId }],
      proration_behavior: isUpgrade ? "always_invoice" : "create_prorations",
      billing_cycle_anchor: "unchanged",
    });

    const newTier = PRICE_TIER[newPriceId] ?? "free";
    await supabaseAdmin
      .from("profiles")
      .update({
        tier:                newTier,
        subscription_status: updated.status,
        subscription_end_at: new Date(updated.current_period_end * 1000).toISOString(),
      })
      .eq("id", user.id);

    return new Response(
      JSON.stringify({ success: true, tier: newTier, isUpgrade }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
