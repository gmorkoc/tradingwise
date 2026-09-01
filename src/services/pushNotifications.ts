import { Capacitor, registerPlugin } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { FirebaseMessaging } from "@capacitor-firebase/messaging";
import { supabase } from "./supabase";

// Android isn't wired up yet (no google-services.json in android/app), so
// this only runs on iOS for now — same gating pattern as revenuecat.ts.
export function isPushAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

// Native plugin (ios/App/App/NotificationAuthPlugin.swift) — bypasses
// @capacitor-firebase/messaging's requestPermissions(), which silently
// asks iOS for zero notification capabilities because it (mis)reuses
// capacitor.config.ts's FirebaseMessaging.presentationOptions (deliberately
// set to [] so a foregrounded push doesn't also pop the OS banner) as the
// authorization options to request. Requesting nothing means iOS never
// records a real permission decision at all — see the plugin file for the
// full explanation.
interface NotificationAuthPlugin {
  requestFullAuthorization(): Promise<{ granted: boolean }>;
}
const NotificationAuth = registerPlugin<NotificationAuthPlugin>("NotificationAuth");

let currentToken: string | null = null;
let listenersAttached = false;

async function saveToken(token: string, userId: string): Promise<void> {
  currentToken = token;
  const { error } = await supabase
    .from("device_push_tokens")
    .upsert({ token, user_id: userId, platform: Capacitor.getPlatform(), updated_at: new Date().toISOString() });
  if (error) console.error("Saving push token failed:", error.message);
}

/** Call once, after the Supabase user ID is known — requests OS permission
 *  immediately (iOS only ever shows that dialog once per install anyway, so
 *  there's no real cost to asking right away instead of gating behind an
 *  explainer screen first), then registers this device's FCM token against
 *  that user so a backend job can target them. No-ops on web/Android, and
 *  never throws (permission denial is a normal, expected outcome). */
export async function initPushNotifications(supabaseUserId: string): Promise<void> {
  if (!isPushAvailable()) return;
  try {
    if (!listenersAttached) {
      listenersAttached = true;
      FirebaseMessaging.addListener("tokenReceived", ({ token }) => {
        supabase.auth.getUser().then(({ data }) => {
          if (data.user) saveToken(token, data.user.id);
        });
      });

      // Tapping a daily-brief-push notification opens straight to that
      // article — same destination as tapping the item inside the app.
      // Tapping an upgrade-reminder-push opens the Upgrade modal — that
      // state lives in App.tsx, well above this plain service module, so
      // it's reached via a plain DOM event instead (same pattern as
      // useNotificationsEnabled.ts's cross-component toggle).
      FirebaseMessaging.addListener("notificationActionPerformed", ({ notification }) => {
        const data = notification.data as { type?: string; url?: string } | undefined;
        if (data?.type === "daily_brief" && data.url) {
          Browser.open({ url: data.url });
        } else if (data?.type === "upgrade_reminder") {
          window.dispatchEvent(new CustomEvent("open-upgrade-modal"));
        }
      });

      // capacitor.config.ts sets presentationOptions to [] so a push that
      // arrives while the app is open doesn't also pop the OS banner —
      // this fires regardless of that setting, so PushToast.tsx (mounted
      // at the app root) can show an in-app one instead.
      FirebaseMessaging.addListener("notificationReceived", ({ notification }) => {
        window.dispatchEvent(new CustomEvent("push-toast", {
          detail: { title: notification.title ?? "", body: notification.body ?? "", data: notification.data },
        }));
      });
    }

    let { receive } = await FirebaseMessaging.checkPermissions();
    if (receive === "prompt") {
      await NotificationAuth.requestFullAuthorization();
      receive = (await FirebaseMessaging.checkPermissions()).receive;
    }
    if (receive !== "granted") return;

    const { token } = await FirebaseMessaging.getToken();
    await saveToken(token, supabaseUserId);
  } catch (err) {
    console.error("Push notification init failed:", err);
  }
}

/** Called from ProfilePage's Notifications tab when the user taps "Enable"
 *  after having skipped the initial login-time prompt (or if it silently
 *  failed) — same request-then-verify flow as initPushNotifications. */
export async function completePushPriming(supabaseUserId: string): Promise<void> {
  try {
    await NotificationAuth.requestFullAuthorization();
    const { receive } = await FirebaseMessaging.checkPermissions();
    if (receive !== "granted") return;
    const { token } = await FirebaseMessaging.getToken();
    await saveToken(token, supabaseUserId);
  } catch (err) {
    console.error("Push permission request failed:", err);
  }
}

/** Detaches this device's token from the signed-out account so a future
 *  sign-in on this device (as a different user) doesn't leave the old
 *  account still able to receive pushes here. */
export async function logOutPushNotifications(): Promise<void> {
  if (!isPushAvailable() || !currentToken) return;
  try {
    await supabase.from("device_push_tokens").delete().eq("token", currentToken);
  } catch (err) {
    console.error("Push token cleanup failed:", err);
  } finally {
    currentToken = null;
  }
}
