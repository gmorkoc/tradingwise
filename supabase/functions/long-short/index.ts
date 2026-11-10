// Long/short positioning straight from each exchange's own public API, for
// the Positions page (/positions). Replaces CoinGlass endpoints our plan
// doesn't include (they all failed, so the page showed 50% / "—" / Neutral).
//
// Why a server function: Binance futures and Bybit refuse requests from many
// regions (HTTP 451 / 403) and OKX's stats API sends no CORS header. The app
// invokes this pinned to a non-US region, like exchange-funding.
//
// Request body: { coin: "BTC", hours: 1|4|12|24, period: "1h"|"4h"|"12h"|"1d",
//                 historyLimit?: number, coins?: string[] }
// Response:
//   ratios:  { [exchange]: { retail, whaleAccount, whalePosition } } — each
//            { longPct, shortPct, ratio } (pct 0–100) or null if unavailable
//   taker:   [{ exchange, buyUsd, sellUsd }] — taker buy/sell volume summed
//            over the last `hours` hours (only exchanges that answered)
//   history: [{ time (unix s), ratio }] — Binance (else OKX) account L/S ratio
//   multi:   { [coin]: { longPct, shortPct } } — Binance account ratio, when
//            `coins` is given
// Nothing is ever faked: a missing source stays null / absent.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-region",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", ...extra } });

type Ratio = { longPct: number; shortPct: number; ratio: number } | null;
type Ratios = { retail: Ratio; whaleAccount: Ratio; whalePosition: Ratio };

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};
/** From long and short shares (any scale) → percentages + ratio. */
const fromShares = (l: unknown, s: unknown): Ratio => {
  const a = num(l), b = num(s);
  if (a == null || b == null || a + b <= 0) return null;
  const longPct = (a / (a + b)) * 100;
  return { longPct, shortPct: 100 - longPct, ratio: b > 0 ? a / b : 0 };
};
/** From a long/short ratio alone (OKX, Gate) → percentages. */
const fromRatio = (r: unknown): Ratio => {
  const x = num(r);
  if (x == null || x < 0) return null;
  const longPct = (x / (1 + x)) * 100;
  return { longPct, shortPct: 100 - longPct, ratio: x };
};

// deno-lint-ignore no-explicit-any
async function getJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "coinhintz-longshort/1.0" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const BN = "https://fapi.binance.com/futures/data";
const OKX = "https://www.okx.com/api/v5/rubik/stat";
const okPeriod: Record<string, string> = { "1h": "1H", "4h": "4H", "12h": "12H", "1d": "1D" };

// OKX's rubik stats allow ~5 requests / 2 s per IP: fire them one after
// another with a small gap (in parallel with every other exchange), and
// retry once if OKX answers "too many requests".
async function okxSequential(urls: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const u of urls) {
    let r = await getJson(u);
    if (!r || (r as { code?: string }).code !== "0") {
      await new Promise((res) => setTimeout(res, 600));
      r = await getJson(u);
    }
    out.push(r);
    await new Promise((res) => setTimeout(res, 250));
  }
  return out;
}

export async function load(coin: string, hours: number, period: string, historyLimit: number) {
  const sym = `${coin}USDT`, inst = `${coin}-USDT-SWAP`, gate = `${coin}_USDT`;
  const [
    bnGlobal, bnTopAcc, bnTopPos, bnTaker, bnHist, bnMark,
    [okAcc, okTopAcc, okTopPos, okTaker, okHist],
    byAcc,
    bgAcc, bgTaker,
    gtStats, gtContract,
  ] = await Promise.all([
    getJson(`${BN}/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`),
    getJson(`${BN}/topLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`),
    getJson(`${BN}/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=1`),
    getJson(`${BN}/takerlongshortRatio?symbol=${sym}&period=1h&limit=${hours}`),
    getJson(`${BN}/globalLongShortAccountRatio?symbol=${sym}&period=${period}&limit=${historyLimit}`),
    getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`),
    // deno-lint-ignore no-explicit-any
    okxSequential([
      `${OKX}/contracts/long-short-account-ratio-contract?instId=${inst}&period=1H&limit=1`,
      `${OKX}/contracts/long-short-account-ratio-contract-top-trader?instId=${inst}&period=1H&limit=1`,
      `${OKX}/contracts/long-short-position-ratio-contract-top-trader?instId=${inst}&period=1H&limit=1`,
      `${OKX}/taker-volume-contract?instId=${inst}&period=1H&unit=2&limit=${hours}`,
      `${OKX}/contracts/long-short-account-ratio-contract?instId=${inst}&period=${okPeriod[period] ?? "4H"}&limit=${historyLimit}`,
    ]) as Promise<any[]>,
    getJson(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${sym}&period=1h&limit=1`),
    getJson(`https://api.bitget.com/api/v2/mix/market/account-long-short?symbol=${sym}&productType=usdt-futures&period=1h`),
    getJson(`https://api.bitget.com/api/v2/mix/market/taker-buy-sell?symbol=${sym}&productType=usdt-futures&period=1h`),
    getJson(`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${gate}&interval=1h&limit=${hours}`),
    getJson(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${gate}`),
  ]);

  const last = <T,>(a: unknown): T | undefined => (Array.isArray(a) && a.length ? a[a.length - 1] as T : undefined);
  const first = <T,>(a: unknown): T | undefined => (Array.isArray(a) && a.length ? a[0] as T : undefined);
  const gtLast = last<any>(gtStats);
  const markPrice = num(bnMark?.markPrice) ?? num(gtLast?.mark_price);

  // ── Ratios (latest snapshot) ──────────────────────────────────────────────
  const bg = last<any>(bgAcc?.data);
  const ratios: Record<string, Ratios> = {
    Binance: {
      retail:        fromShares(last<any>(bnGlobal)?.longAccount, last<any>(bnGlobal)?.shortAccount),
      whaleAccount:  fromShares(last<any>(bnTopAcc)?.longAccount, last<any>(bnTopAcc)?.shortAccount),
      whalePosition: fromShares(last<any>(bnTopPos)?.longAccount, last<any>(bnTopPos)?.shortAccount),
    },
    OKX: {
      retail:        fromRatio(first<string[]>(okAcc?.data)?.[1]),
      whaleAccount:  fromRatio(first<string[]>(okTopAcc?.data)?.[1]),
      whalePosition: fromRatio(first<string[]>(okTopPos?.data)?.[1]),
    },
    Bybit: {
      retail:        fromShares(first<any>(byAcc?.result?.list)?.buyRatio, first<any>(byAcc?.result?.list)?.sellRatio),
      whaleAccount:  null, // Bybit publishes no top-trader ratios
      whalePosition: null,
    },
    Bitget: {
      retail:        fromShares(bg?.longAccountRatio, bg?.shortAccountRatio),
      whaleAccount:  null,
      whalePosition: null,
    },
    Gate: {
      retail:        fromRatio(gtLast?.lsr_account),
      whaleAccount:  fromRatio(gtLast?.top_lsr_account),
      whalePosition: fromRatio(gtLast?.top_lsr_size),
    },
  };

  // ── Taker buy/sell volume, summed over the last `hours` hours (USD) ───────
  const taker: { exchange: string; buyUsd: number; sellUsd: number }[] = [];
  const push = (exchange: string, buy: number, sell: number) => {
    if (Number.isFinite(buy) && Number.isFinite(sell) && buy + sell > 0) taker.push({ exchange, buyUsd: buy, sellUsd: sell });
  };
  if (Array.isArray(bnTaker) && markPrice) {
    // Binance reports base-asset units (BTC) per 1h bucket.
    const rows = bnTaker.slice(-hours);
    push("Binance", rows.reduce((s: number, r: any) => s + (num(r.buyVol) ?? 0), 0) * markPrice,
                    rows.reduce((s: number, r: any) => s + (num(r.sellVol) ?? 0), 0) * markPrice);
  }
  if (Array.isArray(okTaker?.data)) {
    // OKX rows: [ts, sellVol, buyVol], USD (unit=2), newest first.
    const rows = okTaker.data.slice(0, hours);
    push("OKX", rows.reduce((s: number, r: string[]) => s + (num(r[2]) ?? 0), 0),
                rows.reduce((s: number, r: string[]) => s + (num(r[1]) ?? 0), 0));
  }
  if (Array.isArray(bgTaker?.data) && markPrice) {
    // Bitget: base-asset units, oldest first.
    const rows = bgTaker.data.slice(-hours);
    push("Bitget", rows.reduce((s: number, r: any) => s + (num(r.buyVolume) ?? 0), 0) * markPrice,
                   rows.reduce((s: number, r: any) => s + (num(r.sellVolume) ?? 0), 0) * markPrice);
  }
  const quanto = num(gtContract?.quanto_multiplier);
  if (Array.isArray(gtStats) && quanto) {
    // Gate: contracts × multiplier × that bucket's mark price.
    const rows = gtStats.slice(-hours);
    push("Gate", rows.reduce((s: number, r: any) => s + (num(r.long_taker_size) ?? 0) * quanto * (num(r.mark_price) ?? 0), 0),
                 rows.reduce((s: number, r: any) => s + (num(r.short_taker_size) ?? 0) * quanto * (num(r.mark_price) ?? 0), 0));
  }

  // ── Ratio history for the chart ───────────────────────────────────────────
  let history: { time: number; ratio: number }[] = [];
  if (Array.isArray(bnHist) && bnHist.length) {
    history = bnHist.map((r: any) => ({ time: Math.floor(Number(r.timestamp) / 1000), ratio: num(r.longShortRatio) ?? 0 }))
      .filter((p: { ratio: number }) => p.ratio > 0);
  } else if (Array.isArray(okHist?.data)) {
    history = okHist.data.map((r: string[]) => ({ time: Math.floor(Number(r[0]) / 1000), ratio: num(r[1]) ?? 0 }))
      .filter((p: { ratio: number }) => p.ratio > 0).reverse();
  }

  return { ratios, taker, history, historySource: Array.isArray(bnHist) && bnHist.length ? "Binance" : history.length ? "OKX" : null };
}

async function loadMulti(coins: string[]) {
  const out: Record<string, { longPct: number; shortPct: number }> = {};
  await Promise.all(coins.map(async (c) => {
    const d = await getJson(`${BN}/globalLongShortAccountRatio?symbol=${c}USDT&period=1h&limit=1`);
    const r = Array.isArray(d) && d.length ? fromShares(d[d.length - 1].longAccount, d[d.length - 1].shortAccount) : null;
    if (r) out[c] = { longPct: r.longPct, shortPct: r.shortPct };
  }));
  return out;
}

// 30s cache per request shape.
const cache = new Map<string, { at: number; data: unknown }>();
const TTL_MS = 30_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const coin = String(body?.coin ?? "BTC").trim().toUpperCase();
    if (!/^[A-Z0-9]{2,15}$/.test(coin)) return json({ error: "Bad coin" }, 400);
    const hours = [1, 4, 12, 24].includes(Number(body?.hours)) ? Number(body.hours) : 12;
    const period = ["1h", "4h", "12h", "1d"].includes(body?.period) ? String(body.period) : "4h";
    const historyLimit = Math.max(10, Math.min(500, Number(body?.historyLimit) || 180));
    const coins: string[] = Array.isArray(body?.coins)
      ? body.coins.map((c: unknown) => String(c).toUpperCase()).filter((c: string) => /^[A-Z0-9]{2,15}$/.test(c)).slice(0, 30)
      : [];

    const key = `${coin}|${hours}|${period}|${historyLimit}|${coins.join(",")}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return json(hit.data, 200, { "Cache-Control": "public, max-age=20" });

    const [main, multi] = await Promise.all([load(coin, hours, period, historyLimit), coins.length ? loadMulti(coins) : Promise.resolve(undefined)]);
    const data = { coin, hours, period, region: Deno.env.get("SB_REGION") ?? null, at: Date.now(), ...main, ...(multi ? { multi } : {}) };
    cache.set(key, { at: Date.now(), data });
    return json(data, 200, { "Cache-Control": "public, max-age=20" });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
