const US_BTC_ETFS: { ticker: string; name: string }[] = [
  { ticker: 'IBIT',  name: 'iShares Bitcoin Trust' },
  { ticker: 'FBTC',  name: 'Fidelity Wise Origin Bitcoin Fund' },
  { ticker: 'GBTC',  name: 'Grayscale Bitcoin Trust' },
  { ticker: 'BITB',  name: 'Bitwise Bitcoin ETF' },
  { ticker: 'ARKB',  name: 'ARK 21Shares Bitcoin ETF' },
  { ticker: 'HODL',  name: 'VanEck Bitcoin ETF' },
  { ticker: 'BTCO',  name: 'Invesco Galaxy Bitcoin ETF' },
  { ticker: 'BRRR',  name: 'Valkyrie Bitcoin Fund' },
  { ticker: 'EZBC',  name: 'Franklin Bitcoin ETF' },
  { ticker: 'BTCW',  name: 'WisdomTree Bitcoin Fund' },
];

export interface ETFRow {
  ticker: string;
  name: string;
  dailyFlowUsd: number;
  aumUsd: number;
  priceUsd: number;
  priceChangePct: number;
  volumeUsd: number;
  sharesOutstanding: number;
}

export interface ETFDayTotal {
  date: string;
  flowUsd: number;
  priceUsd: number;
  perFund: { etf_ticker: string; flow_usd: number }[];
}

export interface ETFData {
  rows: ETFRow[];
  history: ETFDayTotal[];
  latestDate: string;
  source: 'bold';
}

function parseUsd(s: string | null | undefined): number {
  if (!s) return 0;
  return Number(String(s).replace(/[$,%]/g, '').replace(/,/g, '')) || 0;
}

function parsePct(s: string | null | undefined): number {
  if (!s) return 0;
  return Number(String(s).replace(/[%+]/g, '')) || 0;
}

async function fetchNasdaqQuote(ticker: string): Promise<ETFRow> {
  const base = US_BTC_ETFS.find(e => e.ticker === ticker)!;
  try {
    const [infoRes, summaryRes] = await Promise.all([
      fetch(`/nasdaq-api/api/quote/${ticker}/info?assetclass=etf`).then(r => r.json()),
      fetch(`/nasdaq-api/api/quote/${ticker}/summary?assetclass=etf`).then(r => r.json()),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = infoRes?.data?.primaryData ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s: any = summaryRes?.data?.summaryData ?? {};

    const priceUsd = parseUsd(p.lastSalePrice);
    const shareVolume = parseUsd(p.volume);
    const marketCap = parseUsd(s.MarketCap?.value);

    return {
      ticker,
      name: base.name,
      dailyFlowUsd: 0,
      aumUsd: marketCap,
      priceUsd,
      priceChangePct: parsePct(p.percentageChange),
      volumeUsd: shareVolume * priceUsd,
      sharesOutstanding: marketCap > 0 && priceUsd > 0 ? Math.round(marketCap / priceUsd) : 0,
    };
  } catch {
    return { ticker, name: base.name, dailyFlowUsd: 0, aumUsd: 0, priceUsd: 0, priceChangePct: 0, volumeUsd: 0, sharesOutstanding: 0 };
  }
}

export async function getETFData(): Promise<ETFData> {
  const [unitsResult, rowResults] = await Promise.all([
    fetch('/bold-api/bitcoin/funds/units.json').then(r => r.json()).catch(() => null),
    Promise.all(US_BTC_ETFS.map(e => fetchNasdaqQuote(e.ticker))),
  ]);

  // Build history from BOLD daily unit-change × price
  const unitsRaw: { date: string; units: number; price: number }[] =
    (unitsResult?.data ?? []).filter((d: { units?: number }) => d.units != null);

  const history: ETFDayTotal[] = [];
  for (let i = 1; i < unitsRaw.length; i++) {
    const prev = unitsRaw[i - 1];
    const cur  = unitsRaw[i];
    history.push({
      date:     cur.date,
      flowUsd:  (cur.units - prev.units) * cur.price,
      priceUsd: cur.price,
      perFund:  [],
    });
  }

  const latestDate = history[history.length - 1]?.date ?? new Date().toISOString().slice(0, 10);

  return { rows: rowResults, history, latestDate, source: 'bold' };
}
