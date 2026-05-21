import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ZoneResult } from "./PriceChart.types";
import "../styles/LeveragePanel.css";

interface LeveragePanelProps {
  currentPrice: number;
  zone: ZoneResult | null;
  coin: string;
  hideHeader?: boolean;
}

type Direction = "long" | "short";

const LEVERAGE_PRESETS = [2, 5, 10, 25, 50, 100];

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(a: number, b: number) {
  return (((a - b) / b) * 100).toFixed(2);
}

function calcEntries(
  currentPrice: number,
  zone: ZoneResult,
  direction: Direction,
  leverage: number,
) {
  const { buyZone, sellZone, signal } = zone;

  let entry: number;
  let stopLoss: number;
  let tp1: number;
  let tp2: number;

  if (direction === "long") {
    entry = (signal === "sell" || signal === "strong-sell")
      ? buyZone.upper
      : currentPrice;
    stopLoss = buyZone.lower * 0.997;
    tp1 = (sellZone.lower + sellZone.upper) / 2;
    tp2 = sellZone.upper * 1.005;
  } else {
    entry = (signal === "buy" || signal === "strong-buy")
      ? sellZone.lower
      : currentPrice;
    stopLoss = sellZone.upper * 1.003;
    tp1 = (buyZone.lower + buyZone.upper) / 2;
    tp2 = buyZone.lower * 0.995;
  }

  const liquidation = direction === "long"
    ? entry * (1 - 1 / leverage)
    : entry * (1 + 1 / leverage);

  const riskPerUnit   = Math.abs(entry - stopLoss);
  const rewardPerUnit = Math.abs(tp1 - entry);
  const rr = rewardPerUnit / riskPerUnit;

  const isWaiting = (direction === "long" && entry < currentPrice) ||
                    (direction === "short" && entry > currentPrice);

  return { entry, stopLoss, tp1, tp2, liquidation, rr, isWaiting };
}

export const LeveragePanel: React.FC<LeveragePanelProps> = ({ currentPrice, zone, coin, hideHeader = false }) => {
  const { t } = useTranslation();
  const [direction, setDirection] = useState<Direction>("long");
  const [leverage, setLeverage]   = useState(10);
  const [customLev, setCustomLev] = useState("");

  const result = useMemo(() => {
    if (!zone || !currentPrice) return null;
    return calcEntries(currentPrice, zone, direction, leverage);
  }, [currentPrice, zone, direction, leverage]);

  const isHigh     = leverage >= 20;
  const isVeryHigh = leverage >= 50;

  return (
    <div className="leverage-panel">
      {!hideHeader && (
        <div className="leverage-panel-header">
          <span className="leverage-panel-title">{t("leverage.title")}</span>
          <span className="leverage-disclaimer">{t("leverage.disclaimer")}</span>
        </div>
      )}

      {/* Direction toggle */}
      <div className="leverage-direction-toggle">
        <button
          className={`dir-btn dir-btn--long ${direction === "long" ? "active" : ""}`}
          onClick={() => setDirection("long")}
        >
          {t("leverage.long")}
        </button>
        <button
          className={`dir-btn dir-btn--short ${direction === "short" ? "active" : ""}`}
          onClick={() => setDirection("short")}
        >
          {t("leverage.short")}
        </button>
      </div>

      {/* Leverage selector */}
      <div className="leverage-row">
        <span className="leverage-label">{t("leverage.leverage")}</span>
        <div className="leverage-presets">
          {LEVERAGE_PRESETS.map((lev) => (
            <button
              key={lev}
              className={`lev-preset ${leverage === lev && !customLev ? "active" : ""}`}
              onClick={() => { setLeverage(lev); setCustomLev(""); }}
            >
              {lev}x
            </button>
          ))}
          <input
            className="lev-custom"
            type="number"
            min={1}
            max={125}
            placeholder={t("leverage.custom")}
            value={customLev}
            onChange={(e) => {
              const v = Number(e.target.value);
              setCustomLev(e.target.value);
              if (v >= 1 && v <= 125) setLeverage(v);
            }}
          />
        </div>
      </div>

      {!zone && (
        <div className="leverage-no-data">{t("leverage.waitingZone")}</div>
      )}

      {result && (
        <>
          {result.isWaiting && (
            <div className="leverage-wait-notice">
              {t("leverage.waitNotice", { coin, dir: direction === "long" ? t("leverage.buy") : t("leverage.sell") })}
            </div>
          )}

          <div className="leverage-entries">
            <div className="entry-row entry-row--entry">
              <span>{t("leverage.entry")}</span>
              <span>${fmt(result.entry)}</span>
              <span className="entry-badge">
                {result.isWaiting ? (direction === "long" ? t("leverage.waitDown") : t("leverage.waitUp")) : t("leverage.now")}
              </span>
            </div>
            <div className="entry-row entry-row--sl">
              <span>{t("leverage.stopLoss")}</span>
              <span>${fmt(result.stopLoss)}</span>
              <span className="entry-pct entry-pct--neg">
                {direction === "long"
                  ? pct(result.stopLoss, result.entry)
                  : "+" + Math.abs(parseFloat(pct(result.stopLoss, result.entry))).toFixed(2)}%
              </span>
            </div>
            <div className="entry-row entry-row--tp1">
              <span>{t("leverage.takeProfit1")}</span>
              <span>${fmt(result.tp1)}</span>
              <span className="entry-pct entry-pct--pos">
                {direction === "long"
                  ? "+" + pct(result.tp1, result.entry)
                  : pct(result.tp1, result.entry)}%
              </span>
            </div>
            <div className="entry-row entry-row--tp2">
              <span>{t("leverage.takeProfit2")}</span>
              <span>${fmt(result.tp2)}</span>
              <span className="entry-pct entry-pct--pos">
                {direction === "long"
                  ? "+" + pct(result.tp2, result.entry)
                  : pct(result.tp2, result.entry)}%
              </span>
            </div>
            <div className={`entry-row entry-row--liq ${isVeryHigh ? "very-high" : isHigh ? "high" : ""}`}>
              <span>{t("leverage.liquidation")}</span>
              <span>${fmt(result.liquidation)}</span>
              <span className="entry-pct entry-pct--liq">
                {direction === "long"
                  ? pct(result.liquidation, result.entry)
                  : "+" + Math.abs(parseFloat(pct(result.liquidation, result.entry))).toFixed(2)}%
              </span>
            </div>
          </div>

          <div className="leverage-rr">
            <span>{t("leverage.riskReward")}</span>
            <span className={`rr-value ${result.rr >= 2 ? "good" : result.rr >= 1 ? "ok" : "bad"}`}>
              1 : {result.rr.toFixed(2)}
              {result.rr >= 2 && " ✓"}
              {result.rr < 1 && " ✗"}
            </span>
          </div>

          {isHigh && (
            <div className={`leverage-warning ${isVeryHigh ? "leverage-warning--critical" : ""}`}>
              {isVeryHigh
                ? t("leverage.warningCritical", { lev: leverage, pct: (100 / leverage).toFixed(1) })
                : t("leverage.warningHigh", { lev: leverage })}
            </div>
          )}
        </>
      )}
    </div>
  );
};
