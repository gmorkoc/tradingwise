// AI-built custom indicators.
//
// The AI never writes code. It returns a small JSON "recipe" made of the
// same building blocks the built-in catalog uses (EMA, RSI, ATR, …), math
// between them, comparisons, and how to draw the result. This file checks
// that recipe against a whitelist, turns it into a normal IndicatorDef (so
// every chart draws it like any other indicator), and stores the user's
// saved ones on the device.
import {
  sma, ema, dema, tema, trima, rma, roc, mstd, mmax, mmin, rsi, trix, vwma, vwap, atr, cci, willr,
  stoch, mfi, obv, cmf, psar, ao, aroon, bb, kc, dc, macd, vortex,
} from "indicatorts";
import { callOpenAI } from "./openai";
import { supabase } from "./supabase";
import { INDICATORS, type IndicatorDef, type IndLine } from "./indicatorLibrary";

// ── Recipe types ─────────────────────────────────────────────────────────
type Expr =
  | string // reference to a named series, or a price source
  | number
  | { const: number }
  | { fn: string; input?: Expr; period?: number; fast?: number; slow?: number; signal?: number; output?: string }
  | { op: string; a?: Expr; b?: Expr; by?: number };

export interface RecipePlot {
  series: string;
  style?: "line" | "histogram" | "dots" | "signal";
  color?: string;
  /** Per-candle color: condition → colorTrue / colorFalse. */
  colorWhen?: Expr;
  colorTrue?: string;
  colorFalse?: string;
  /** For style "signal": only draw where this condition is true. */
  when?: Expr;
  name?: string;
}

export interface Recipe {
  name: string;
  description: string;
  placement: "overlay" | "pane";
  series: Record<string, Expr>;
  plots: RecipePlot[];
  levels?: number[];
}

export interface CustomIndicator {
  id: string;
  prompt: string;
  recipe: Recipe;
  createdAt: number;
}

// ── Evaluation ───────────────────────────────────────────────────────────
interface Cols { o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }

const SOURCES: Record<string, (c: Cols) => number[]> = {
  close: (c) => c.c,
  open: (c) => c.o,
  high: (c) => c.h,
  low: (c) => c.l,
  volume: (c) => c.v,
  hl2: (c) => c.h.map((h, i) => (h + c.l[i]) / 2),
  hlc3: (c) => c.h.map((h, i) => (h + c.l[i] + c.c[i]) / 3),
  ohlc4: (c) => c.h.map((h, i) => (c.o[i] + h + c.l[i] + c.c[i]) / 4),
};

const per = (n: number | undefined, d: number) => Math.max(1, Math.min(500, Math.round(Number.isFinite(n) ? (n as number) : d)));

// Every function the AI may use. input = the series to run on (default close).
const FNS: Record<string, (x: number[], c: Cols, e: Record<string, number | string | undefined>) => number[]> = {
  sma: (x, _c, e) => sma(x, { period: per(e.period as number, 20) }),
  ema: (x, _c, e) => ema(x, { period: per(e.period as number, 20) }),
  dema: (x, _c, e) => dema(x, { period: per(e.period as number, 20) }),
  tema: (x, _c, e) => tema(x, { period: per(e.period as number, 20) }),
  trima: (x, _c, e) => trima(x, { period: per(e.period as number, 20) }),
  rma: (x, _c, e) => rma(x, { period: per(e.period as number, 14) }),
  roc: (x, _c, e) => roc(x, { period: per(e.period as number, 12) }),
  stdev: (x, _c, e) => mstd(x, { period: per(e.period as number, 20) }),
  highest: (x, _c, e) => mmax(x, { period: per(e.period as number, 20) }),
  lowest: (x, _c, e) => mmin(x, { period: per(e.period as number, 20) }),
  rsi: (x, _c, e) => rsi(x, { period: per(e.period as number, 14) }),
  trix: (x, _c, e) => trix(x, { period: per(e.period as number, 15) }),
  macd: (x, _c, e) => {
    const r = macd(x, { fast: per(e.fast as number, 12), slow: per(e.slow as number, 26), signal: per(e.signal as number, 9) });
    if (e.output === "signal") return r.signalLine;
    if (e.output === "histogram") return r.macdLine.map((v, i) => v - r.signalLine[i]);
    return r.macdLine;
  },
  bb: (x, _c, e) => {
    const r = bb(x, { period: per(e.period as number, 20) });
    return e.output === "lower" ? r.lower : e.output === "middle" ? r.middle : r.upper;
  },
  donchian: (x, _c, e) => {
    const r = dc(x, { period: per(e.period as number, 20) });
    return e.output === "lower" ? r.lower : e.output === "middle" ? r.middle : r.upper;
  },
  // Price-based (ignore input):
  atr: (_x, c, e) => atr(c.h, c.l, c.c, { period: per(e.period as number, 14) }).atrLine,
  cci: (_x, c, e) => cci(c.h, c.l, c.c, { period: per(e.period as number, 20) }),
  willr: (_x, c, e) => willr(c.h, c.l, c.c, { period: per(e.period as number, 14) }),
  stoch_k: (_x, c, e) => stoch(c.h, c.l, c.c, { kPeriod: per(e.period as number, 14), dPeriod: 3 }).k,
  stoch_d: (_x, c, e) => stoch(c.h, c.l, c.c, { kPeriod: per(e.period as number, 14), dPeriod: 3 }).d,
  mfi: (_x, c, e) => mfi(c.h, c.l, c.c, c.v, { period: per(e.period as number, 14) }),
  obv: (_x, c) => obv(c.c, c.v),
  cmf: (_x, c, e) => cmf(c.h, c.l, c.c, c.v, { period: per(e.period as number, 20) }),
  vwap: (_x, c, e) => vwap(c.c, c.v, { period: per(e.period as number, 14) }),
  vwma: (_x, c, e) => vwma(c.c, c.v, { period: per(e.period as number, 20) }),
  psar: (_x, c) => psar(c.h, c.l, c.c).psarResult,
  ao: (_x, c) => ao(c.h, c.l),
  aroon_up: (_x, c, e) => aroon(c.h, c.l, { period: per(e.period as number, 25) }).up,
  aroon_down: (_x, c, e) => aroon(c.h, c.l, { period: per(e.period as number, 25) }).down,
  keltner: (_x, c, e) => {
    const r = kc(c.h, c.l, c.c, { period: per(e.period as number, 20) });
    return e.output === "lower" ? r.lower : e.output === "middle" ? r.middle : r.upper;
  },
  vortex_plus: (_x, c, e) => vortex(c.h, c.l, c.c, { period: per(e.period as number, 14) }).plus,
  vortex_minus: (_x, c, e) => vortex(c.h, c.l, c.c, { period: per(e.period as number, 14) }).minus,
};

const BIN_OPS: Record<string, (a: number, b: number) => number> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => (b === 0 ? NaN : a / b),
  max: (a, b) => Math.max(a, b),
  min: (a, b) => Math.min(a, b),
  gt: (a, b) => (a > b ? 1 : 0),
  lt: (a, b) => (a < b ? 1 : 0),
  gte: (a, b) => (a >= b ? 1 : 0),
  lte: (a, b) => (a <= b ? 1 : 0),
  and: (a, b) => (a && b ? 1 : 0),
  or: (a, b) => (a || b ? 1 : 0),
};

function evaluate(expr: Expr, cols: Cols, named: Record<string, Expr>, memo: Map<string, number[]>, depth = 0): number[] {
  if (depth > 40) throw new Error("Recipe is nested too deeply.");
  const n = cols.c.length;
  if (typeof expr === "number") return new Array(n).fill(expr);
  if (typeof expr === "string") {
    if (SOURCES[expr]) return SOURCES[expr](cols);
    if (memo.has(expr)) return memo.get(expr)!;
    if (!(expr in named)) throw new Error(`Unknown series "${expr}".`);
    memo.set(expr, new Array(n).fill(NaN)); // cycle guard
    const v = evaluate(named[expr], cols, named, memo, depth + 1);
    memo.set(expr, v);
    return v;
  }
  if ("const" in expr) return new Array(n).fill(Number(expr.const));
  if ("fn" in expr) {
    const f = FNS[expr.fn];
    if (!f) throw new Error(`Unknown function "${expr.fn}".`);
    const input = expr.input != null ? evaluate(expr.input, cols, named, memo, depth + 1) : cols.c;
    const out = f(input.map((v) => (Number.isFinite(v) ? v : 0)), cols, expr as never);
    return out.length === n ? out : out.slice(0, n);
  }
  if ("op" in expr) {
    const op = expr.op;
    const A = expr.a != null ? evaluate(expr.a, cols, named, memo, depth + 1) : null;
    const B = expr.b != null ? evaluate(expr.b, cols, named, memo, depth + 1) : null;
    if (BIN_OPS[op]) {
      if (!A || !B) throw new Error(`"${op}" needs a and b.`);
      return A.map((a, i) => BIN_OPS[op](a, B[i]));
    }
    if (!A) throw new Error(`"${op}" needs a.`);
    switch (op) {
      case "abs": return A.map(Math.abs);
      case "neg": return A.map((a) => -a);
      case "not": return A.map((a) => (a ? 0 : 1));
      case "shift": { const k = per(expr.by, 1); return A.map((_, i) => (i - k >= 0 ? A[i - k] : NaN)); }
      case "crossover":
        if (!B) throw new Error(`"crossover" needs a and b.`);
        return A.map((a, i) => (i > 0 && a > B[i] && A[i - 1] <= B[i - 1] ? 1 : 0));
      case "crossunder":
        if (!B) throw new Error(`"crossunder" needs a and b.`);
        return A.map((a, i) => (i > 0 && a < B[i] && A[i - 1] >= B[i - 1] ? 1 : 0));
      case "change": return A.map((a, i) => (i > 0 ? a - A[i - 1] : NaN));
    }
    throw new Error(`Unknown operation "${op}".`);
  }
  throw new Error("Invalid recipe value.");
}

function maxPeriod(expr: Expr, named: Record<string, Expr>, seen = new Set<string>()): number {
  if (typeof expr === "string") {
    if (SOURCES[expr] || seen.has(expr) || !(expr in named)) return 0;
    seen.add(expr);
    return maxPeriod(named[expr], named, seen);
  }
  if (typeof expr !== "object" || expr == null) return 0;
  const self = "fn" in expr ? Math.max(Number(expr.period) || 0, Number(expr.slow) || 0, expr.fn === "macd" ? 35 : 0, expr.fn === "ao" ? 34 : 0) : 0;
  const kids = ["input", "a", "b"].map((k) => (k in expr ? maxPeriod((expr as Record<string, Expr>)[k], named, seen) : 0));
  return self + Math.max(0, ...kids);
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const safeColor = (c: unknown, d: string) => (typeof c === "string" && HEX.test(c) ? c : d);
const PALETTE = ["#3b82f6", "#f97316", "#22c55e", "#a855f7", "#ef4444", "#06b6d4"];

/** Checks a recipe and turns it into a regular IndicatorDef. Throws a readable error if it can't. */
export function compileRecipe(id: string, recipe: Recipe): IndicatorDef {
  if (!recipe || typeof recipe !== "object") throw new Error("Empty recipe.");
  if (!recipe.series || typeof recipe.series !== "object") throw new Error("Recipe has no series.");
  if (!Array.isArray(recipe.plots) || recipe.plots.length === 0) throw new Error("Recipe has nothing to draw.");
  if (recipe.plots.length > 8) throw new Error("Too many lines (max 8).");
  const named = recipe.series;
  const placement = recipe.placement === "pane" ? "pane" : "overlay";
  const warmup = Math.min(300, Math.max(1, ...recipe.plots.map((p) => maxPeriod(p.series, named))));

  const def: IndicatorDef = {
    id,
    name: String(recipe.name || "My indicator").slice(0, 48),
    category: "My indicators",
    kind: placement,
    description: String(recipe.description || "").slice(0, 240),
    warmup,
    levels: Array.isArray(recipe.levels) ? recipe.levels.filter((l) => Number.isFinite(l)).slice(0, 4) : undefined,
    compute: (cols) => {
      const memo = new Map<string, number[]>();
      return recipe.plots.map((p, i): IndLine => {
        const values = evaluate(p.series, cols, named, memo);
        const base = safeColor(p.color, PALETTE[i % PALETTE.length]);
        const style = p.style === "histogram" ? "histogram" : p.style === "dots" || p.style === "signal" ? "dots" : "line";
        let out = values;
        if (p.style === "signal" && p.when != null) {
          const w = evaluate(p.when, cols, named, memo);
          out = values.map((v, k) => (w[k] ? v : NaN));
        }
        let colors: (string | undefined)[] | undefined;
        if (p.colorWhen != null) {
          const w = evaluate(p.colorWhen, cols, named, memo);
          const t = safeColor(p.colorTrue, "#22c55e");
          const f = safeColor(p.colorFalse, "#ef4444");
          colors = w.map((x) => (x ? t : f));
        }
        return { name: String(p.name || p.series).slice(0, 24), color: base, values: out, style, colors };
      });
    },
  };
  // Dry run on synthetic candles so a broken recipe fails here, not on the chart.
  const n = 260;
  const cs = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 7) * 6 + i * 0.03);
  const test: Cols = { o: cs.map((x) => x - 0.4), h: cs.map((x) => x + 1.2), l: cs.map((x) => x - 1.2), c: cs, v: cs.map((_, i) => 1000 + (i % 9) * 40) };
  const lines = def.compute(test as never);
  if (!lines.some((l) => l.values.some((v) => Number.isFinite(v)))) throw new Error("Recipe produced no values.");
  return def;
}

// ── Store: account (Supabase custom_indicators) + device cache ───────────
// The device copy makes charts draw instantly; the account copy makes a
// user's indicators follow them to every device. Writes go to both.
const STORE_KEY = "customIndicatorsV1";
const STORE_EVENT = "custom-indicators-changed";
const compiled = new Map<string, IndicatorDef>();

export function listCustomIndicators(): CustomIndicator[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => x && typeof x.id === "string" && x.recipe) : [];
  } catch {
    return [];
  }
}

function writeStore(list: CustomIndicator[]) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  compiled.clear();
  window.dispatchEvent(new Event(STORE_EVENT));
}

async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

async function pushRemote(ci: CustomIndicator, userId: string) {
  const { error } = await supabase.from("custom_indicators").upsert({
    id: ci.id,
    user_id: userId,
    prompt: ci.prompt,
    recipe: ci.recipe,
    created_at: new Date(ci.createdAt).toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (error) console.error("custom indicator sync failed:", error.message);
}

export function saveCustomIndicator(ci: CustomIndicator) {
  const list = listCustomIndicators().filter((x) => x.id !== ci.id);
  writeStore([...list, ci]);
  currentUserId().then((uid) => { if (uid) pushRemote(ci, uid); });
}

export function deleteCustomIndicator(id: string) {
  writeStore(listCustomIndicators().filter((x) => x.id !== id));
  currentUserId().then((uid) => {
    if (!uid) return;
    supabase.from("custom_indicators").delete().eq("id", id).eq("user_id", uid)
      .then(({ error }) => { if (error) console.error("custom indicator delete failed:", error.message); });
  });
}

// Pull the account's indicators, upload any made on this device while
// logged out, and make the device cache match the account.
async function syncFromAccount(userId: string) {
  const { data, error } = await supabase
    .from("custom_indicators")
    .select("id, prompt, recipe, created_at")
    .order("created_at", { ascending: true });
  if (error) { console.error("custom indicator load failed:", error.message); return; }
  const remote: CustomIndicator[] = (data ?? []).map((r) => ({
    id: r.id as string,
    prompt: (r.prompt as string) ?? "",
    recipe: r.recipe as Recipe,
    createdAt: new Date(r.created_at as string).getTime(),
  }));
  const remoteIds = new Set(remote.map((r) => r.id));
  const localOnly = listCustomIndicators().filter((x) => !remoteIds.has(x.id));
  await Promise.all(localOnly.map((ci) => pushRemote(ci, userId)));
  writeStore([...remote, ...localOnly]);
}

let syncStarted = false;
/** Keeps the device cache in step with the signed-in account. Safe to call many times. */
export function startCustomIndicatorSync() {
  if (syncStarted) return;
  syncStarted = true;
  let lastUser: string | null = null;
  supabase.auth.onAuthStateChange((event, session) => {
    const uid = session?.user?.id ?? null;
    if (event === "SIGNED_OUT" || (!uid && lastUser)) {
      // Someone else may use this device next — drop the signed-out user's copy.
      lastUser = null;
      writeStore([]);
      return;
    }
    if (uid && uid !== lastUser) {
      lastUser = uid;
      // Outside the auth callback (supabase-js can deadlock on calls made inside it).
      setTimeout(() => { syncFromAccount(uid); }, 0);
    }
  });
}

export function onCustomIndicatorsChange(fn: () => void): () => void {
  window.addEventListener(STORE_EVENT, fn);
  return () => window.removeEventListener(STORE_EVENT, fn);
}

/** Built-in catalog first, then the user's saved AI indicators. */
export function getIndicatorDef(id: string): IndicatorDef | undefined {
  const builtIn = INDICATORS.find((d) => d.id === id);
  if (builtIn) return builtIn;
  if (!id.startsWith("ai-")) return undefined;
  if (compiled.has(id)) return compiled.get(id);
  const ci = listCustomIndicators().find((x) => x.id === id);
  if (!ci) return undefined;
  try {
    const def = compileRecipe(id, ci.recipe);
    compiled.set(id, def);
    return def;
  } catch {
    return undefined;
  }
}

// ── AI ───────────────────────────────────────────────────────────────────
const SYSTEM = `You design trading-chart indicators as JSON recipes. You never write code.

Return ONLY a JSON object:
{
  "name": short name (max 40 chars),
  "description": one plain-English sentence on what it shows and how to read it,
  "placement": "overlay" (drawn on the price, values in price units) or "pane" (own panel under the chart, for oscillators/ratios/volume),
  "series": { "<name>": <expr>, ... },
  "plots": [ { "series": "<name>", "style": "line"|"histogram"|"dots"|"signal", "color": "#rrggbb", "name": "label",
               "colorWhen": <condition expr, optional>, "colorTrue": "#rrggbb", "colorFalse": "#rrggbb",
               "when": <condition expr, only for style "signal"> } ],
  "levels": [numbers, optional — dashed guide lines for pane indicators, e.g. [70, 30]]
}

<expr> is one of:
- a price source: "close" "open" "high" "low" "volume" "hl2" "hlc3" "ohlc4"
- the name of another series in "series"
- a number
- {"fn": F, "input": <expr, default close>, "period": n, ...}
  F on any input: sma ema dema tema trima rma roc stdev highest lowest rsi trix
    macd (fast, slow, signal, output: "line"|"signal"|"histogram")
    bb (period, output: "upper"|"middle"|"lower" — 2 std dev)
    donchian (period, output: "upper"|"middle"|"lower")
  F on the candles (input ignored): atr cci willr stoch_k stoch_d mfi obv cmf vwap vwma psar ao aroon_up aroon_down
    keltner (period, output) vortex_plus vortex_minus
- {"op": OP, "a": <expr>, "b": <expr>}  OP: add sub mul div max min gt lt gte lte and or crossover crossunder
- {"op": "abs"|"neg"|"not"|"change", "a": <expr>}
- {"op": "shift", "a": <expr>, "by": n}   (value n candles ago)
Conditions are exprs that are 1 (true) or 0 (false).

Rules:
- Use only what is listed. Periods 1–500.
- A "signal" plot draws dots at its series value only where "when" is true — e.g. series "low" with when = crossover, to mark entries under candles.
- Use colorWhen for lines/histograms that change color (green "#22c55e" up / red "#ef4444" down are good defaults).
- Mixing price-unit lines with 0–100 oscillators in one indicator is not allowed: pick one placement.
- If the request is impossible with these blocks, build the closest useful version and say so in the description.`;

export async function buildIndicatorWithAI(prompt: string, previous?: Recipe): Promise<Recipe> {
  const userMsg = previous
    ? `Current indicator recipe:\n${JSON.stringify(previous)}\n\nChange it as follows: ${prompt}`
    : `Build this indicator: ${prompt}`;
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = [
      { role: "system", content: SYSTEM },
      { role: "user", content: userMsg },
      ...(lastErr ? [{ role: "user", content: `That recipe failed validation: ${lastErr}. Fix it and return the full JSON again.` }] : []),
    ];
    const data = await callOpenAI({
      model: "gpt-4o",
      messages,
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 1400,
    });
    let recipe: Recipe;
    try {
      recipe = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
    } catch {
      lastErr = "not valid JSON";
      continue;
    }
    try {
      compileRecipe("ai-check", recipe);
      return recipe;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  throw new Error(`Couldn't build that indicator (${lastErr}). Try describing it differently.`);
}
