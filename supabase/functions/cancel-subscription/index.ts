import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logAccountEvent } from "../_shared/accountEvents.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

    // Release any active subscription schedule before cancelling.
    // A schedule locks the subscription and will reject cancel_at_period_end otherwise.
    const schedules = await stripe.subscriptionSchedules.list({
      customer: profile.stripe_customer_id,
      limit: 10,
    });
    for (const s of schedules.data) {
      if (
        s.subscription === subscription.id &&
        (s.status === "active" || s.status === "not_started")
      ) {
        await stripe.subscriptionSchedules.release(s.id);
      }
    }

    // Cancel at the end of the billing period — user keeps access until then.
    const updated = await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: true,
    });

    const periodEnd = new Date(updated.current_period_end * 1000).toISOString();

    // Mark as canceling so the UI can show "access until <date>"
    await supabaseAdmin
      .from("profiles")
      .update({
        subscription_status: "canceling",
        subscription_end_at: periodEnd,
      })
      .eq("id", user.id);

    await logAccountEvent(supabaseAdmin, user.id, "subscription_cancel_scheduled", {
      provider: "stripe", accessUntil: periodEnd,
    });

    return new Response(
      JSON.stringify({ success: true, accessUntil: periodEnd }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
