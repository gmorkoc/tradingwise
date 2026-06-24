import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PRICE_TIER: Record<string, string> = {
  [Deno.env.get("STRIPE_PRO_PRICE_ID")   ?? ""]: "pro",
  [Deno.env.get("STRIPE_ELITE_PRICE_ID") ?? ""]: "elite",
  "price_1ThB2pCanYhArG7jTUUYjnSy": "pro",
  "price_1ThB3ACanYhArG7jDp33W6xS": "elite",
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

    if (isUpgrade) {
      // Immediate upgrade: charge prorated difference, keep renewal date unchanged.
      const updated = await stripe.subscriptions.update(subscription.id, {
        items: [{ id: itemId, price: newPriceId }],
        proration_behavior: "always_invoice",
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
        JSON.stringify({ success: true, tier: newTier, isUpgrade: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      // Downgrade: schedule plan change at end of current billing period.
      // No refund, no credit — user keeps current tier until expiry.

      // Release any existing schedule on this subscription first.
      const existingSchedules = await stripe.subscriptionSchedules.list({
        customer: profile.stripe_customer_id,
        limit: 10,
      });
      for (const s of existingSchedules.data) {
        if (
          s.subscription === subscription.id &&
          (s.status === "active" || s.status === "not_started")
        ) {
          await stripe.subscriptionSchedules.release(s.id);
        }
      }

      // Create a schedule and add a second phase for the downgraded plan.
      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: subscription.id,
      });

      await stripe.subscriptionSchedules.update(schedule.id, {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: subscription.current_period_start,
            end_date:   subscription.current_period_end,
            items: [{ price: currentItem.price.id, quantity: 1 }],
          },
          {
            items: [{ price: newPriceId, quantity: 1 }],
          },
        ],
      });

      const scheduledAt = new Date(subscription.current_period_end * 1000).toISOString();

      // Profile tier stays unchanged — user keeps current access until period end.
      // The Stripe webhook will update the tier when the schedule executes.
      return new Response(
        JSON.stringify({ success: true, isUpgrade: false, scheduledAt }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
