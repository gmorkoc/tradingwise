// Server-side AI limits — the browser no longer counts or writes usage.
//
//   Weekly quota (Pro 100 / week, Elite unlimited but still tracked, Free 0)
//     → profiles.ai_requests_used / ai_requests_week, bumped atomically by
//       try_increment_ai_quota (service role only). Same Monday-UTC week key
//       as src/hooks/useAIQuota.ts and api/openai.ts.
//   Rate limit (per user, per feature, per time window)
//     → try_ai_rate_limit, for the cheap/free or Elite-unlimited endpoints
//       so one account can't run up the OpenAI bill.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const PRO_WEEKLY_AI_LIMIT = 100;
// Elite is unlimited; a huge cap keeps usage tracked through the same RPC.
const ELITE_TRACKING_LIMIT = 1_000_000_000;

/** Monday (UTC) of the current week, e.g. "2026-10-26". */
export function aiWeekKey(now = new Date()): string {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
  return monday.toISOString().slice(0, 10);
}

/** Count one AI request against the user's weekly quota. false = over the limit. */
export async function consumeAiQuota(admin: SupabaseClient, userId: string, tier: string | null | undefined): Promise<boolean> {
  const limit = tier === "elite" ? ELITE_TRACKING_LIMIT : tier === "pro" ? PRO_WEEKLY_AI_LIMIT : 0;
  if (limit <= 0) return false;
  const { data, error } = await admin.rpc("try_increment_ai_quota", {
    p_user_id: userId,
    p_day_key: aiWeekKey(),
    p_limit: limit,
  });
  if (error) {
    console.error("try_increment_ai_quota failed:", error.message);
    return false;
  }
  return data === true;
}

/** Allow at most `max` calls per `windowSeconds` for this user + bucket. */
export async function aiRateLimit(
  admin: SupabaseClient,
  userId: string,
  bucket: string,
  windowSeconds: number,
  max: number,
): Promise<boolean> {
  const { data, error } = await admin.rpc("try_ai_rate_limit", {
    p_user_id: userId,
    p_bucket: bucket,
    p_window_seconds: windowSeconds,
    p_max: max,
  });
  if (error) {
    console.error("try_ai_rate_limit failed:", error.message);
    return false;
  }
  return data === true;
}

export function limitResponse(message: string, corsHeaders: Record<string, string>, status = 429): Response {
  return new Response(JSON.stringify({ error: message, code: status === 429 ? "ai_limit" : "forbidden" }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
