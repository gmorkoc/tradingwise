import { supabase } from "./supabase";

export interface UserNotification {
  id: number;
  user_id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, string>;
  read: boolean;
  created_at: string;
}

const LIST_LIMIT = 50;

export async function fetchNotifications(userId: string): Promise<UserNotification[]> {
  const { data, error } = await supabase
    .from("user_notifications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) {
    console.error("Failed to fetch notifications:", error.message);
    return [];
  }
  return (data ?? []) as UserNotification[];
}

export async function fetchUnreadNotificationCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("user_notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("read", false);
  if (error) {
    console.error("Failed to fetch unread notification count:", error.message);
    return 0;
  }
  return count ?? 0;
}

export async function markNotificationRead(id: number): Promise<void> {
  const { error } = await supabase.from("user_notifications").update({ read: true }).eq("id", id);
  if (error) console.error("Failed to mark notification read:", error.message);
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  const { error } = await supabase
    .from("user_notifications")
    .update({ read: true })
    .eq("user_id", userId)
    .eq("read", false);
  if (error) console.error("Failed to mark all notifications read:", error.message);
}
