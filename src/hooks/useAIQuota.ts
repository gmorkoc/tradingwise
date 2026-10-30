import { useState, useCallback, useEffect, useMemo } from "react";
import { useAuth } from "../contexts/AuthContext";
import type { Tier } from "../services/supabase";

const TIER_LIMITS: Record<Tier, number> = { free: 0, pro: 100, elite: Infinity };

// ai_requests_week has always been named for a weekly reset, but this used
// to just be today's date — so usage actually reset every day, not once a
// week, despite every "X AI requests/week" the UI has ever shown. This
// returns the Monday (UTC) of the current week instead, a stable key that
// only changes once every 7 days, so profile.ai_requests_week finally
// means what it's always said it means.
function getWeekKey(): string {
  const now = new Date();
  const daysSinceMonday = (now.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
  return monday.toISOString().slice(0, 10);
}

// The server counts usage now (api/openai.ts and the AI edge functions call
// try_increment_ai_quota with this same week key); clients can no longer
// write ai_requests_used. This hook only reads the count, bumps it
// optimistically for the UI, and re-syncs from the profile shortly after.
export function useAIQuota() {
  const { tier, profile, refreshProfile } = useAuth();
  const [localUsed, setLocalUsed] = useState<number | null>(null);

  const weekKey = useMemo(() => getWeekKey(), []);

  const limit       = TIER_LIMITS[tier] ?? 5;
  const profileUsed = (profile?.ai_requests_week === weekKey)
    ? (profile?.ai_requests_used ?? 0)
    : 0;

  const used      = localUsed ?? profileUsed;
  const isPaid    = tier === "pro" || tier === "elite";
  const exceeded  = tier !== "elite" && used >= limit;
  const remaining = tier === "elite" ? Infinity : Math.max(0, limit - used);

  // Reset local override when Supabase profile syncs
  useEffect(() => {
    setLocalUsed(null);
  }, [profile?.ai_requests_used, profile?.ai_requests_week]);

  const consume = useCallback(async (): Promise<boolean> => {
    const current = localUsed ?? profileUsed;
    // Elite: Infinity limit, never blocked — but still tracks usage
    if (current >= limit) return false;

    setLocalUsed(current + 1); // Optimistic — the server does the real count

    // Pull the server's count once the request has had time to land.
    if (profile?.id) window.setTimeout(() => { void refreshProfile(); }, 4000);

    return true;
  }, [localUsed, profileUsed, limit, profile, refreshProfile]);

  return { exceeded, remaining, used, limit, consume, isPaid };
}
