import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shared by market-pulse-bot (15-min broadcast) and market-pulse-reply
// (answers questions asked in chat) — one bot identity, provisioned once.
export const BOT_USERNAME = "MarketPulse";
const BOT_EMAIL = "marketpulse-bot@coinhintz.internal";

export const supabaseAdmin: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Idempotent: reuses the bot's existing profile row after the first call,
// from either function — whichever runs first provisions it for both.
export async function getOrCreateBotId(): Promise<string> {
  const { data: existing } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("username", BOT_USERNAME)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email: BOT_EMAIL,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (createErr || !created.user) {
    throw new Error(`Failed to create bot auth user: ${createErr?.message}`);
  }

  const { error: upsertErr } = await supabaseAdmin.from("profiles").upsert({
    id: created.user.id,
    email: BOT_EMAIL,
    full_name: "Market Pulse",
    username: BOT_USERNAME,
    tier: "elite",
    is_bot: true,
    // Vector, not the raster icon-192.png — a small chat avatar downscaled
    // from a 192px PNG read as noticeably blurry; the SVG stays crisp.
    avatar_url: "/icon.svg",
  });
  if (upsertErr) throw new Error(`Failed to upsert bot profile: ${upsertErr.message}`);

  return created.user.id;
}
