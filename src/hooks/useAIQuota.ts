import { useState, useCallback, useEffect, useMemo } from "react";
import { useAuth } from "../contexts/AuthContext";
import { supabase, Tier } from "../services/supabase";

const TIER_LIMITS: Record<Tier, number> = { free: 0, pro: 70, elite: Infinity };

function getWeekKey(): string {
  const now  = new Date();
  const day  = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon  = new Date(now);
  mon.setDate(now.getDate() + diff);
  return mon.toISOString().slice(0, 10);
}

export function useAIQuota() {
  const { tier, profile } = useAuth();
  const [localUsed, setLocalUsed] = useState<number | null>(null);

  // Memoize weekKey so it doesn't recreate consume() on every render
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

    const next = current + 1;
    setLocalUsed(next); // Optimistic increment

    if (profile?.id) {
      const { error } = await supabase
        .from("profiles")
        .update({ ai_requests_used: next, ai_requests_week: weekKey })
        .eq("id", profile.id);

      if (error) {
        console.error("AI quota sync failed:", error.message);
        setLocalUsed(current); // Rollback on failure
        return false;
      }
    }

    return true;
  }, [localUsed, profileUsed, limit, weekKey, profile]);

  return { exceeded, remaining, used, limit, consume, isPaid };
}
