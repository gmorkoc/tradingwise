import { supabase } from "./supabase";
import { CandleDataPoint, CoinSymbol } from "./coinglass";
import { calcEMA, calcRSI, calcMACDSeries, calcBBPctSeries, calcATR, calcTEMA, calcVolRatio } from "./indicators";

export type IndicatorId = "price" | "ema" | "rsi" | "macd" | "macdHist" | "bb" | "atr" | "tema" | "volRatio";

export type ConditionType = "threshold" | "crossover"; // Phase 2 adds "pctChange" | "divergence"

export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "1d" | "1w";

export type ComparisonTarget =
  | { kind: "value"; value: number }
  | { kind: "price" }
  | { kind: "indicator"; indicator: IndicatorId; params?: Record<string, number> };

export interface StrategyCondition {
  id: string;
  indicator: IndicatorId;
  params?: Record<string, number>;
  timeframe: Timeframe;
  type: ConditionType;
  operator?: ">" | "<" | ">=" | "<=";
  target: ComparisonTarget;
  direction?: "above" | "below";
}

export interface StrategyAlert {
  id: string;
  userId: string;
  name: string;
  templateId: string | null;
  logic: "AND" | "OR";
  conditions: StrategyCondition[];
  coins: string[];
  cooldownMinutes: number;
  enabled: boolean;
  createdAt: string;
}

export interface StrategyFire {
  id: number;
  strategyId: string;
  coin: string;
  timeframe: string;
  summary: string;
  firedAt: string;
}

export const INDICATOR_LABELS: Record<IndicatorId, string> = {
  price: "Price",
  ema: "EMA",
  rsi: "RSI",
  macd: "MACD Line",
  macdHist: "MACD Histogram",
  bb: "Bollinger %B",
  atr: "ATR",
  tema: "TEMA",
  volRatio: "Volume Ratio",
};

export interface StrategyTemplate {
  id: string;
  name: string;
  glyph: string;
  color: string;
  desc: string;
  previewText: string;
  logic: "AND" | "OR";
  conditions: Omit<StrategyCondition, "id">[];
  defaultCoins: string[];
  defaultCooldownMinutes: number;
}

export const TEMPLATES: StrategyTemplate[] = [
  {
    id: "ema-cross",
    name: "EMA 9 / 21 Cross",
    glyph: "EMA",
    color: "#818cf8",
    desc: "EMA(9) crosses above or below EMA(21) — a classic trend-shift signal.",
    previewText: "EMA(9) crosses EMA(21) · 1h",
    logic: "AND",
    conditions: [
      {
        indicator: "ema",
        params: { period: 9 },
        timeframe: "1h",
        type: "crossover",
        target: { kind: "indicator", indicator: "ema", params: { period: 21 } },
      },
    ],
    defaultCoins: ["BTC"],
    defaultCooldownMinutes: 60,
  },
  {
    id: "rsi-extreme",
    name: "RSI Extreme Zone",
    glyph: "RSI",
    color: "#f59e0b",
    desc: "RSI(14) drops below 30 or climbs above 70 — classic oversold/overbought.",
    previewText: "RSI(14) < 30 · 4h",
    logic: "AND",
    conditions: [
      { indicator: "rsi", params: { period: 14 }, timeframe: "4h", type: "threshold", operator: "<", target: { kind: "value", value: 30 } },
    ],
    defaultCoins: ["BTC"],
    defaultCooldownMinutes: 240,
  },
  {
    id: "macd-zero-cross",
    name: "MACD Zero-Cross",
    glyph: "MAC",
    color: "#38bdf8",
    desc: "MACD line crosses its zero line — momentum flipping direction.",
    previewText: "MACD line crosses 0 · 1h",
    logic: "AND",
    conditions: [
      { indicator: "macd", timeframe: "1h", type: "crossover", target: { kind: "value", value: 0 } },
    ],
    defaultCoins: ["BTC"],
    defaultCooldownMinutes: 60,
  },
  {
    id: "bb-breakout",
    name: "Bollinger Band Breakout",
    glyph: "BB",
    color: "#fb7185",
    desc: "Price closes outside either Bollinger Band — a volatility expansion.",
    previewText: "%B > 1 or < 0 · 1h",
    logic: "OR",
    conditions: [
      { indicator: "bb", timeframe: "1h", type: "threshold", operator: ">", target: { kind: "value", value: 1 } },
      { indicator: "bb", timeframe: "1h", type: "threshold", operator: "<", target: { kind: "value", value: 0 } },
    ],
    defaultCoins: ["BTC"],
    defaultCooldownMinutes: 60,
  },
  {
    id: "volume-spike",
    name: "Volume Spike",
    glyph: "VOL",
    color: "#22c55e",
    desc: "Volume exceeds 2× its 20-period average — something's happening.",
    previewText: "Volume ratio > 2 · 15m",
    logic: "AND",
    conditions: [
      { indicator: "volRatio", params: { period: 20 }, timeframe: "15m", type: "threshold", operator: ">", target: { kind: "value", value: 2 } },
    ],
    defaultCoins: ["BTC"],
    defaultCooldownMinutes: 15,
  },
];

// ── Indicator resolution (client-side preview only — the edge function has
// its own ported twin against server-fetched candles) ──────────────────────

function resolveIndicatorSeries(indicator: IndicatorId, candles: CandleDataPoint[], params?: Record<string, number>): (number | null)[] {
  switch (indicator) {
    case "price":
      return candles.map(c => c.close);
    case "ema":
      return calcEMA(candles.map(c => c.close), params?.period ?? 20).map(v => (isNaN(v) ? null : v));
    case "rsi": {
      // Only the latest value is cheap via calcRSI; build a minimal series by
      // sliding the window for the small number of points a preview needs.
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

function resolveTargetSeries(target: ComparisonTarget, candles: CandleDataPoint[]): (number | null)[] {
  if (target.kind === "value") return candles.map(() => target.value);
  if (target.kind === "price") return candles.map(c => c.close);
  return resolveIndicatorSeries(target.indicator, candles, target.params);
}

function evaluateConditionAt(condition: StrategyCondition, series: (number | null)[], targetSeries: (number | null)[], i: number): boolean {
  const v = series[i];
  if (v == null) return false;
  if (condition.type === "threshold") {
    const t = targetSeries[i];
    if (t == null || !condition.operator) return false;
    if (condition.operator === ">") return v > t;
    if (condition.operator === "<") return v < t;
    if (condition.operator === ">=") return v >= t;
    return v <= t;
  }
  // crossover
  if (i === 0) return false;
  const prevV = series[i - 1], prevT = targetSeries[i - 1], t = targetSeries[i];
  if (prevV == null || prevT == null || t == null) return false;
  const wasBelow = prevV < prevT, isAbove = v > t;
  const wasAbove = prevV > prevT, isBelow = v < t;
  if (condition.direction === "above") return wasBelow && isAbove;
  if (condition.direction === "below") return wasAbove && isBelow;
  return (wasBelow && isAbove) || (wasAbove && isBelow);
}

/** Client-side "would this have fired recently" preview against one coin's
 * already-fetched candles — for the Builder tab's live hint only. The real
 * evaluation happens server-side in strategy-alert-eval. */
export function evaluateStrategyPreview(
  logic: "AND" | "OR",
  conditions: StrategyCondition[],
  candles: CandleDataPoint[],
): number {
  if (conditions.length === 0 || candles.length === 0) return 0;
  const seriesByCondition = conditions.map(c => ({
    series: resolveIndicatorSeries(c.indicator, candles, c.params),
    targetSeries: resolveTargetSeries(c.target, candles),
  }));
  let hits = 0;
  for (let i = 1; i < candles.length; i++) {
    const results = conditions.map((c, idx) => evaluateConditionAt(c, seriesByCondition[idx].series, seriesByCondition[idx].targetSeries, i));
    const fired = logic === "AND" ? results.every(Boolean) : results.some(Boolean);
    if (fired) hits++;
  }
  return hits;
}

// ── Supabase CRUD ────────────────────────────────────────────────────────

interface StrategyAlertRow {
  id: string;
  user_id: string;
  name: string;
  template_id: string | null;
  logic: "AND" | "OR";
  conditions: StrategyCondition[];
  coins: string[];
  cooldown_minutes: number;
  enabled: boolean;
  created_at: string;
}

function fromRow(row: StrategyAlertRow): StrategyAlert {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    templateId: row.template_id,
    logic: row.logic,
    conditions: row.conditions,
    coins: row.coins,
    cooldownMinutes: row.cooldown_minutes,
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

export async function fetchMyStrategies(): Promise<StrategyAlert[]> {
  const { data, error } = await supabase.from("strategy_alerts").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return (data as StrategyAlertRow[]).map(fromRow);
}

export async function createStrategy(input: {
  userId: string;
  name: string;
  templateId: string | null;
  logic: "AND" | "OR";
  conditions: StrategyCondition[];
  coins: CoinSymbol[] | string[];
  cooldownMinutes: number;
}): Promise<StrategyAlert> {
  const { data, error } = await supabase
    .from("strategy_alerts")
    .insert({
      user_id: input.userId,
      name: input.name,
      template_id: input.templateId,
      logic: input.logic,
      conditions: input.conditions,
      coins: input.coins,
      cooldown_minutes: input.cooldownMinutes,
    })
    .select()
    .single();
  if (error) throw error;
  return fromRow(data as StrategyAlertRow);
}

export async function setStrategyEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from("strategy_alerts").update({ enabled }).eq("id", id);
  if (error) throw error;
}

export async function deleteStrategy(id: string): Promise<void> {
  const { error } = await supabase.from("strategy_alerts").delete().eq("id", id);
  if (error) throw error;
}

export async function duplicateStrategy(strategy: StrategyAlert): Promise<StrategyAlert> {
  return createStrategy({
    userId: strategy.userId,
    name: `${strategy.name} (copy)`,
    templateId: strategy.templateId,
    logic: strategy.logic,
    conditions: strategy.conditions,
    coins: strategy.coins,
    cooldownMinutes: strategy.cooldownMinutes,
  });
}

export async function fetchRecentFires(limit = 20): Promise<StrategyFire[]> {
  const { data, error } = await supabase
    .from("strategy_fires")
    .select("*")
    .order("fired_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as { id: number; strategy_id: string; coin: string; timeframe: string; summary: string; fired_at: string }[]).map(r => ({
    id: r.id,
    strategyId: r.strategy_id,
    coin: r.coin,
    timeframe: r.timeframe,
    summary: r.summary,
    firedAt: r.fired_at,
  }));
}
