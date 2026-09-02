import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { coinglass } from "../services/coinglass";
import { fetchFearGreed } from "../services/feargreed";
import "../styles/CoinMarketMood.css";

interface Props {
  coin: string;
}

interface MoodData {
  fundingRate: number | null;
  longShortRatio: number | null;
  fearGreedValue: number | null;
  fearGreedLabel: string | null;
}

const EMPTY: MoodData = { fundingRate: null, longShortRatio: null, fearGreedValue: null, fearGreedLabel: null };

// Real, already-fetched market data — funding rate + long/short ratio from
// CoinGlass/exchange APIs, Fear & Greed from alternative.me — never
// fabricated commentary. Clearly labeled as data, not chat.
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
        fundingRate: typeof btc?.fundingRate === "number" ? btc.fundingRate : null,
        longShortRatio: typeof btc?.longShortRatio === "number" ? btc.longShortRatio : null,
        fearGreedValue: fg?.current.value ?? null,
        fearGreedLabel: fg?.current.classification ?? null,
      });
    });

    return () => { cancelled = true; };
  }, [coin]);

  const hasAny = data.fundingRate !== null || data.longShortRatio !== null || data.fearGreedValue !== null;
  if (!hasAny) return null;

  const fundingUp = (data.fundingRate ?? 0) >= 0;
  const lsUp = (data.longShortRatio ?? 1) >= 1;

  return (
    <div className="coin-mood">
      <span className="coin-mood-label">{t("coinChat.marketData", "Market data")}</span>
      <div className="coin-mood-metrics">
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
