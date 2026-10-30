import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const ADMIN_NOTIFY_EMAIL = Deno.env.get("ADMIN_NOTIFY_EMAIL") ?? "ggmorkoc@gmail.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Every interpolated value is escaped — emails, tiers, usernames and
// comment text can all be attacker-chosen.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// Subject lines: no control chars / newlines, length-capped.
function cleanSubject(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A signup notice is only sent for an account created this recently.
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: { event?: string; email?: string; tier?: string; commentId?: number };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
  }

  const { event, email, tier, commentId } = body;
  if (!event) {
    return new Response("Missing event", { status: 400, headers: corsHeaders });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const isServer = bearer !== "" && bearer === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  let subject = "";
  let html = "";

  if (event === "signup") {
    // Sent by the client right after sign-up, often before there's a
    // session (email confirmation), so instead of a JWT: only notify for
    // an auth account with this email that was created in the last few
    // minutes. Random addresses can't be used to spam the admin inbox.
    if (!email || !EMAIL_RE.test(email)) return new Response("Missing email", { status: 400, headers: corsHeaders });
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const match = (list?.users ?? []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
    const fresh = match && Date.now() - new Date(match.created_at).getTime() < SIGNUP_WINDOW_MS;
    if (!fresh) return new Response(JSON.stringify({ sent: false }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    subject = cleanSubject(`🆕 New signup: ${email}`);
    html = `<p>A new user just signed up on <strong>coinhintz</strong>:</p><p><strong>${escapeHtml(email)}</strong></p>`;
  } else if (event === "purchase") {
    // Server-only (stripe-webhook calls this with the service role key).
    if (!isServer) return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    if (!email) return new Response("Missing email", { status: 400, headers: corsHeaders });
    const t = String(tier ?? "");
    subject = cleanSubject(`💰 New ${t} subscriber: ${email}`);
    html = `<p><strong>${escapeHtml(email)}</strong> just subscribed to the <strong>${escapeHtml(t)}</strong> tier on <strong>coinhintz</strong>.</p>`;
  } else if (event === "report") {
    // Reporter comes from the caller's JWT, never the body, and the report
    // row must exist (written by the client via RLS as that same user).
    const { data: { user } } = bearer ? await supabaseAdmin.auth.getUser(bearer) : { data: { user: null } };
    if (!user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    if (!commentId) {
      return new Response("Missing commentId", { status: 400, headers: corsHeaders });
    }
    const reporterId = user.id;
    const { data: reportRow } = await supabaseAdmin
      .from("comment_reports")
      .select("comment_id")
      .eq("comment_id", commentId)
      .eq("reporter_id", reporterId)
      .maybeSingle();
    if (!reportRow) return new Response("No such report", { status: 404, headers: corsHeaders });
    const [{ data: comment }, { data: reporter }] = await Promise.all([
      supabaseAdmin.from("coin_comments").select("body, coin, username, user_id").eq("id", commentId).maybeSingle(),
      supabaseAdmin.from("profiles").select("username, email").eq("id", reporterId).maybeSingle(),
    ]);
    subject = cleanSubject(`🚩 Comment reported${comment?.coin ? ` — ${comment.coin}` : ""}`);
    html = `
      <p><strong>${escapeHtml(reporter?.username ?? reporter?.email ?? reporterId)}</strong> reported a comment
      ${comment?.username ? `by <strong>${escapeHtml(comment.username)}</strong> ` : ""}
      ${comment?.coin ? `on <strong>${escapeHtml(comment.coin)}</strong>` : ""}:</p>
      <blockquote style="border-left:3px solid #ccc;margin:8px 0;padding:4px 12px;color:#333;">
        ${comment ? escapeHtml(comment.body) : "(comment not found — it may have already been deleted)"}
      </blockquote>
      <p style="color:#888;font-size:0.85em;">Comment ID: ${escapeHtml(String(commentId))} · Reported by user ID: ${escapeHtml(reporterId)}</p>
    `;
  } else {
    return new Response("Unknown event type", { status: 400, headers: corsHeaders });
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "coinhintz <support@coinhintz.com>",
      to: ADMIN_NOTIFY_EMAIL,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Resend error:", err);
    return new Response("Failed to send notification", { status: 502, headers: corsHeaders });
  }

  return new Response(JSON.stringify({ sent: true }), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
});
