// Web Push (browser) sending — the equivalent of _shared/fcm.ts, but for
// plain web browsers via the standard Push API/VAPID protocol instead of
// Firebase. Uses the `web-push` npm package (via Deno's npm: compat) rather
// than hand-rolling RFC 8291's ECDH+HKDF+aes128gcm encoding.
import webpush from "npm:web-push@3.6.7";
import { supabaseAdmin } from "./fcm.ts";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:support@coinhintz.io";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

interface WebPushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function sendWebPush(
  sub: WebPushSubscriptionRow,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  try {
    const res = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({ title, body, data: data ?? {} }),
    );
    return { ok: true, statusCode: res.statusCode };
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const message = (err as { body?: string; message?: string })?.body ?? (err as Error)?.message ?? String(err);
    // 404/410 = the browser dropped this subscription (uninstalled,
    // cleared site data, expired) — stale row, delete it so future runs
    // stop paying to retry it. Same cleanup pattern as sendPush in fcm.ts.
    if (statusCode === 404 || statusCode === 410) {
      await supabaseAdmin.from("web_push_subscriptions").delete().eq("endpoint", sub.endpoint);
    } else {
      console.error("Web push send failed:", statusCode, message);
    }
    return { ok: false, statusCode, error: message };
  }
}

export async function getWebPushSubscriptions(userId: string): Promise<WebPushSubscriptionRow[]> {
  const { data } = await supabaseAdmin.from("web_push_subscriptions").select("endpoint, p256dh, auth").eq("user_id", userId);
  return data ?? [];
}
