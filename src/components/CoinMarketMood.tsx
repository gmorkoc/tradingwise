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

interface Cell {
  key: string;
  icon: string;
  label: string;
  value: string;
  cls: "" | " up" | " down";
}

// Real, already-fetched market data — price, funding rate, long/short
// ratio, RSI, MACD trend, open interest and liquidation zones from
// CoinGlass/exchange APIs, Fear & Greed from alternative.me — never
// fabricated commentary. Clearly labeled as data, not chat. A compact
// grid rather than a wrapping/scrolling row — every value stays aligned
// regardless of how many of these happen to have data.
export function CoinMarketMood({ coin }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<MoodData>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    setData(EMPTY);

    // Same 30s cadence App.tsx already polls getAllBTCData at for the main
    // chart/header — this just rides the same real-time refresh, not a
    // separate slower one.
    const refresh = () => {
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
    };

    refresh();
    const id = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [coin]);

  const hasAny = Object.values(data).some((v) => v !== null);
  if (!hasAny) return null;

  const fundingUp = (data.fundingRate ?? 0) >= 0;
  const lsUp = (data.longShortRatio ?? 1) >= 1;
  // Standard 70/30 overbought/oversold thresholds — same convention used
  // in the tutorial and Alt Analysis' indicator glossary.
  const rsiCls: Cell["cls"] = data.rsi === null ? "" : data.rsi >= 70 ? " down" : data.rsi <= 30 ? " up" : "";
  const macdUp = data.macd !== null && data.macdSignal !== null ? data.macd >= data.macdSignal : null;

  const cells: Cell[] = [];
  if (data.price !== null) {
    cells.push({ key: "price", icon: "$", label: t("coinChat.price", "Price"), value: fmtPrice(data.price), cls: "" });
  }
  if (data.fundingRate !== null) {
    cells.push({
      key: "funding", icon: "⚡", label: t("coinChat.funding", "Funding"),
      value: `${fundingUp ? "+" : ""}${(data.fundingRate * 100).toFixed(3)}%`, cls: fundingUp ? " up" : " down",
    });
  }
  if (data.longShortRatio !== null) {
    cells.push({
      key: "ls", icon: "⇄", label: t("coinChat.longShort", "L/S"),
      value: data.longShortRatio.toFixed(2), cls: lsUp ? " up" : " down",
    });
  }
  if (data.rsi !== null) {
    cells.push({ key: "rsi", icon: "〰", label: t("coinChat.rsi", "RSI"), value: data.rsi.toFixed(0), cls: rsiCls });
  }
  if (macdUp !== null) {
    cells.push({
      key: "macd", icon: "≈", label: t("coinChat.macd", "MACD"),
      value: macdUp ? t("coinChat.bullish", "Bullish") : t("coinChat.bearish", "Bearish"), cls: macdUp ? " up" : " down",
    });
  }
  if (data.openInterest !== null) {
    cells.push({ key: "oi", icon: "Σ", label: t("coinChat.openInterest", "OI"), value: fmtCompactUsd(data.openInterest), cls: "" });
  }
  if (data.liquidationAbove !== null) {
    cells.push({ key: "liqAbove", icon: "↑", label: t("coinChat.liqAbove", "Liq Above"), value: fmtPrice(data.liquidationAbove), cls: " down" });
  }
  if (data.liquidationBelow !== null) {
    cells.push({ key: "liqBelow", icon: "↓", label: t("coinChat.liqBelow", "Liq Below"), value: fmtPrice(data.liquidationBelow), cls: " up" });
  }
  if (data.fearGreedValue !== null) {
    cells.push({
      key: "fg", icon: "◐", label: t("coinChat.fearGreed", "Fear & Greed"),
      value: `${data.fearGreedValue} · ${data.fearGreedLabel}`, cls: "",
    });
  }

  return (
    <div className="coin-mood">
      <span className="coin-mood-label">{t("coinChat.marketData", "Market data")}</span>
      <div className="coin-mood-grid">
        {cells.map((c) => (
          <div className="coin-mood-cell" key={c.key}>
            <div className="coin-mood-cell-icon">{c.icon}</div>
            <div className="coin-mood-cell-label">{c.label}</div>
            <div className={`coin-mood-cell-value${c.cls}`}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
