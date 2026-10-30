import type { VercelRequest, VercelResponse } from "@vercel/node";

// Weekly limits — same numbers and week key as src/hooks/useAIQuota.ts and
// supabase/functions/_shared/aiLimits.ts (the server is the only counter).
// Elite is unlimited; the large cap just keeps its usage tracked.
const TIER_LIMITS: Record<string, number> = { free: 0, pro: 100, elite: 1_000_000_000 };

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o":      { input: 2.50,  output: 10.00 },
  "gpt-4o-mini": { input: 0.15,  output: 0.60  },
};

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["gpt-4o"];
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

// Monday (UTC) of the current week — the quota resets weekly.
function getWeekKey(): string {
  const now = new Date();
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
  return monday.toISOString().slice(0, 10);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin  = req.headers.origin ?? "";
  // capacitor://localhost is the native iOS app's real Origin header — see
  // api/deleteAccount.ts for why this has to be here.
  const allowed = ["https://www.coinhintz.io", "https://coinhintz.io", "capacitor://localhost", "http://localhost:5173", "http://localhost:4173"];
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

  // ── 3. Fetch profile tier ────────────────────────────────────────────────
  let tier = "free";
  if (serviceKey) {
    try {
      const profileRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=tier`,
        { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } }
      );
      if (profileRes.ok) {
        const [profile] = await profileRes.json();
        if (profile) tier = profile.tier ?? "free";
      }
    } catch { /* fallback to free */ }
  }

  // ── 4. Tier gate ─────────────────────────────────────────────────────────
  if (tier === "free")
    return res.status(403).json({ error: "Pro subscription required for AI features" });

  // ── 5. Atomic quota check + increment (Pro 100/week, Elite tracked) ───────
  {
    if (!serviceKey)
      return res.status(500).json({ error: "Server misconfigured" });

    const limit = TIER_LIMITS[tier] ?? 0;
    try {
      const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/try_increment_ai_quota`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_user_id: userId, p_day_key: getWeekKey(), p_limit: limit }),
      });
      const allowed = rpcRes.ok ? await rpcRes.json() : false;
      if (allowed !== true)
        return res.status(429).json({ error: "Weekly AI limit reached. It resets on Monday, or go Elite for unlimited." });
    } catch {
      return res.status(500).json({ error: "Quota check failed" });
    }
  }

  // ── 6. Forward to OpenAI ─────────────────────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OpenAI API key not configured" });

  // Only the models the app uses, and a sane answer size — the browser can't
  // pick an expensive model or ask for a huge response on our key.
  const ALLOWED_MODELS = new Set(Object.keys(MODEL_PRICING));
  const MAX_TOKENS_CAP = 1500;
  const body = { ...(req.body ?? {}) };
  if (!ALLOWED_MODELS.has(body.model)) body.model = "gpt-4o-mini";
  const asked = Number(body.max_tokens ?? body.max_completion_tokens);
  body.max_tokens = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_TOKENS_CAP) : 800;
  delete body.max_completion_tokens;
  if (Number(body.n) > 1) body.n = 1;
  delete body.stream;

  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);

    // Log usage async — don't block the response
    if (upstream.ok && data.usage && serviceKey) {
      const model        = data.model ?? req.body?.model ?? "gpt-4o";
      const inputTokens  = data.usage.prompt_tokens     ?? 0;
      const outputTokens = data.usage.completion_tokens ?? 0;
      const costUsd      = calcCost(model, inputTokens, outputTokens);

      fetch(`${supabaseUrl}/rest/v1/ai_usage_log`, {
        method: "POST",
        headers: {
          Authorization:  `Bearer ${serviceKey}`,
          apikey:         serviceKey,
          "Content-Type": "application/json",
          Prefer:         "return=minimal",
        },
        body: JSON.stringify({ user_id: userId, model, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd }),
      }).catch(() => {/* ignore logging errors */});
    }
  } catch {
    res.status(502).json({ error: "OpenAI request failed" });
  }
}
