import { fetchKlines } from "../_shared/klines.ts";
import { supabaseAdmin, getOrCreateBotId } from "../_shared/marketPulseBot.ts";

// Posts a 15-minute market summary into every coin's live chat that's had
// real (non-bot) activity in the last 24h. See the matching migration
// (20260916164650_market_pulse_bot.sql) for why liquidations are left out
// entirely and whale activity is BTC-only — both are real data-availability
// limits, not a design choice. The bot also answers questions asked
// directly in chat — see market-pulse-reply, invoked by the client right
// after a comment posts, same as notify-mention.

const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const BINANCE_BASE = "https://data-api.binance.vision/api/v3";

// Coins with a real human message in the last 24h — self-perpetuation
// (the bot's own posts counting as "activity") would mean once the bot
// posts anywhere, it never stops, even in a room nobody's actually in.
async function getActiveCoins(): Promise<string[]> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("coin_comments")
    .select("coin")
    .eq("is_bot", false)
    .gte("created_at", cutoff)
    .limit(500);
  if (error) throw new Error(`Failed to load active coins: ${error.message}`);
  return [...new Set((data ?? []).map((r) => r.coin as string))];
}

interface CandleSummary {
  direction: "bullish" | "bearish" | "flat";
  movePct: number;
  open: number;
  close: number;
}

async function getCandleSummary(coin: string): Promise<CandleSummary> {
  // limit 3, then drop the still-forming final candle — same convention as
  // strategy-alert-eval, so "the current 15m candle" always means the last
  // *closed* one, not one that's still moving.
  const candles = await fetchKlines(coin, "15m", 3);
  const closed = candles[candles.length - 2];
  const movePct = ((closed.close - closed.open) / closed.open) * 100;
  return {
    direction: movePct > 0.02 ? "bullish" : movePct < -0.02 ? "bearish" : "flat",
    movePct,
    open: closed.open,
    close: closed.close,
  };
}

interface PriceAction {
  lastPrice: number;
  changePct24h: number;
}

async function getPriceAction(coin: string): Promise<PriceAction> {
  const symbol = `${coin.toUpperCase()}USDT`;
  const res = await fetch(`${BINANCE_BASE}/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`ticker fetch failed for ${symbol}: ${res.status}`);
  const json = await res.json();
  return {
    lastPrice: parseFloat(json.lastPrice),
    changePct24h: parseFloat(json.priceChangePercent),
  };
}

interface WhaleSummary {
  count: number;
  totalBtc: number;
}

const WHALE_THRESHOLD_BTC = 25;
const WHALE_THRESHOLD_SAT = Math.round(WHALE_THRESHOLD_BTC * 1e8);

// Same Blockchair mempool source src/services/whaleAlerts.ts uses client-
// side — Bitcoin-only, which is exactly why whale activity is BTC-only
// here too (see the migration's header comment).
async function getWhaleSummary(): Promise<WhaleSummary> {
  const url =
    `https://api.blockchair.com/bitcoin/mempool/transactions` +
    `?q=output_total(${WHALE_THRESHOLD_SAT}..)&limit=40&s=id(desc)`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`blockchair fetch failed: ${res.status}`);
  const json = await res.json();
  const txs: { output_total: number; time: string }[] = json.data ?? [];
  const cutoffMs = Date.now() - 15 * 60 * 1000;
  const recent = txs.filter((t) => new Date(`${t.time}Z`).getTime() >= cutoffMs);
  return {
    count: recent.length,
    totalBtc: recent.reduce((sum, t) => sum + t.output_total / 1e8, 0),
  };
}

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 1 ? 6 : 2 });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function composeMessage(coin: string, candle: CandleSummary, price: PriceAction, whale: WhaleSummary | null): string {
  const candleEmoji = candle.direction === "bullish" ? "🟢" : candle.direction === "bearish" ? "🔴" : "⚪";
  const candleLabel = candle.direction === "bullish" ? "Bullish" : candle.direction === "bearish" ? "Bearish" : "Flat";
  const lines = [
    `🕒 15m Update — ${coin}`,
    `📊 Candle: ${candleEmoji} ${candleLabel} ${fmtPct(candle.movePct)} (${fmtUsd(candle.open)} → ${fmtUsd(candle.close)})`,
    `💰 Price: ${fmtUsd(price.lastPrice)} (24h: ${fmtPct(price.changePct24h)})`,
  ];
  if (whale) {
    lines.push(
      whale.count > 0
        ? `🐋 Whale Activity: ${whale.count} transfer${whale.count === 1 ? "" : "s"} ≥${WHALE_THRESHOLD_BTC} BTC (${whale.totalBtc.toFixed(1)} BTC total) in the last 15m`
        : `🐋 Whale Activity: no transfers ≥${WHALE_THRESHOLD_BTC} BTC in the last 15m`,
    );
  }
  return lines.join("\n");
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const botId = await getOrCreateBotId();
  const coins = await getActiveCoins();

  const results: Record<string, string> = {};

  for (const coin of coins) {
    try {
      const [candle, price] = await Promise.all([getCandleSummary(coin), getPriceAction(coin)]);
      const whale = coin.toUpperCase() === "BTC" ? await getWhaleSummary() : null;
      const body = composeMessage(coin, candle, price, whale);

      const { error } = await supabaseAdmin
        .from("coin_comments")
        .insert({ coin, user_id: botId, body });
      if (error) throw new Error(error.message);

      results[coin] = "posted";
    } catch (e) {
      // One bad symbol (e.g. delisted on Binance) shouldn't take the whole
      // run down — every other active coin still gets its update.
      results[coin] = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return new Response(JSON.stringify({ botId, coins: results }), {
    headers: { "Content-Type": "application/json" },
  });
});
