// Background "buy opportunity" scanner — runs once daily (see the paired
// cron migration), scores every actively-tracked coin on daily-candle
// technical confluence, and pushes to opted-in users when a coin newly
// crosses the active threshold. Deliberately NOT a prediction: it flags a
// documented confluence of oversold/reversal-associated conditions, same
// disclaimer posture as CandleWatcher's "statistical range, not a
// directional prediction" — see buy_signals.signals for exactly which
// conditions fired and why.
import { supabaseAdmin, getAccessToken, sendPush, getSoundsByUser } from "../_shared/fcm.ts";
import { sendWebPush, getWebPushSubscriptions } from "../_shared/webpush.ts";
import { fetchKlines } from "../_shared/klines.ts";
import { CandleDataPoint, calcRSI, calcBBPctSeries, calcVolRatio } from "../_shared/indicators.ts";
import { SCAN_COINS } from "../_shared/chartable-coins.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

const RSI_PERIOD = 14;
const BB_PERIOD = 20;
const VOL_PERIOD = 20;
const DRAWDOWN_LOOKBACK_DAYS = 5;
const DRAWDOWN_THRESHOLD_PCT = -8;
const VOL_RATIO_THRESHOLD = 1.3;
const RSI_OVERSOLD = 30;
const ACTIVE_THRESHOLD = 3; // of 4 signals
const MAX_SCORE = 4;

interface SignalHit { id: string; label: string; value: number }

function scoreCoin(candles: CandleDataPoint[]): {
  score: number; signals: SignalHit[]; price: number;
  rsi: number | null; bbPct: number | null; drawdownPct: number | null; volRatio: number | null;
} | null {
  // Drop the still-forming final candle — only ever score a closed daily
  // bar, same "evaluates on candle close" convention strategy-alert-eval
  // uses, so this doesn't flicker as today's candle is still forming.
  const closed = candles.slice(0, -1);
  if (closed.length < BB_PERIOD + 1) return null;

  const last = closed[closed.length - 1];
  const price = last.close;

  const rsi = calcRSI(closed, RSI_PERIOD);
  const bbSeries = calcBBPctSeries(closed, BB_PERIOD);
  const bbPct = bbSeries[bbSeries.length - 1];
  const volRatio = calcVolRatio(closed, VOL_PERIOD);

  const lookbackIdx = closed.length - 1 - DRAWDOWN_LOOKBACK_DAYS;
  const drawdownPct = lookbackIdx >= 0
    ? ((price - closed[lookbackIdx].close) / closed[lookbackIdx].close) * 100
    : null;

  const signals: SignalHit[] = [];
  if (rsi !== null && rsi < RSI_OVERSOLD) {
    signals.push({ id: "rsi", label: `RSI(${RSI_PERIOD}) oversold`, value: rsi });
  }
  if (bbPct !== null && bbPct <= 0) {
    signals.push({ id: "bb", label: "At/below lower Bollinger Band", value: bbPct });
  }
  if (drawdownPct !== null && drawdownPct <= DRAWDOWN_THRESHOLD_PCT) {
    signals.push({ id: "drawdown", label: `Down ${Math.abs(drawdownPct).toFixed(1)}% over ${DRAWDOWN_LOOKBACK_DAYS}d`, value: drawdownPct });
  }
  if (volRatio !== null && volRatio > VOL_RATIO_THRESHOLD) {
    signals.push({ id: "volume", label: "Elevated volume vs 20d avg", value: volRatio });
  }

  return { score: signals.length, signals, price, rsi, bbPct, drawdownPct, volRatio };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Opted-in recipients fetched once, reused for every coin that fires this
  // run — a scan can turn up several newly-active coins in one pass.
  const { data: optedInProfiles } = await supabaseAdmin
    .from("profiles")
    .select("id, alert_sound")
    .eq("notify_buy_signals", true);
  const recipientIds = (optedInProfiles ?? []).map(p => p.id);
  const soundByUser = recipientIds.length ? await getSoundsByUser(recipientIds) : new Map();

  let accessToken: string | null = null;
  const ensureAccessToken = async () => accessToken ??= await getAccessToken();

  let scanned = 0;
  let fired = 0;
  const errors: unknown[] = [];

  for (const coin of SCAN_COINS) {
    scanned++;
    try {
      const candles = await fetchKlines(coin, "1d", 40);
      const result = scoreCoin(candles);
      if (!result) continue;

      const isActive = result.score >= ACTIVE_THRESHOLD;

      const { data: prev } = await supabaseAdmin
        .from("buy_signals")
        .select("is_active")
        .eq("coin", coin)
        .maybeSingle();
      const wasActive = prev?.is_active ?? false;

      await supabaseAdmin.from("buy_signals").upsert({
        coin,
        score: result.score,
        max_score: MAX_SCORE,
        signals: result.signals,
        price: result.price,
        rsi: result.rsi,
        bb_pct: result.bbPct,
        drawdown_pct: result.drawdownPct,
        vol_ratio: result.volRatio,
        is_active: isActive,
        scanned_at: new Date().toISOString(),
      });

      // Only a NEW crossing into "active" fires a notification — a coin
      // that stays active scan after scan doesn't re-alert every day.
      if (!isActive || wasActive) continue;

      await supabaseAdmin.from("buy_signal_fires").insert({
        coin, score: result.score, signals: result.signals, price: result.price,
      });
      fired++;

      if (recipientIds.length === 0) continue;

      const title = `${coin} — Possible Buy Zone`;
      const body = result.signals.map(s => s.label).join(" · ");
      const pushData = { type: "buy_signal", coin, score: String(result.score) };

      const { data: tokenRows } = await supabaseAdmin
        .from("device_push_tokens")
        .select("token, user_id")
        .in("user_id", recipientIds);
      if (tokenRows && tokenRows.length > 0) {
        const token = await ensureAccessToken();
        await Promise.all(
          tokenRows.map(({ token: t, user_id }) =>
            sendPush(token, t, title, body, soundByUser.get(user_id) ?? "bell", pushData, "time-sensitive")),
        );
      }

      for (const userId of recipientIds) {
        const webSubs = await getWebPushSubscriptions(userId);
        if (webSubs.length > 0) {
          await Promise.all(webSubs.map((sub) => sendWebPush(sub, title, body, pushData)));
        }
      }
    } catch (err) {
      console.error(`buy-signal-scan failed for ${coin}:`, err);
      errors.push({ coin, error: String(err) });
    }
  }

  return new Response(JSON.stringify({ scanned, fired, errors }), { headers: { "Content-Type": "application/json" } });
});
