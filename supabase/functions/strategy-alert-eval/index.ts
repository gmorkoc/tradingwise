import { supabaseAdmin, getAccessToken, sendPush, getSoundsByUser } from "../_shared/fcm.ts";
import { sendWebPush, getWebPushSubscriptions } from "../_shared/webpush.ts";
import { fetchKlines } from "../_shared/klines.ts";
import {
  CandleDataPoint,
  calcEMA, calcRSI, calcMACDSeries, calcBBPctSeries, calcATR, calcTEMA, calcVolRatio,
} from "../_shared/indicators.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

// Mirrors the types in src/services/strategyAlerts.ts (that file is not
// importable from here — see _shared/indicators.ts's header comment).
type IndicatorId = "price" | "ema" | "rsi" | "macd" | "macdHist" | "bb" | "atr" | "tema" | "volRatio";
type ConditionType = "threshold" | "crossover";
type ComparisonTarget =
  | { kind: "value"; value: number }
  | { kind: "price" }
  | { kind: "indicator"; indicator: IndicatorId; params?: Record<string, number> };
interface StrategyCondition {
  id: string;
  indicator: IndicatorId;
  params?: Record<string, number>;
  timeframe: string;
  type: ConditionType;
  operator?: ">" | "<" | ">=" | "<=";
  target: ComparisonTarget;
  direction?: "above" | "below";
}
interface StrategyRow {
  id: string;
  user_id: string;
  name: string;
  logic: "AND" | "OR";
  conditions: StrategyCondition[];
  coins: string[];
  cooldown_minutes: number;
}

// Candle sets are cached per (coin, timeframe) for the whole run — many
// strategies/conditions on the same pair only cost one fetch.
const candleCache = new Map<string, CandleDataPoint[]>();
async function getCandles(coin: string, timeframe: string): Promise<CandleDataPoint[]> {
  const key = `${coin}:${timeframe}`;
  if (candleCache.has(key)) return candleCache.get(key)!;
  const candles = await fetchKlines(coin, timeframe, 300);
  // Drop the still-forming final candle so evaluation only ever sees closed
  // bars — matches TickScan's "evaluates on candle close" behavior and
  // avoids crossovers flickering on a bar that hasn't finished yet.
  const closed = candles.slice(0, -1);
  candleCache.set(key, closed);
  return closed;
}

function resolveSeries(indicator: IndicatorId, candles: CandleDataPoint[], params?: Record<string, number>): (number | null)[] {
  switch (indicator) {
    case "price":
      return candles.map(c => c.close);
    case "ema":
      return calcEMA(candles.map(c => c.close), params?.period ?? 20).map(v => (isNaN(v) ? null : v));
    case "rsi": {
      const period = params?.period ?? 14;
      return candles.map((_, i) => (i < period ? null : calcRSI(candles.slice(0, i + 1), period)));
    }
    case "macd":
      return calcMACDSeries(candles).line;
    case "macdHist": {
      const { line, signal } = calcMACDSeries(candles);
      return line.map((l, i) => (l == null || signal[i] == null ? null : l - signal[i]!));
    }
    case "bb":
      return calcBBPctSeries(candles, params?.period ?? 20);
    case "atr": {
      const period = params?.period ?? 14;
      return candles.map((_, i) => (i < period ? null : calcATR(candles.slice(0, i + 1), period)));
    }
    case "tema":
      return calcTEMA(candles.map(c => c.close), params?.period ?? 14);
    case "volRatio": {
      const period = params?.period ?? 20;
      return candles.map((_, i) => (i < period ? null : calcVolRatio(candles.slice(0, i + 1), period)));
    }
  }
}

function resolveTarget(target: ComparisonTarget, candles: CandleDataPoint[]): (number | null)[] {
  if (target.kind === "value") return candles.map(() => target.value);
  if (target.kind === "price") return candles.map(c => c.close);
  return resolveSeries(target.indicator, candles, target.params);
}

function targetLabel(target: ComparisonTarget): string {
  if (target.kind === "value") return String(target.value);
  if (target.kind === "price") return "price";
  return `${target.indicator}${target.params?.period ? `(${target.params.period})` : ""}`;
}

/** Evaluates one condition against one coin's last-closed candle; returns
 * whether it fired plus a human-readable summary fragment for the push. */
function evaluateCondition(condition: StrategyCondition, candles: CandleDataPoint[]): { fired: boolean; summary: string } {
  const series = resolveSeries(condition.indicator, candles, condition.params);
  const targetSeries = resolveTarget(condition.target, candles);
  const i = candles.length - 1;
  const label = `${INDICATOR_NAMES[condition.indicator]}${condition.params?.period ? `(${condition.params.period})` : ""}(${condition.timeframe})`;

  if (i < 1) return { fired: false, summary: "" };
  const v = series[i];

  if (condition.type === "threshold") {
    const t = targetSeries[i];
    if (v == null || t == null || !condition.operator) return { fired: false, summary: "" };
    const ops: Record<string, (a: number, b: number) => boolean> = {
      ">": (a, b) => a > b, "<": (a, b) => a < b, ">=": (a, b) => a >= b, "<=": (a, b) => a <= b,
    };
    const fired = ops[condition.operator](v, t);
    return { fired, summary: `${label} ${condition.operator} ${targetLabel(condition.target)} (${v.toFixed(2)})` };
  }

  // crossover
  const prevV = series[i - 1], prevT = targetSeries[i - 1], t = targetSeries[i];
  if (v == null || prevV == null || prevT == null || t == null) return { fired: false, summary: "" };
  const wasBelow = prevV < prevT, isAbove = v > t;
  const wasAbove = prevV > prevT, isBelow = v < t;
  const crossedUp = wasBelow && isAbove, crossedDown = wasAbove && isBelow;
  const fired = condition.direction === "above" ? crossedUp : condition.direction === "below" ? crossedDown : crossedUp || crossedDown;
  const dirWord = crossedUp ? "crossed above" : "crossed below";
  return { fired, summary: `${label} ${dirWord} ${targetLabel(condition.target)}` };
}

const INDICATOR_NAMES: Record<IndicatorId, string> = {
  price: "Price", ema: "EMA", rsi: "RSI", macd: "MACD", macdHist: "MACD Hist",
  bb: "%B", atr: "ATR", tema: "TEMA", volRatio: "Vol Ratio",
};

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { data: strategies } = await supabaseAdmin
    .from("strategy_alerts")
    .select("id, user_id, name, logic, conditions, coins, cooldown_minutes")
    .eq("enabled", true);

  let evaluated = 0;
  let fired = 0;
  let accessToken: string | null = null;
  const ensureAccessToken = async () => accessToken ??= await getAccessToken();
  const debug: unknown[] = [];

  for (const strategy of (strategies ?? []) as StrategyRow[]) {
    for (const coin of strategy.coins) {
      evaluated++;
      try {
        const results = await Promise.all(
          strategy.conditions.map(async (c) => {
            const candles = await getCandles(coin, c.timeframe);
            return evaluateCondition(c, candles);
          }),
        );
        const hit = strategy.logic === "AND" ? results.every(r => r.fired) : results.some(r => r.fired);
        debug.push({ strategy: strategy.name, coin, logic: strategy.logic, results, hit });
        if (!hit) continue;

        // Cooldown: has this exact strategy+coin fired within the window?
        const { data: lastFire } = await supabaseAdmin
          .from("strategy_fires")
          .select("fired_at")
          .eq("strategy_id", strategy.id)
          .eq("coin", coin)
          .order("fired_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastFire) {
          const elapsedMin = (Date.now() - new Date(lastFire.fired_at).getTime()) / 60000;
          if (elapsedMin < strategy.cooldown_minutes) continue;
        }

        const summary = results.filter(r => r.fired).map(r => r.summary).join(" and ") || `${strategy.name} conditions met`;
        const timeframe = strategy.conditions[0]?.timeframe ?? "1h";

        await supabaseAdmin.from("strategy_fires").insert({
          strategy_id: strategy.id, user_id: strategy.user_id, coin, timeframe, summary,
        });
        fired++;

        const { data: profile } = await supabaseAdmin
          .from("profiles")
          .select("alert_sound, notify_strategy_alerts")
          .eq("id", strategy.user_id)
          .single();
        if (profile?.notify_strategy_alerts === false) continue;

        const title = `${coin} — ${strategy.name}`;
        const pushData = { type: "strategy_alert", strategyId: strategy.id, coin };

        // Native app (FCM/APNs) and web browser (Web Push) are independent
        // channels — a user can have either, both, or neither registered.
        const { data: tokens } = await supabaseAdmin.from("device_push_tokens").select("token").eq("user_id", strategy.user_id);
        if (tokens && tokens.length > 0) {
          const soundByUser = await getSoundsByUser([strategy.user_id]);
          const token = await ensureAccessToken();
          await Promise.all(
            tokens.map(({ token: t }) => sendPush(token, t, title, summary, soundByUser.get(strategy.user_id) ?? "bell", pushData, "time-sensitive")),
          );
        }

        const webSubs = await getWebPushSubscriptions(strategy.user_id);
        if (webSubs.length > 0) {
          const webResults = await Promise.all(webSubs.map((sub) => sendWebPush(sub, title, summary, pushData)));
          debug.push({ webPushAttempt: true, subCount: webSubs.length, results: webResults });
        } else {
          debug.push({ webPushAttempt: false, reason: "no subscriptions for this user" });
        }
      } catch (err) {
        console.error(`strategy ${strategy.id} / ${coin} failed:`, err);
      }
    }
  }

  return new Response(JSON.stringify({ evaluated, fired, debug }), { headers: { "Content-Type": "application/json" } });
});
