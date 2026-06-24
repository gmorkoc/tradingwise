import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TIER_RANK: Record<string, number> = {
  [Deno.env.get("STRIPE_PRO_PRICE_ID")   ?? ""]: 1,
  [Deno.env.get("STRIPE_ELITE_PRICE_ID") ?? ""]: 2,
  "price_1ThB2pCanYhArG7jTUUYjnSy": 1,
  "price_1ThB3ACanYhArG7jDp33W6xS": 2,
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
    const currentRank  = TIER_RANK[subscription.items.data[0]?.price.id ?? ""] ?? 0;
    const newRank      = TIER_RANK[newPriceId] ?? 0;
    const isDowngrade  = newRank < currentRank;

    // Downgrades: no charge, no credit — scheduled at period end.
    if (isDowngrade) {
      return new Response(
        JSON.stringify({
          amountDue:   0,
          currency:    "usd",
          scheduledAt: new Date(subscription.current_period_end * 1000).toISOString(),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Upgrades: compute prorated charge preview.
    const itemId = subscription.items.data[0]?.id;
    const upcoming = await stripe.invoices.retrieveUpcoming({
      customer: profile.stripe_customer_id,
      subscription: subscription.id,
      subscription_items: [{ id: itemId, price: newPriceId }],
      subscription_proration_behavior: "create_prorations",
    });

    const proratedAmount = upcoming.lines.data
      .filter((line) => line.proration)
      .reduce((sum, line) => sum + line.amount, 0);

    return new Response(
      JSON.stringify({ amountDue: proratedAmount, currency: upcoming.currency }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
