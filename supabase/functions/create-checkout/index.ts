import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    // Verify the user JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    ).auth.getUser(token);

    if (authError || !user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const { priceId, origin } = await req.json();

    // Only our own current plans can be bought here (Pro, Elite, ProVision)
    // — never an arbitrary price ID sent by the client.
    const ALLOWED_PRICES = new Set(
      [
        Deno.env.get("STRIPE_PRO_PRICE_ID"),
        Deno.env.get("STRIPE_ELITE_PRICE_ID"),
        Deno.env.get("STRIPE_PROVISION_PRICE_ID"),
      ].filter((p): p is string => !!p),
    );
    if (typeof priceId !== "string" || !ALLOWED_PRICES.has(priceId)) {
      return new Response(JSON.stringify({ error: "Unknown plan" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Send people back only to our own site after checkout (no open redirect).
    const ALLOWED_ORIGINS = new Set([
      "https://coinhintz.io",
      "https://www.coinhintz.io",
      "https://coinhintz.com",
      "https://www.coinhintz.com",
      "http://localhost:5173",
      "http://localhost:3000",
      ...(Deno.env.get("CHECKOUT_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ]);
    const returnOrigin = typeof origin === "string" && ALLOWED_ORIGINS.has(origin) ? origin : "https://coinhintz.io";

    // Get or create Stripe customer
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email! });
      customerId = customer.id;
      await supabaseAdmin
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${returnOrigin}/?payment=success`,
      cancel_url:  `${returnOrigin}/?payment=cancelled`,
      allow_promotion_codes: true,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
