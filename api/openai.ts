import type { VercelRequest, VercelResponse } from "@vercel/node";

const TIER_LIMITS: Record<string, number> = { free: 0, pro: 25, elite: Infinity };

function getDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin  = req.headers.origin ?? "";
  const allowed = ["https://www.coinhintz.io", "https://coinhintz.io", "http://localhost:5173", "http://localhost:4173"];
  res.setHeader("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-Handler-Version", "2"); // sentinel to confirm new code is running

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  // ── 1. Require bearer token ───────────────────────────────────────────────
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });

  // ── 2. Verify token via Supabase REST (no SDK dependency) ────────────────
  const supabaseUrl  = process.env.SUPABASE_URL      || process.env.VITE_SUPABASE_URL;
  const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey      = process.env.SUPABASE_ANON_KEY  || process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl) return res.status(500).json({ error: "SUPABASE_URL not configured" });

  // Verify JWT — works with either service key or anon key
  const authKey = serviceKey || anonKey;
  if (!authKey)  return res.status(500).json({ error: "Supabase key not configured" });

  let userId: string;
  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: authKey },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Invalid or expired session" });
    const userData = await userRes.json();
    if (!userData?.id) return res.status(401).json({ error: "Invalid session" });
    userId = userData.id;
  } catch {
    return res.status(401).json({ error: "Session verification failed" });
  }

  // ── 3. Fetch profile and check tier ──────────────────────────────────────
  let tier = "free";
  let profileUsed = 0;
  let profileWeek: string | null = null;

  if (serviceKey) {
    try {
      const profileRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=tier,ai_requests_used,ai_requests_week`,
        { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } }
      );
      if (profileRes.ok) {
        const [profile] = await profileRes.json();
        if (profile) {
          tier        = profile.tier        ?? "free";
          profileUsed = profile.ai_requests_used  ?? 0;
          profileWeek = profile.ai_requests_week  ?? null;
        }
      }
    } catch { /* fallback to free */ }
  }

  // ── 4. Tier gate ─────────────────────────────────────────────────────────
  if (tier === "free")
    return res.status(403).json({ error: "Pro subscription required for AI features" });

  // ── 5. Quota gate (Elite unlimited) ──────────────────────────────────────
  const dayKey = getDayKey();
  let usedToday = 0;
  if (tier !== "elite") {
    const limit = TIER_LIMITS[tier] ?? 0;
    usedToday   = profileWeek === dayKey ? profileUsed : 0;
    if (usedToday >= limit)
      return res.status(429).json({ error: "Daily AI quota exceeded. Upgrade to Elite for unlimited access." });
  }

  // ── 6. Forward to OpenAI ─────────────────────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OpenAI API key not configured" });

  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();

    // ── 7. Increment quota server-side (Pro only) ─────────────────────────
    if (upstream.ok && tier !== "elite" && serviceKey) {
      const nextUsed = usedToday + 1;
      fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ ai_requests_used: nextUsed, ai_requests_week: dayKey }),
        }
      ).catch(() => {});
    }

    res.status(upstream.status).json(data);
  } catch {
    res.status(502).json({ error: "OpenAI request failed" });
  }
}
