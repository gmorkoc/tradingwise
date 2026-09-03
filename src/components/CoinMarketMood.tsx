import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { coinglass } from "../services/coinglass";
import { fetchFearGreed } from "../services/feargreed";
import "../styles/CoinMarketMood.css";

interface Props {
  coin: string;
}

interface MoodData {
  price: number | null;
  fundingRate: number | null;
  longShortRatio: number | null;
  fearGreedValue: number | null;
  fearGreedLabel: string | null;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  openInterest: number | null;
  liquidationAbove: number | null;
  liquidationBelow: number | null;
}

const EMPTY: MoodData = {
  price: null, fundingRate: null, longShortRatio: null, fearGreedValue: null, fearGreedLabel: null,
  rsi: null, macd: null, macdSignal: null, openInterest: null, liquidationAbove: null, liquidationBelow: null,
};

function fmtPrice(p: number): string {
  return `$${p.toLocaleString("en-US", { maximumFractionDigits: p >= 1000 ? 0 : p >= 1 ? 2 : 6 })}`;
}

function fmtCompactUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

// Real, already-fetched market data — price, funding rate, long/short
// ratio, RSI, MACD trend, open interest and liquidation zones from
// CoinGlass/exchange APIs, Fear & Greed from alternative.me — never
// fabricated commentary. Clearly labeled as data, not chat. A horizontal
// scroll ticker rather than a wrapping row so it never grows past one
// line no matter how many of these happen to have data.
export function CoinMarketMood({ coin }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<MoodData>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    setData(EMPTY);

    Promise.all([
      coinglass.getAllBTCData(coin).catch(() => null),
      fetchFearGreed().catch(() => null),
    ]).then(([btc, fg]) => {
      if (cancelled) return;
      setData({
        price: typeof btc?.price === "number" ? btc.price : null,
        fundingRate: typeof btc?.fundingRate === "number" ? btc.fundingRate : null,
        longShortRatio: typeof btc?.longShortRatio === "number" ? btc.longShortRatio : null,
        fearGreedValue: fg?.current.value ?? null,
        fearGreedLabel: fg?.current.classification ?? null,
        rsi: typeof btc?.rsi === "number" ? btc.rsi : null,
        macd: typeof btc?.macd === "number" ? btc.macd : null,
        macdSignal: typeof btc?.macdSignal === "number" ? btc.macdSignal : null,
        openInterest: typeof btc?.openInterest === "number" ? btc.openInterest : null,
        liquidationAbove: typeof btc?.liquidationAbove === "number" ? btc.liquidationAbove : null,
        liquidationBelow: typeof btc?.liquidationBelow === "number" ? btc.liquidationBelow : null,
      });
    });

    return () => { cancelled = true; };
  }, [coin]);

  const hasAny = Object.values(data).some((v) => v !== null);
  if (!hasAny) return null;

  const fundingUp = (data.fundingRate ?? 0) >= 0;
  const lsUp = (data.longShortRatio ?? 1) >= 1;
  // Standard 70/30 overbought/oversold thresholds — same convention used
  // in the tutorial and Alt Analysis' indicator glossary.
  const rsiClass = data.rsi === null ? "" : data.rsi >= 70 ? " down" : data.rsi <= 30 ? " up" : "";
  const macdUp = data.macd !== null && data.macdSignal !== null ? data.macd >= data.macdSignal : null;

  return (
    <div className="coin-mood">
      <span className="coin-mood-label">{t("coinChat.marketData", "Market data")}</span>
      <div className="coin-mood-scroll">
        {data.price !== null && (
          <span className="coin-mood-metric">
            <span className="coin-mood-metric-label">{t("coinChat.price", "Price")}</span>
            <span className="coin-mood-metric-value">{fmtPrice(data.price)}</span>
          </span>
        )}
        {data.fundingRate !== null && (
          <span className="coin-mood-metric">
            <span className="coin-mood-metric-label">{t("coinChat.funding", "Funding")}</span>
            <span className={`coin-mood-metric-value${fundingUp ? " up" : " down"}`}>
              {fundingUp ? "+" : ""}{(data.fundingRate * 100).toFixed(3)}%
            </span>
          </span>
        )}
        {data.longShortRatio !== null && (
          <span className="coin-mood-metric">
            <span className="coin-mood-metric-label">{t("coinChat.longShort", "L/S")}</span>
            <span className={`coin-mood-metric-value${lsUp ? " up" : " down"}`}>
              {data.longShortRatio.toFixed(2)}
            </span>
          </span>
        )}
        {data.rsi !== null && (
          <span className="coin-mood-metric">
            <span className="coin-mood-metric-label">{t("coinChat.rsi", "RSI")}</span>
            <span className={`coin-mood-metric-value${rsiClass}`}>{data.rsi.toFixed(0)}</span>
          </span>
        )}
        {macdUp !== null && (
          <span className="coin-mood-metric">
            <span className="coin-mood-metric-label">{t("coinChat.macd", "MACD")}</span>
            <span className={`coin-mood-metric-value${macdUp ? " up" : " down"}`}>
              {macdUp ? t("coinChat.bullish", "Bullish") : t("coinChat.bearish", "Bearish")}
            </span>
          </span>
        )}
        {data.openInterest !== null && (
          <span className="coin-mood-metric">
            <span className="coin-mood-metric-label">{t("coinChat.openInterest", "OI")}</span>
            <span className="coin-mood-metric-value">{fmtCompactUsd(data.openInterest)}</span>
          </span>
        )}
        {data.liquidationAbove !== null && (
          <span className="coin-mood-metric">
            <span className="coin-mood-metric-label">{t("coinChat.liqAbove", "Liq Above")}</span>
            <span className="coin-mood-metric-value down">{fmtPrice(data.liquidationAbove)}</span>
          </span>
        )}
        {data.liquidationBelow !== null && (
          <span className="coin-mood-metric">
            <span className="coin-mood-metric-label">{t("coinChat.liqBelow", "Liq Below")}</span>
            <span className="coin-mood-metric-value up">{fmtPrice(data.liquidationBelow)}</span>
          </span>
        )}
        {data.fearGreedValue !== null && (
          <span className="coin-mood-metric">
            <span className="coin-mood-metric-label">{t("coinChat.fearGreed", "Fear & Greed")}</span>
            <span className="coin-mood-metric-value">{data.fearGreedValue} · {data.fearGreedLabel}</span>
          </span>
        )}
      </div>
    </div>
  );
}
