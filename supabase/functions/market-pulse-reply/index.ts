import { supabaseAdmin, getOrCreateBotId, BOT_USERNAME } from "../_shared/marketPulseBot.ts";

// Invoked by the client right after a comment posts (see postCoinComment in
// src/services/coinChat.ts) — same fire-and-forget pattern as notify-mention.
// Only actually replies when the message looks addressed to the bot
// (@mention or a question); every other comment is a cheap no-op so the
// bot doesn't chime in on every "lol" or "nice" in the room.

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

// Grounds the reply in real fetched data rather than letting the model
// guess a price — the system prompt explicitly forbids inventing numbers,
// and the only numbers it's given are the ones getMarketSnapshot fetched.
async function generateReply(coin: string, question: string, market: MarketSnapshot | null): Promise<{ text: string | null; debug: string }> {
  if (!OPENAI_API_KEY) return { text: null, debug: "no OPENAI_API_KEY in env" };
  const context = market
    ? `Current ${coin} price: $${market.price.toLocaleString()}. 24h change: ${market.changePct24h >= 0 ? "+" : ""}${market.changePct24h.toFixed(2)}%.`
    : `No live price data available for ${coin} right now.`;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are ${BOT_USERNAME}, a terse crypto market-data bot posting in a ${coin} live chat room. Answer using only the real data given to you below — never invent a price or number, and say so briefly if you don't have the data instead of guessing. Keep replies under 280 characters, casual, no disclaimers, no "as an AI" framing.`,
          },
          { role: "user", content: `${context}\n\nMessage from a trader in the room: "${question}"` },
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
  try {
    const { commentId } = await req.json();
    if (!commentId) return new Response("Missing commentId", { status: 400 });

    const { data: comment } = await supabaseAdmin
      .from("coin_comments")
      .select("id, coin, body, is_bot, reply_to_id, user_id")
      .eq("id", commentId)
      .maybeSingle();
    if (!comment || comment.is_bot) return new Response("skip", { status: 200 });

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
        reply_to_id: comment.id,
      });
      if (welcomeErr) throw new Error(welcomeErr.message);
      return new Response("welcomed", { status: 200 });
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

    if (!replyingToBot && !looksAddressedToBot(comment.body)) {
      return new Response("not addressed to bot", { status: 200 });
    }

    const market = await getMarketSnapshot(comment.coin);
    const { text: reply, debug } = await generateReply(comment.coin, comment.body, market);
    if (!reply) return new Response(`no reply generated: ${debug}`, { status: 200 });

    const { error } = await supabaseAdmin.from("coin_comments").insert({
      coin: comment.coin,
      user_id: botId,
      body: reply.slice(0, 500),
      reply_to_id: comment.id,
    });
    if (error) throw new Error(error.message);

    return new Response("replied", { status: 200 });
  } catch (e) {
    return new Response(`error: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
  }
});
