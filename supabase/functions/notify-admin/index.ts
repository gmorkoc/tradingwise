import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const ADMIN_NOTIFY_EMAIL = Deno.env.get("ADMIN_NOTIFY_EMAIL") ?? "ggmorkoc@gmail.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Minimal escaping so a reported comment's own text can't inject markup
// into the notification email.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: { event?: string; email?: string; tier?: string; commentId?: number; reporterId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
  }

  const { event, email, tier, commentId, reporterId } = body;
  if (!event) {
    return new Response("Missing event", { status: 400, headers: corsHeaders });
  }

  let subject = "";
  let html = "";

  if (event === "signup") {
    if (!email) return new Response("Missing email", { status: 400, headers: corsHeaders });
    subject = `🆕 New signup: ${email}`;
    html = `<p>A new user just signed up on <strong>coinhintz</strong>:</p><p><strong>${email}</strong></p>`;
  } else if (event === "purchase") {
    if (!email) return new Response("Missing email", { status: 400, headers: corsHeaders });
    subject = `💰 New ${tier} subscriber: ${email}`;
    html = `<p><strong>${email}</strong> just subscribed to the <strong>${tier}</strong> tier on <strong>coinhintz</strong>.</p>`;
  } else if (event === "report") {
    // Looked up server-side (service role) rather than trusting comment
    // text/usernames from the client — a reported comment is exactly the
    // kind of content a bad actor might try to use to inject something.
    if (!commentId || !reporterId) {
      return new Response("Missing commentId or reporterId", { status: 400, headers: corsHeaders });
    }
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const [{ data: comment }, { data: reporter }] = await Promise.all([
      supabaseAdmin.from("coin_comments").select("body, coin, username, user_id").eq("id", commentId).maybeSingle(),
      supabaseAdmin.from("profiles").select("username, email").eq("id", reporterId).maybeSingle(),
    ]);
    subject = `🚩 Comment reported${comment?.coin ? ` — ${comment.coin}` : ""}`;
    html = `
      <p><strong>${escapeHtml(reporter?.username ?? reporter?.email ?? reporterId)}</strong> reported a comment
      ${comment?.username ? `by <strong>${escapeHtml(comment.username)}</strong> ` : ""}
      ${comment?.coin ? `on <strong>${escapeHtml(comment.coin)}</strong>` : ""}:</p>
      <blockquote style="border-left:3px solid #ccc;margin:8px 0;padding:4px 12px;color:#333;">
        ${comment ? escapeHtml(comment.body) : "(comment not found — it may have already been deleted)"}
      </blockquote>
      <p style="color:#888;font-size:0.85em;">Comment ID: ${commentId} · Reported by user ID: ${reporterId}</p>
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
      from: "coinhintz <onboarding@resend.dev>",
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
