import axios from 'axios';

const deribitApi = axios.create({
  baseURL: 'https://www.deribit.com/api/v2/public',
  timeout: 15000,
  headers: { accept: 'application/json' },
});

export type OptionCurrency = 'BTC' | 'ETH';

interface RawInstrument {
  instrument_name: string;
  strike: number;
  option_type: 'call' | 'put';
  expiration_timestamp: number;
  is_active: boolean;
}

interface RawBookSummary {
  instrument_name: string;
  open_interest: number;
  mark_iv: number | null;
  underlying_price: number | null;
}

export interface OptionLeg {
  strike: number;
  type: 'call' | 'put';
  openInterest: number;
  markIv: number | null;
}

export interface ExpiryGroup {
  expiryMs: number;
  label: string;
  legs: OptionLeg[];
  totalOI: number;
}

export interface OptionsSnapshot {
  currency: OptionCurrency;
  spot: number;
  expiries: ExpiryGroup[];
  fetchedAt: number;
}

export interface ExpiryStats {
  maxPain: number;
  putCallRatio: number;
  atmIv: number | null;
  totalCallOI: number;
  totalPutOI: number;
  totalOI: number;
}

const CACHE_TTL = 5 * 60 * 1000;
const snapshotCache = new Map<OptionCurrency, { data: OptionsSnapshot; fetchedAt: number }>();
const inFlight = new Map<OptionCurrency, Promise<OptionsSnapshot>>();

function fmtExpiryLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

async function fetchSnapshot(currency: OptionCurrency): Promise<OptionsSnapshot> {
  const cached = snapshotCache.get(currency);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.data;

  const flying = inFlight.get(currency);
  if (flying) return flying;

  const doFetch = async (): Promise<OptionsSnapshot> => {
    try {
      const [instrumentsRes, summaryRes] = await Promise.all([
        deribitApi.get('/get_instruments', { params: { currency, kind: 'option', expired: false } }),
        deribitApi.get('/get_book_summary_by_currency', { params: { currency, kind: 'option' } }),
      ]);

      const instruments = instrumentsRes.data.result as RawInstrument[];
      const summaries = summaryRes.data.result as RawBookSummary[];
      const summaryByName = new Map(summaries.map(s => [s.instrument_name, s]));

      let spot = 0;
      const byExpiry = new Map<number, OptionLeg[]>();

      for (const inst of instruments) {
        if (!inst.is_active) continue;
        const summary = summaryByName.get(inst.instrument_name);
        if (!summary) continue;
        if (summary.underlying_price) spot = summary.underlying_price;

        const leg: OptionLeg = {
          strike: inst.strike,
          type: inst.option_type,
          openInterest: summary.open_interest ?? 0,
          markIv: summary.mark_iv ?? null,
        };
        const list = byExpiry.get(inst.expiration_timestamp);
        if (list) list.push(leg);
        else byExpiry.set(inst.expiration_timestamp, [leg]);
      }

      const expiries: ExpiryGroup[] = Array.from(byExpiry.entries())
        .map(([expiryMs, legs]) => ({
          expiryMs,
          label: fmtExpiryLabel(expiryMs),
          legs: legs.sort((a, b) => a.strike - b.strike),
          totalOI: legs.reduce((s, l) => s + l.openInterest, 0),
        }))
        .sort((a, b) => a.expiryMs - b.expiryMs);

      const data: OptionsSnapshot = { currency, spot, expiries, fetchedAt: Date.now() };
      snapshotCache.set(currency, { data, fetchedAt: Date.now() });
      return data;
    } catch (err) {
      if (cached?.data) return cached.data;
      throw err;
    }
  };

  const promise = doFetch().finally(() => inFlight.delete(currency));
  inFlight.set(currency, promise);
  return promise;
}

// Candidate settlement prices are the listed strikes only — the total payout
// to option holders is piecewise-linear/convex in the settlement price, so
// its minimum always lands exactly on a strike (a kink point).
function computeExpiryStats(legs: OptionLeg[], spot: number): ExpiryStats {
  const strikes = Array.from(new Set(legs.map(l => l.strike))).sort((a, b) => a - b);

  let maxPain = strikes[0] ?? 0;
  let bestPayout = Infinity;
  for (const settle of strikes) {
    let payout = 0;
    for (const leg of legs) {
      payout += leg.type === 'call'
        ? Math.max(0, settle - leg.strike) * leg.openInterest
        : Math.max(0, leg.strike - settle) * leg.openInterest;
    }
    if (payout < bestPayout) {
      bestPayout = payout;
      maxPain = settle;
    }
  }

  const totalCallOI = legs.filter(l => l.type === 'call').reduce((s, l) => s + l.openInterest, 0);
  const totalPutOI = legs.filter(l => l.type === 'put').reduce((s, l) => s + l.openInterest, 0);

  const withIv = legs.filter(l => l.markIv != null);
  const atmIv = spot && withIv.length
    ? withIv.reduce((best, l) => Math.abs(l.strike - spot) < Math.abs(best.strike - spot) ? l : best).markIv
    : null;

  return {
    maxPain,
    putCallRatio: totalCallOI > 0 ? totalPutOI / totalCallOI : 0,
    atmIv,
    totalCallOI,
    totalPutOI,
    totalOI: totalCallOI + totalPutOI,
  };
}

// Avoids defaulting into a near-empty column right after a monthly expiry
// rolls off — prefer soonest, but skip ahead if it's too thin to be meaningful.
const MIN_OI_FLOOR = 100;

function pickDefaultExpiry(expiries: ExpiryGroup[]): ExpiryGroup | null {
  if (!expiries.length) return null;
  return expiries.find(e => e.totalOI >= MIN_OI_FLOOR) ?? expiries[0];
}

export const deribit = {
  getOptionsSnapshot: fetchSnapshot,
  computeExpiryStats,
  pickDefaultExpiry,
};
