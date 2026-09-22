import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Invoked from ChartAnalyzeModal.tsx — a user picks/shoots one or more
// chart screenshots and gets a real technical read back. Pro/Elite only
// (same "requiredTier: pro" gate the nav item itself carries), so this
// checks the caller's own profile row rather than trusting the client.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const MAX_IMAGES = 5;

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

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("tier")
      .eq("id", user.id)
      .maybeSingle();
    if (profile?.tier !== "pro" && profile?.tier !== "elite") {
      return new Response("Chart analysis is a Pro feature", { status: 403, headers: corsHeaders });
    }

    if (!OPENAI_API_KEY) return new Response("Server not configured", { status: 500, headers: corsHeaders });

    const { images, coin } = await req.json();
    if (!Array.isArray(images) || images.length === 0) {
      return new Response("No images provided", { status: 400, headers: corsHeaders });
    }
    if (images.length > MAX_IMAGES) {
      return new Response(`Too many images (max ${MAX_IMAGES})`, { status: 400, headers: corsHeaders });
    }

    const contextLine = coin
      ? ` The trader currently has ${coin} open in the app, though the attached chart(s) may be for a different asset — read what's actually shown, not what's assumed.`
      : "";

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `You are a sharp technical analyst reviewing trading chart screenshots. Read what's actually visible in each image — timeframe, price action, candlestick patterns, trendlines, support/resistance, and any indicators shown (RSI, MACD, moving averages, volume). Give a structured, genuinely useful read: overall trend/bias, key levels, notable patterns, and a short actionable take, clearly framed as analysis rather than financial advice. If multiple images are attached, compare them (different timeframes or assets) and call out anything that stands out across them.${contextLine} Be concrete and specific to what's actually in the image(s) — never generic boilerplate.

Formatting is strict — follow it exactly, the response is parsed by a client that depends on this structure:
- Every section title (Trend, Key Levels, Notable Patterns, Volume & Indicators, Best Opportunity, and any other section you add) must be its own "### Title:" heading on its own line — never inline as plain text inside a sentence or bullet.
- Under each heading, each distinct point is its own "- " bullet on its own line. Never write a section title as text inside a bullet (e.g. a bullet must never end with "...as it broke out. Key Levels:" — "Key Levels" needs its own "### Key Levels:" heading instead).
- Never combine two distinct points onto one bullet.

Always end with a "### Best Opportunity:" section giving one concrete, numbers-driven trade idea reasoned from what's actually on the chart, as exactly six separate "- " bullets (each on its own "- Label: ..." clause, never combined onto the same bullet as another):
- Direction: LONG or SHORT (say "No clear edge — wait" instead of forcing a call if the chart genuinely doesn't support one)
- Entry: a specific price or tight zone
- Target: a specific take-profit price, tied to a visible level (prior high/low, resistance/support, measured move)
- Stop loss: a specific price, tied to where the setup is actually invalidated
- Risk/reward: the ratio those three numbers imply — nothing else on this bullet
- Why: its own separate bullet, one sentence, referencing the actual pattern/level that justifies it — never appended after Risk/reward
Every number here must be a real price read off the chart (or a tight zone), never a vague range like "somewhere higher" — and frame it as one read of the setup, not financial advice.`,
          },
          {
            role: "user",
            content: [
              { type: "text", text: images.length > 1 ? `Here are ${images.length} charts — analyze them.` : "Here's a chart — analyze it." },
              ...images.map((url: string) => ({ type: "image_url", image_url: { url, detail: "high" } })),
            ],
          },
        ],
        max_tokens: 1100,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log(`[${user.id}] openai http ${res.status}: ${errText.slice(0, 300)}`);
      return new Response("Analysis failed — please try again", { status: 502, headers: corsHeaders });
    }
    const json = await res.json();
    const analysis = (json.choices?.[0]?.message?.content ?? "").trim();
    if (!analysis) {
      console.log(`[${user.id}] empty analysis: ${JSON.stringify(json).slice(0, 300)}`);
      return new Response("Analysis failed — please try again", { status: 502, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ analysis }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`error: ${msg}`);
    return new Response(`error: ${msg}`, { status: 500, headers: corsHeaders });
  }
});
