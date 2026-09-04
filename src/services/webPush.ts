import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabase";

// Web Push (browser) — the equivalent of pushNotifications.ts's FCM/APNs
// pipeline, but for plain web browsers instead of the native iOS app.
// Native builds already have the real thing via FCM; this only matters on
// web, where nothing has ever delivered a notification outside an open tab.

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export function isWebPushAvailable(): boolean {
  return (
    !Capacitor.isNativePlatform() &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    !!VAPID_PUBLIC_KEY
  );
}

export function webPushPermission(): NotificationPermission | "unsupported" {
  if (!isWebPushAvailable()) return "unsupported";
  return Notification.permission;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function isWebPushSubscribed(): Promise<boolean> {
  if (!isWebPushAvailable()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub !== null;
  } catch {
    return false;
  }
}

/** Requests browser notification permission (if not already decided) and
 * creates/saves a push subscription for this user. Deliberately never
 * called automatically — browsers penalize sites that ask for notification
 * permission on load; call this from an explicit user action instead
 * (a button, not a page-load effect). */
export async function subscribeWebPush(userId: string): Promise<{ ok: boolean; error?: string }> {
  if (!isWebPushAvailable()) return { ok: false, error: "Not supported in this browser" };
  try {
    // Once a browser origin's permission is settled (either way),
    // requestPermission() resolves immediately with NO prompt shown — that's
    // the browser enforcing "don't re-ask," not a bug. "denied" specifically
    // can only be undone from the browser's own site settings; we can't
    // trigger that prompt again from code, so say so explicitly instead of
    // just failing silently.
    if (Notification.permission === "denied") {
      return { ok: false, error: "Notifications are blocked for this site — enable them in your browser's site settings, then try again." };
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, error: "Permission denied" };

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!) as BufferSource,
      });
    }

    const json = sub.toJSON();
    const { error } = await supabase.from("web_push_subscriptions").upsert({
      endpoint: json.endpoint,
      user_id: userId,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
      updated_at: new Date().toISOString(),
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Subscription failed" };
  }
}

let messageListenerInit = false;

/** Routes a tap on a web push notification the same way a native push tap
 * is routed (see pushNotifications.ts's notificationActionPerformed) — the
 * service worker forwards the notification's data payload here via
 * postMessage when it focuses/opens a tab, and this re-dispatches the exact
 * same CustomEvents App.tsx/PushToast.tsx already listen for, so both
 * platforms converge on one set of handlers. Call once at startup. */
export function initWebPushMessageRouting(): void {
  if (messageListenerInit || !("serviceWorker" in navigator)) return;
  messageListenerInit = true;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.source !== "web-push") return;
    const data = event.data.data as { type?: string; url?: string; coin?: string; commentId?: string; strategyId?: string } | undefined;
    if (data?.type === "daily_brief" && data.url) {
      window.open(data.url, "_blank");
    } else if (data?.type === "upgrade_reminder") {
      window.dispatchEvent(new CustomEvent("open-upgrade-modal"));
    } else if (data?.type === "coin_mention" && data.coin && data.commentId) {
      window.dispatchEvent(new CustomEvent("open-coin-mention", { detail: { coin: data.coin, commentId: parseInt(data.commentId, 10) } }));
    } else if (data?.type === "strategy_alert" && data.strategyId) {
      window.dispatchEvent(new CustomEvent("open-strategy-alert", { detail: { strategyId: data.strategyId, coin: data.coin } }));
    }
  });
}

export async function unsubscribeWebPush(): Promise<void> {
  if (!isWebPushAvailable()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await supabase.from("web_push_subscriptions").delete().eq("endpoint", endpoint);
    }
  } catch {
    // Best-effort — nothing actionable if the browser refuses to unsubscribe.
  }
}
