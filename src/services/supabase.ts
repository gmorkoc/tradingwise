import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

export type Tier = "free" | "pro" | "elite";

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  tier: Tier;
  stripe_customer_id: string | null;
  subscription_status: string;
  subscription_end_at: string | null;
  created_at: string;
  ai_requests_used: number;
  ai_requests_week: string | null;
  trader_level: string | null;
}

export const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, elite: 2 };

export function hasAccess(userTier: Tier, required: Tier): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[required];
}

export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (!error) return data as Profile;

  // Row missing — bootstrap a free profile so tier/quota tracking works
  if (error.code === "PGRST116") {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: created } = await supabase
      .from("profiles")
      .insert({
        id: userId,
        email: user?.email ?? "",
        full_name: user?.user_metadata?.full_name ?? "",
        tier: "free",
        subscription_status: "none",
        ai_requests_used: 0,
        ai_requests_week: null,
        stripe_customer_id: null,
        subscription_end_at: null,
        trader_level: null,
      })
      .select()
      .single();
    return created as Profile | null;
  }

  return null;
}

export async function saveTraderLevel(userId: string, level: string): Promise<void> {
  await supabase
    .from("profiles")
    .update({ trader_level: level })
    .eq("id", userId);
}
