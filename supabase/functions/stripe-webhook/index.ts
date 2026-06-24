import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const PRICE_TIER: Record<string, string> = {
  // Current price IDs
  [Deno.env.get("STRIPE_PRO_PRICE_ID")   ?? ""]: "pro",
  [Deno.env.get("STRIPE_ELITE_PRICE_ID") ?? ""]: "elite",
  // Legacy price IDs — existing subscribers on old prices must still resolve correctly
  "price_1ThB2pCanYhArG7jTUUYjnSy": "pro",
  "price_1ThB3ACanYhArG7jDp33W6xS": "elite",
};

async function updateProfileByCustomer(customerId: string, fields: Record<string, unknown>) {
  await supabaseAdmin
    .from("profiles")
    .update(fields)
    .eq("stripe_customer_id", customerId);
}

Deno.serve(async (req) => {
  const body = await req.text();
  const sig  = req.headers.get("stripe-signature") ?? "";

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body, sig, Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    return new Response(`Webhook signature error: ${err.message}`, { status: 400 });
  }

  const customerId = (obj: { customer: string | Stripe.Customer | Stripe.DeletedCustomer | null }) =>
    typeof obj.customer === "string" ? obj.customer : (obj.customer as Stripe.Customer)?.id ?? "";

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription") break;
      const sub = await stripe.subscriptions.retrieve(session.subscription as string);
      const priceId = sub.items.data[0]?.price.id ?? "";
      await updateProfileByCustomer(customerId(session), {
        tier:                PRICE_TIER[priceId] ?? "free",
        subscription_status: sub.status,
        subscription_end_at: new Date(sub.current_period_end * 1000).toISOString(),
      });
      break;
    }

    case "customer.subscription.updated": {
      const raw = event.data.object as Stripe.Subscription;
      const sub = await stripe.subscriptions.retrieve(raw.id);
      const priceId = sub.items.data[0]?.price.id ?? "";
      await updateProfileByCustomer(customerId(raw), {
        tier:                PRICE_TIER[priceId] ?? "free",
        subscription_status: sub.status,
        subscription_end_at: new Date(sub.current_period_end * 1000).toISOString(),
      });
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await updateProfileByCustomer(customerId(sub), {
        tier:                "free",
        subscription_status: "canceled",
        subscription_end_at: null,
      });
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      await updateProfileByCustomer(customerId(invoice), {
        subscription_status: "past_due",
      });
      break;
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
