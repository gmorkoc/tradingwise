import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Speaks a Trading Agent reply aloud via OpenAI's own neural TTS model —
// the same class of model ChatGPT's voice mode uses — rather than the
// device's on-device synthesizer. No on-device iOS voice (even an
// "Enhanced"/"Premium" one) sounds like a real neural TTS model; it's a
// different generation of technology, not just a matter of which voice
// name is selected. Invoked synchronously from TradingAgent.tsx
// (request/response — the client plays back the returned audio directly),
// same shape as trading-agent-reply.
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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    ).auth.getUser(token);
    if (authError || !user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    if (!OPENAI_API_KEY) return new Response("Server not configured", { status: 500, headers: corsHeaders });

    const { text } = await req.json();
    if (typeof text !== "string" || !text.trim()) {
      return new Response("Missing text", { status: 400, headers: corsHeaders });
    }
    // OpenAI TTS has its own input length cap — a reply this long would
    // never happen in practice (the agent's "reply" field is instructed
    // to stay to 1-3 sentences), but truncate defensively rather than let
    // the upstream call fail outright on some unusually long edge case.
    const input = text.slice(0, 4000);

    const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "echo",
        input,
        speed: 1.2,
        // gpt-4o-mini-tts (unlike tts-1/tts-1-hd) actually reads this and
        // audibly changes delivery — real warmth/inflection, not just
        // which voice is selected. "Smiling while you talk" is a real,
        // documented technique for this model: it measurably warms the
        // tone rather than being a no-op instruction.
        instructions:
          "Speak like a warm, upbeat friend talking you through a trade — not a formal narrator reading a report. Smile slightly as you talk, especially on anything positive; let real conversational warmth, light emotional inflection, and the occasional dry/sarcastic edge come through where the words call for it. Vary your volume and pacing the way an actual person does in conversation — a touch quieter and slower on a cautious or serious point, a bit more energy on a confident call — rather than one flat, constant loudness and rate the whole way through. Verbal habits like \"hmm,\" \"gotcha,\" or \"right\" that appear in the text should land exactly like a real person tossing them in mid-thought, not a flat recitation of the word.",
      }),
    });
    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      return new Response(`TTS upstream error (${upstream.status}): ${errText.slice(0, 300)}`, {
        status: 502,
        headers: corsHeaders,
      });
    }

    return new Response(upstream.body, {
      headers: { ...corsHeaders, "Content-Type": "audio/mpeg" },
    });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 500, headers: corsHeaders });
  }
});
