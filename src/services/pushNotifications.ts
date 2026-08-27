import { Capacitor } from "@capacitor/core";
import { FirebaseMessaging } from "@capacitor-firebase/messaging";
import { supabase } from "./supabase";

// Android isn't wired up yet (no google-services.json in android/app), so
// this only runs on iOS for now — same gating pattern as revenuecat.ts.
export function isPushAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

let currentToken: string | null = null;
let listenersAttached = false;

async function saveToken(token: string, userId: string): Promise<void> {
  currentToken = token;
  const { error } = await supabase
    .from("device_push_tokens")
    .upsert({ token, user_id: userId, platform: Capacitor.getPlatform(), updated_at: new Date().toISOString() });
  if (error) console.error("Saving push token failed:", error.message);
}

/** Call once, after the Supabase user ID is known — requests OS permission,
 *  then registers this device's FCM token against that user so a backend
 *  job can target them. No-ops on web/Android, and never throws (permission
 *  denial is a normal, expected outcome). */
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
    }

    const { receive } = await FirebaseMessaging.checkPermissions();
    const granted = receive === "granted" ? true : (await FirebaseMessaging.requestPermissions()).receive === "granted";
    if (!granted) return;

    const { token } = await FirebaseMessaging.getToken();
    await saveToken(token, supabaseUserId);
  } catch (err) {
    console.error("Push notification init failed:", err);
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
