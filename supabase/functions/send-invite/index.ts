import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// inviterName comes from the sender's own profile (editable by them), so
// it's escaped for the HTML body and stripped of control chars / length-
// capped for the subject line.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 40);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Per-sender cap so this can't be used to blast email.
const MAX_INVITES_PER_DAY = 20;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
  }

  const email = body.email?.trim();
  if (!email || !EMAIL_RE.test(email)) {
    return new Response("Invalid email", { status: 400, headers: corsHeaders });
  }

  // Signed-in senders only (identity from their JWT, never the body). The
  // anon key alone used to be enough, making this an open email relay.
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: { user } } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
  if (!user) return new Response("Sign in to send invites", { status: 401, headers: corsHeaders });

  const invitee = email.toLowerCase();
  if (user.email?.toLowerCase() === invitee) {
    return new Response("You can't invite yourself", { status: 400, headers: corsHeaders });
  }

  // Already invited this address → don't email it again.
  const { data: existing } = await admin
    .from("referral_invites")
    .select("id")
    .eq("inviter_id", user.id)
    .eq("invitee_email", invitee)
    .maybeSingle();
  if (existing) {
    return new Response(JSON.stringify({ sent: true, alreadyInvited: true }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Daily cap per sender.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: sentToday } = await admin
    .from("referral_invites")
    .select("id", { count: "exact", head: true })
    .eq("inviter_id", user.id)
    .gte("created_at", since);
  if ((sentToday ?? 0) >= MAX_INVITES_PER_DAY) {
    return new Response("Daily invite limit reached", { status: 429, headers: corsHeaders });
  }

  // Inviter's name from their own profile, not the request.
  const { data: prof } = await admin
    .from("profiles")
    .select("full_name, username")
    .eq("id", user.id)
    .maybeSingle();
  const inviterName = cleanName(prof?.full_name || prof?.username || "") || "A CoinHintz user";

  // Log the invite so the signup trigger (reward_referral_on_signup,
  // migration 20261026120000) can pay the inviter +$10,000 paper cash.
  const { error: logErr } = await admin.from("referral_invites").upsert(
    { inviter_id: user.id, invitee_email: invitee },
    { onConflict: "inviter_id,invitee_email", ignoreDuplicates: true },
  );
  if (logErr) console.error("referral log failed:", logErr);

  const appUrl = "https://coinhintz.com";
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;">
      <p>Hey,</p>
      <p><strong>${escapeHtml(inviterName)}</strong> thinks you'd like <strong>CoinHintz</strong> —
      real-time crypto charts, paper trading, and an AI trading agent.</p>
      <p>Sign up with this email address to get started with <strong>$100,000</strong> in free paper trading cash.</p>
      <p style="margin:24px 0;">
        <a href="${appUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">
          Open CoinHintz
        </a>
      </p>
      <p style="color:#888;font-size:0.85em;">${appUrl}</p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "coinhintz <support@coinhintz.com>",
      to: email,
      subject: `${inviterName} invited you to CoinHintz`,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Resend error:", err);
    return new Response("Failed to send invite", { status: 502, headers: corsHeaders });
  }

  return new Response(JSON.stringify({ sent: true }), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
});
