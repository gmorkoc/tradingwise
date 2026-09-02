import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { supabaseAdmin, getAccessToken, sendPush } from "../_shared/fcm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Called right after a client successfully posts a comment (see
// postCoinComment in src/services/coinChat.ts) — the
// queue_comment_mentions trigger has already resolved @handles to
// mention_notifications rows by the time this runs; this just drains
// them into actual pushes. Client-invoked-right-after-the-action, same
// pattern as sync-iap-entitlement, not a cron poll — there's no reason
// to delay a mention notification.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    ).auth.getUser(token);
    if (authError || !user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const { commentId } = await req.json();
    if (!commentId) return new Response("Missing commentId", { status: 400, headers: corsHeaders });

    // Only the comment's own author can trigger delivery for it — the
    // queue rows are already scoped correctly by the trigger regardless,
    // this just stops an arbitrary caller from replaying delivery for a
    // comment that isn't theirs.
    const { data: comment } = await supabaseAdmin
      .from("coin_comments")
      .select("user_id, username, coin")
      .eq("id", commentId)
      .single();
    if (!comment || comment.user_id !== user.id) {
      return new Response("Unauthorized", { status: 403, headers: corsHeaders });
    }

    const { data: pending } = await supabaseAdmin
      .from("mention_notifications")
      .select("mentioned_user_id")
      .eq("comment_id", commentId)
      .eq("sent", false);

    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const userIds = [...new Set(pending.map((p) => p.mentioned_user_id))];

    const { data: recipients } = await supabaseAdmin
      .from("profiles")
      .select("id, notify_mentions, alert_sound")
      .in("id", userIds);
    const recipientById = new Map((recipients ?? []).map((r) => [r.id, r]));

    const { data: tokenRows } = await supabaseAdmin
      .from("device_push_tokens")
      .select("token, user_id")
      .in("user_id", userIds);

    let sentCount = 0;
    let accessToken: string | null = null;
    const ensureAccessToken = async () => (accessToken ??= await getAccessToken());

    if (tokenRows && tokenRows.length > 0) {
      const title = `@${comment.username} mentioned you`;
      const body = `New message in the ${comment.coin} chat`;
      for (const t of tokenRows) {
        const recipient = recipientById.get(t.user_id);
        if (!recipient || recipient.notify_mentions === false) continue;
        const at = await ensureAccessToken();
        const ok = await sendPush(at, t.token, title, body, recipient.alert_sound ?? "bell", {
          type: "coin_mention",
          coin: comment.coin,
          commentId: String(commentId),
        });
        if (ok) sentCount++;
      }
    }

    await supabaseAdmin.from("mention_notifications").update({ sent: true }).eq("comment_id", commentId);

    return new Response(JSON.stringify({ sent: sentCount, queued: pending.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
