import { supabaseAdmin } from "./fcm.ts";

// Persists one row per (user, push) into user_notifications — the source
// for the app's Notifications tab. Separate from the actual send
// (sendPush/sendWebPush in fcm.ts/webpush.ts) so a user with 0 registered
// devices (push permission denied, or web-only) still gets an in-app
// history entry; "did we deliver a push" and "does this user know about
// this event" are different questions. One row per USER, not per device
// token — a user with 2 devices registered shouldn't see the same alert
// twice in their feed.
export interface NotificationLogEntry {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export async function logNotifications(entries: NotificationLogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const { error } = await supabaseAdmin.from("user_notifications").insert(
    entries.map((e) => ({
      user_id: e.userId,
      type: e.type,
      title: e.title,
      body: e.body,
      data: e.data ?? {},
    })),
  );
  // Best-effort — a logging failure shouldn't be treated as a push-sending
  // failure by the caller, so this never throws.
  if (error) console.error("Failed to log notifications:", error.message);
}
