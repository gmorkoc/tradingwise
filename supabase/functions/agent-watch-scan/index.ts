// Closes the loop the trading agent leaves open at proposal time: a
// "notify me when..." watch or an open leveraged position's take-profit/
// stop-loss/liquidation price just sit in the database until something
// re-checks them. This runs on a schedule (see the paired cron migration),
// re-evaluates every active watch and every open futures position against
// fresh market data, and for anything that's now true: resolves it in the
// DB, posts a confirmation message into that user's conversation, and
// pushes a notification (FCM reaches iOS/Android, Web Push reaches
// browsers) — same dual-channel pattern strategy-alert-eval/buy-signal-scan
// already use.
import { supabaseAdmin, getAccessToken, sendPush, getSoundsByUser } from "../_shared/fcm.ts";
import { sendWebPush, getWebPushSubscriptions } from "../_shared/webpush.ts";
import { getMarketContext, MarketContext } from "../_shared/market.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

interface WatchRow {
  id: string;
  user_id: string;
  conversation_id: string;
  coin: string;
  condition_text: string;
}

type PositionSide = "long" | "short";
interface FuturesPositionRow {
  user_id: string;
  coin: string;
  side: PositionSide;
  qty: number;
  avg_entry_price: number;
  leverage: number;
  margin_usd: number;
  liquidation_price: number | null;
  take_profit_price: number | null;
  stop_loss_price: number | null;
}

// Lightweight last-trade price — deliberately NOT getMarketContext (which
// fetches 160 candles across two timeframes to build a full indicator
// snapshot). A TP/SL/liquidation check only ever needs the current price,
// so this stays cheap even when scanning many open positions every run.
async function fetchPrice(coin: string): Promise<number | null> {
  try {
    const res = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${coin.toUpperCase()}USDT`);
    if (!res.ok) return null;
    const data = await res.json();
    const price = parseFloat(data?.price ?? "0");
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

// Classifies one watch's free-text condition against a real market
// snapshot via a cheap, non-streaming model call — strict JSON out, no
// narration needed since nothing here is shown to the user live.
async function classifyWatch(watch: WatchRow, market: MarketContext): Promise<{ triggered: boolean; explanation: string } | null> {
  const prompt = `Coin: ${market.coin}
Price: $${market.price.toLocaleString()}
RSI(14, 1h): ${market.rsi != null ? market.rsi.toFixed(1) : "n/a"}
MACD histogram (1h): ${market.macdHist != null ? market.macdHist.toFixed(4) : "n/a"}
Bollinger %B (1h): ${market.bbPct != null ? market.bbPct.toFixed(2) : "n/a"}
4h trend: ${market.htfTrend ?? "n/a"}
Volume ratio (1h vs 20-period avg): ${market.volRatio != null ? market.volRatio.toFixed(2) : "n/a"}

Watch condition: "${watch.condition_text}"

Has this condition become true right now, strictly based on the data above? Respond with JSON only: {"triggered": boolean, "explanation": string} — explanation is one short sentence citing the actual number that satisfied (or didn't satisfy) the condition.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You strictly evaluate whether a stated trading watch condition is currently true, given real market data. Only say triggered if the data clearly satisfies it — when in doubt, say not triggered.",
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 200,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    if (typeof parsed.triggered !== "boolean") return null;
    return { triggered: parsed.triggered, explanation: String(parsed.explanation ?? "Condition met.") };
  } catch {
    return null;
  }
}

type CloseReason = "take_profit" | "stop_loss" | "liquidation";

// Which exit condition (if any) the current price satisfies — liquidation
// is checked first since it's the hard backstop a real exchange enforces
// regardless of where the user set their own stop-loss.
function checkExit(pos: FuturesPositionRow, price: number): CloseReason | null {
  const isLong = pos.side === "long";
  if (pos.liquidation_price != null && (isLong ? price <= pos.liquidation_price : price >= pos.liquidation_price)) {
    return "liquidation";
  }
  if (pos.stop_loss_price != null && (isLong ? price <= pos.stop_loss_price : price >= pos.stop_loss_price)) {
    return "stop_loss";
  }
  if (pos.take_profit_price != null && (isLong ? price >= pos.take_profit_price : price <= pos.take_profit_price)) {
    return "take_profit";
  }
  return null;
}

// Realizes the position's P&L into cash and removes it — same math
// executeTrade's opposite-side-close path uses client-side, just run here
// with the service-role client since there's no authenticated user in a
// cron context.
async function autoClosePosition(pos: FuturesPositionRow, price: number, reason: CloseReason): Promise<number> {
  const pnl = pos.side === "long" ? (price - pos.avg_entry_price) * pos.qty : (pos.avg_entry_price - price) * pos.qty;

  const { data: portfolio } = await supabaseAdmin
    .from("paper_portfolios").select("cash_balance").eq("user_id", pos.user_id).single();
  const newCash = (portfolio?.cash_balance ?? 0) + pos.margin_usd + pnl;

  await supabaseAdmin.from("paper_portfolios")
    .update({ cash_balance: Math.max(0, newCash), updated_at: new Date().toISOString() })
    .eq("user_id", pos.user_id);
  await supabaseAdmin.from("paper_positions").delete()
    .eq("user_id", pos.user_id).eq("coin", pos.coin).eq("market", "futures");
  await supabaseAdmin.from("paper_trades").insert({
    user_id: pos.user_id, coin: pos.coin, side: pos.side === "long" ? "sell" : "buy",
    qty: pos.qty, price, reason: `Auto-closed: ${reason.replace("_", " ")}`,
    market: "futures", position_side: pos.side, leverage: pos.leverage, margin_usd: pos.margin_usd,
    liquidation_price: pos.liquidation_price, take_profit_price: pos.take_profit_price,
    stop_loss_price: pos.stop_loss_price, close_reason: reason,
  });
  return pnl;
}

async function mostRecentConversationId(userId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("agent_messages").select("conversation_id").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data?.conversation_id ?? crypto.randomUUID();
}

async function notifyUser(userId: string, title: string, body: string, pushData: Record<string, string>): Promise<void> {
  const { data: tokens } = await supabaseAdmin.from("device_push_tokens").select("token").eq("user_id", userId);
  if (tokens && tokens.length > 0) {
    const soundByUser = await getSoundsByUser([userId]);
    const accessToken = await getAccessToken();
    await Promise.all(
      tokens.map(({ token }) => sendPush(accessToken, token, title, body, soundByUser.get(userId) ?? "bell", pushData, "time-sensitive")),
    );
  }
  const webSubs = await getWebPushSubscriptions(userId);
  if (webSubs.length > 0) {
    await Promise.all(webSubs.map((sub) => sendWebPush(sub, title, body, pushData)));
  }
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const marketCache = new Map<string, MarketContext | null>();
  const getMarket = async (coin: string): Promise<MarketContext | null> => {
    if (!marketCache.has(coin)) marketCache.set(coin, await getMarketContext(coin));
    return marketCache.get(coin)!;
  };
  const priceCache = new Map<string, number | null>();
  const getPrice = async (coin: string): Promise<number | null> => {
    if (marketCache.has(coin)) return marketCache.get(coin)?.price ?? null;
    if (!priceCache.has(coin)) priceCache.set(coin, await fetchPrice(coin));
    return priceCache.get(coin)!;
  };

  let watchesChecked = 0, watchesTriggered = 0;
  let positionsChecked = 0, positionsClosed = 0;
  const errors: unknown[] = [];

  const { data: watches } = await supabaseAdmin
    .from("agent_watches").select("id, user_id, conversation_id, coin, condition_text").eq("active", true);

  for (const watch of (watches ?? []) as WatchRow[]) {
    watchesChecked++;
    try {
      const market = await getMarket(watch.coin);
      if (!market) continue;
      const result = await classifyWatch(watch, market);
      await supabaseAdmin.from("agent_watches").update({ last_checked_at: new Date().toISOString() }).eq("id", watch.id);
      if (!result?.triggered) continue;

      watchesTriggered++;
      await supabaseAdmin.from("agent_watches")
        .update({ active: false, triggered_at: new Date().toISOString() }).eq("id", watch.id);
      await supabaseAdmin.from("agent_messages").insert({
        user_id: watch.user_id, conversation_id: watch.conversation_id, role: "agent",
        content: `👁 Your ${watch.coin} watch triggered — ${result.explanation}`, watch_id: watch.id,
      });

      const title = `${watch.coin} — watch triggered`;
      await notifyUser(watch.user_id, title, result.explanation, { type: "agent_watch", watchId: watch.id, coin: watch.coin });
    } catch (err) {
      console.error(`watch ${watch.id} failed:`, err);
      errors.push({ watchId: watch.id, error: String(err) });
    }
  }

  const { data: positions } = await supabaseAdmin
    .from("paper_positions")
    .select("user_id, coin, side, qty, avg_entry_price, leverage, margin_usd, liquidation_price, take_profit_price, stop_loss_price")
    .eq("market", "futures");

  for (const pos of (positions ?? []) as FuturesPositionRow[]) {
    if (pos.liquidation_price == null && pos.take_profit_price == null && pos.stop_loss_price == null) continue;
    positionsChecked++;
    try {
      const price = await getPrice(pos.coin);
      if (!price) continue;
      const reason = checkExit(pos, price);
      if (!reason) continue;

      const pnl = await autoClosePosition(pos, price, reason);
      positionsClosed++;

      const reasonLabel = reason === "liquidation" ? "Liquidated" : reason === "take_profit" ? "Take-profit hit" : "Stop-loss hit";
      const pnlText = `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
      const body = `${reasonLabel} on your ${pos.side} ${pos.coin} position at $${price.toLocaleString()} — ${pnlText} realized.`;

      const conversationId = await mostRecentConversationId(pos.user_id);
      await supabaseAdmin.from("agent_messages").insert({
        user_id: pos.user_id, conversation_id: conversationId, role: "agent", content: `📉 ${body}`,
      });

      await notifyUser(pos.user_id, `${pos.coin} — ${reasonLabel}`, body, {
        type: "agent_position_close", coin: pos.coin, reason, pnl: String(pnl),
      });
    } catch (err) {
      console.error(`position ${pos.user_id}/${pos.coin} failed:`, err);
      errors.push({ userId: pos.user_id, coin: pos.coin, error: String(err) });
    }
  }

  return new Response(
    JSON.stringify({ watchesChecked, watchesTriggered, positionsChecked, positionsClosed, errors }),
    { headers: { "Content-Type": "application/json" } },
  );
});
