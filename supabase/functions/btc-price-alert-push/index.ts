import { supabaseAdmin, getAccessToken, sendPush, getSoundsByUser } from "../_shared/fcm.ts";

// Server-side twin of useBtcMoveAlert.ts's anchor/threshold logic, but with
// a much larger threshold since this fires a push notification (interrupts
// the user even with the app closed) rather than an in-app toast. Runs on a
// cron schedule (see the pg_cron job set up in the matching migration) since
// there's no client tab open to poll from.
const THRESHOLD = 250;

const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

// Binance's REST API 451s from some cloud regions (including, apparently,
// wherever Supabase runs edge functions) — Coinbase's public spot price
// endpoint doesn't have that restriction, and works for any coin ticker.
const priceCache = new Map<string, number>();
async function getPrice(coin: string): Promise<number | null> {
  if (priceCache.has(coin)) return priceCache.get(coin)!;
  try {
    const res = await fetch(`https://api.coinbase.com/v2/prices/${coin}-USD/spot`);
    if (!res.ok) return null;
    const { data } = await res.json();
    const price = parseFloat(data.amount);
    priceCache.set(coin, price);
    return price;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  // verify_jwt is off for this function (see supabase/config.toml) since its
  // only caller is the pg_cron job, not a signed-in client — this header is
  // the substitute check.
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const btcPrice = await getPrice("BTC");
  if (btcPrice == null) return new Response("Failed to fetch BTC price", { status: 502 });

  let accessToken: string | null = null;
  const ensureAccessToken = async () => accessToken ??= await getAccessToken();

  // --- Flat $50 BTC move alert (server-side twin of useBtcMoveAlert.ts) ---
  let btcResult: Record<string, unknown> = { price: btcPrice, moved: false };
  {
    const { data: state } = await supabaseAdmin
      .from("btc_price_alert_state")
      .select("anchor_price")
      .eq("id", 1)
      .single();

    const anchor = state?.anchor_price;
    if (anchor == null) {
      await supabaseAdmin.from("btc_price_alert_state").update({ anchor_price: btcPrice, updated_at: new Date().toISOString() }).eq("id", 1);
      btcResult = { price: btcPrice, moved: false, reason: "anchor initialized" };
    } else if (Math.abs(btcPrice - anchor) >= THRESHOLD) {
      const diff = btcPrice - anchor;
      await supabaseAdmin.from("btc_price_alert_state").update({ anchor_price: btcPrice, updated_at: new Date().toISOString() }).eq("id", 1);

      const { data: tokens } = await supabaseAdmin.from("device_push_tokens").select("token, user_id");
      if (tokens && tokens.length > 0) {
        const direction = diff > 0 ? "up" : "down";
        const title = `BTC ${direction === "up" ? "▲" : "▼"} $${Math.round(btcPrice).toLocaleString("en-US")}`;
        const body = `${direction === "up" ? "+" : "-"}$${Math.round(Math.abs(diff)).toLocaleString("en-US")} move`;
        const soundByUser = await getSoundsByUser(tokens.map(t => t.user_id));
        const token = await ensureAccessToken();
        const results = await Promise.all(tokens.map(({ token: t, user_id }) => sendPush(token, t, title, body, soundByUser.get(user_id) ?? "bell")));
        btcResult = { price: btcPrice, moved: true, sent: results.filter(Boolean).length, total: tokens.length };
      } else {
        btcResult = { price: btcPrice, moved: true, sent: 0 };
      }
    }
  }

  // --- User-set target price alerts, any coin (server-side twin of the
  // localStorage alerts in PriceAlerts.tsx — "has the price reached the
  // target" rather than PriceAlerts.tsx's exact crossing check, since this
  // only samples once a minute) ---
  const { data: pending } = await supabaseAdmin
    .from("price_alerts")
    .select("id, user_id, coin, target_price, direction")
    .eq("triggered", false);

  let userAlertsFired = 0;
  for (const alert of pending ?? []) {
    const price = alert.coin === "BTC" ? btcPrice : await getPrice(alert.coin);
    if (price == null) continue;
    const hit = alert.direction === "above" ? price >= alert.target_price : price <= alert.target_price;
    if (!hit) continue;

    await supabaseAdmin.from("price_alerts").update({ triggered: true }).eq("id", alert.id);

    const { data: userTokens } = await supabaseAdmin.from("device_push_tokens").select("token").eq("user_id", alert.user_id);
    if (!userTokens || userTokens.length === 0) continue;

    const { data: userProfile } = await supabaseAdmin.from("profiles").select("alert_sound").eq("id", alert.user_id).single();
    const title = `${alert.coin} ${alert.direction === "above" ? "▲" : "▼"} $${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const body = `${alert.direction === "above" ? "Went above" : "Dropped below"} your $${alert.target_price.toLocaleString("en-US", { maximumFractionDigits: 2 })} alert`;
    const token = await ensureAccessToken();
    await Promise.all(userTokens.map(({ token: t }) => sendPush(token, t, title, body, userProfile?.alert_sound ?? "bell")));
    userAlertsFired++;
  }

  return new Response(JSON.stringify({ btc: btcResult, userAlertsFired }), { headers: { "Content-Type": "application/json" } });
});
