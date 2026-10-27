// Every 5 min (pg_cron, migration 20261026130000): scan Hyperliquid's top
// traders (_shared/hlTopTraders.ts) and replace public.hl_top_traders with
// their current open positions. The Trade page's "Top Traders" tab reads
// that table directly. verify_jwt is off; the cron sends x-cron-secret.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scanTopTraders } from "../_shared/hlTopTraders.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const runAt = new Date().toISOString();
  try {
    const rows = await scanTopTraders();
    const stamped = rows.map((r) => ({ ...r, updated_at: runAt }));
    for (let i = 0; i < stamped.length; i += 500) {
      const { error } = await admin.from("hl_top_traders").upsert(stamped.slice(i, i + 500), { onConflict: "coin,address" });
      if (error) throw error;
    }
    // Positions no longer open (not in this run) are removed.
    await admin.from("hl_top_traders").delete().lt("updated_at", runAt);
    return new Response(JSON.stringify({ ok: true, rows: rows.length }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("hl-top-traders failed:", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
});
