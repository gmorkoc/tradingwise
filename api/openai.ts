import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const TIER_LIMITS: Record<string, number> = { free: 0, pro: 70, elite: Infinity };

function getWeekKey(): string {
  const now  = new Date();
  const day  = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon  = new Date(now);
  mon.setDate(now.getDate() + diff);
  return mon.toISOString().slice(0, 10);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin  = req.headers.origin ?? "";
  const allowed = ["https://www.coinhintz.io", "http://localhost:5173", "http://localhost:4173"];
  res.setHeader("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  // ── 1. Require bearer token ───────────────────────────────────────────────
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });

  // ── 2. Verify token & load profile via service-role client ───────────────
  const supabaseUrl  = process.env.SUPABASE_URL;
  const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey)
    return res.status(500).json({ error: "Server configuration error" });

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user)
    return res.status(401).json({ error: "Invalid or expired session" });

  const { data: profile } = await admin
    .from("profiles")
    .select("tier, ai_requests_used, ai_requests_week")
    .eq("id", user.id)
    .single();

  // ── 3. Tier gate — free users blocked ────────────────────────────────────
  const tier  = (profile?.tier ?? "free") as string;
  const limit = TIER_LIMITS[tier] ?? 0;

  if (tier === "free")
    return res.status(403).json({ error: "Pro subscription required for AI features" });

  // ── 4. Quota gate (Elite is unlimited) ───────────────────────────────────
  if (tier !== "elite") {
    const weekKey = getWeekKey();
    const used    = profile?.ai_requests_week === weekKey ? (profile?.ai_requests_used ?? 0) : 0;
    if (used >= limit)
      return res.status(429).json({ error: "Weekly AI quota exceeded. Upgrade to Elite for unlimited access." });
  }

  // ── 5. Forward to OpenAI ─────────────────────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OpenAI API key not configured on server" });

  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(req.body),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch {
    res.status(502).json({ error: "OpenAI request failed" });
  }
}
