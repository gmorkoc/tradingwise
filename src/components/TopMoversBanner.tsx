import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "../styles/TopMoversBanner.css";
import { fetchTopMovers, TopMover } from "../services/binancePrices";

interface Props {
  onSelectCoin?: (symbol: string) => void;
}

// Static pill row of today's top-gaining coins (by 24h %), ranked from the
// same Binance ticker data Watchlist and PriceChart already use — sits
// directly above the price chart so a bullish standout is one tap away
// from actually being charted.
export function TopMoversBanner({ onSelectCoin }: Props) {
  const { t } = useTranslation();
  const [movers, setMovers] = useState<TopMover[]>([]);
  const [loading, setLoading] = useState(true);
  const [imgErrors, setImgErrors] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const data = await fetchTopMovers(20);
      if (!cancelled) { setMovers(data); setLoading(false); }
    }
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!loading && movers.length === 0) return null;

  return (
    <div className="tmb-strip">
      <div className="tmb-head">
        <span className="tmb-head-left">
          <span className="tmb-title"><span className="tmb-dot" />{t("topMovers.title")}</span>
          <span className="aiqw-live-badge"><span className="aiqw-live-dot" />LIVE</span>
        </span>
        <span className="tmb-subtitle">{t("topMovers.subtitle")}</span>
      </div>
      <div className="tmb-scroll">
        {loading ? (
          <div className="tmb-loading">{t("topMovers.loading")}</div>
        ) : movers.map(m => {
          const up = m.pct >= 0;
          return (
            <button
              key={m.symbol}
              type="button"
              className={`tmb-pill${up ? " up" : " down"}`}
              onClick={() => onSelectCoin?.(m.symbol)}
              title={m.name}
            >
              {!imgErrors.has(m.symbol) ? (
                <img
                  className="tmb-pill-icon"
                  src={`https://assets.coincap.io/assets/icons/${m.symbol.toLowerCase()}@2x.png`}
                  alt=""
                  loading="lazy"
                  onError={() => setImgErrors(prev => new Set([...prev, m.symbol]))}
                />
              ) : (
                <span className="tmb-pill-icon tmb-pill-icon--fallback">{m.symbol[0]}</span>
              )}
              <span className="tmb-pill-sym">{m.symbol}</span>
              <span className="tmb-pill-pct">{up ? "+" : ""}{m.pct.toFixed(2)}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
