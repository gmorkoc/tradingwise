import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// PKCE flow is required for the native Google sign-in redirect (a custom
// URL scheme, not a page load) — the default implicit flow only works
// when Supabase can read tokens back out of window.location itself.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { flowType: "pkce" },
});

export type Tier = "free" | "pro" | "elite";

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  username: string | null;
  tier: Tier;
  stripe_customer_id: string | null;
  subscription_status: string;
  subscription_end_at: string | null;
  created_at: string;
  ai_requests_used: number;
  ai_requests_week: string | null;
  trader_level: string | null;
  terms_agreed_at: string | null;
  alert_sound: string;
  notify_daily_brief: boolean;
  notify_price_alerts: boolean;
  notify_upgrade_reminders: boolean;
  notify_strategy_alerts: boolean;
  notify_breaking_news: boolean;
  notify_buy_signals: boolean;
  notify_sell_signals: boolean;
  signal_muted_coins: string[];
  signal_min_confidence: "low" | "medium" | "high";
  avatar_url: string | null;
}

export const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, elite: 2 };

export function hasAccess(userTier: Tier, required: Tier): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[required];
}

// Which payment processor actually owns a paid subscription — the
// RevenueCat (Apple IAP) webhook never sets stripe_customer_id, so its
// presence reliably distinguishes the two. Used to stop a user from trying
// to upgrade/downgrade/cancel from the platform that *didn't* sell them
// the subscription (web vs iOS use entirely separate billing systems with
// no visibility into each other).
export type SubscriptionProvider = "stripe" | "apple";

export function subscriptionProvider(profile: Profile | null, tier: Tier): SubscriptionProvider | null {
  if (tier === "free") return null;
  return profile?.stripe_customer_id ? "stripe" : "apple";
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
    const base = {
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
      terms_agreed_at: null,
    };
    const username = (user?.user_metadata?.username as string | undefined) ?? null;

    let { data: created, error: insertError } = await supabase
      .from("profiles")
      .insert({ ...base, username })
      .select()
      .single();

    // 23505 (unique_violation) fires for TWO different reasons here, and
    // they need different recoveries:
    //  1. This same row already exists — AuthContext.tsx calls loadProfile
    //     from both its mount-time getSession() and its onAuthStateChange
    //     handler (which Supabase also fires once on subscribe), so on a
    //     brand-new signup both fire concurrently and race to insert the
    //     same `id`. The loser must NOT treat this as "username taken" and
    //     silently drop it — that was the actual bug (the signup form's
    //     username never reappearing was this call winning the race with
    //     a username-less fallback insert). Re-select the row the winner
    //     already created instead — it has the real username.
    //  2. The username itself collided with a different user's row
    //     (its own `id` is genuinely new) — the signup form's real-time
    //     check makes this vanishingly rare, but if it happens the user
    //     should still end up with *a* profile row rather than none, so
    //     this one retries the insert without the username.
    if (insertError?.code === "23505") {
      const { data: existing } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
      if (existing) {
        created = existing;
      } else {
        ({ data: created } = await supabase.from("profiles").insert(base).select().single());
      }
    }

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

export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

// Backed by a SECURITY DEFINER function (not a plain select) so this works
// for an anonymous, mid-signup caller without exposing any other profile
// row's data — see the profile_username migration.
export async function isUsernameAvailable(username: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_username_available", { check_username: username });
  if (error) { console.error("isUsernameAvailable failed:", error.message); return false; }
  return !!data;
}

export async function saveUsername(userId: string, username: string): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ username })
    .eq("id", userId);
  if (error) throw new Error(error.code === "23505" ? "That username is already taken." : error.message);
}

// One object per user at a flat path equal to their own uid (see the
// avatars bucket's storage.objects RLS policies) — upsert overwrites it in
// place on every re-upload rather than accumulating old files. The public
// URL is stable, so a cache-busting query param is appended for the
// caller to store, otherwise browsers/WKWebView keep showing the old
// photo after a re-upload since the URL itself never changes.
export async function uploadAvatar(userId: string, file: Blob, contentType: string): Promise<string> {
  const { error: uploadError } = await supabase.storage
    .from("avatars")
    .upload(userId, file, { contentType, upsert: true });
  if (uploadError) throw new Error(uploadError.message);

  const { data } = supabase.storage.from("avatars").getPublicUrl(userId);
  return `${data.publicUrl}?t=${Date.now()}`;
}

export async function saveAvatarUrl(userId: string, url: string): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ avatar_url: url })
    .eq("id", userId);
  if (error) throw new Error(error.message);
}

export const ALERT_SOUNDS = ["bell", "chime", "alert", "classic"] as const;
export type AlertSound = typeof ALERT_SOUNDS[number];

export async function saveAlertSound(userId: string, sound: AlertSound): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ alert_sound: sound })
    .eq("id", userId);
  if (error) throw new Error(error.message);
}

export type NotificationPrefKey = "notify_daily_brief" | "notify_price_alerts" | "notify_upgrade_reminders" | "notify_strategy_alerts" | "notify_breaking_news" | "notify_buy_signals" | "notify_sell_signals";

export async function saveNotificationPref(userId: string, key: NotificationPrefKey, value: boolean): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ [key]: value })
    .eq("id", userId);
  if (error) throw new Error(error.message);
}

export async function saveSignalMinConfidence(userId: string, value: "low" | "medium" | "high"): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ signal_min_confidence: value })
    .eq("id", userId);
  if (error) throw new Error(error.message);
}

// Toggle a single coin in/out of signal_muted_coins — read-modify-write
// rather than a set column update, since Postgres array append/remove
// needs the current array anyway and this keeps the call site a one-liner
// (used from both the Buy Signals panel's per-card mute button and the
// push toast's own "Mute this coin" action).
export async function toggleMutedSignalCoin(userId: string, coin: string, currentMuted: string[]): Promise<string[]> {
  const next = currentMuted.includes(coin)
    ? currentMuted.filter((c) => c !== coin)
    : [...currentMuted, coin];
  const { error } = await supabase
    .from("profiles")
    .update({ signal_muted_coins: next })
    .eq("id", userId);
  if (error) throw new Error(error.message);
  return next;
}

export interface AccountEvent {
  id: number;
  type: string;
  detail: Record<string, any> | null;
  created_at: string;
}

// Written by the Stripe/RevenueCat webhooks and the cancel/reactivate/upgrade
// edge functions (see supabase/functions/_shared/accountEvents.ts) — shown
// in the Profile → Activity tab.
export async function fetchAccountEvents(userId: string): Promise<AccountEvent[]> {
  const { data, error } = await supabase
    .from("account_events")
    .select("id, type, detail, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) { console.error("fetchAccountEvents failed:", error.message); return []; }
  return data ?? [];
}

export async function saveTermsAgreement(userId: string, agreedAt: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("profiles")
    .update({ terms_agreed_at: agreedAt })
    .eq("id", userId);
  if (error) console.error("saveTermsAgreement failed:", error.message);
  return { error: error?.message ?? null };
}
