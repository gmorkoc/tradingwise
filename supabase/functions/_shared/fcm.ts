import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shared by every push-sending edge function (btc-price-alert-push,
// daily-brief-push) — one Firebase JWT-signing + FCM-send implementation
// instead of copies drifting apart.

const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID")!;
const FIREBASE_SERVICE_ACCOUNT_JSON = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON")!;

export const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const byte of b) str += String.fromCharCode(byte);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function getAccessToken(): Promise<string> {
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

// `sound` is the name (no extension) of a .wav file bundled at the iOS app's
// bundle root (ios/App/App/Sounds/*.wav, added as individual Resources —
// apns.payload.aps.sound only resolves a plain filename at the bundle root,
// not a nested path) — see src/utils/alertSound.ts for the matching web copy.
// `data` becomes the notification's tap payload — read via
// notificationActionPerformed in pushNotifications.ts.
export async function sendPush(
  accessToken: string, token: string, title: string, body: string, sound: string,
  data?: Record<string, string>
): Promise<boolean> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        apns: { payload: { aps: { sound: `${sound}.wav` } } },
        ...(data ? { data } : {}),
      },
    }),
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

export async function getSoundsByUser(userIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const { data } = await supabaseAdmin.from("profiles").select("id, alert_sound").in("id", unique);
  return new Map((data ?? []).map(p => [p.id, p.alert_sound]));
}
