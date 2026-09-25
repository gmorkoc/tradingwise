// Background "buy/sell opportunity" scanner — runs every 4 hours (see the
// paired cron migration), scores every actively-tracked coin on 4h-candle
// technical confluence in BOTH directions, and pushes to opted-in elite
// users when a coin newly crosses either threshold. Deliberately NOT a
// prediction: it flags a documented confluence of oversold/overbought-
// and-reversal-associated conditions, same disclaimer posture as
// CandleWatcher's "statistical range, not a directional prediction" — see
// buy_signals.signals for exactly which conditions fired and why.
import { supabaseAdmin, getAccessToken, sendPush, getSoundsByUser } from "../_shared/fcm.ts";
import { sendWebPush, getWebPushSubscriptions } from "../_shared/webpush.ts";
import { fetchKlines } from "../_shared/klines.ts";
import { fetchPositioning } from "../_shared/positioning.ts";
import {
  CandleDataPoint, calcRSI, calcBBPctSeries, calcVolRatio, calcATR, calcSMA, calcMACDSeries,
} from "../_shared/indicators.ts";
import { SCAN_COINS } from "../_shared/chartable-coins.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

const INTERVAL = "4h";
const CANDLE_LIMIT = 260; // 200 for the trend SMA + warmup buffer for RSI/BB/MACD/ATR

const RSI_PERIOD = 14;
const BB_PERIOD = 20;
const VOL_PERIOD = 20;
const TREND_SMA_PERIOD = 200;     // ~33 days of 4h candles — medium-term trend context, not "200-day"
const MOVE_LOOKBACK_CANDLES = 12; // 48h window for the volatility-normalized move check
const MOVE_ATR_MULTIPLE = 2;      // move must be >= 2x ATR(14) to count — scales per coin instead of a flat %
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const VOL_RATIO_THRESHOLD = 1.3;
// Heuristic, never backtested — typical funding sits near 0.01%/8h; these
// mark clearly crowded positioning, not a precise statistical cutoff.
const FUNDING_EXTREME = 0.0005;
const LS_RATIO_LONG_CROWDED = 2.5;
const LS_RATIO_SHORT_CROWDED = 0.6;

type Direction = "buy" | "sell";
const ACTIVE_THRESHOLD = 4; // of 7 signals
const MAX_SCORE = 7;

interface SignalHit { id: string; label: string; value: number }

interface ScoreResult {
  score: number; signals: SignalHit[]; price: number;
  rsi: number | null; bbPct: number | null; movePct: number | null; volRatio: number | null;
  macdHist: number | null; smaRatio: number | null;
  fundingRate: number | null; longShortRatio: number | null;
}

function confidenceOf(score: number): "low" | "medium" | "high" {
  if (score >= 6) return "high";
  if (score >= 5) return "medium";
  return "low";
}

function scoreCoin(
  direction: Direction, candles: CandleDataPoint[], positioning: { fundingRate: number | null; longShortRatio: number | null },
): ScoreResult | null {
  // Drop the still-forming final candle — only ever score a closed bar,
  // same "evaluates on candle close" convention strategy-alert-eval uses,
  // so this doesn't flicker while the current 4h candle is still forming.
  const closed = candles.slice(0, -1);
  if (closed.length < TREND_SMA_PERIOD + 1) return null;

  const last = closed[closed.length - 1];
  const price = last.close;
  const isBuy = direction === "buy";

  const rsi = calcRSI(closed, RSI_PERIOD);
  const bbSeries = calcBBPctSeries(closed, BB_PERIOD);
  const bbPct = bbSeries[bbSeries.length - 1];
  const volRatio = calcVolRatio(closed, VOL_PERIOD);
  const atr = calcATR(closed, 14);
  const sma = calcSMA(closed, TREND_SMA_PERIOD);
  const smaRatio = sma !== null && sma > 0 ? price / sma : null;
  const macdSeries = calcMACDSeries(closed);
  const macdHist = (() => {
    const i = closed.length - 1;
    const line = macdSeries.line[i], sig = macdSeries.signal[i];
    return line !== null && sig !== null ? line - sig : null;
  })();
  const macdCross = (() => {
    const i = closed.length - 1;
    const prevLine = macdSeries.line[i - 1], prevSig = macdSeries.signal[i - 1];
    const line = macdSeries.line[i], sig = macdSeries.signal[i];
    if (prevLine === null || prevSig === null || line === null || sig === null) return null;
    if (isBuy) return prevLine <= prevSig && line > sig;   // bullish cross
    return prevLine >= prevSig && line < sig;               // bearish cross
  })();

  const lookbackIdx = closed.length - 1 - MOVE_LOOKBACK_CANDLES;
  const movePct = lookbackIdx >= 0
    ? ((price - closed[lookbackIdx].close) / closed[lookbackIdx].close) * 100
    : null;
  const atrPct = atr !== null && price > 0 ? (atr / price) * 100 : null;
  const moveThresholdPct = atrPct !== null ? atrPct * MOVE_ATR_MULTIPLE : null;

  const { fundingRate, longShortRatio } = positioning;
  const positioningHit = (() => {
    if (fundingRate === null && longShortRatio === null) return null;
    if (isBuy) {
      return (fundingRate !== null && fundingRate <= -FUNDING_EXTREME)
        || (longShortRatio !== null && longShortRatio <= LS_RATIO_SHORT_CROWDED);
    }
    return (fundingRate !== null && fundingRate >= FUNDING_EXTREME)
      || (longShortRatio !== null && longShortRatio >= LS_RATIO_LONG_CROWDED);
  })();

  const signals: SignalHit[] = [];
  if (rsi !== null && (isBuy ? rsi < RSI_OVERSOLD : rsi > RSI_OVERBOUGHT)) {
    signals.push({ id: "rsi", label: `RSI(${RSI_PERIOD}) ${isBuy ? "oversold" : "overbought"} — ${rsi.toFixed(1)}`, value: rsi });
  }
  if (bbPct !== null && (isBuy ? bbPct <= 0 : bbPct >= 1)) {
    signals.push({ id: "bb", label: `At/${isBuy ? "below" : "above"} ${isBuy ? "lower" : "upper"} Bollinger Band`, value: bbPct });
  }
  if (movePct !== null && moveThresholdPct !== null && (isBuy ? movePct <= -moveThresholdPct : movePct >= moveThresholdPct)) {
    signals.push({ id: "move", label: `${isBuy ? "Down" : "Up"} ${Math.abs(movePct).toFixed(1)}% over 48h (2x+ ATR)`, value: movePct });
  }
  if (volRatio !== null && volRatio > VOL_RATIO_THRESHOLD) {
    signals.push({ id: "volume", label: `Elevated volume — ${volRatio.toFixed(1)}x 20-period avg`, value: volRatio });
  }
  if (macdCross) {
    signals.push({ id: "macd", label: `MACD ${isBuy ? "bullish" : "bearish"} cross`, value: macdHist ?? 0 });
  }
  if (smaRatio !== null && (isBuy ? smaRatio > 1 : smaRatio < 1)) {
    signals.push({ id: "trend", label: `${isBuy ? "Above" : "Below"} 200-period trend average`, value: smaRatio });
  }
  if (positioningHit) {
    signals.push({
      id: "positioning",
      label: isBuy ? "Crowded short positioning" : "Crowded long positioning",
      value: fundingRate ?? longShortRatio ?? 0,
    });
  }

  return {
    score: signals.length, signals, price, rsi, bbPct, movePct, volRatio,
    macdHist, smaRatio, fundingRate, longShortRatio,
  };
}

const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Every elite profile opted into *something* here — per-fire eligibility
  // (direction toggle, muted coin, min confidence) is resolved per event
  // below, since it varies per coin/direction, not just per user.
  const { data: eliteProfiles } = await supabaseAdmin
    .from("profiles")
    .select("id, alert_sound, notify_buy_signals, notify_sell_signals, signal_muted_coins, signal_min_confidence")
    .eq("tier", "elite")
    .or("notify_buy_signals.eq.true,notify_sell_signals.eq.true");
  const allProfiles = eliteProfiles ?? [];
  const soundByUser = allProfiles.length
    ? await getSoundsByUser(allProfiles.map(p => p.id))
    : new Map();

  let accessToken: string | null = null;
  const ensureAccessToken = async () => accessToken ??= await getAccessToken();

  let scanned = 0;
  let fired = 0;
  const errors: unknown[] = [];

  for (const coin of SCAN_COINS) {
    scanned++;
    try {
      const [candles, positioning] = await Promise.all([
        fetchKlines(coin, INTERVAL, CANDLE_LIMIT),
        fetchPositioning(coin).catch(() => ({ fundingRate: null, longShortRatio: null })),
      ]);

      for (const direction of ["buy", "sell"] as Direction[]) {
        const result = scoreCoin(direction, candles, positioning);
        if (!result) continue;

        const isActive = result.score >= ACTIVE_THRESHOLD;

        const { data: prev } = await supabaseAdmin
          .from("buy_signals")
          .select("is_active")
          .eq("coin", coin)
          .eq("direction", direction)
          .maybeSingle();
        const wasActive = prev?.is_active ?? false;

        await supabaseAdmin.from("buy_signals").upsert({
          coin, direction,
          score: result.score,
          max_score: MAX_SCORE,
          signals: result.signals,
          price: result.price,
          rsi: result.rsi,
          bb_pct: result.bbPct,
          move_pct: result.movePct,
          vol_ratio: result.volRatio,
          macd_hist: result.macdHist,
          sma_ratio: result.smaRatio,
          funding_rate: result.fundingRate,
          long_short_ratio: result.longShortRatio,
          is_active: isActive,
          scanned_at: new Date().toISOString(),
        }, { onConflict: "coin,direction" });

        // Only a NEW crossing into "active" fires a notification — a coin
        // that stays active scan after scan doesn't re-alert every 4h.
        if (!isActive || wasActive) continue;

        await supabaseAdmin.from("buy_signal_fires").insert({
          coin, direction, score: result.score, signals: result.signals, price: result.price,
        });
        fired++;

        const confidence = confidenceOf(result.score);
        const confidenceRank = CONFIDENCE_RANK[confidence];
        const directionKey = direction === "buy" ? "notify_buy_signals" : "notify_sell_signals";
        const recipients = allProfiles.filter((p) =>
          p[directionKey]
          && !(p.signal_muted_coins ?? []).includes(coin)
          && confidenceRank >= (CONFIDENCE_RANK[p.signal_min_confidence ?? "low"] ?? 0));
        if (recipients.length === 0) continue;

        const label = direction === "buy" ? "Possible Buy Zone" : "Possible Sell Zone";
        const title = `${coin} — ${label} (${confidence[0].toUpperCase()}${confidence.slice(1)} confidence)`;
        const body = result.signals.map(s => s.label).join(" · ");
        const pushData = { type: "buy_signal", coin, direction, score: String(result.score), confidence };

        const recipientIds = recipients.map(p => p.id);
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
      }
    } catch (err) {
      console.error(`buy-signal-scan failed for ${coin}:`, err);
      errors.push({ coin, error: String(err) });
    }
  }

  return new Response(JSON.stringify({ scanned, fired, errors }), { headers: { "Content-Type": "application/json" } });
});
