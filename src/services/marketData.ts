// Market data layer — a fallback chain per data need:
//   1. CoinGecko  (primary)
//   2. CoinPaprika (free, no key, open CORS)
//   3. CoinLore    (free, no key, open CORS)
// plus Binance public market data (klines via fetchBn / the /bn-api proxy)
// for 7-day sparklines and fine-grained price history when a fallback is
// answering. Each step only runs if the previous one failed — HTTP 429, any
// other non-2xx, network error / timeout, or an empty / unexpected payload.
// After a 429 a source is skipped for a minute (cool-down) instead of being
// hammered. Whatever answers is returned in CoinGecko's shapes (field names
// like current_price / market_cap_rank / sparkline_in_7d, market_chart's
// [ms, value] pairs), so components don't care which source it was.
//
// Gaps (left null, the UI shows "—" or hides the item — never made up):
//  - CoinPaprika: all-time low, number of active markets, high/low 24h.
//  - CoinLore: also 30d / 1y % change, description, whitepaper, tags,
//    market-cap history (charts estimate it as price × circulating supply).
// CoinPaprika's free tier requires a credit — usePaprikaShown() lets a page
// show a small "Data: CoinPaprika" note only while its data is on screen.
import { useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { fetchBn } from "./coinglass";
import { CATALOG } from "./coinCatalog";

// CoinGecko goes through our server (middleware.ts /gecko-api), which adds
// the API key and picks free vs paid host — so switching plans or keys is
// a Vercel setting, never an app update. The app (capacitor://) calls the
// live site's route directly.
const CG = `${Capacitor.isNativePlatform() ? "https://www.coinhintz.io" : ""}/gecko-api/api/v3`;
const PAPRIKA = "https://api.coinpaprika.com/v1";
const LORE = "https://api.coinlore.net/api";

// ── Types (CoinGecko-shaped) ──────────────────────────────────────────────
export type DataSource = "cg" | "pp" | "cl";

export interface MarketCoin {
  /** CoinGecko id. Fallback rows: the watchlist catalog's (CoinGecko) id
   *  when the coin is in it, otherwise the fallback source's own id. */
  id: string;
  /** Set on fallback rows only (which source answered). */
  source?: Exclude<DataSource, "cg">;
  symbol: string; // lowercase, like CoinGecko
  name: string;
  image: string;
  market_cap_rank: number;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_24h: number;
  price_change_percentage_24h_in_currency: number | null;
  price_change_percentage_1h_in_currency: number | null;
  price_change_percentage_7d_in_currency: number;
  price_change_percentage_30d_in_currency: number | null;
  price_change_percentage_1y_in_currency: number | null;
  market_cap_change_percentage_24h: number | null;
  circulating_supply: number | null;
  total_supply: number | null;
  max_supply: number | null;
  fully_diluted_valuation: number | null;
  ath: number | null;
  ath_date: string | null;
  ath_change_percentage: number | null;
  atl: number | null;
  atl_date: string | null;
  atl_change_percentage: number | null;
  high_24h: number | null;
  low_24h: number | null;
  sparkline_in_7d?: { price: number[] };
}

export interface GlobalStats {
  active_cryptocurrencies: number | null;
  markets: number | null;
  total_market_cap: { usd: number };
  total_volume: { usd: number };
  market_cap_percentage: { btc: number; eth: number; [k: string]: number };
  market_cap_change_percentage_24h_usd: number;
}

export interface TrendingCoin {
  id: string;
  symbol: string;
  name: string;
  image: string;
  price: number | null;
  change24h: number | null;
}

export interface MarketChart {
  prices: [number, number][];
  market_caps: [number, number][];
  total_volumes: [number, number][];
}

export interface CoinDetails {
  name: string;
  symbol: string;
  rank: number | null;
  description: string;
  tags: string[];
  /** "YYYY-MM-DD" or null. */
  genesis_date: string | null;
  links: {
    website: string[];
    explorer: string[];
    reddit: string[];
    source_code: string[];
    whitepaper: string | null;
    twitter: string | null;
  };
  market: {
    market_cap: number | null;
    fdv: number | null;
    total_volume: number | null;
    circulating_supply: number | null;
    total_supply: number | null;
    max_supply: number | null;
    ath: number | null;
    ath_date: string | null;
    ath_change_percentage: number | null;
    atl: number | null;
    atl_date: string | null;
    atl_change_percentage: number | null;
    change_7d: number | null;
  } | null;
}

export interface ExchangeMarket {
  exchange: string;
  logo: string | null;
  base: string;
  target: string;
  price: number;
  volumeUsd: number | null;
  trust: "green" | "yellow" | "red" | null;
  url: string | null;
}

// ── HTTP + per-source cool-down ───────────────────────────────────────────
const COOLDOWN_MS = 60_000;
const SOURCE_BASE: [DataSource, string][] = [["cg", CG], ["pp", PAPRIKA], ["cl", LORE]];
const blockedUntil: Record<DataSource, number> = { cg: 0, pp: 0, cl: 0 };
try {
  const saved = JSON.parse(sessionStorage.getItem("mdCooldown") ?? "null") as Record<DataSource, number> | null;
  if (saved) Object.assign(blockedUntil, saved);
} catch { /* ignore */ }
const sourceOf = (url: string) => SOURCE_BASE.find(([, b]) => url.startsWith(b))?.[0] ?? null;

class HttpError extends Error {
  constructor(public status: number, public retryAfter: number | null) { super(status === 429 ? "rate-limited" : `HTTP ${status}`); }
}
class CoolDown extends Error { constructor(src: string) { super(`${src} cool-down`); } }
class BadPayload extends Error { constructor() { super("unexpected payload"); } }

async function httpJson(url: string, timeoutMs = 12_000): Promise<unknown> {
  const src = sourceOf(url);
  if (src && Date.now() < blockedUntil[src]) throw new CoolDown(src);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!res.ok) {
      const ra = Number(res.headers.get("retry-after"));
      if (res.status === 429 && src) {
        blockedUntil[src] = Date.now() + COOLDOWN_MS;
        try { sessionStorage.setItem("mdCooldown", JSON.stringify(blockedUntil)); } catch { /* ignore */ }
      }
      throw new HttpError(res.status, Number.isFinite(ra) && ra > 0 ? ra : null);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────
// In-memory + localStorage TTL cache, in-flight dedupe, stale copy served
// when every source fails.
type Entry = { data: unknown; ts: number };
const mem: Record<string, Entry> = {};
const inflight: Record<string, Promise<unknown>> = {};
const LS_PREFIX = "mdc:";

// One-time cleanup of the old per-component caches this layer replaced.
try {
  if (!localStorage.getItem("mdc:cleaned-v1")) {
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("cgc:") || k.startsWith("cgTickers:") || k.startsWith("cgCoin:") || k === "mhm-coins-cache-v1")) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
    localStorage.setItem("mdc:cleaned-v1", "1");
  }
} catch { /* storage unavailable */ }

function readStored(key: string): Entry | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? (JSON.parse(raw) as Entry) : null;
  } catch { return null; }
}
function store(key: string, entry: Entry, persist: boolean) {
  mem[key] = entry;
  if (!persist) return;
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(entry)); } catch { /* quota / private mode */ }
}

interface CacheOpts<R> {
  ttl: number;
  load: () => Promise<R>;
  /** Mirror to localStorage (survives reloads). Default true. */
  persist?: boolean;
}

async function cached<R>(key: string, { ttl, load, persist = true }: CacheOpts<R>): Promise<R> {
  const now = Date.now();
  if (!mem[key] && persist) { const s = readStored(key); if (s) mem[key] = s; }
  if (mem[key] && now - mem[key].ts < ttl) return mem[key].data as R;
  if (key in inflight) return inflight[key] as Promise<R>;
  const p = (async () => {
    try {
      const data = await load();
      store(key, { data, ts: Date.now() }, persist);
      return data;
    } catch (e) {
      if (mem[key]) return mem[key].data as R; // stale beats an error screen
      throw e;
    }
  })().finally(() => { delete inflight[key]; });
  inflight[key] = p;
  return p;
}

/** Cached plain GET of one source URL, shaped by `transform` (which throws
 *  on a bad payload). Used for the fallback sources' raw endpoints. */
const getJson = <R>(url: string, ttl: number, transform: (raw: unknown) => R, persist = true) =>
  cached<R>(url, { ttl, persist, load: async () => transform(await httpJson(url)) });

// ── Which source answered (attribution / source labels) ───────────────────
// Keys: "markets", "global", "trending", "details:SYM", "pairs:SYM",
// "chart:SYM:…", "row:SYM".
const sources = new Map<string, DataSource>();
let srcVersion = 0;
const srcListeners = new Set<() => void>();
function noteSource(key: string, src: DataSource) {
  if (sources.get(key) === src) return;
  sources.set(key, src);
  srcVersion++;
  srcListeners.forEach((l) => l());
}
function useSourcesVersion() {
  useSyncExternalStore(
    (cb) => { srcListeners.add(cb); return () => { srcListeners.delete(cb); }; },
    () => srcVersion,
  );
}

/** True while data whose key starts with one of `prefixes` came from
 *  CoinPaprika (its free tier requires a visible credit). */
export function usePaprikaShown(prefixes: string[]): boolean {
  useSourcesVersion();
  for (const [k, s] of sources) if (s === "pp" && prefixes.some((p) => k.startsWith(p))) return true;
  return false;
}

/** Which source answered the data stored under `key` (null until loaded). */
export function useDataSource(key: string): DataSource | null {
  useSourcesVersion();
  return sources.get(key) ?? null;
}

type Step<R> = [DataSource, () => Promise<R>];

/** Tries each source in order; the first one that answers wins. Cached as
 *  one entry that remembers which source answered. */
async function chain<R>(key: string, ttl: number, steps: Step<R>[], persist = true): Promise<R> {
  const r = await cached<{ s: DataSource; d: R }>(`md:${key}`, {
    ttl,
    persist,
    load: async () => {
      let last: unknown = new Error("no source");
      for (const [s, fn] of steps) {
        try { return { s, d: await fn() }; } catch (e) { last = e; }
      }
      throw last;
    },
  });
  noteSource(key, r.s);
  return r.d;
}

// ── Helpers ───────────────────────────────────────────────────────────────
// Catalog (watchlist) ids by symbol — CoinGecko ids, so saved watchlists
// keep matching fallback rows.
const CATALOG_ID = new Map(CATALOG.map((c) => [c.symbol.toUpperCase(), c.id]));
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? (v.trim() === "" ? NaN : Number(v)) : typeof v === "number" ? v : NaN;
  return isFinite(n) ? n : null;
};
const clean = (a?: (string | null | undefined)[]) => (a ?? []).filter((u): u is string => !!u);
const paprikaLogo = (id: string) => `https://static.coinpaprika.com/coin/${id}/logo.png`;
// The app's existing generic logo source (CoinInfoPanel's fallback).
const genericLogo = (sym: string) => `https://assets.coincap.io/assets/icons/${sym.toLowerCase()}@2x.png`;
const TICKERS_TTL = 120_000;

/** Keeps the first (best-ranked) row per symbol for the catalog id; drops
 *  duplicate ids. */
function dedupeRows(rows: MarketCoin[]): MarketCoin[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

// ── CoinGecko ─────────────────────────────────────────────────────────────
async function cgGet<T>(path: string, valid: (d: T) => boolean): Promise<T> {
  // The key is added server-side (see CG above).
  const d = (await httpJson(`${CG}${path}`)) as T;
  if (!d || !valid(d)) throw new BadPayload();
  return d;
}

type CgRow = Partial<MarketCoin> & { id: string; symbol: string; name: string; current_price: number };
function cgToCoin(c: CgRow): MarketCoin {
  return {
    id: c.id,
    symbol: c.symbol,
    name: c.name,
    image: c.image ?? "",
    market_cap_rank: c.market_cap_rank ?? 0,
    current_price: c.current_price,
    market_cap: c.market_cap ?? 0,
    total_volume: c.total_volume ?? 0,
    price_change_percentage_24h: c.price_change_percentage_24h ?? 0,
    price_change_percentage_24h_in_currency: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h ?? null,
    price_change_percentage_1h_in_currency: c.price_change_percentage_1h_in_currency ?? null,
    price_change_percentage_7d_in_currency: c.price_change_percentage_7d_in_currency ?? 0,
    price_change_percentage_30d_in_currency: c.price_change_percentage_30d_in_currency ?? null,
    price_change_percentage_1y_in_currency: c.price_change_percentage_1y_in_currency ?? null,
    market_cap_change_percentage_24h: c.market_cap_change_percentage_24h ?? null,
    circulating_supply: c.circulating_supply ?? null,
    total_supply: c.total_supply ?? null,
    max_supply: c.max_supply ?? null,
    fully_diluted_valuation: c.fully_diluted_valuation ?? null,
    ath: c.ath ?? null,
    ath_date: c.ath_date ?? null,
    ath_change_percentage: c.ath_change_percentage ?? null,
    atl: c.atl ?? null,
    atl_date: c.atl_date ?? null,
    atl_change_percentage: c.atl_change_percentage ?? null,
    high_24h: c.high_24h ?? null,
    low_24h: c.low_24h ?? null,
    sparkline_in_7d: c.sparkline_in_7d?.price?.length ? c.sparkline_in_7d : undefined,
  };
}

// ── CoinPaprika ───────────────────────────────────────────────────────────
interface PaprikaQuote {
  price: number; volume_24h: number; volume_24h_change_24h?: number; market_cap: number; market_cap_change_24h?: number;
  percent_change_1h?: number; percent_change_24h?: number; percent_change_7d?: number;
  percent_change_30d?: number; percent_change_1y?: number;
  ath_price?: number | null; ath_date?: string | null; percent_from_price_ath?: number | null;
}
interface PaprikaTicker {
  id: string; name: string; symbol: string; rank: number;
  total_supply?: number | null; max_supply?: number | null;
  quotes?: { USD?: PaprikaQuote };
}
type PpCoin = MarketCoin & { pp_id: string; vol_change: number | null };

function ppToCoin(t: PaprikaTicker, primary: boolean): PpCoin | null {
  const q = t.quotes?.USD;
  if (!q || !(q.price > 0)) return null;
  const sym = t.symbol.toUpperCase();
  const mcap = num(q.market_cap) ?? 0;
  const total = num(t.total_supply) || null;
  const max = num(t.max_supply) || null;
  const fdvSupply = max ?? total;
  return {
    id: (primary && CATALOG_ID.get(sym)) || t.id,
    source: "pp",
    pp_id: t.id,
    vol_change: num(q.volume_24h_change_24h),
    symbol: t.symbol.toLowerCase(),
    name: t.name,
    image: paprikaLogo(t.id),
    market_cap_rank: t.rank,
    current_price: q.price,
    market_cap: mcap,
    total_volume: num(q.volume_24h) ?? 0,
    price_change_percentage_24h: num(q.percent_change_24h) ?? 0,
    price_change_percentage_24h_in_currency: num(q.percent_change_24h),
    price_change_percentage_1h_in_currency: num(q.percent_change_1h),
    price_change_percentage_7d_in_currency: num(q.percent_change_7d) ?? 0,
    price_change_percentage_30d_in_currency: num(q.percent_change_30d),
    price_change_percentage_1y_in_currency: num(q.percent_change_1y),
    market_cap_change_percentage_24h: num(q.market_cap_change_24h),
    circulating_supply: mcap > 0 ? mcap / q.price : null,
    total_supply: total,
    max_supply: max,
    fully_diluted_valuation: fdvSupply ? fdvSupply * q.price : null,
    ath: num(q.ath_price),
    ath_date: q.ath_date ?? null,
    ath_change_percentage: num(q.percent_from_price_ath),
    atl: null, atl_date: null, atl_change_percentage: null,
    high_24h: null, low_24h: null,
  };
}

function ppRows(raw: unknown): PpCoin[] {
  const list = (Array.isArray(raw) ? (raw as PaprikaTicker[]) : []).filter((t) => t && t.rank > 0).sort((a, b) => a.rank - b.rank);
  const seenSym = new Set<string>();
  const rows: PpCoin[] = [];
  for (const t of list) {
    const sym = t.symbol.toUpperCase();
    const c = ppToCoin(t, !seenSym.has(sym));
    seenSym.add(sym);
    if (c) rows.push(c);
  }
  if (!rows.length) throw new BadPayload();
  return dedupeRows(rows) as PpCoin[];
}
const ppTop = () => getJson(`${PAPRIKA}/tickers?quotes=USD&limit=250`, TICKERS_TTL, ppRows);

/** CoinPaprika id for a ticker symbol (e.g. BTC → "btc-bitcoin"), or null. */
async function ppId(symbol: string): Promise<string | null> {
  const s = symbol.toUpperCase();
  try {
    const hit = (await ppTop()).find((c) => c.symbol.toUpperCase() === s);
    if (hit) return hit.pp_id;
  } catch { /* fall through */ }
  try {
    const r = await getJson(`${PAPRIKA}/search/?q=${encodeURIComponent(s)}&c=currencies&limit=10`, 24 * 3_600_000,
      (raw) => ((raw as { currencies?: { id: string; symbol: string; rank: number; is_active?: boolean }[] }).currencies ?? []));
    const best = r.filter((c) => c.symbol.toUpperCase() === s && c.is_active !== false)
      .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))[0];
    return best?.id ?? null;
  } catch {
    return null;
  }
}
const ppRow = async (symbol: string): Promise<PpCoin | null> => {
  const id = await ppId(symbol);
  if (!id) return null;
  return getJson(`${PAPRIKA}/tickers/${id}?quotes=USD`, TICKERS_TTL, (raw) => {
    const c = ppToCoin(raw as PaprikaTicker, true);
    if (!c) throw new BadPayload();
    return c;
  });
};

// ── CoinLore ──────────────────────────────────────────────────────────────
interface LoreTicker {
  id: string; symbol: string; name: string; nameid: string; rank: number;
  price_usd: string; percent_change_1h?: string; percent_change_24h?: string; percent_change_7d?: string;
  market_cap_usd?: string; volume24?: number | string; csupply?: string; tsupply?: string; msupply?: string;
}
type ClCoin = MarketCoin & { cl_id: string };

function clToCoin(t: LoreTicker, primary: boolean): ClCoin | null {
  const price = num(t.price_usd);
  if (!price || price <= 0) return null;
  const sym = t.symbol.toUpperCase();
  const circ = num(t.csupply) || null;
  const total = num(t.tsupply) || null;
  const max = num(t.msupply) || null;
  const fdvSupply = max ?? total;
  return {
    id: (primary && CATALOG_ID.get(sym)) || `coinlore-${t.id}`,
    source: "cl",
    cl_id: t.id,
    symbol: t.symbol.toLowerCase(),
    name: t.name,
    image: genericLogo(t.symbol),
    market_cap_rank: Number(t.rank) || 0,
    current_price: price,
    market_cap: num(t.market_cap_usd) ?? 0,
    total_volume: num(t.volume24) ?? 0,
    price_change_percentage_24h: num(t.percent_change_24h) ?? 0,
    price_change_percentage_24h_in_currency: num(t.percent_change_24h),
    price_change_percentage_1h_in_currency: num(t.percent_change_1h),
    price_change_percentage_7d_in_currency: num(t.percent_change_7d) ?? 0,
    price_change_percentage_30d_in_currency: null,
    price_change_percentage_1y_in_currency: null,
    market_cap_change_percentage_24h: null,
    circulating_supply: circ,
    total_supply: total,
    max_supply: max,
    fully_diluted_valuation: fdvSupply ? fdvSupply * price : null,
    ath: null, ath_date: null, ath_change_percentage: null,
    atl: null, atl_date: null, atl_change_percentage: null,
    high_24h: null, low_24h: null,
  };
}
function clRows(list: LoreTicker[]): ClCoin[] {
  const seenSym = new Set<string>();
  const rows: ClCoin[] = [];
  for (const t of [...list].sort((a, b) => Number(a.rank) - Number(b.rank))) {
    const sym = t.symbol.toUpperCase();
    const c = clToCoin(t, !seenSym.has(sym));
    seenSym.add(sym);
    if (c) rows.push(c);
  }
  if (!rows.length) throw new BadPayload();
  return dedupeRows(rows) as ClCoin[];
}
const loreData = (raw: unknown): LoreTicker[] => {
  const d = (raw as { data?: LoreTicker[] })?.data ?? raw;
  if (!Array.isArray(d)) throw new BadPayload();
  return d as LoreTicker[];
};
/** CoinLore top 250 — three pages of 100 (its per-call max), fetched one
 *  after another (it asks for ~1 request/second). */
const clTop = () => cached<ClCoin[]>("cl:top250", {
  ttl: TICKERS_TTL,
  load: async () => {
    const all: LoreTicker[] = [];
    for (const start of [0, 100, 200]) {
      all.push(...loreData(await httpJson(`${LORE}/tickers/?start=${start}&limit=${start === 200 ? 50 : 100}`)));
    }
    return clRows(all);
  },
});
/** CoinLore numeric id for a symbol (top 250, else the full asset list). */
async function clId(symbol: string): Promise<string | null> {
  const s = symbol.toUpperCase();
  try {
    const hit = (await clTop()).find((c) => c.symbol.toUpperCase() === s);
    if (hit) return hit.cl_id;
  } catch { /* fall through */ }
  try {
    const ids = await getJson(`${LORE}/assets/`, 24 * 3_600_000, (raw) => {
      const out: Record<string, string> = {};
      const list = ((raw as { data?: { id: string; symbol: string; rank: number }[] }).data ?? [])
        .filter((a) => a.rank > 0).sort((a, b) => a.rank - b.rank);
      for (const a of list) { const k = a.symbol.toUpperCase(); if (!(k in out)) out[k] = a.id; }
      if (!Object.keys(out).length) throw new BadPayload();
      return out;
    });
    return ids[s] ?? null;
  } catch {
    return null;
  }
}
const clRow = async (symbol: string): Promise<ClCoin | null> => {
  const id = await clId(symbol);
  if (!id) return null;
  return getJson(`${LORE}/ticker/?id=${id}`, TICKERS_TTL, (raw) => {
    const t = loreData(raw)[0];
    const c = t ? clToCoin(t, true) : null;
    if (!c) throw new BadPayload();
    return c;
  });
};

// ── Coin list ─────────────────────────────────────────────────────────────
/** Top 250 coins by market cap (CoinGecko /coins/markets shape). One shared,
 *  cached request for the whole app. Fallback rows have no sparkline —
 *  requestSparklines fills those in from Binance. */
export function getMarkets(): Promise<MarketCoin[]> {
  return chain<MarketCoin[]>("markets", 90_000, [
    ["cg", async () => (await cgGet<CgRow[]>(
      "/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&price_change_percentage=1h,24h,7d,30d,1y&sparkline=true",
      (d) => Array.isArray(d) && d.length > 0 && typeof d[0]?.current_price === "number",
    )).map(cgToCoin)],
    ["pp", ppTop],
    ["cl", clTop],
  // Highest market cap first whichever source answered — CoinGecko sends
  // that order, the backup sources (used when it's out of quota) don't.
  ]).then((rows) => [...rows].sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0)));
}

/** CoinGecko id for a symbol: from the list when CoinGecko answered it,
 *  else the watchlist catalog (CoinGecko ids). */
async function cgId(symbol: string): Promise<string | null> {
  const s = symbol.toUpperCase();
  try {
    const hit = (await getMarkets()).find((c) => c.symbol.toUpperCase() === s);
    if (hit && !hit.source) return hit.id;
  } catch { /* fall through */ }
  return CATALOG_ID.get(s) ?? null;
}

/** One coin's row — from the shared top-250 list, or (coins outside it) a
 *  single-coin ticker from the fallback sources. */
export async function getCoinRow(symbol: string): Promise<MarketCoin | null> {
  const s = symbol.toUpperCase();
  try {
    const hit = (await getMarkets()).find((c) => c.symbol.toUpperCase() === s);
    if (hit) return hit;
  } catch { /* fall through */ }
  // Symbol lookups outside the top 250 can hit a different coin with the
  // same ticker — reject a row whose price is far off Binance's (when
  // Binance lists the symbol).
  const checked = async (r: MarketCoin | null) => {
    if (!r) throw new BadPayload();
    const bn = await binanceUsdtPrices().then((m) => m.get(s)).catch(() => undefined);
    if (bn && Math.abs(bn / r.current_price - 1) > 0.5) throw new BadPayload();
    return r;
  };
  return chain<MarketCoin | null>(`row:${s}`, TICKERS_TTL, [
    ["pp", async () => checked(await ppRow(s))],
    ["cl", async () => checked(await clRow(s))],
  ]).catch(() => null);
}

// ── Global stats ──────────────────────────────────────────────────────────
interface CgGlobal {
  data?: {
    active_cryptocurrencies?: number; markets?: number;
    total_market_cap?: { usd?: number }; total_volume?: { usd?: number };
    market_cap_percentage?: Record<string, number>; market_cap_change_percentage_24h_usd?: number;
  };
}
interface PaprikaGlobal {
  market_cap_usd: number; volume_24h_usd: number; bitcoin_dominance_percentage: number;
  cryptocurrencies_number: number; market_cap_change_24h: number;
}
interface LoreGlobal {
  coins_count?: number; active_markets?: number; total_mcap?: number; total_volume?: number;
  btc_d?: string; eth_d?: string; mcap_change?: string;
}

/** Dominance of the biggest coins = each coin's market cap ÷ the total. */
function dominance(total: number, rows: MarketCoin[], known: Record<string, number>): GlobalStats["market_cap_percentage"] {
  const pct: GlobalStats["market_cap_percentage"] = { btc: 0, eth: 0, ...known };
  if (total > 0) {
    for (const c of rows.slice(0, 10)) {
      const k = c.symbol.toLowerCase();
      if (!(k in known) && !pct[k]) pct[k] = (c.market_cap / total) * 100;
    }
  }
  return pct;
}

/** Market-wide totals (CoinGecko /global "data" shape). */
export function getGlobal(): Promise<GlobalStats> {
  return chain<GlobalStats>("global", 90_000, [
    ["cg", async () => {
      const { data: d } = await cgGet<CgGlobal>("/global", (j) => typeof j.data?.total_market_cap?.usd === "number");
      return {
        active_cryptocurrencies: num(d!.active_cryptocurrencies),
        markets: num(d!.markets),
        total_market_cap: { usd: d!.total_market_cap!.usd! },
        total_volume: { usd: d!.total_volume?.usd ?? 0 },
        market_cap_percentage: { btc: 0, eth: 0, ...(d!.market_cap_percentage ?? {}) },
        market_cap_change_percentage_24h_usd: d!.market_cap_change_percentage_24h_usd ?? 0,
      };
    }],
    ["pp", async () => {
      const [g, rows] = await Promise.all([
        getJson(`${PAPRIKA}/global`, TICKERS_TTL, (raw) => {
          const j = raw as PaprikaGlobal;
          if (!(j?.market_cap_usd > 0)) throw new BadPayload();
          return j;
        }),
        ppTop().catch(() => [] as MarketCoin[]),
      ]);
      return {
        active_cryptocurrencies: num(g.cryptocurrencies_number),
        markets: null,
        total_market_cap: { usd: g.market_cap_usd },
        total_volume: { usd: g.volume_24h_usd },
        market_cap_percentage: dominance(g.market_cap_usd, rows, { btc: g.bitcoin_dominance_percentage ?? 0 }),
        market_cap_change_percentage_24h_usd: g.market_cap_change_24h ?? 0,
      };
    }],
    ["cl", async () => {
      const g = await getJson(`${LORE}/global/`, TICKERS_TTL, (raw) => {
        const j = (Array.isArray(raw) ? raw[0] : raw) as LoreGlobal;
        if (!(num(j?.total_mcap) ?? 0)) throw new BadPayload();
        return j;
      });
      const total = num(g.total_mcap) ?? 0;
      // Dominance of the other top coins from the CoinLore list when it's already loaded.
      const rows = mem["cl:top250"]?.data as MarketCoin[] | undefined;
      return {
        active_cryptocurrencies: num(g.coins_count),
        markets: num(g.active_markets),
        total_market_cap: { usd: total },
        total_volume: { usd: num(g.total_volume) ?? 0 },
        market_cap_percentage: dominance(total, rows ?? [], { btc: num(g.btc_d) ?? 0, eth: num(g.eth_d) ?? 0 }),
        market_cap_change_percentage_24h_usd: num(g.mcap_change) ?? 0,
      };
    }],
  ]);
}

// ── Trending ──────────────────────────────────────────────────────────────
export const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDE", "PYUSD", "USDS", "BUSD", "USDD", "FRAX", "USD1", "RLUSD",
  "USDP", "GUSD", "LUSD", "SUSD", "EURC", "USDY", "USD0", "SUSDE", "BSC-USD", "USDT0", "USDF", "USDG", "USDX",
]);
interface CgTrending {
  coins?: { item: { id: string; symbol: string; name: string; thumb: string; data?: { price?: number; price_change_percentage_24h?: { usd?: number } } } }[];
}
const trendFromRow = (c: MarketCoin): TrendingCoin => ({
  id: c.id, symbol: c.symbol, name: c.name, image: c.image, price: c.current_price, change24h: c.price_change_percentage_24h,
});

/** CoinGecko's trending searches. Fallbacks (nobody else has search data):
 *  CoinPaprika — the top 200 ranked by how much their 24h volume jumped;
 *  CoinLore — its 24h top movers (winners) among the top 500. */
export function getTrending(): Promise<TrendingCoin[]> {
  return chain<TrendingCoin[]>("trending", 300_000, [
    ["cg", async () => (await cgGet<CgTrending>("/search/trending", (j) => Array.isArray(j.coins) && j.coins.length > 0)).coins!
      .map(({ item }) => ({
        id: item.id, symbol: item.symbol, name: item.name, image: item.thumb,
        price: num(item.data?.price), change24h: num(item.data?.price_change_percentage_24h?.usd),
      }))],
    ["pp", async () => {
      // Pegged coins (stablecoins the list misses) barely move — skip them.
      const pegged = (c: MarketCoin) => Math.abs(c.price_change_percentage_24h) < 0.5 && Math.abs(c.price_change_percentage_7d_in_currency) < 1.5;
      const rows = (await ppTop())
        .filter((c) => c.market_cap_rank <= 200 && !STABLE_SYMBOLS.has(c.symbol.toUpperCase()) && !pegged(c) && c.total_volume >= 5e6 && c.vol_change != null)
        .sort((a, b) => (b.vol_change ?? 0) - (a.vol_change ?? 0))
        .slice(0, 15);
      if (!rows.length) throw new BadPayload();
      return rows.map(trendFromRow);
    }],
    ["cl", async () => {
      const winners = await getJson(`${LORE}/movers/`, 300_000, (raw) => {
        const w = (raw as { data?: { winners?: LoreTicker[] } }).data?.winners;
        if (!Array.isArray(w) || !w.length) throw new BadPayload();
        return w;
      });
      const pick = winners.filter((t) => Number(t.rank) > 0 && Number(t.rank) <= 500);
      return (pick.length ? pick : winners).slice(0, 15)
        .map((t) => clToCoin(t, true)).filter((c): c is ClCoin => !!c).map(trendFromRow);
    }],
  ]);
}

// ── Coin details ──────────────────────────────────────────────────────────
interface CgCoin {
  name: string; symbol: string; market_cap_rank?: number | null; categories?: (string | null)[];
  description?: { en?: string }; genesis_date?: string | null;
  links?: {
    homepage?: string[]; whitepaper?: string; blockchain_site?: string[]; subreddit_url?: string;
    twitter_screen_name?: string; repos_url?: { github?: string[] };
  };
  market_data?: {
    market_cap?: { usd?: number }; fully_diluted_valuation?: { usd?: number }; total_volume?: { usd?: number };
    circulating_supply?: number | null; total_supply?: number | null; max_supply?: number | null;
    ath?: { usd?: number }; ath_date?: { usd?: string }; ath_change_percentage?: { usd?: number };
    atl?: { usd?: number }; atl_date?: { usd?: string }; atl_change_percentage?: { usd?: number };
    price_change_percentage_7d?: number;
  };
}
interface PaprikaCoin {
  id: string; name: string; symbol: string; rank?: number; description?: string;
  started_at?: string | null; tags?: { name: string }[];
  links?: { website?: string[]; explorer?: string[]; reddit?: string[]; source_code?: string[] };
  links_extended?: { url: string; type: string }[];
  whitepaper?: { link?: string | null };
}
interface LoreInfo {
  name: string; symbol: string; rank?: number; website?: string; twitter?: string; explorer?: string;
  ath?: number; ath_date?: string; startdate?: string | null;
}
const marketFromRow = (row: MarketCoin | null): CoinDetails["market"] => (row ? {
  market_cap: row.market_cap || null,
  fdv: row.fully_diluted_valuation,
  total_volume: row.total_volume || null,
  circulating_supply: row.circulating_supply,
  total_supply: row.total_supply,
  max_supply: row.max_supply,
  ath: row.ath,
  ath_date: row.ath_date,
  ath_change_percentage: row.ath_change_percentage,
  atl: row.atl,
  atl_date: row.atl_date,
  atl_change_percentage: row.atl_change_percentage,
  change_7d: row.price_change_percentage_7d_in_currency,
} : null);

/** Description, links, tags and key market figures for a coin. */
export function getCoinDetails(symbol: string): Promise<CoinDetails | null> {
  const s = symbol.toUpperCase();
  return chain<CoinDetails | null>(`details:${s}`, 15 * 60_000, [
    ["cg", async () => {
      const id = await cgId(s);
      if (!id) throw new Error("no coingecko id");
      const d = await cgGet<CgCoin>(
        `/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`,
        (j) => typeof j.name === "string",
      );
      const m = d.market_data;
      const L = d.links ?? {};
      return {
        name: d.name,
        symbol: d.symbol,
        rank: d.market_cap_rank ?? null,
        description: (d.description?.en ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 2000),
        tags: clean(d.categories),
        genesis_date: d.genesis_date || null,
        links: {
          website: clean(L.homepage),
          explorer: clean(L.blockchain_site),
          reddit: clean([L.subreddit_url]),
          source_code: clean(L.repos_url?.github),
          whitepaper: L.whitepaper || null,
          twitter: L.twitter_screen_name ? `https://x.com/${L.twitter_screen_name}` : null,
        },
        market: m ? {
          market_cap: num(m.market_cap?.usd),
          fdv: num(m.fully_diluted_valuation?.usd),
          total_volume: num(m.total_volume?.usd),
          circulating_supply: num(m.circulating_supply),
          total_supply: num(m.total_supply),
          max_supply: num(m.max_supply),
          ath: num(m.ath?.usd),
          ath_date: m.ath_date?.usd ?? null,
          ath_change_percentage: num(m.ath_change_percentage?.usd),
          atl: num(m.atl?.usd),
          atl_date: m.atl_date?.usd ?? null,
          atl_change_percentage: num(m.atl_change_percentage?.usd),
          change_7d: num(m.price_change_percentage_7d),
        } : null,
      };
    }],
    ["pp", async () => {
      const id = await ppId(s);
      if (!id) throw new Error("no id");
      const [d, row] = await Promise.all([
        getJson(`${PAPRIKA}/coins/${id}`, 6 * 3_600_000, (raw) => {
          const c = raw as PaprikaCoin;
          if (!c?.name) throw new BadPayload();
          return { ...c, description: (c.description ?? "").slice(0, 2000) };
        }),
        ppRow(s).catch(() => null),
      ]);
      return {
        name: d.name,
        symbol: d.symbol,
        rank: d.rank || null,
        description: d.description ?? "",
        tags: (d.tags ?? []).map((t) => t.name).filter(Boolean),
        genesis_date: d.started_at ? d.started_at.slice(0, 10) : null,
        links: {
          website: clean(d.links?.website),
          explorer: clean(d.links?.explorer),
          reddit: clean(d.links?.reddit),
          source_code: clean(d.links?.source_code),
          whitepaper: d.whitepaper?.link || null,
          twitter: (d.links_extended ?? []).find((l) => l.type === "twitter")?.url ?? null,
        },
        market: marketFromRow(row),
      };
    }],
    ["cl", async () => {
      const id = await clId(s);
      if (!id) throw new Error("no id");
      const [d, row] = await Promise.all([
        getJson(`${LORE}/coin/info/?id=${id}`, 6 * 3_600_000, (raw) => {
          const c = (Array.isArray(raw) ? raw[0] : raw) as LoreInfo;
          if (!c?.name) throw new BadPayload();
          return c;
        }),
        clRow(s).catch(() => null),
      ]);
      const market = marketFromRow(row);
      if (market && num(d.ath)) {
        market.ath = num(d.ath);
        market.ath_date = d.ath_date ?? null;
        market.ath_change_percentage = row ? ((row.current_price - d.ath!) / d.ath!) * 100 : null;
      }
      const handle = (d.twitter ?? "").replace(/^@/, "").trim();
      return {
        name: d.name,
        symbol: d.symbol,
        rank: num(d.rank),
        description: "",
        tags: [],
        genesis_date: d.startdate ? d.startdate.slice(0, 10) : null,
        links: {
          website: clean([d.website]),
          explorer: clean([d.explorer]),
          reddit: [],
          source_code: [],
          whitepaper: null,
          twitter: handle ? (/^https?:/.test(handle) ? handle : `https://x.com/${handle}`) : null,
        },
        market,
      };
    }],
  ]);
}

// ── Exchange pairs ("where it trades") ─────────────────────────────────────
interface CgTicker {
  market: { name: string; logo?: string }; base: string; target: string; last: number;
  converted_volume?: { usd?: number }; trust_score?: string | null; trade_url?: string | null;
}
interface PaprikaMarket {
  exchange_id: string; exchange_name: string; pair: string; market_url?: string | null;
  category?: string; outlier?: boolean; trust_score?: string;
  quotes?: { USD?: { price?: number; volume_24h?: number } };
}
interface LoreMarket { name: string; base: string; quote: string; price_usd: number; volume_usd: number }
const TRUST: Record<string, ExchangeMarket["trust"]> = { green: "green", yellow: "yellow", red: "red", high: "green", medium: "yellow", low: "red" };

/** Spot pairs the coin trades on, biggest 24h volume first (≤25). */
export function getExchangeMarkets(symbol: string): Promise<ExchangeMarket[]> {
  const s = symbol.toUpperCase();
  return chain<ExchangeMarket[]>(`pairs:${s}`, 10 * 60_000, [
    ["cg", async () => {
      const id = await cgId(s);
      if (!id) throw new Error("no coingecko id");
      const j = await cgGet<{ tickers?: CgTicker[] }>(
        `/coins/${id}/tickers?include_exchange_logo=true&order=volume_desc`,
        (d) => Array.isArray(d.tickers) && d.tickers.length > 0,
      );
      return j.tickers!.slice(0, 25).map((t) => ({
        exchange: t.market.name,
        logo: t.market.logo ?? null,
        base: t.base,
        target: t.target,
        price: t.last,
        volumeUsd: num(t.converted_volume?.usd),
        trust: TRUST[t.trust_score ?? ""] ?? null,
        url: t.trade_url || null,
      }));
    }],
    ["pp", async () => {
      const id = await ppId(s);
      if (!id) throw new Error("no id");
      const raw = await httpJson(`${PAPRIKA}/coins/${id}/markets?quotes=USD`);
      const rows = (Array.isArray(raw) ? (raw as PaprikaMarket[]) : [])
        .filter((m) => !m.outlier && (m.category ?? "Spot") === "Spot" && (m.quotes?.USD?.price ?? 0) > 0)
        .sort((a, b) => (b.quotes?.USD?.volume_24h ?? 0) - (a.quotes?.USD?.volume_24h ?? 0))
        .slice(0, 25)
        .map((m) => {
          const [base, target] = m.pair.split("/");
          return {
            exchange: m.exchange_name,
            logo: `https://static.coinpaprika.com/exchanges/${m.exchange_id}/logo.png`,
            base: base ?? m.pair,
            target: target ?? "",
            price: m.quotes!.USD!.price!,
            volumeUsd: num(m.quotes?.USD?.volume_24h),
            trust: TRUST[m.trust_score ?? ""] ?? null,
            url: m.market_url || null,
          };
        });
      if (!rows.length) throw new BadPayload();
      return rows;
    }],
    ["cl", async () => {
      const [id, row] = await Promise.all([clId(s), getCoinRow(s)]);
      if (!id) throw new Error("no id");
      const raw = await httpJson(`${LORE}/coin/markets/?id=${id}`);
      const ref = row?.current_price ?? null;
      // CoinLore's USD conversion is off for some fiat pairs — keep only
      // pairs whose USD price matches the coin's.
      const rows = (Array.isArray(raw) ? (raw as LoreMarket[]) : [])
        .filter((m) => m.price_usd > 0 && (ref == null || Math.abs(m.price_usd / ref - 1) < 0.2))
        .sort((a, b) => b.volume_usd - a.volume_usd)
        .slice(0, 25)
        .map((m) => ({
          exchange: m.name, logo: null, base: m.base, target: m.quote, price: m.price_usd,
          volumeUsd: num(m.volume_usd), trust: null, url: null,
        }));
      if (!rows.length) throw new BadPayload();
      return rows;
    }],
  ]);
}

// ── Binance helpers ────────────────────────────────────────────────────────
/** Binance USDT spot prices by base symbol (one cheap call, 10 min cache). */
async function binanceUsdtPrices(): Promise<Map<string, number>> {
  const list = await cached<[string, number][]>("bn:ticker-price", {
    ttl: 10 * 60_000,
    persist: false,
    load: async () => ((await fetchBn("/api/v3/ticker/price", { signal: AbortSignal.timeout(8000) })) as { symbol: string; price: string }[])
      .filter((t) => t.symbol.endsWith("USDT"))
      .map((t) => [t.symbol.slice(0, -4), parseFloat(t.price)] as [string, number]),
  });
  return new Map(list);
}

/** "SOLUSDT" if Binance lists it AND its price matches this coin's (the same
 *  ticker can be a different or delisted coin on Binance), else null. */
async function binancePair(symbol: string, refPrice: number | null): Promise<string | null> {
  try {
    const prices = await binanceUsdtPrices();
    const s = symbol.toUpperCase();
    const p = prices.get(s);
    if (!p || !(p > 0)) return null;
    if (refPrice != null && refPrice > 0 && Math.abs(p / refPrice - 1) > 0.15) return null;
    return `${s}USDT`;
  } catch {
    return null;
  }
}

type Kline = (string | number)[];
/** Close prices stamped at each candle's close time (capped at now). */
function klines(pair: string, interval: string, limit: number, startMs?: number, endMs?: number): Promise<[number, number][]> {
  const q = `/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}${startMs != null ? `&startTime=${Math.floor(startMs)}` : ""}${endMs != null ? `&endTime=${Math.floor(endMs)}` : ""}`;
  return cached<[number, number][]>(`bn:${q}`, {
    ttl: 60_000,
    persist: false,
    load: async () => {
      const now = Date.now();
      return ((await fetchBn(q, { signal: AbortSignal.timeout(12_000) })) as Kline[])
        .map((r) => [Math.min(Number(r[6]), now), parseFloat(String(r[4]))] as [number, number]);
    },
  });
}

// ── 7-day sparklines for fallback rows (Binance 1h × 168, like CoinGecko's) ─
const SPARK_TTL = 15 * 60_000;
const sparks = new Map<string, { pts: number[]; ts: number }>();
const sparkPending = new Set<string>();
let sparkVersion = 0;
const sparkListeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
function notifySparks() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    sparkVersion++;
    sparkListeners.forEach((l) => l());
  }, 60);
}

/** 7-day hourly closes from OKX or Gate.io for coins Binance doesn't list.
 *  Only accepted if the latest close is within 15% of the coin's known price
 *  (so a different coin that shares the ticker can't slip in). */
async function altExchangeSpark(symbol: string, price: number | null): Promise<number[]> {
  const ok = (pts: number[]) =>
    pts.length > 1 && (!price || Math.abs(pts[pts.length - 1] / price - 1) < 0.15);
  const get = async (url: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      return r.ok ? await r.json() : null;
    } catch { return null; } finally { clearTimeout(timer); }
  };
  // OKX: [ts, o, h, l, c, …], newest first.
  const okx = await get(`https://www.okx.com/api/v5/market/candles?instId=${symbol}-USDT&bar=1H&limit=168`);
  if (okx?.code === "0" && Array.isArray(okx.data)) {
    const pts = (okx.data as string[][]).map((r) => parseFloat(r[4])).filter((v) => v > 0).reverse();
    if (ok(pts)) return pts;
  }
  // Gate.io: [ts, quoteVol, close, high, low, open, baseVol, closed], oldest first.
  const gate = await get(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${symbol}_USDT&interval=1h&limit=168`);
  if (Array.isArray(gate)) {
    const pts = (gate as string[][]).map((r) => parseFloat(r[2])).filter((v) => v > 0);
    if (ok(pts)) return pts;
  }
  return [];
}

const sparkQueue: { symbol: string; price: number | null }[] = [];
let sparkActive = 0;
const SPARK_CONCURRENCY = 6;
function pumpSparks() {
  while (sparkActive < SPARK_CONCURRENCY && sparkQueue.length) {
    const job = sparkQueue.shift()!;
    sparkActive++;
    (async () => {
      let pts: number[] = [];
      try {
        const pair = await binancePair(job.symbol, job.price);
        if (pair) pts = (await klines(pair, "1h", 168)).map(([, v]) => v).filter((v) => v > 0);
      } catch { /* try the next exchange */ }
      // Not on Binance: OKX, then Gate.io (both public + CORS-open).
      if (pts.length < 2) pts = await altExchangeSpark(job.symbol, job.price);
      sparks.set(job.symbol, { pts, ts: Date.now() });
      sparkPending.delete(job.symbol);
      notifySparks();
    })().finally(() => { sparkActive--; pumpSparks(); });
  }
}

/** Loads 7-day sparklines for rows that came without one (fallback data) —
 *  fire-and-forget, cached; coins with no matching Binance USDT pair simply
 *  get none. Rows that already have CoinGecko's sparkline are skipped. */
export function requestSparklines(rows: readonly { symbol: string; current_price?: number | null; sparkline_in_7d?: { price: number[] } }[]): void {
  const now = Date.now();
  for (const r of rows) {
    if (r.sparkline_in_7d?.price?.length) continue;
    const s = r.symbol.toUpperCase();
    const hit = sparks.get(s);
    if ((hit && now - hit.ts < SPARK_TTL) || sparkPending.has(s)) continue;
    sparkPending.add(s);
    sparkQueue.push({ symbol: s, price: r.current_price ?? null });
  }
  pumpSparks();
}

/** Re-renders the caller whenever new sparklines arrive. */
export function useSparklines(): number {
  return useSyncExternalStore(
    (cb) => { sparkListeners.add(cb); return () => { sparkListeners.delete(cb); }; },
    () => sparkVersion,
  );
}

/** Rows with sparkline_in_7d filled in from whatever has loaded so far. */
export function withSparklines<T extends { symbol: string; sparkline_in_7d?: { price: number[] } }>(rows: T[]): T[] {
  return rows.map((r) => {
    if (r.sparkline_in_7d?.price?.length) return r;
    const p = sparks.get(r.symbol.toUpperCase())?.pts;
    return p && p.length > 1 ? { ...r, sparkline_in_7d: { price: p } } : r;
  });
}

// ── History (market_chart) ────────────────────────────────────────────────
interface HistRow { timestamp: string; price: number; volume_24h: number; market_cap: number }
const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const toMs = (iso: string) => Date.parse(iso);
const histArr = (raw: unknown) => (Array.isArray(raw) ? (raw as HistRow[]) : []);

/** CoinPaprika daily history — the free tier allows the last 365 days. */
const ppDaily = (id: string) =>
  getJson(`${PAPRIKA}/tickers/${id}/historical?start=${isoDay(Date.now() - 364 * DAY_MS)}&interval=1d&limit=400`, 30 * 60_000, histArr);
/** CoinPaprika hourly history — the free tier allows the last ~24 hours. */
const ppHourly = (id: string) =>
  getJson(`${PAPRIKA}/tickers/${id}/historical?start=${new Date(Date.now() - 23 * 3_600_000).toISOString().slice(0, 13)}:00:00Z&interval=1h&limit=48`, 5 * 60_000, histArr, false);
/** CoinLore daily OHLCV (365 days): [ms, close, volume]. */
const clDaily = (id: string) =>
  getJson(`${LORE}/coin/ohlcv/?coin=${id}`, 30 * 60_000, (raw) => {
    const rows = Object.values((raw ?? {}) as Record<string, number[]>)
      .filter((r) => Array.isArray(r) && r.length >= 6)
      .map((r) => [Number(r[0]) * 1000, Number(r[4]), Number(r[5])] as [number, number, number])
      .sort((a, b) => a[0] - b[0]);
    if (!rows.length) throw new BadPayload();
    return rows;
  });

// Bitcoin's circulating supply at a past moment: issuance is linear between
// halvings (fixed block reward, ~10 min blocks), so interpolating between
// the halving-date supplies is accurate to well under 1% — used only for
// fallback BTC market cap older than the fallbacks' 1-year history.
const BTC_SUPPLY_ANCHORS: [number, number][] = [
  [Date.UTC(2012, 10, 28), 10_500_000],
  [Date.UTC(2016, 6, 9), 15_750_000],
  [Date.UTC(2020, 4, 11), 18_375_000],
  [Date.UTC(2024, 3, 20), 19_687_500],
];
function btcSupplyAt(ms: number, nowSupply: number | null): number | null {
  const pts = nowSupply ? [...BTC_SUPPLY_ANCHORS, [Date.now(), nowSupply] as [number, number]] : BTC_SUPPLY_ANCHORS;
  if (ms < pts[0][0]) return null;
  for (let i = 1; i < pts.length; i++) {
    const [t0, s0] = pts[i - 1], [t1, s1] = pts[i];
    if (ms <= t1) return s0 + ((s1 - s0) * (ms - t0)) / (t1 - t0);
  }
  return nowSupply;
}

function klineInterval(spanMs: number): string {
  const d = spanMs / DAY_MS;
  if (d <= 2) return "5m";
  if (d <= 41) return "1h";
  if (d <= 166) return "4h";
  if (d <= 1000) return "1d";
  return "1w";
}

/** Fine-grained Binance prices for a window ([] when no matching pair). */
async function binancePrices(symbol: string, refPrice: number | null, fromMs: number, toMsV: number): Promise<[number, number][]> {
  const pair = await binancePair(symbol, refPrice);
  if (!pair) return [];
  try {
    return (await klines(pair, klineInterval(toMsV - fromMs), 1000, fromMs, toMsV)).filter(([t, v]) => v > 0 && t >= fromMs);
  } catch {
    return [];
  }
}

/** BTC market cap for points older than `before`, from its issuance schedule. */
function btcOldCaps(prices: [number, number][], before: number, circ: number | null): [number, number][] {
  const out: [number, number][] = [];
  for (const [t, p] of prices) {
    if (t >= before) break;
    const s = btcSupplyAt(t, circ);
    if (s) out.push([t, p * s]);
  }
  return out;
}

/**
 * CoinPaprika (+ Binance) market_chart for [fromMs, toMs]:
 * prices: Binance klines (≤1000 points), else CoinPaprika history.
 * market_caps: up to ~41 days → price × current circulating supply; longer →
 *   CoinPaprika's real daily market caps (last 365 days; BTC's older history
 *   from its issuance schedule; other coins have none before that).
 * total_volumes: rolling 24h volume — hourly for the last day, else daily.
 */
async function ppChart(symbol: string, fromMs: number, toMsV: number): Promise<MarketChart> {
  const id = await ppId(symbol);
  if (!id) throw new Error("no id");
  const row = await ppRow(symbol).catch(() => null);
  const span = toMsV - fromMs;
  const inWin = (t: number) => t >= fromMs && t <= toMsV;
  const useHourly = span <= 1.05 * DAY_MS && fromMs >= Date.now() - 24.5 * 3_600_000;
  const hist = useHourly ? await ppHourly(id).catch(() => []) : await ppDaily(id).catch(() => []);
  const series = (f: (r: HistRow) => number) => hist.map((r) => [toMs(r.timestamp), f(r)] as [number, number]).filter(([t, v]) => inWin(t) && v > 0);

  let prices = await binancePrices(symbol, row?.current_price ?? null, fromMs, toMsV);
  if (prices.length < 2) prices = series((r) => r.price);
  const circ = row?.circulating_supply ?? null;
  let market_caps: [number, number][];
  if (span <= 41 * DAY_MS) {
    market_caps = circ ? prices.map(([t, p]) => [t, p * circ]) : series((r) => r.market_cap);
  } else {
    const first = hist.length ? toMs(hist[0].timestamp) : Infinity;
    market_caps = [...(symbol === "BTC" ? btcOldCaps(prices, first, circ) : []), ...series((r) => r.market_cap)];
  }
  const total_volumes = series((r) => r.volume_24h);
  if (prices.length < 2) throw new BadPayload();
  return { prices, market_caps, total_volumes };
}

/**
 * CoinLore (+ Binance) market_chart: prices from Binance, else CoinLore's
 * daily closes (last 365 days); market cap is an estimate — price × current
 * circulating supply (CoinLore has no market-cap history); volume = CoinLore
 * daily volume.
 */
async function clChart(symbol: string, fromMs: number, toMsV: number): Promise<MarketChart> {
  const id = await clId(symbol);
  if (!id) throw new Error("no id");
  const row = await clRow(symbol).catch(() => null);
  const daily = (await clDaily(id).catch(() => [] as [number, number, number][])).filter(([t]) => t >= fromMs && t <= toMsV);
  let prices = await binancePrices(symbol, row?.current_price ?? null, fromMs, toMsV);
  if (prices.length < 2) prices = daily.map(([t, c]) => [t, c] as [number, number]).filter(([, v]) => v > 0);
  if (prices.length < 2) throw new BadPayload();
  const circ = row?.circulating_supply ?? null;
  const market_caps: [number, number][] = symbol === "BTC"
    ? btcOldCaps(prices, Infinity, circ)
    : circ ? prices.map(([t, p]) => [t, p * circ]) : [];
  const total_volumes = daily.map(([t, , v]) => [t, v] as [number, number]).filter(([, v]) => v > 0);
  return { prices, market_caps, total_volumes };
}

const validChart = (d: Partial<MarketChart>) => Array.isArray(d.prices) && d.prices.length > 1;
const cgChart = (d: Partial<MarketChart>): MarketChart => ({ prices: d.prices ?? [], market_caps: d.market_caps ?? [], total_volumes: d.total_volumes ?? [] });

/** CoinGecko market_chart?days= ("max" = all history). */
export function getMarketChart(symbol: string, days: number | "max"): Promise<MarketChart> {
  const s = symbol.toUpperCase();
  const now = Date.now();
  const from = days === "max" ? 1_293_840_000_000 : now - days * DAY_MS;
  return chain<MarketChart>(`chart:${s}:${days}`, days === 1 ? 60_000 : 300_000, [
    ["cg", async () => {
      const id = await cgId(s);
      if (!id) throw new Error("no coingecko id");
      return cgChart(await cgGet<Partial<MarketChart>>(`/coins/${id}/market_chart?vs_currency=usd&days=${days}`, validChart));
    }],
    ["pp", () => ppChart(s, from, now)],
    ["cl", () => clChart(s, from, now)],
  ], days !== 1);
}

/** CoinGecko market_chart/range equivalent (unix seconds). */
export function getMarketChartRange(symbol: string, fromSec: number, toSec: number): Promise<MarketChart> {
  const s = symbol.toUpperCase();
  const toMsV = Math.min(toSec * 1000, Date.now());
  const recent = Date.now() - toMsV < 10 * 60_000;
  return chain<MarketChart>(`chart:${s}:${Math.floor(fromSec / 300)}:${Math.floor(toSec / 300)}`, recent ? 60_000 : 3_600_000, [
    ["cg", async () => {
      const id = await cgId(s);
      if (!id) throw new Error("no coingecko id");
      return cgChart(await cgGet<Partial<MarketChart>>(`/coins/${id}/market_chart/range?vs_currency=usd&from=${fromSec}&to=${toSec}`, validChart));
    }],
    ["pp", () => ppChart(s, fromSec * 1000, toMsV)],
    ["cl", () => clChart(s, fromSec * 1000, toMsV)],
  ], false);
}

/** One point per UTC day (that day's last value). */
export function toDaily(pairs: [number, number][]): [number, number][] {
  const m = new Map<string, [number, number]>();
  for (const p of pairs) m.set(isoDay(p[0]), p);
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}
