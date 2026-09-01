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
}

const BODY_MAX = 500;

export async function fetchCoinComments(coin: string, limit = 50): Promise<CoinComment[]> {
  const { data, error } = await supabase
    .from("coin_comments")
    .select("*")
    .eq("coin", coin)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) { console.error("fetchCoinComments failed:", error.message); return []; }
  return (data as CoinComment[]) ?? [];
}

// username/tier are stamped server-side by a trigger (see the coin_chat
// migration) from the poster's own profile row — never trusted from here,
// so there's nothing to pass but the coin and the message itself.
export async function postCoinComment(coin: string, userId: string, body: string): Promise<CoinComment> {
  const trimmed = body.trim().slice(0, BODY_MAX);
  if (!trimmed) throw new Error("Comment can't be empty.");
  const { data, error } = await supabase
    .from("coin_comments")
    .insert({ coin, user_id: userId, body: trimmed })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as CoinComment;
}

export async function deleteCoinComment(commentId: number): Promise<void> {
  const { error } = await supabase.from("coin_comments").delete().eq("id", commentId);
  if (error) throw new Error(error.message);
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
