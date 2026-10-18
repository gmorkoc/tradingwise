import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Invoked from the Advance Chart page's mobile hero card (PriceChart.tsx,
// "Agent" category) — a short, opinionated read on whatever coin/interval
// is currently on screen, grounded only in the numbers the client already
// has on hand (same zone signal/price/change the other hero cards show),
// not a second fetch of market data. Deliberately separate from the real
// Agent Ready conversation (trading-agent-reply/sendAgentMessage): this is
// a cheap, cached, read-only teaser with no history, no actions, no
// position awareness — swiping to this card should never write a message
// into the user's actual Agent Ready chat.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Signed-in only (no tier gate — this is free, unlike analyze-chart),
    // purely to keep an anonymous caller from running up the OpenAI bill.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    ).auth.getUser(token);
    if (authError || !user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    if (!OPENAI_API_KEY) return new Response("Server not configured", { status: 500, headers: corsHeaders });

    const { coin, interval, price, changePct24h, signal } = await req.json();
    if (!coin || typeof price !== "number") {
      return new Response("Missing coin/price", { status: 400, headers: corsHeaders });
    }

    const changeLine = typeof changePct24h === "number"
      ? `24h change: ${changePct24h >= 0 ? "+" : ""}${changePct24h.toFixed(2)}%.`
      : "24h change: unknown.";
    const signalLine = signal ? `Composite technical signal: ${signal}.` : "";
    const intervalLine = interval ? ` They're viewing the ${interval} chart.` : "";

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are Agent Ready, giving a quick opinionated read on ${coin} for a trader currently looking at its chart.${intervalLine} Ground every factual claim only in the real data given below — never invent a price or stat not provided. Price: $${price}. ${changeLine} ${signalLine} Give a short, genuinely useful take: your read on momentum/bias right now and one thing worth watching, in at most 2 short sentences (under 220 characters total). Casual, direct, no "as an AI" framing, no financial-advice disclaimer — just a quick read, same voice as a sharp trader's chat message.`,
          },
          { role: "user", content: `Quick take on ${coin}?` },
        ],
        max_tokens: 120,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log(`[${user.id}] openai http ${res.status}: ${errText.slice(0, 300)}`);
      return new Response("Agent didn't respond — please try again", { status: 502, headers: corsHeaders });
    }
    const json = await res.json();
    const take = (json.choices?.[0]?.message?.content ?? "").trim();
    if (!take) {
      return new Response("Agent didn't respond — please try again", { status: 502, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ take }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`error: ${msg}`);
    return new Response(`error: ${msg}`, { status: 500, headers: corsHeaders });
  }
});
