import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "../styles/TopMoversCarousel.css";
import { fetchTopMovers, fetchSparklines, TopMover } from "../services/binancePrices";
import { Sparkline } from "./Watchlist";

interface Props {
  onSelectCoin?: (symbol: string) => void;
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}

const LIST_COLLAPSED_COUNT = 5;

// Same vertical icon/name/sparkline/price/% row list on every width now —
// used to be a separate card-carousel strip on desktop, dropped in favor
// of reusing this one everywhere (see Watchlist.tsx's own identical
// change — desktop was asked to just match what mobile already does).
export function TopMoversCarousel({ onSelectCoin }: Props) {
  const { t } = useTranslation();
  const [movers, setMovers] = useState<TopMover[]>([]);
  const [loading, setLoading] = useState(true);
  const [imgErrors, setImgErrors] = useState<Set<string>>(new Set());
  const [sparklines, setSparklines] = useState<Map<string, number[]>>(new Map());
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const data = await fetchTopMovers(20);
      if (cancelled) return;
      setMovers(data);
      setLoading(false);
    }
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (movers.length === 0) return;
    const symbols = movers.map(m => m.symbol);
    fetchSparklines(symbols).then(setSparklines);
  }, [movers]);

  if (!loading && movers.length === 0) return null;

  const shown = showAll ? movers : movers.slice(0, LIST_COLLAPSED_COUNT);
  return (
    <div className="tmc-list">
      <div className="tmc-list-head">
        <span className="tmc-list-title">{t("topMovers.title")}</span>
        <span className="aiqw-live-badge"><span className="aiqw-live-dot" />LIVE</span>
      </div>
      {loading ? (
        <div className="tmc-loading">{t("topMovers.loading")}</div>
      ) : (
        <div className="tmc-list-rows">
          {shown.map(m => {
            const up = m.pct >= 0;
            const spark = sparklines.get(m.symbol) ?? [];
            return (
              <div key={m.symbol} className="tmc-list-row">
                {/* Same 6-column grid as Watchlist's own row
                    (.wl-list-row) — name/price/sparkline/% here via
                    display:contents, then a blank 5th column (no
                    favorite concept for a ranked market list like this
                    one) and an explicit "view in chart" icon as the 6th,
                    matching Watchlist's column count exactly. */}
                <button
                  type="button"
                  className="tmc-list-row-main"
                  onClick={() => onSelectCoin?.(m.symbol)}
                >
                  <span className="tmc-list-identity">
                    <span className="tmc-list-icon">
                      {!imgErrors.has(m.symbol) ? (
                        <img
                          className="tmc-list-icon-img"
                          src={`https://assets.coincap.io/assets/icons/${m.symbol.toLowerCase()}@2x.png`}
                          alt=""
                          loading="lazy"
                          onError={() => setImgErrors(prev => new Set([...prev, m.symbol]))}
                        />
                      ) : (
                        <span className="tmc-card-icon--fallback tmc-list-icon-img">{m.symbol[0]}</span>
                      )}
                    </span>
                    <span className="tmc-list-names">
                      <span className="tmc-list-name">{m.name}</span>
                      <span className="tmc-list-sym">{m.symbol}</span>
                    </span>
                  </span>
                  <span className="tmc-list-col-price">${fmtPrice(m.price)}</span>
                  {spark.length > 1 ? (
                    <Sparkline prices={spark} positive={up} width={64} height={28} className="tmc-list-spark" />
                  ) : (
                    <span className="tmc-list-spark" />
                  )}
                  <span className={`tmc-list-col-pct${up ? " up" : " down"}`}>
                    {up ? "↗" : "↘"} {Math.abs(m.pct).toFixed(2)}%
                  </span>
                </button>
                <span className="tmc-list-star" aria-hidden="true" />
                <button
                  type="button"
                  className="tmc-list-view"
                  onClick={() => onSelectCoin?.(m.symbol)}
                  aria-label={t("topMovers.viewChart", "View chart")}
                  title={t("topMovers.viewChart", "View chart")}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
      {!loading && movers.length > LIST_COLLAPSED_COUNT && (
        <button type="button" className="tmc-list-showmore" onClick={() => setShowAll(v => !v)}>
          {showAll ? t("topMovers.showLess", "Show less") : t("topMovers.showMore", "Show more")}
        </button>
      )}
    </div>
  );
}
