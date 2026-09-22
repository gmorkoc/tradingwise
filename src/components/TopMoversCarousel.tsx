import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../styles/TopMoversCarousel.css";
import { fetchTopMovers, TopMover } from "../services/binancePrices";

interface Props {
  onSelectCoin?: (symbol: string) => void;
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}

// Card-carousel take on the same top-movers banner (see TopMoversBanner.tsx
// for the static-pill-row version) — same fetchTopMovers ranking, just
// more visual weight per coin: price, % change, a scrollable card row
// instead of compact chips. No sparkline — didn't read well squeezed into
// a 140px-wide card.
export function TopMoversCarousel({ onSelectCoin }: Props) {
  const { t } = useTranslation();
  const [movers, setMovers] = useState<TopMover[]>([]);
  const [loading, setLoading] = useState(true);
  const [imgErrors, setImgErrors] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

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

  if (!loading && movers.length === 0) return null;

  const scrollBy = (dir: 1 | -1) => scrollRef.current?.scrollBy({ left: dir * 300, behavior: "smooth" });

  return (
    <div className="tmc-strip">
      <div className="tmc-head">
        <span className="tmc-head-left">
          <span className="tmc-title">{t("topMovers.title")}</span>
          <span className="aiqw-live-badge"><span className="aiqw-live-dot" />LIVE</span>
        </span>
        <div className="tmc-nav">
          <button type="button" className="tmc-nav-btn" onClick={() => scrollBy(-1)} aria-label="Scroll left">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <button type="button" className="tmc-nav-btn" onClick={() => scrollBy(1)} aria-label="Scroll right">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </button>
        </div>
      </div>
      <div className="tmc-scroll" ref={scrollRef}>
        {loading ? (
          <div className="tmc-loading">{t("topMovers.loading")}</div>
        ) : movers.map(m => {
          const up = m.pct >= 0;
          return (
            <button
              key={m.symbol}
              type="button"
              className="tmc-card"
              onClick={() => onSelectCoin?.(m.symbol)}
              title={m.name}
            >
              <div className="tmc-card-top">
                {!imgErrors.has(m.symbol) ? (
                  <img
                    className="tmc-card-icon"
                    src={`https://assets.coincap.io/assets/icons/${m.symbol.toLowerCase()}@2x.png`}
                    alt=""
                    loading="lazy"
                    onError={() => setImgErrors(prev => new Set([...prev, m.symbol]))}
                  />
                ) : (
                  <span className="tmc-card-icon tmc-card-icon--fallback">{m.symbol[0]}</span>
                )}
                <span className="tmc-card-sym">{m.symbol}</span>
                <span className={`tmc-card-pct${up ? " up" : " down"}`}>{up ? "+" : ""}{m.pct.toFixed(2)}%</span>
              </div>
              <span className="tmc-card-price">${fmtPrice(m.price)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
