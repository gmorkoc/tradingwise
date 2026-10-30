// ProVision — a standalone $99/yr plan that lives NEXT TO the Pro/Elite tier,
// never instead of it. It has its own columns on profiles
// (provision_status / provision_end_at / provision_stripe_sub_id), so
// buying, renewing, cancelling or expiring ProVision must never touch
// `tier` or `subscription_*`, and vice versa.
import type Stripe from "https://esm.sh/stripe@14.21.0";

/** Stripe price ID(s) for the ProVision plan (yearly). */
export function provisionPriceIds(): Set<string> {
  return new Set(
    [Deno.env.get("STRIPE_PROVISION_PRICE_ID") ?? ""].filter(Boolean),
  );
}

/** Is this Stripe subscription the ProVision plan (not a Pro/Elite tier)? */
export function isProvisionSub(sub: Stripe.Subscription): boolean {
  const ids = provisionPriceIds();
  return sub.items.data.some((it) => ids.has(it.price.id));
}

/** profiles columns for a ProVision subscription's current state. */
export function provisionFields(sub: Stripe.Subscription): Record<string, unknown> {
  return {
    provision_status: sub.status,
    provision_end_at: new Date(sub.current_period_end * 1000).toISOString(),
    provision_stripe_sub_id: sub.id,
  };
}

/** RevenueCat entitlement identifier for ProVision. */
export const PROVISION_ENTITLEMENT = "provision";

/**
 * Pick the customer's Pro/Elite subscription, skipping ProVision — for the
 * functions that used to assume one subscription per customer
 * (upgrade / preview / cancel / reactivate / reconcile).
 */
export function tierSubOnly<T extends Stripe.Subscription>(subs: T[]): T | undefined {
  return subs.find((s) => !isProvisionSub(s));
}
