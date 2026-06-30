const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const ADMIN_NOTIFY_EMAIL = Deno.env.get("ADMIN_NOTIFY_EMAIL") ?? "ggmorkoc@gmail.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: { event?: string; email?: string; tier?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
  }

  const { event, email, tier } = body;
  if (!event || !email) {
    return new Response("Missing event or email", { status: 400, headers: corsHeaders });
  }

  let subject = "";
  let html = "";

  if (event === "signup") {
    subject = `🆕 New signup: ${email}`;
    html = `<p>A new user just signed up on <strong>coinhintz</strong>:</p><p><strong>${email}</strong></p>`;
  } else if (event === "purchase") {
    subject = `💰 New ${tier} subscriber: ${email}`;
    html = `<p><strong>${email}</strong> just subscribed to the <strong>${tier}</strong> tier on <strong>coinhintz</strong>.</p>`;
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
