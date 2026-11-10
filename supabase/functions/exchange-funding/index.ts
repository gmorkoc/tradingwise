// Live funding rates straight from each exchange's own public API
// (Binance, Bybit, OKX, Bitget, Coinbase International) for one coin.
//
// Why a server function: Binance and Bybit refuse requests from the US
// (HTTP 451 / 403), which is where the website's own proxies run. The app
// invokes this pinned to a non-US region (supabase.functions.invoke with
// `region`), so those APIs answer. Nothing here needs a user — it only reads
// public market data.
//
// Response: { coin, region, at, rates: { Binance: number|null, … } } where
// each rate is the raw 8h funding fraction (0.0001 = 0.01%), or null when
// that exchange didn't answer (shown as "No data", never as 0).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-region",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Rates = Record<"Binance" | "Bybit" | "OKX" | "Bitget" | "Coinbase", number | null>;

// 30s cache per coin — many visitors, few exchange calls.
const cache = new Map<string, { at: number; rates: Rates }>();
const TTL_MS = 30_000;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

async function getJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "coinhintz-funding/1.0" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function loadRates(coin: string): Promise<Rates> {
  const sym = `${coin}USDT`;
  // deno-lint-ignore no-explicit-any
  const [bn, by, okx, bg, cb]: any[] = await Promise.all([
    getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`),
    getJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`),
    getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`),
    getJson(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${sym}&productType=USDT-FUTURES`),
    // Coinbase International perpetuals via Coinbase's main public market
    // API (the api.international.coinbase.com host returns 502).
    getJson(`https://api.coinbase.com/api/v3/brokerage/market/products/${coin}-PERP-INTX`),
  ]);
  const bgData = bg?.data;
  return {
    Binance: num(bn?.lastFundingRate),
    Bybit: num(by?.result?.list?.[0]?.fundingRate),
    OKX: num(okx?.data?.[0]?.fundingRate),
    Bitget: num(Array.isArray(bgData) ? bgData[0]?.fundingRate : bgData?.fundingRate),
    // Used as-is: checked against Binance/Bybit/OKX/Bitget on BTC, ETH and
    // SOL it lines up as an 8h-comparable figure (×8 would put it 5–10×
    // above every other exchange, which arbitrage wouldn't allow).
    Coinbase: num(cb?.future_product_details?.perpetual_details?.funding_rate),
  };
}

// ── "All coins" mode (Funding Bot): one bulk request per exchange instead of
// one per coin. Returns { all: { BTC: { Binance, Bybit, Bitget, Coinbase }, … } }
// (OKX has no bulk endpoint; the app fetches it per coin directly.)
type AllRates = Record<string, Partial<Record<"Binance" | "Bybit" | "Bitget" | "Coinbase", number>>>;
let allCache: { at: number; all: AllRates } | null = null;

/** "1000PEPEUSDT" / "PEPE-PERP-INTX" → "PEPE" (multiplier contracts share the coin's rate). */
function baseCoin(sym: string): string {
  return sym.replace(/-PERP-INTX$/, "").replace(/USDT$/, "").replace(/^(1000000|10000|1000)(?=[A-Z])/, "");
}

async function loadAll(): Promise<AllRates> {
  // deno-lint-ignore no-explicit-any
  const [bn, by, bg, cb]: any[] = await Promise.all([
    getJson("https://fapi.binance.com/fapi/v1/premiumIndex"),
    getJson("https://api.bybit.com/v5/market/tickers?category=linear"),
    getJson("https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES"),
    getJson("https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&contract_expiry_type=PERPETUAL"),
  ]);
  const all: AllRates = {};
  const put = (sym: string, ex: keyof AllRates[string], v: unknown) => {
    const n = num(v);
    if (n == null) return;
    const c = baseCoin(sym);
    if (!/^[A-Z0-9]{2,15}$/.test(c)) return;
    (all[c] ??= {})[ex] ??= n; // first (plain) contract wins over a 1000x one
  };
  if (Array.isArray(bn)) for (const r of bn) if (String(r.symbol).endsWith("USDT")) put(r.symbol, "Binance", r.lastFundingRate);
  for (const r of by?.result?.list ?? []) if (String(r.symbol).endsWith("USDT")) put(r.symbol, "Bybit", r.fundingRate);
  for (const r of (Array.isArray(bg?.data) ? bg.data : [])) put(r.symbol, "Bitget", r.fundingRate);
  for (const p of cb?.products ?? []) {
    if (!String(p.product_id).endsWith("-PERP-INTX")) continue;
    put(p.product_id, "Coinbase", p?.future_product_details?.perpetual_details?.funding_rate);
  }
  return all;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.all === true) {
      if (!allCache || Date.now() - allCache.at >= TTL_MS) allCache = { at: Date.now(), all: await loadAll() };
      return new Response(
        JSON.stringify({ region: Deno.env.get("SB_REGION") ?? null, at: allCache.at, all: allCache.all }),
        { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=20" } },
      );
    }
    const coin = String(body?.coin ?? "BTC").trim().toUpperCase();
    if (!/^[A-Z0-9]{2,15}$/.test(coin)) {
      return new Response(JSON.stringify({ error: "Bad coin" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const hit = cache.get(coin);
    const rates = hit && Date.now() - hit.at < TTL_MS ? hit.rates : await loadRates(coin);
    if (!hit || Date.now() - hit.at >= TTL_MS) cache.set(coin, { at: Date.now(), rates });
    return new Response(
      JSON.stringify({ coin, region: Deno.env.get("SB_REGION") ?? null, at: Date.now(), rates }),
      { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=20" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
