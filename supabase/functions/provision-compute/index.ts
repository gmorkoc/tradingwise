// ProVision results — the only place the ProVision engine runs.
//
// The app sends the chart's own candles (so results line up exactly with
// what's on screen, and so we never fetch exchange data from a server
// region that exchanges block). Before computing anything this checks the
// user's access with claim_provision_coin, which also counts Pro's 3 coins
// per 24h on the server. Without access: 403, nothing computed.
//
// Request  { coin, main?: Wire[], htf?: Wire[], shortSec?: number, mtf?: { label, candles: Wire[] }[] }
//   Wire = [time, open, high, low, close, volume|-1, takerBuyVolume|-1]
// Response { result?: SlimResult, mtf?: { label, bias, checks, strength }[] }
//   SlimResult = engine result without the EMA ribbon (the app draws that
//   standard indicator itself) and with `trend` packed as a "b/r/n" string.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeProVision, mergeHigherTimeframe, type PvCandle, type PvResult } from "../_shared/proVisionEngine.ts";
import { aiRateLimit } from "../_shared/aiLimits.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_CANDLES = 1500;
const MAX_MTF = 6;

type Wire = number[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/** Validate + decode wire candles; null when malformed. */
function decode(w: unknown): PvCandle[] | null {
  if (!Array.isArray(w) || w.length > MAX_CANDLES) return null;
  const out: PvCandle[] = [];
  for (const r of w) {
    if (!Array.isArray(r) || r.length < 5) return null;
    const [t, o, h, l, c, v, tb] = r as number[];
    if (![t, o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x))) return null;
    const cd: PvCandle = { time: t, open: o, high: h, low: l, close: c };
    if (typeof v === "number" && v >= 0) cd.volume = v;
    if (typeof tb === "number" && tb >= 0) cd.takerBuyVolume = tb;
    out.push(cd);
  }
  return out;
}

const TREND_CODE = { bull: "b", bear: "r", neutral: "n" } as const;

function slim(r: PvResult) {
  return {
    ...r,
    ribbon: undefined,
    trend: r.trend.map((b) => TREND_CODE[b]).join(""),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return json({ error: "Sign in to use ProVision", reason: "signin" }, 401);

    // Acts as the user, so RLS + auth.uid() apply to the access check.
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user) return json({ error: "Sign in to use ProVision", reason: "signin" }, 401);

    const body = await req.json().catch(() => null);
    const coin = typeof body?.coin === "string" ? body.coin.trim().toUpperCase() : "";
    if (!coin || coin.length > 20) return json({ error: "Missing coin" }, 400);

    // Generous ceiling (the app asks ~7×/min) — stops scripted hammering.
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    if (!(await aiRateLimit(admin, user.id, "provision", 60, 40))) {
      return json({ error: "Too many requests — slow down a little." }, 429);
    }

    // Access check (and Pro's server-side coin count).
    const { data: claim, error: claimErr } = await userClient.rpc("claim_provision_coin", { p_coin: coin });
    if (claimErr) return json({ error: "Couldn't check ProVision access" }, 500);
    if (!claim?.allowed) {
      return json({ error: "ProVision is locked for this coin", reason: "locked", used: claim?.used ?? [], next_free_at: claim?.next_free_at ?? null }, 403);
    }

    const out: Record<string, unknown> = {};

    if (body.main !== undefined) {
      const main = decode(body.main);
      if (!main) return json({ error: "Bad candles" }, 400);
      const local = computeProVision(main);
      let result: PvResult | null = local;
      if (body.htf !== undefined) {
        const htfC = decode(body.htf);
        const htf = htfC ? computeProVision(htfC) : null;
        const shortSec = Number(body.shortSec) || 300;
        if (htf) {
          const base: PvResult = local ?? {
            ...htf, trend: [], spikes: [], spikeGuard: null, rangeBox: null, rangeSignals: [],
            ribbon: { lines: [], bull: [] }, flips: [], barSec: shortSec,
          };
          result = mergeHigherTimeframe(base, htf, 900, "15m");
        }
      }
      out.result = result ? slim(result) : null;
    }

    if (Array.isArray(body.mtf)) {
      out.mtf = (body.mtf as { label: string; candles: Wire[] }[]).slice(0, MAX_MTF).map((s) => {
        const cs = decode(s?.candles);
        const r = cs ? computeProVision(cs) : null;
        return {
          label: String(s?.label ?? "").slice(0, 8),
          bias: r ? r.verdict.bias : null,
          checks: r ? r.checks : [],
          strength: r ? r.bullStrength : null,
        };
      });
    }

    return json(out);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
