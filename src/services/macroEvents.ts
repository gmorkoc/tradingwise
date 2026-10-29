import { Capacitor, CapacitorHttp } from "@capacitor/core";

// This week's high-impact US economic events (FOMC, CPI, jobs, GDP, PCE…)
// — the scheduled headlines that move crypto hardest. Used by Pro Vision to
// warn ahead of time and pause signals around each release.
//
// Source: the public Forex Factory weekly calendar JSON. Browsers get it via
// our own /ff-cal proxy (middleware.ts in production, vite.config.ts in dev)
// because the upstream sends no CORS header; the native app calls it
// directly through CapacitorHttp, which isn't subject to CORS.

export interface MacroEvent {
  title: string;
  /** Epoch ms. */
  time: number;
  forecast?: string;
  previous?: string;
}

const UPSTREAM = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CACHE_KEY = "macroEvents:v1";
const TTL_MS = 30 * 60 * 1000;

let memo: { at: number; events: MacroEvent[] } | null = null;
let inflight: Promise<MacroEvent[]> | null = null;

interface RawEvent { title?: string; country?: string; date?: string; impact?: string; forecast?: string; previous?: string }

function parse(raw: unknown): MacroEvent[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawEvent[])
    .filter((e) => e.country === "USD" && e.impact === "High" && e.title && e.date)
    .map((e) => ({ title: e.title as string, time: Date.parse(e.date as string), forecast: e.forecast || undefined, previous: e.previous || undefined }))
    .filter((e) => Number.isFinite(e.time))
    .sort((a, b) => a.time - b.time);
}

export async function getMacroEvents(): Promise<MacroEvent[]> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.events;
  if (!memo) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (cached && Date.now() - cached.at < TTL_MS) { memo = cached; return cached.events; }
    } catch { /* ignore */ }
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      let data: unknown;
      if (Capacitor.isNativePlatform()) {
        const res = await CapacitorHttp.get({ url: UPSTREAM, headers: { accept: "application/json" } });
        data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
      } else {
        const res = await fetch("/ff-cal");
        if (!res.ok) throw new Error(`calendar ${res.status}`);
        data = await res.json();
      }
      const events = parse(data);
      memo = { at: Date.now(), events };
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(memo)); } catch { /* ignore */ }
      return events;
    } catch {
      return memo?.events ?? [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Signals are paused from this long before an event… */
export const EVENT_PAUSE_BEFORE_MS = 30 * 60 * 1000;
/** …until this long after it. */
export const EVENT_PAUSE_AFTER_MS = 60 * 60 * 1000;

/** Short, friendly name for a calendar title ("Core CPI m/m" → "CPI"). */
export function eventShortName(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("fomc") || t.includes("federal funds")) return "FOMC";
  if (t.includes("cpi")) return "CPI";
  if (t.includes("ppi")) return "PPI";
  if (t.includes("pce")) return "PCE";
  if (t.includes("non-farm") || t.includes("nonfarm") || t.includes("employment")) return "Jobs report";
  if (t.includes("gdp")) return "GDP";
  if (t.includes("retail sales")) return "Retail sales";
  if (t.includes("unemployment claims")) return "Jobless claims";
  if (t.includes("ism")) return "ISM";
  if (t.includes("powell") || t.includes("fed chair")) return "Fed Chair speech";
  return title;
}
