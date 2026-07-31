import { useTranslation } from "react-i18next";
import { PTickerBgChart } from "./PTickerBgChart";
import type { CoinSymbol } from "../services/coinglass";

const COIN_ICONS: Record<string, string> = {
  BTC: "₿",
  ETH: "Ξ",
  XRP: "◈",
  SOL: "◎",
  BNB: "⬡",
  SUI: "⬟",
  DOGE: "Ð",
  ADA: "₳",
  NEAR: "Ⓝ",
  RENDER: "⬡",
  ZEC: "ⓩ",
};
const COIN_COLORS: Record<string, string> = {
  BTC: "#f7931a",
  ETH: "#627eea",
  XRP: "#346aa9",
  SOL: "#9945ff",
  BNB: "#f3ba2f",
  SUI: "#4da2ff",
  DOGE: "#c2a633",
  ADA: "#0033ad",
  NEAR: "#00c08b",
  RENDER: "#ff3c6e",
  ZEC: "#f4b728",
};

interface Props {
  coin: CoinSymbol;
  theme: "dark" | "light";
  livePrice: number | null;
  btcPrice: number | undefined;
  openPrice: number | null;
  tickerFlash: "up" | "down" | null;
  tickerMuted: boolean;
  onToggleMute: () => void;
  rockets: { id: number; dir: "up" | "down"; x: number }[];
  onExit: () => void;
  isPopped?: boolean;
  onPopOut?: () => void;
}

export function PriceTickerFullscreen({
  coin,
  theme,
  livePrice,
  btcPrice,
  openPrice,
  tickerFlash,
  tickerMuted,
  onToggleMute,
  rockets,
  onExit,
  isPopped,
  onPopOut,
}: Props) {
  const { t } = useTranslation();

  const coinColor = COIN_COLORS[coin] ?? "#38bdf8";
  const price = livePrice ?? btcPrice ?? 0;
  const openP = openPrice ?? price;
  const delta = openP > 0 ? ((price - openP) / openP) * 100 : 0;
  const deltaAbs = Math.abs(delta);
  const up = delta >= 0;

  const insight =
    delta === 0
      ? t("priceTicker.insightSteady", { coin })
      : up
        ? t("priceTicker.insightUp", { coin, pct: deltaAbs.toFixed(3) })
        : t("priceTicker.insightDown", { coin, pct: deltaAbs.toFixed(3) });

  return (
    <div
      className="pticker-overlay"
      style={{ "--pticker-color": coinColor } as React.CSSProperties}
      onKeyDown={(e) => e.key === "Escape" && onExit()}
      tabIndex={-1}
    >
      <div className="pticker-bg-symbol">{COIN_ICONS[coin] ?? coin[0]}</div>
      <PTickerBgChart coin={coin} isDark={theme === "dark"} />
      {rockets.map((r) => (
        <span
          key={r.id}
          className={`pticker-rocket pticker-rocket--${r.dir}`}
          style={{ left: `${r.x}%` }}
        >
          🚀
        </span>
      ))}
      <div className="pticker-top-actions">
        {!isPopped && onPopOut && (
          <button
            className="pticker-sound-btn"
            onClick={onPopOut}
            aria-label="Pop out"
            title={t("priceTicker.popOut", "Float in a separate window")}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
              <path d="M15 3h6v6" />
              <path d="M10 14L21 3" />
            </svg>
            <span className="pticker-close-label">
              {t("priceTicker.popOut", "Float")}
            </span>
          </button>
        )}
        <button
          className={`pticker-sound-btn${tickerMuted ? "" : " pticker-sound-btn--on"}`}
          onClick={onToggleMute}
          aria-label="Toggle sound"
        >
          {tickerMuted ? (
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </svg>
          ) : (
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" />
            </svg>
          )}
          <span className="pticker-close-label">
            {tickerMuted ? t("priceTicker.muted") : t("priceTicker.sound")}
          </span>
        </button>
        <button className="pticker-close" onClick={onExit} aria-label="Exit">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3" />
          </svg>
          <span className="pticker-close-label">{t("priceTicker.exit")}</span>
        </button>
      </div>
      <div className="pticker-inner">
        <span className="pticker-price-source">via Binance</span>
        <div className="pticker-coin-name">
          <span className="pticker-coin-sym">{COIN_ICONS[coin] ?? coin[0]}</span>
          {coin}
          <span className="pticker-coin-quote">/USD</span>
        </div>
        <div
          className={`pticker-price${tickerFlash === "up" ? " pticker-flash-up" : tickerFlash === "down" ? " pticker-flash-down" : ""}`}
        >
          $
          {price.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </div>
        {openP > 0 && (
          <div
            className={`pticker-delta ${up ? "pticker-delta--up" : "pticker-delta--down"}`}
          >
            {up ? "▲" : "▼"} {deltaAbs.toFixed(3)}
            {t("priceTicker.sinceOpen")}
          </div>
        )}
        <div className="pticker-live-dot">
          <span />
          <span className="pticker-live-label">{t("nav.live")}</span>
        </div>

        <div
          className={`pticker-insight-wrap ${delta === 0 ? "pticker-insight-wrap--neutral" : up ? "pticker-insight-wrap--up" : "pticker-insight-wrap--down"}`}
        >
          <div className="pticker-insight-icon">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {delta === 0 ? (
                <path d="M5 12h14" />
              ) : up ? (
                <>
                  <path d="M12 19V5" />
                  <path d="M5 12l7-7 7 7" />
                </>
              ) : (
                <>
                  <path d="M12 5v14" />
                  <path d="M19 12l-7 7-7-7" />
                </>
              )}
            </svg>
          </div>
          <div className="pticker-insight-body">
            <span className="pticker-insight-label">
              {delta === 0
                ? t("priceTicker.neutral")
                : up
                  ? t("priceTicker.bullishSignal")
                  : t("priceTicker.bearishSignal")}
            </span>
            <div className="pticker-insight pticker-insight--visible">
              {insight}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
