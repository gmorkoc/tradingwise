import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BTCData, CoinSymbol, coinglass } from "../services/coinglass";
import "../styles/DataDisplay.css";

interface DataDisplayProps {
  data: Partial<BTCData> | null;
  loading: boolean;
  coin?: CoinSymbol;
}

const STATUS_KEYS = [
  "liquidationAbove", "liquidationBelow", "openInterest",
  "fundingRate", "rsi", "macd", "longShortRatio",
] as const;
type StatusKey = typeof STATUS_KEYS[number];

function deriveStatusClass(key: StatusKey, data: Partial<BTCData>): string {
  switch (key) {
    case "liquidationAbove":
      if (!data.price || !data.liquidationAbove) return "neutral";
      return data.liquidationAbove - data.price > data.price * 0.03 ? "bullish" : "bearish";
    case "liquidationBelow":
      if (!data.price || !data.liquidationBelow) return "neutral";
      return data.price - data.liquidationBelow > data.price * 0.03 ? "bullish" : "bearish";
    case "openInterest":
      return (data.openInterest ?? 0) > 50_000_000 ? "bullish" : "neutral";
    case "fundingRate":
      return (data.fundingRate ?? 0) > 0 ? "bullish" : "bearish";
    case "rsi": {
      const rsi = data.rsi ?? 50;
      if (rsi >= 70) return "bearish";
      if (rsi <= 30) return "bullish";
      return "neutral";
    }
    case "macd":
      return (data.macd ?? 0) > 0 ? "bullish" : "bearish";
    case "longShortRatio":
      return (data.longShortRatio ?? 1) > 1 ? "bullish" : "bearish";
    default:
      return "neutral";
  }
}

type FlashDir = "flash-up" | "flash-down" | "";

export const DataDisplay: React.FC<DataDisplayProps> = ({
  data,
  loading,
  coin = "BTC",
}) => {
  const { t } = useTranslation();

  // Live price — polled every second inside this component only
  const [livePrice, setLivePrice] = useState<number | undefined>(undefined);
  useEffect(() => {
    const id = setInterval(async () => {
      const candle = await coinglass.getLiveSecondCandle(coin);
      if (candle) setLivePrice(candle.close);
    }, 1000);
    return () => clearInterval(id);
  }, [coin]);

  const displayPrice = livePrice ?? data?.price;

  // Price flash
  const prevPriceRef = useRef<number | undefined>(undefined);
  const [priceFlash, setPriceFlash] = useState<FlashDir>("");

  // Status-change flash for all other cards
  const prevStatusRef = useRef<Partial<Record<StatusKey, string>>>({});
  const [cardFlash, setCardFlash] = useState<Partial<Record<StatusKey, FlashDir>>>({});

  useEffect(() => {
    const prev = prevPriceRef.current;
    const curr = displayPrice;
    if (curr !== undefined && prev !== undefined && curr !== prev) {
      setPriceFlash(curr > prev ? "flash-up" : "flash-down");
    }
    prevPriceRef.current = curr;
  }, [displayPrice]);

  useEffect(() => {
    if (!data) return;
    const newFlashes: Partial<Record<StatusKey, FlashDir>> = {};
    for (const key of STATUS_KEYS) {
      const curr = deriveStatusClass(key, data);
      const prev = prevStatusRef.current[key];
      if (prev !== undefined && prev !== curr) {
        newFlashes[key] = curr === "bullish" ? "flash-up" : curr === "bearish" ? "flash-down" : "";
      }
      prevStatusRef.current[key] = curr;
    }
    if (Object.keys(newFlashes).length > 0) {
      setCardFlash((prev) => ({ ...prev, ...newFlashes }));
    }
  }, [data]);

  const clearCardFlash = (key: StatusKey) =>
    setCardFlash((prev) => ({ ...prev, [key]: "" }));

  if (loading && !data) {
    return <div className="data-display loading">{t("dataDisplay.loading")}</div>;
  }

  if (!data) {
    return (
      <div className="data-display error">
        {t("dataDisplay.failed")}
      </div>
    );
  }

  const priceMidpoint =
    data.liquidationAbove && data.liquidationBelow
      ? (data.liquidationAbove + data.liquidationBelow) / 2
      : undefined;

  const getStatus = (value: number | undefined, type: string) => {
    if (value === undefined || value === null || Number.isNaN(value)) {
      return { label: t("common.na"), className: "neutral" };
    }

    switch (type) {
      case "price":
        if (priceMidpoint === undefined)
          return { label: t("common.neutral"), className: "neutral" };
        return value >= priceMidpoint
          ? { label: t("common.bullish"), className: "bullish" }
          : { label: t("common.bearish"), className: "bearish" };
      case "liquidationAbove":
        if (!data.price) return { label: t("common.neutral"), className: "neutral" };
        return value - data.price > data.price * 0.03
          ? { label: t("common.bullish"), className: "bullish" }
          : { label: t("common.bearish"), className: "bearish" };
      case "liquidationBelow":
        if (!data.price) return { label: t("common.neutral"), className: "neutral" };
        return data.price - value > data.price * 0.03
          ? { label: t("common.bullish"), className: "bullish" }
          : { label: t("common.bearish"), className: "bearish" };
      case "openInterest":
        return value > 50000000
          ? { label: t("common.bullish"), className: "bullish" }
          : { label: t("common.neutral"), className: "neutral" };
      case "fundingRate":
        return value > 0
          ? { label: t("common.bullish"), className: "bullish" }
          : { label: t("common.bearish"), className: "bearish" };
      case "rsi":
        if (value >= 70) return { label: t("common.bearish"), className: "bearish" };
        if (value <= 30) return { label: t("common.bullish"), className: "bullish" };
        return { label: t("common.neutral"), className: "neutral" };
      case "macd":
        return value > 0
          ? { label: t("common.bullish"), className: "bullish" }
          : { label: t("common.bearish"), className: "bearish" };
      case "longShortRatio":
        return value > 1
          ? { label: t("common.bullish"), className: "bullish" }
          : { label: t("common.bearish"), className: "bearish" };
      default:
        return { label: t("common.neutral"), className: "neutral" };
    }
  };

  const indicators = {
    price: getStatus(data.price, "price"),
    liquidationAbove: getStatus(data.liquidationAbove, "liquidationAbove"),
    liquidationBelow: getStatus(data.liquidationBelow, "liquidationBelow"),
    openInterest: getStatus(data.openInterest, "openInterest"),
    fundingRate: getStatus(data.fundingRate, "fundingRate"),
    rsi: getStatus(data.rsi, "rsi"),
    macd: getStatus(data.macd, "macd"),
    longShortRatio: getStatus(data.longShortRatio, "longShortRatio"),
  };

  const cardClass = (key: StatusKey) =>
    `data-card${cardFlash[key] ? ` ${cardFlash[key]}` : ""}`;

  return (
    <div className="data-display">
      <div className="data-grid">
        <div
          className={`data-card${priceFlash ? ` ${priceFlash}` : ""}`}
          onAnimationEnd={() => setPriceFlash("")}
        >
          <div className="card-label tooltip">
            {t("dataDisplay.coinPrice", { coin })}
            <span className="tooltip-text">{t("dataDisplay.tooltipPrice", { coin })}</span>
          </div>
          <div className="card-value">${displayPrice?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || t("common.na")}</div>
          <div className={`status-badge ${indicators.price.className}`}>
            {indicators.price.label}
          </div>
        </div>

        <div className={cardClass("liquidationAbove")} onAnimationEnd={() => clearCardFlash("liquidationAbove")}>
          <div className="card-label tooltip">
            {t("dataDisplay.liquidationAbove")}
            <span className="tooltip-text">{t("dataDisplay.tooltipLiqAbove")}</span>
          </div>
          <div className="card-value liquidation-above">
            ${data.liquidationAbove?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || t("common.na")}
          </div>
          <div className={`status-badge ${indicators.liquidationAbove.className}`}>
            {indicators.liquidationAbove.label}
          </div>
        </div>

        <div className={cardClass("liquidationBelow")} onAnimationEnd={() => clearCardFlash("liquidationBelow")}>
          <div className="card-label tooltip">
            {t("dataDisplay.liquidationBelow")}
            <span className="tooltip-text">{t("dataDisplay.tooltipLiqBelow")}</span>
          </div>
          <div className="card-value liquidation-below">
            ${data.liquidationBelow?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || t("common.na")}
          </div>
          <div className={`status-badge ${indicators.liquidationBelow.className}`}>
            {indicators.liquidationBelow.label}
          </div>
        </div>

        <div className={cardClass("openInterest")} onAnimationEnd={() => clearCardFlash("openInterest")}>
          <div className="card-label tooltip">
            {t("dataDisplay.openInterest")}
            <span className="tooltip-text">{t("dataDisplay.tooltipOI")}</span>
          </div>
          <div className="card-value">${data.openInterest ? (data.openInterest / 1000).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : t("common.na")}</div>
          <div className={`status-badge ${indicators.openInterest.className}`}>
            {indicators.openInterest.label}
          </div>
        </div>

        <div className={cardClass("fundingRate")} onAnimationEnd={() => clearCardFlash("fundingRate")}>
          <div className="card-label tooltip">
            {t("dataDisplay.fundingRate")}
            <span className="tooltip-text">{t("dataDisplay.tooltipFunding")}</span>
          </div>
          <div className="card-value">
            {data.fundingRate?.toFixed(4) || t("common.na")}%
          </div>
          <div className={`status-badge ${indicators.fundingRate.className}`}>
            {indicators.fundingRate.label}
          </div>
        </div>

        <div className={cardClass("rsi")} onAnimationEnd={() => clearCardFlash("rsi")}>
          <div className="card-label tooltip">
            {t("dataDisplay.rsi")}
            <span className="tooltip-text">{t("dataDisplay.tooltipRSI")}</span>
          </div>
          <div className="card-value">{data.rsi?.toFixed(1) || t("common.na")}</div>
          <div className={`status-badge ${indicators.rsi.className}`}>
            {indicators.rsi.label}
          </div>
        </div>

        <div className={cardClass("macd")} onAnimationEnd={() => clearCardFlash("macd")}>
          <div className="card-label tooltip">
            {t("dataDisplay.macd")}
            <span className="tooltip-text">{t("dataDisplay.tooltipMACD")}</span>
          </div>
          <div className="card-value">{data.macd?.toFixed(2) || t("common.na")}</div>
          <div className={`status-badge ${indicators.macd.className}`}>
            {indicators.macd.label}
          </div>
        </div>

        <div className={cardClass("longShortRatio")} onAnimationEnd={() => clearCardFlash("longShortRatio")}>
          <div className="card-label tooltip">
            {t("dataDisplay.longShortRatio")}
            <span className="tooltip-text">{t("dataDisplay.tooltipLS")}</span>
          </div>
          <div className="card-value">
            {data.longShortRatio?.toFixed(2) || t("common.na")}
          </div>
          <div className={`status-badge ${indicators.longShortRatio.className}`}>
            {indicators.longShortRatio.label}
          </div>
        </div>
      </div>
    </div>
  );
};
