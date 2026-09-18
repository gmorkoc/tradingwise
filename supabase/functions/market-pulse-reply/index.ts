import { supabaseAdmin, getOrCreateBotId, BOT_USERNAME } from "../_shared/marketPulseBot.ts";

// Invoked by the client right after a comment posts (see postCoinComment in
// src/services/coinChat.ts) — same fire-and-forget pattern as notify-mention.
// Only actually replies when the message looks addressed to the bot
// (@mention, a question, or has an image attached); every other comment
// is a cheap no-op so the bot doesn't chime in on every "lol" or "nice"
// in the room.

// Every other function in this project has this guard (see notify-mention)
// — missing it here meant every browser CORS preflight (OPTIONS) hit
// req.json() on an empty body, threw, and got caught as a 500. The browser
// then silently dropped the real POST since its preflight had failed, so
// the bot almost never actually ran despite being invoked correctly.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const BINANCE_BASE = "https://data-api.binance.vision/api/v3";

const QUESTION_STARTERS = /^(how|what|when|where|why|who|is|are|does|do|can|could|will|would|should)\b/i;

function looksAddressedToBot(body: string): boolean {
  const t = body.trim();
  if (new RegExp(`@${BOT_USERNAME}\\b`, "i").test(t)) return true;
  return t.endsWith("?") || QUESTION_STARTERS.test(t);
}

interface MarketSnapshot {
  price: number;
  changePct24h: number;
}

async function getMarketSnapshot(coin: string): Promise<MarketSnapshot | null> {
  try {
    const symbol = `${coin.toUpperCase()}USDT`;
    const res = await fetch(`${BINANCE_BASE}/ticker/24hr?symbol=${symbol}`);
    if (!res.ok) return null;
    const json = await res.json();
    return { price: parseFloat(json.lastPrice), changePct24h: parseFloat(json.priceChangePercent) };
  } catch {
    return null;
  }
}

// Factual claims (current price, 24h change) are grounded in real fetched
// data — the model is never given more numbers than getMarketSnapshot
// actually returned, and is told never to invent a current one. Direction/
// price-target *predictions* are a deliberate exception: the model is
// explicitly allowed (encouraged, even) to give a short, opinionated,
// clearly-speculative take when asked, reasoned off that same real data.
//
// imageUrl (chart screenshot etc.) switches to gpt-4o — mini doesn't do
// vision — and adds it as an image_url content part, same request shape
// the old standalone AI Chat panel used (removed ChatInterface.tsx /
// services/openai.ts's openai.chat) before this capability moved here.
async function generateReply(
  coin: string, question: string, market: MarketSnapshot | null, imageUrl?: string | null
): Promise<{ text: string | null; debug: string }> {
  if (!OPENAI_API_KEY) return { text: null, debug: "no OPENAI_API_KEY in env" };
  const context = market
    ? `Current ${coin} price: $${market.price.toLocaleString()}. 24h change: ${market.changePct24h >= 0 ? "+" : ""}${market.changePct24h.toFixed(2)}%.`
    : `No live price data available for ${coin} right now.`;
  const imageInstruction = imageUrl
    ? " An image was attached (likely a chart screenshot) — perform real technical analysis on it: read the visible price action, patterns, indicators, or levels, and speak to what you actually see rather than generic advice."
    : "";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: imageUrl ? "gpt-4o" : "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are ${BOT_USERNAME}, a terse crypto bot posting in a ${coin} live chat room. Ground any factual claim (current price, 24h change, etc.) only in the real data given below — never invent a current number. If asked for a prediction, direction, or price target, DO give one: a short, opinionated take (e.g. "leaning bullish short-term off this momentum" or a rough price range) reasoned from the momentum in the data below, clearly framed as a quick guess or vibe rather than a fact — work a brief "not financial advice, just a read" style caveat into the sentence itself rather than a separate disclaimer line.${imageInstruction} Keep replies under 280 characters, casual, no "as an AI" framing.`,
          },
          {
            role: "user",
            content: imageUrl
              ? [
                  { type: "text", text: `${context}\n\nMessage from a trader in the room: "${question}"` },
                  { type: "image_url", image_url: { url: imageUrl, detail: "auto" } },
                ]
              : `${context}\n\nMessage from a trader in the room: "${question}"`,
          },
        ],
      }),
    });
    if (!res.ok) return { text: null, debug: `openai http ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const json = await res.json();
    const text = (json.choices?.[0]?.message?.content ?? "").trim() || null;
    return { text, debug: text ? "ok" : `empty content: ${JSON.stringify(json).slice(0, 300)}` };
  } catch (e) {
    return { text: null, debug: `exception: ${e instanceof Error ? e.message : String(e)}` };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  let commentId: unknown;
  try {
    ({ commentId } = await req.json());
    if (!commentId) return new Response("Missing commentId", { status: 400, headers: corsHeaders });

    const { data: comment } = await supabaseAdmin
      .from("coin_comments")
      .select("id, coin, body, is_bot, reply_to_id, user_id, image_url")
      .eq("id", commentId)
      .maybeSingle();
    if (!comment || comment.is_bot) {
      console.log(`[${commentId}] skip — ${!comment ? "comment not found" : "is_bot"}`);
      return new Response("skip", { status: 200, headers: corsHeaders });
    }

    // The client only ever renders one level of nesting — CoinChat.tsx's
    // own composer flattens every new reply onto its root ancestor
    // (replyTarget.reply_to_id ?? replyTarget.id) before posting, and its
    // renderer only looks up replies keyed by a TOP-LEVEL comment's id.
    // Replying directly to `comment.id` here breaks that whenever `comment`
    // is itself already a reply (e.g. someone replying to the bot's own
    // answer) — the bot's new row would carry a reply_to_id pointing at a
    // non-top-level comment, so it'd never be looked up by the renderer
    // and silently vanish from the UI despite existing in the database.
    // Mirroring the same flattening here keeps every bot reply visible.
    const replyToId = comment.reply_to_id ?? comment.id;

    const botId = await getOrCreateBotId();

    // Welcome takes priority over everything below — a brand-new poster
    // gets greeted regardless of what their first message actually says,
    // account-wide (not per-coin), so this only ever fires once per user.
    const { count: priorCount } = await supabaseAdmin
      .from("coin_comments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", comment.user_id)
      .neq("id", comment.id);

    if (priorCount === 0) {
      const { error: welcomeErr } = await supabaseAdmin.from("coin_comments").insert({
        coin: comment.coin,
        user_id: botId,
        body: `👋 Welcome to the room! I'm ${BOT_USERNAME} — I post market updates here and answer questions. Tag @${BOT_USERNAME} anytime to ask about price, recent moves, or market data.`,
        reply_to_id: replyToId,
      });
      if (welcomeErr) throw new Error(welcomeErr.message);
      console.log(`[${commentId}] welcomed user ${comment.user_id}`);
      return new Response("welcomed", { status: 200, headers: corsHeaders });
    }

    // A reply INSIDE the bot's own thread counts as addressed to it
    // regardless of phrasing — "thanks", "no I meant ETH", etc. wouldn't
    // match the @mention/question heuristic on their own, but they're
    // clearly not meant for the room at large.
    let replyingToBot = false;
    if (comment.reply_to_id) {
      const { data: parent } = await supabaseAdmin
        .from("coin_comments")
        .select("user_id")
        .eq("id", comment.reply_to_id)
        .maybeSingle();
      replyingToBot = parent?.user_id === botId;
    }

    // An attached image is always meant for the bot — same as the old
    // standalone AI Chat, which analyzed any uploaded image unconditionally
    // — so it skips the @mention/question heuristic below too.
    if (!replyingToBot && !comment.image_url && !looksAddressedToBot(comment.body)) {
      console.log(`[${commentId}] not addressed to bot — body: ${JSON.stringify(comment.body.slice(0, 120))}`);
      return new Response("not addressed to bot", { status: 200, headers: corsHeaders });
    }

    const market = await getMarketSnapshot(comment.coin);
    const { text: reply, debug } = await generateReply(comment.coin, comment.body, market, comment.image_url);
    if (!reply) {
      console.log(`[${commentId}] no reply generated — ${debug}`);
      return new Response(`no reply generated: ${debug}`, { status: 200, headers: corsHeaders });
    }

    const { error } = await supabaseAdmin.from("coin_comments").insert({
      coin: comment.coin,
      user_id: botId,
      body: reply.slice(0, 500),
      reply_to_id: replyToId,
    });
    if (error) throw new Error(error.message);

    console.log(`[${commentId}] replied: ${JSON.stringify(reply.slice(0, 120))}`);
    return new Response("replied", { status: 200, headers: corsHeaders });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[${commentId ?? "?"}] error: ${msg}`);
    return new Response(`error: ${msg}`, { status: 500, headers: corsHeaders });
  }
});
