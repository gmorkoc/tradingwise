import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logAccountEvent } from "../_shared/accountEvents.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const PRICE_TIER: Record<string, string> = {
  [Deno.env.get("STRIPE_PRO_PRICE_ID")   ?? ""]: "pro",
  [Deno.env.get("STRIPE_ELITE_PRICE_ID") ?? ""]: "elite",
  // Legacy price IDs — existing subscribers on old prices must still resolve correctly
  "price_1ThB2pCanYhArG7jTUUYjnSy": "pro",
  "price_1ThB3ACanYhArG7jDp33W6xS": "elite",
};

async function updateProfileByCustomer(customerId: string, fields: Record<string, unknown>): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .update(fields)
    .eq("stripe_customer_id", customerId)
    .select("id")
    .single();
  return data?.id ?? null;
}

async function notifyAdmin(payload: { event: "signup" | "purchase"; email: string; tier?: string }) {
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/notify-admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("notifyAdmin failed:", err);
  }
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
      const tier = PRICE_TIER[priceId];
      const fields: Record<string, unknown> = {
        subscription_status: sub.status,
        subscription_end_at: new Date(sub.current_period_end * 1000).toISOString(),
      };
      if (tier) fields.tier = tier;
      const id = await updateProfileByCustomer(customerId(session), fields);
      if (tier && session.customer_details?.email) {
        await notifyAdmin({ event: "purchase", email: session.customer_details.email, tier });
      }
      if (id) await logAccountEvent(supabaseAdmin, id, "subscription_started", { tier, provider: "stripe" });
      break;
    }

    case "customer.subscription.updated": {
      const raw = event.data.object as Stripe.Subscription;
      const sub = await stripe.subscriptions.retrieve(raw.id);
      const priceId = sub.items.data[0]?.price.id ?? "";
      const tier = PRICE_TIER[priceId];
      const cust = customerId(raw);

      const { data: before } = await supabaseAdmin
        .from("profiles")
        .select("id, tier")
        .eq("stripe_customer_id", cust)
        .single();

      const fields: Record<string, unknown> = {
        subscription_status: sub.status,
        subscription_end_at: new Date(sub.current_period_end * 1000).toISOString(),
      };
      if (tier) fields.tier = tier;
      await updateProfileByCustomer(cust, fields);

      if (before && tier && tier !== before.tier) {
        await logAccountEvent(supabaseAdmin, before.id, "tier_changed", { from: before.tier, to: tier, provider: "stripe" });
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const id = await updateProfileByCustomer(customerId(sub), {
        tier:                "free",
        subscription_status: "canceled",
        subscription_end_at: null,
      });
      if (id) await logAccountEvent(supabaseAdmin, id, "subscription_canceled", { provider: "stripe" });
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.subscription) {
        const sub = await stripe.subscriptions.retrieve(invoice.subscription as string);
        const priceId = sub.items.data[0]?.price.id ?? "";
        const tier = PRICE_TIER[priceId];
        const fields: Record<string, unknown> = {
          subscription_status: sub.status,
          subscription_end_at: new Date(sub.current_period_end * 1000).toISOString(),
        };
        if (tier) fields.tier = tier;
        const id = await updateProfileByCustomer(customerId(sub), fields);
        if (id) {
          await logAccountEvent(supabaseAdmin, id, "payment_succeeded", {
            tier, provider: "stripe", amount: invoice.amount_paid, currency: invoice.currency,
          });
        }
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const id = await updateProfileByCustomer(customerId(invoice), {
        subscription_status: "past_due",
      });
      if (id) await logAccountEvent(supabaseAdmin, id, "payment_failed", { provider: "stripe" });
      break;
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
