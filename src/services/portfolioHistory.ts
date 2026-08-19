import { coinglass, CandleDataPoint, CoinSymbol } from "./coinglass";

export type ValuePeriod = "1H" | "1D" | "1W" | "1M" | "1Y" | "ALL";

export const VALUE_PERIODS: ValuePeriod[] = ["1H", "1D", "1W", "1M", "1Y", "ALL"];

export interface Holding {
  symbol: string;
  amount: number;
}

export interface ValuePoint {
  time: number;
  value: number;
}

async function fetchCoinSeries(symbol: string, period: ValuePeriod): Promise<CandleDataPoint[]> {
  const coin = symbol as CoinSymbol | string;
  switch (period) {
    case "1H":
      return coinglass.get24hMinuteCandles(coin, 65);
    case "1D":
      return coinglass.get24hMinuteCandles(coin, 1440);
    case "1W":
      return coinglass.getHistoricalCandles("1h", coin);
    case "1M": {
      const daily = await coinglass.getHistoricalCandles("1day", coin);
      return daily.slice(-31);
    }
    case "1Y":
      return coinglass.getHistoricalCandles("1week", coin);
    case "ALL":
      return coinglass.getHistoricalCandles("all", coin);
  }
}

// Binary search for the candle closest in time to `t` — candles assumed sorted ascending.
function nearestCandle(candles: CandleDataPoint[], t: number): CandleDataPoint | null {
  if (!candles.length) return null;
  let lo = 0, hi = candles.length - 1;
  if (t <= (candles[0].time as number)) return candles[0];
  if (t >= (candles[hi].time as number)) return candles[hi];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((candles[mid].time as number) < t) lo = mid + 1; else hi = mid;
  }
  const before = candles[lo - 1];
  const after = candles[lo];
  if (!before) return after;
  const dBefore = t - (before.time as number);
  const dAfter = (after.time as number) - t;
  return dBefore <= dAfter ? before : after;
}

/**
 * Builds a combined portfolio value series over `period` by fetching each
 * held coin's historical candles and summing amount × price at each point
 * on a shared timestamp grid. The grid is taken from whichever coin has the
 * fewest candles (the coarsest/shortest series), cropped to the range where
 * every coin has data — so a recently-listed coin doesn't produce a
 * misleading value cliff at the start of e.g. the "ALL" period.
 */
export async function getPortfolioValueSeries(
  holdings: Holding[],
  period: ValuePeriod,
): Promise<ValuePoint[]> {
  const withAmount = holdings.filter(h => h.amount > 0);
  if (!withAmount.length) return [];

  const uniqueSymbols = Array.from(new Set(withAmount.map(h => h.symbol)));
  const seriesByCoin = new Map<string, CandleDataPoint[]>();
  await Promise.all(uniqueSymbols.map(async (symbol) => {
    try {
      const series = await fetchCoinSeries(symbol, period);
      if (series.length) seriesByCoin.set(symbol, series);
    } catch {
      // Coin has no chartable history (e.g. no Binance USDT pair) — skip it,
      // its value just won't be reflected in the chart/gain-loss figures.
    }
  }));

  const usable = withAmount.filter(h => seriesByCoin.has(h.symbol));
  if (!usable.length) return [];

  let refSeries: CandleDataPoint[] | null = null;
  for (const h of usable) {
    const series = seriesByCoin.get(h.symbol)!;
    if (!refSeries || series.length < refSeries.length) refSeries = series;
  }
  if (!refSeries || refSeries.length < 2) return [];

  const startTime = Math.max(
    ...usable.map(h => seriesByCoin.get(h.symbol)![0].time as number),
  );
  const grid = refSeries.filter(c => (c.time as number) >= startTime);
  if (grid.length < 2) return [];

  return grid.map((pt) => {
    const t = pt.time as number;
    let value = 0;
    for (const h of usable) {
      const candle = nearestCandle(seriesByCoin.get(h.symbol)!, t);
      if (candle) value += h.amount * candle.close;
    }
    return { time: t, value };
  });
}
