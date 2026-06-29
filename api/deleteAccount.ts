import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOWED_ORIGINS = ["https://www.coinhintz.io", "https://coinhintz.io", "http://localhost:5173", "http://localhost:4173"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin ?? "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl    = process.env.VITE_SUPABASE_URL ?? "";
  const anonKey        = process.env.VITE_SUPABASE_ANON_KEY ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const stripeKey      = process.env.STRIPE_SECRET_KEY ?? "";

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return res.status(500).json({ error: `Missing env vars: url=${!!supabaseUrl} anon=${!!anonKey} srk=${!!serviceRoleKey}` });
  }

  const authHeader = (req.headers["authorization"] ?? "") as string;
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = authHeader.slice(7);

  try {
    // 1. Verify user identity
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Invalid or expired session" });

    const userData = (await userRes.json()) as { id?: string };
    if (!userData.id) return res.status(401).json({ error: "Could not identify user" });

    // 2. Fetch profile to get Stripe customer ID
    if (stripeKey) {
      const profileRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${userData.id}&select=stripe_customer_id`,
        { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
      );
      if (profileRes.ok) {
        const [profile] = (await profileRes.json()) as Array<{ stripe_customer_id?: string }>;
        const customerId = profile?.stripe_customer_id;

        if (customerId) {
          // 3. List all active subscriptions for this customer
          const subRes = await fetch(
            `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active&limit=10`,
            { headers: { Authorization: `Bearer ${stripeKey}` } }
          );
          if (subRes.ok) {
            const { data: subs } = (await subRes.json()) as { data: Array<{ id: string }> };
            // 4. Cancel each active subscription immediately (no refund, stops future charges)
            await Promise.all(
              subs.map(sub =>
                fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
                  method: "DELETE",
                  headers: { Authorization: `Bearer ${stripeKey}` },
                })
              )
            );
          }
        }
      }
    }

    // 5. Delete the Supabase auth user (cascades to profiles via DB trigger)
    const deleteRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userData.id}`, {
      method: "DELETE",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });

    if (!deleteRes.ok) {
      const body = await deleteRes.text();
      return res.status(500).json({ error: `Supabase error: ${body}` });
    }

    return res.status(200).json({ success: true });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
}
