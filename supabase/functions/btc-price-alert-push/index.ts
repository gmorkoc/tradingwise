import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Server-side twin of useBtcMoveAlert.ts's anchor/threshold logic, but with
// a much larger threshold since this fires a push notification (interrupts
// the user even with the app closed) rather than an in-app toast. Runs on a
// cron schedule (see the pg_cron job set up in the matching migration) since
// there's no client tab open to poll from.
const THRESHOLD = 50;

const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID")!;
const FIREBASE_SERVICE_ACCOUNT_JSON = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const byte of b) str += String.fromCharCode(byte);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(): Promise<string> {
  const sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string; token_uri: string };

  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const claims = base64url(new TextEncoder().encode(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  })));
  const unsigned = `${header}.${claims}`;

  const pemBody = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, "");
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Firebase token exchange failed: ${await res.text()}`);
  const { access_token } = await res.json();
  return access_token;
}

async function sendPush(accessToken: string, token: string, title: string, body: string): Promise<boolean> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: { token, notification: { title, body } } }),
  });
  // A token FCM no longer recognizes (app uninstalled, token expired) —
  // stale row, safe to delete so future runs stop paying to retry it.
  if (res.status === 404 || res.status === 400) {
    const err = await res.text();
    if (err.includes("UNREGISTERED") || err.includes("NOT_FOUND") || err.includes("INVALID_ARGUMENT")) {
      await supabaseAdmin.from("device_push_tokens").delete().eq("token", token);
    }
    return false;
  }
  return res.ok;
}

Deno.serve(async (req) => {
  // verify_jwt is off for this function (see supabase/config.toml) since its
  // only caller is the pg_cron job, not a signed-in client — this header is
  // the substitute check.
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Binance's REST API 451s from some cloud regions (including, apparently,
  // wherever Supabase runs edge functions) — Coinbase's public spot price
  // endpoint doesn't have that restriction.
  const priceRes = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  if (!priceRes.ok) return new Response("Failed to fetch BTC price", { status: 502 });
  const { data } = await priceRes.json();
  const price = parseFloat(data.amount);

  const { data: state } = await supabaseAdmin
    .from("btc_price_alert_state")
    .select("anchor_price")
    .eq("id", 1)
    .single();

  const anchor = state?.anchor_price;
  if (anchor == null) {
    await supabaseAdmin.from("btc_price_alert_state").update({ anchor_price: price, updated_at: new Date().toISOString() }).eq("id", 1);
    return new Response(JSON.stringify({ price, moved: false, reason: "anchor initialized" }), { headers: { "Content-Type": "application/json" } });
  }

  const diff = price - anchor;
  if (Math.abs(diff) < THRESHOLD) {
    return new Response(JSON.stringify({ price, moved: false }), { headers: { "Content-Type": "application/json" } });
  }

  await supabaseAdmin.from("btc_price_alert_state").update({ anchor_price: price, updated_at: new Date().toISOString() }).eq("id", 1);

  const { data: tokens } = await supabaseAdmin.from("device_push_tokens").select("token");
  if (!tokens || tokens.length === 0) {
    return new Response(JSON.stringify({ price, moved: true, sent: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  const direction = diff > 0 ? "up" : "down";
  const fmtPrice = Math.round(price).toLocaleString("en-US");
  const fmtChange = Math.round(Math.abs(diff)).toLocaleString("en-US");
  const title = `BTC ${direction === "up" ? "▲" : "▼"} $${fmtPrice}`;
  const body = `${direction === "up" ? "+" : "-"}$${fmtChange} move`;

  const accessToken = await getAccessToken();
  const results = await Promise.all(tokens.map(({ token }) => sendPush(accessToken, token, title, body)));
  const sent = results.filter(Boolean).length;

  return new Response(JSON.stringify({ price, moved: true, sent, total: tokens.length }), { headers: { "Content-Type": "application/json" } });
});
