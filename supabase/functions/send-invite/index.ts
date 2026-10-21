const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Minimal escaping — inviterName comes from the signed-in user's own
// profile (editable by them), so it goes straight into the HTML body.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: { email?: string; inviterName?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
  }

  const email = body.email?.trim();
  if (!email || !EMAIL_RE.test(email)) {
    return new Response("Invalid email", { status: 400, headers: corsHeaders });
  }
  const inviterName = body.inviterName?.trim() || "A CoinHintz user";

  const appUrl = "https://coinhintz.com";
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;">
      <p>Hey,</p>
      <p><strong>${escapeHtml(inviterName)}</strong> thinks you'd like <strong>CoinHintz</strong> —
      real-time crypto charts, paper trading, and an AI trading agent.</p>
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
