import { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export interface CoinComment {
  id: number;
  coin: string;
  user_id: string;
  username: string;
  tier: "pro" | "elite";
  body: string;
  created_at: string;
  like_count: number;
  reply_to_id: number | null;
}

const BODY_MAX = 500;

// `before` pages backward in time (strictly older than that comment's
// created_at) — a cursor rather than an offset so comments inserted at the
// top between page loads (realtime) can't shift a later page's results.
export async function fetchCoinComments(coin: string, limit = 50, before?: string): Promise<CoinComment[]> {
  let query = supabase
    .from("coin_comments")
    .select("*")
    .eq("coin", coin)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) { console.error("fetchCoinComments failed:", error.message); return []; }
  return (data as CoinComment[]) ?? [];
}

// Deep-linking from a mention push notification can't rely on the comment
// showing up in fetchCoinComments' most-recent-50 window — a busy chat can
// easily bury it. Used to fetch that one comment (and, if it's a reply,
// its parent — see CoinChat.tsx) directly by id instead.
export async function fetchCommentById(id: number): Promise<CoinComment | null> {
  const { data, error } = await supabase
    .from("coin_comments")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) { console.error("fetchCommentById failed:", error.message); return null; }
  return (data as CoinComment) ?? null;
}

// username/tier are stamped server-side by a trigger (see the coin_chat
// migration) from the poster's own profile row — never trusted from here,
// so there's nothing to pass but the coin and the message itself.
export async function postCoinComment(
  coin: string, userId: string, body: string, replyToId?: number | null
): Promise<CoinComment> {
  const trimmed = body.trim().slice(0, BODY_MAX);
  if (!trimmed) throw new Error("Comment can't be empty.");
  const { data, error } = await supabase
    .from("coin_comments")
    .insert({ coin, user_id: userId, body: trimmed, reply_to_id: replyToId ?? null })
    .select()
    .single();
  if (error) throw new Error(error.message);

  // The queue_comment_mentions trigger has already resolved any @handles
  // in the body into mention_notifications rows by now — this just asks
  // the edge function to drain them into pushes. Fire-and-forget: a
  // failure here shouldn't surface as the comment itself having failed.
  supabase.functions.invoke("notify-mention", { body: { commentId: data.id } }).catch(() => {});

  return data as CoinComment;
}

// Composer @mention autocomplete.
export async function searchUsernames(prefix: string): Promise<string[]> {
  if (!prefix) return [];
  const { data, error } = await supabase.rpc("search_usernames", { prefix });
  if (error) { console.error("searchUsernames failed:", error.message); return []; }
  return ((data as { username: string }[]) ?? []).map((r) => r.username);
}

export async function deleteCoinComment(commentId: number): Promise<void> {
  const { error } = await supabase.from("coin_comments").delete().eq("id", commentId);
  if (error) throw new Error(error.message);
}

// Any authenticated user can like — lighter-weight than posting, not
// restricted to pro/elite. like_count on the comment is kept in sync
// server-side by a trigger, never written from here.
export async function likeComment(commentId: number, userId: string): Promise<void> {
  const { error } = await supabase.from("coin_comment_likes").insert({ comment_id: commentId, user_id: userId });
  if (error && error.code !== "23505") throw new Error(error.message);
}

export async function unlikeComment(commentId: number, userId: string): Promise<void> {
  const { error } = await supabase
    .from("coin_comment_likes")
    .delete()
    .eq("comment_id", commentId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// Which of the given comments the signed-in user has already liked —
// fetched once alongside the feed so like buttons render filled/unfilled
// correctly on load.
export async function fetchMyLikedCommentIds(userId: string, commentIds: number[]): Promise<Set<number>> {
  if (commentIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("coin_comment_likes")
    .select("comment_id")
    .eq("user_id", userId)
    .in("comment_id", commentIds);
  if (error) { console.error("fetchMyLikedCommentIds failed:", error.message); return new Set(); }
  return new Set((data ?? []).map((r) => r.comment_id as number));
}

export async function reportCoinComment(commentId: number, reporterId: string): Promise<void> {
  const { error } = await supabase
    .from("comment_reports")
    .insert({ comment_id: commentId, reporter_id: reporterId });
  // A duplicate report (already reported by this user) isn't worth
  // surfacing as an error — the outcome the user wanted already happened.
  if (error && error.code !== "23505") throw new Error(error.message);
}

// One realtime channel per coin — the panel/sheet mounts and unmounts with
// whichever coin is currently being viewed, so there's no need to manage
// more than one subscription at a time.
export function subscribeToCoinComments(
  coin: string,
  onInsert: (comment: CoinComment) => void,
  onDelete: (id: number) => void
): RealtimeChannel {
  return supabase
    .channel(`coin-chat-${coin}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "coin_comments", filter: `coin=eq.${coin}` },
      (payload) => onInsert(payload.new as CoinComment)
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "coin_comments", filter: `coin=eq.${coin}` },
      (payload) => onDelete((payload.old as { id: number }).id)
    )
    .subscribe();
}

export function unsubscribeFromCoinComments(channel: RealtimeChannel): void {
  supabase.removeChannel(channel);
}

export { BODY_MAX as COIN_COMMENT_MAX_LENGTH };
