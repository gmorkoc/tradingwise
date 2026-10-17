import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { PriceChart, formatLivePrice, formatCompactVolume, formatCompactNumber, COIN_FULL_NAME, COIN_GLYPHS, COIN_COLORS, INTERVALS, INTERVAL_SHORT, TimeInterval, CHART_STYLE_ICONS, ChartStyle } from "./PriceChart";
import { ZoneResult, ZoneSignal } from "./PriceChart.types";
import { CoinSymbol, Ticker24h } from "../services/coinglass";
import { fetchCoinMeta, fetchOpenInterestCoins, CoinMeta } from "../services/coinMeta";
import { fetchBrief, timeAgo, BriefItem } from "./DailyBrief";

interface Props {
  coin: CoinSymbol;
  theme?: "dark" | "light";
  quoteVolume24h?: number;
  // Reference-match header (coin icon/name, big price, today's change) —
  // the embedded compact <PriceChart> has no equivalent prominent header
  // on mobile (that's desktop-only there), so this sheet builds its own
  // from the same live ticker App.tsx already keeps for every coin,
  // rather than threading a new callback through PriceChart.tsx for it.
  ticker?: Ticker24h;
  onOpenAuth?: () => void;
  onOpenUpgrade?: (plan?: "pro" | "elite") => void;
  onOpenCoinPicker?: (anchor: HTMLElement) => void;
  onClose: () => void;
  // "Full Chart" button — the real #advance-chart page (<PriceChart
  // pageMode>, same one desktop's own Full Screen button opens), not the
  // browser Fullscreen API on this sheet's own DOM.
  onOpenFullChart: () => void;
}

// Same real zone.signal → 5-point gauge mapping PriceChart.tsx's own
// Technicals category uses — kept in sync by hand since this sheet is a
// separate mount (see MobileSymbolSheet usage in App.tsx) rather than
// something PriceChart.tsx itself renders.
const GAUGE_PCT: Record<ZoneSignal, number> = {
  "strong-sell": 5, "sell": 25, "overbought": 25,
  "neutral": 50,
  "oversold": 75, "buy": 75, "strong-buy": 95,
};

type Tab = "overview" | "news" | "minds" | "ideas";

// Reference-match (TradingView mobile "symbol info" page, merged from the
// user's 3 screenshots into one continuous scroll) — mobile only. Opened
// from App.tsx in place of a hard navigation to #advance-chart. Reuses the
// EXISTING compact (non-pageMode, non-fullscreen) <PriceChart> for the
// chart itself — that mode already renders at a fixed 400px height/100%
// width and is already non-interactive (no pan/zoom), which is exactly
// the "frozen" chart the reference shows sitting in normal scroll flow
// above the stats, not a new chart implementation.
export function MobileSymbolSheet({ coin, theme, quoteVolume24h, ticker, onOpenAuth, onOpenUpgrade, onOpenCoinPicker, onClose, onOpenFullChart }: Props) {
  const { t } = useTranslation();
  const [zone, setZone] = useState<ZoneResult | null>(null);
  const [coinMeta, setCoinMeta] = useState<CoinMeta | null>(null);
  const [oiCoins, setOiCoins] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [requestedInterval, setRequestedInterval] = useState<TimeInterval>("1day");
  const [activeInterval, setActiveInterval] = useState<TimeInterval>("1day");
  // Candle-style cycle button — the ONLY chart-style control exposed to
  // this sheet. Deliberately no indicators/grid control is threaded
  // through at all (unlike PriceChart.tsx's own indicatorsList/
  // gridStyleControls), so neither can ever show up here.
  const STYLE_CYCLE: ChartStyle[] = ["candle", "hollow", "line", "heikinAshi"];
  const [requestedStyle, setRequestedStyle] = useState<ChartStyle>("candle");
  const [activeStyle, setActiveStyle] = useState<ChartStyle>("candle");

  useEffect(() => {
    let cancelled = false;
    setCoinMeta(null);
    setOiCoins(null);
    fetchCoinMeta(coin).then((m) => { if (!cancelled) setCoinMeta(m); });
    fetchOpenInterestCoins(coin).then((v) => { if (!cancelled) setOiCoins(v); });
    return () => { cancelled = true; };
  }, [coin]);

  // News tab — reuses DailyBrief's own fetchBrief() (CoinTelegraph/
  // CoinDesk/Decrypt + relevance-filtered markets/geopolitics feeds),
  // the same crypto news this app already has, rather than a new source.
  // Coin-specific headlines first (title mentions this coin's name or
  // symbol); when none match, falls back to the plain top crypto feed —
  // never an empty tab.
  const [allNews, setAllNews] = useState<BriefItem[]>([]);
  // Real devices on a slower connection can easily still be mid-fetch (7
  // RSS feeds, each through rss2json) by the time the user taps the News
  // tab — without this, that in-flight window rendered identically to a
  // genuine zero-results failure ("No news right now"), which is exactly
  // what got reported as a bug.
  const [newsLoading, setNewsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    fetchBrief().then((items) => {
      if (cancelled) return;
      setAllNews(items);
      setNewsLoading(false);
    });
    return () => { cancelled = true; };
  }, []);
  const coinNews = allNews.filter((item) => {
    const title = item.title.toLowerCase();
    return title.includes(coin.toLowerCase()) || title.includes((COIN_FULL_NAME[coin] ?? "").toLowerCase());
  });
  const newsToShow = coinNews.length > 0 ? coinNews : allNews;

  // Header price only attaches once the big price block below has
  // scrolled out from under the sticky header — not shown while that
  // block is still on screen (would just duplicate it).
  const scrollRef = useRef<HTMLDivElement>(null);
  const priceBlockRef = useRef<HTMLDivElement>(null);
  const [showHeaderPrice, setShowHeaderPrice] = useState(false);
  useEffect(() => {
    const root = scrollRef.current;
    const target = priceBlockRef.current;
    if (!root || !target) return;
    const observer = new IntersectionObserver(
      ([entry]) => setShowHeaderPrice(!entry.isIntersecting && entry.boundingClientRect.top < 0),
      { root, threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [ticker]);

  const [livePrice, setLivePrice] = useState(0);
  const oiUSD = oiCoins != null && livePrice > 0 ? oiCoins * livePrice : null;
  const gaugePct = zone ? GAUGE_PCT[zone.signal] : 50;
  const gaugeLabel: Record<ZoneSignal, string> = {
    "strong-sell": t("chart.strongSell"), "sell": t("chart.sell"), "overbought": t("chart.sell"),
    "neutral": t("chart.neutralZone"),
    "oversold": t("chart.buy"), "buy": t("chart.buy"), "strong-buy": t("chart.strongBuy"),
  };
  const theta = (180 - gaugePct * 1.8) * (Math.PI / 180);
  const needleX = 80 + 52 * Math.cos(theta);
  const needleY = 86 - 52 * Math.sin(theta);

  // Portaled to document.body — same established fix this codebase
  // already uses for every other floating sheet (fs-dock, TradingAgent
  // panel, interval sheet): a plain in-tree fixed-position element here
  // got trapped inside an ancestor's stacking context and rendered BELOW
  // the bottom nav bar despite a much higher z-index.
  return ReactDOM.createPortal(
    <div className="mss-backdrop" onClick={onClose}>
      <div className="mss-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="mss-scroll" ref={scrollRef}>
          <div className="mss-header">
            {/* Lives inside the sticky header itself (not a separate
                static element above it) — a handle pinned by .mss-sheet's
                own static layout and a header pinned by position:sticky
                inside the scrolling container are computed independently,
                and could show a sliver of chart content between them
                during a fast scroll/the sticky catching up a frame late.
                One shared sticky box makes that gap impossible. */}
            <span className="mss-handle" aria-hidden="true" />
            <div className="mss-header-row">
              <span
                className="mss-coin-icon"
                style={{ background: COIN_COLORS[coin] ?? "#6b7280" }}
              >
                {COIN_GLYPHS[coin] ?? coin[0]}
              </span>
              {/* Reference-match: once the big price block below scrolls
                  out from under the sticky header, the price takes the
                  coin name's place there instead of sitting alongside it
                  — the coin icon stays either way. */}
              {ticker && showHeaderPrice ? (
                <span className="mss-header-price">
                  <span className="mss-header-price-value">{formatLivePrice(ticker.price)}</span>
                  <span className={`mss-header-price-change${ticker.change >= 0 ? " mss-price-change--up" : " mss-price-change--down"}`}>
                    {ticker.change >= 0 ? "+" : ""}{ticker.change.toFixed(2)}%
                  </span>
                </span>
              ) : (
                <div className="mss-header-text">
                  <span className="mss-coin-name">{COIN_FULL_NAME[coin] ?? coin} / U.S. dollar</span>
                  <span className="mss-coin-sub">
                    {coin}USDT • BINANCE <span className="mss-live-dot" aria-hidden="true" />
                  </span>
                </div>
              )}
              <button type="button" className="mss-close" onClick={onClose} aria-label={t("chart.close", "Close")}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
          {ticker && (() => {
            // Real, derived from the same live price/%-change already
            // shown elsewhere in this app — not a separate fetch.
            const absToday = ticker.price - ticker.price / (1 + ticker.change / 100);
            const week = coinMeta?.weekChangePercent;
            const absWeek = week != null ? ticker.price - ticker.price / (1 + week / 100) : null;
            return (
              <div className="mss-price-block" ref={priceBlockRef}>
                <span className="mss-price">
                  {ticker.price.toLocaleString("en-US", { maximumFractionDigits: ticker.price >= 1000 ? 0 : 4 })}
                  <span className="mss-price-unit">USD</span>
                </span>
                <div className={`mss-price-change-row${ticker.change >= 0 ? " mss-price-change--up" : " mss-price-change--down"}`}>
                  {ticker.change >= 0 ? "+" : ""}{Math.round(absToday).toLocaleString("en-US")}{" "}
                  {ticker.change >= 0 ? "+" : ""}{ticker.change.toFixed(2)}% <span className="mss-price-change-label">{t("chart.today", "today")}</span>
                </div>
                {week != null && absWeek != null && (
                  <div className={`mss-price-change-row${week >= 0 ? " mss-price-change--up" : " mss-price-change--down"}`}>
                    {week >= 0 ? "+" : ""}{Math.round(absWeek).toLocaleString("en-US")}{" "}
                    {week >= 0 ? "+" : ""}{week.toFixed(2)}% <span className="mss-price-change-label">{t("chart.pastWeek", "past week")}</span>
                  </div>
                )}
              </div>
            );
          })()}
          {/* Reference-match: small candle-style toggle above the chart.
              Cycles candle→hollow→line→heikinAshi on tap. The ONLY chart-
              style control in this sheet; no indicators/grid anywhere
              here (see the comment on requestedStyle above). The
              fullscreen action moved to the big button below (was its own
              small icon button here, now redundant). */}
          <div className="mss-chart-tools-row">
            <button
              type="button"
              className="mss-chart-tool-btn"
              onClick={() => setRequestedStyle(STYLE_CYCLE[(STYLE_CYCLE.indexOf(activeStyle) + 1) % STYLE_CYCLE.length])}
            >
              {CHART_STYLE_ICONS[activeStyle]}
              <span className="mss-chart-tool-label">{t("chart.style", "Candle")}</span>
            </button>
          </div>

          {/* Frozen — fixed height/width, non-interactive (compact mode
              already disables pan/zoom), scrolls away with the rest of
              the page instead of staying pinned, same as the reference. */}
          <div className="mss-chart-frozen">
            <PriceChart
              coin={coin}
              theme={theme}
              quoteVolume24h={quoteVolume24h}
              onZoneChange={(z, p) => { setZone(z); setLivePrice(p); }}
              onOpenAuth={onOpenAuth}
              onOpenUpgrade={onOpenUpgrade}
              onOpenCoinPicker={onOpenCoinPicker}
              requestInterval={requestedInterval}
              onIntervalChange={setActiveInterval}
              requestChartStyle={requestedStyle}
              onChartStyleChange={setActiveStyle}
              forceHideIndicators
            />
          </div>

          {/* Reference-match interval row — this app's own real supported
              intervals/labels (1m…1M/All), not TradingView's exact
              1D/1W/.../5Y window set, which this app has no equivalent
              data windows for. Drives the embedded chart above via
              requestInterval/onIntervalChange (PriceChart.tsx), not a
              decorative row. */}
          <div className="mss-interval-row">
            {INTERVALS.filter((i) => !["1sec", "1min", "5min", "15min"].includes(i)).map((i) => (
              <button
                type="button"
                key={i}
                className={`mss-interval-pill${activeInterval === i ? " mss-interval-pill--active" : ""}`}
                onClick={() => setRequestedInterval(i)}
              >
                {INTERVAL_SHORT[i]}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="mss-trade-btn"
            onClick={onOpenFullChart}
          >
            {t("chart.fullChart", "Full Chart")}
          </button>

          <div className="mss-tabs">
            {(["overview", "news", "minds", "ideas"] as Tab[]).map((key) => (
              <button
                type="button"
                key={key}
                className={`mss-tab${tab === key ? " mss-tab--active" : ""}`}
                onClick={() => setTab(key)}
              >
                {t(`chart.tab${key.charAt(0).toUpperCase()}${key.slice(1)}`, key.charAt(0).toUpperCase() + key.slice(1))}
              </button>
            ))}
          </div>

          {tab === "news" ? (
            newsLoading ? (
              <div className="mss-tab-empty">{t("chart.loadingNews", "Loading news…")}</div>
            ) : newsToShow.length > 0 ? (
              <div className="mss-news-list">
                {newsToShow.slice(0, 15).map((item) => (
                  <a
                    key={item.url}
                    className="mss-news-item"
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {item.thumbnail && <img className="mss-news-thumb" src={item.thumbnail} alt="" />}
                    <div className="mss-news-text">
                      <span className="mss-news-title">{item.title}</span>
                      <span className="mss-news-meta">{item.source} • {timeAgo(item.pubDate, t)}</span>
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <div className="mss-tab-empty">{t("chart.noNews", "No news right now")}</div>
            )
          ) : tab !== "overview" ? (
            <div className="mss-tab-empty">{t("chart.comingSoon", "Coming soon")}</div>
          ) : (
            <>
              <div className="mss-section-title">{t("chart.overview", "Overview")}</div>
              <div className="fs-info-list">
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.allTimeHigh", "All time high")}</span>
                  <span className="fs-info-value">{coinMeta?.athUSD != null ? formatLivePrice(coinMeta.athUSD) : "—"}</span>
                </div>
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.circulatingSupply", "Circulating supply")}</span>
                  <span className="fs-info-value">{coinMeta?.circulatingSupply != null ? `${formatCompactNumber(coinMeta.circulatingSupply)} ${coin}` : "—"}</span>
                </div>
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.totalSupply", "Total supply")}</span>
                  <span className="fs-info-value">{coinMeta?.totalSupply != null ? `${formatCompactNumber(coinMeta.totalSupply)} ${coin}` : "—"}</span>
                </div>
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.openInterest", "Open interest")}</span>
                  <span className="fs-info-value">{oiUSD != null ? formatCompactVolume(oiUSD) : "—"}</span>
                </div>
              </div>

              <div className="mss-section-title">{t("chart.technicals", "Technicals")}</div>
              <div className="fs-gauge">
                <svg width="160" height="92" viewBox="0 0 160 92">
                  <path d="M10,86 A70,70 0 0 1 23.4,44.8" fill="none" stroke="#ef4444" strokeWidth="14" strokeLinecap="round" />
                  <path d="M23.4,44.8 A70,70 0 0 1 58.4,19.4" fill="none" stroke="#f97316" strokeWidth="14" />
                  <path d="M58.4,19.4 A70,70 0 0 1 101.6,19.4" fill="none" stroke="#9ca3af" strokeWidth="14" />
                  <path d="M101.6,19.4 A70,70 0 0 1 136.6,44.8" fill="none" stroke="#4ade80" strokeWidth="14" />
                  <path d="M136.6,44.8 A70,70 0 0 1 150,86" fill="none" stroke="#16a34a" strokeWidth="14" strokeLinecap="round" />
                  <line x1="80" y1="86" x2={needleX} y2={needleY} stroke="var(--color-text)" strokeWidth="2.4" strokeLinecap="round" />
                  <circle cx="80" cy="86" r="4.5" fill="var(--color-text)" />
                </svg>
                <div className="fs-gauge-labels">
                  <span>{t("chart.strongSell")}</span>
                  <span>{t("chart.sell")}</span>
                  <span>{t("chart.neutralZone")}</span>
                  <span>{t("chart.buy")}</span>
                  <span>{t("chart.strongBuy")}</span>
                </div>
                <div className={`fs-gauge-value fs-gauge-value--${zone?.signal ?? "neutral"}`}>
                  {zone ? gaugeLabel[zone.signal] : t("chart.neutralZone")}
                </div>
              </div>

              <div className="mss-section-title">{t("chart.keyStats", "Key stats")}</div>
              <div className="fs-info-list">
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.volume", "Volume")}</span>
                  <span className="fs-info-value">{quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}</span>
                </div>
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.avgVolume30d", "Average volume (30D)")}</span>
                  <span className="fs-info-value">—</span>
                </div>
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.marketCap", "Market capitalization")}</span>
                  <span className="fs-info-value">{coinMeta?.marketCapUSD != null ? formatCompactVolume(coinMeta.marketCapUSD) : "—"}</span>
                </div>
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.fdv", "Fully diluted market cap")}</span>
                  <span className="fs-info-value">{coinMeta?.fdvUSD != null ? formatCompactVolume(coinMeta.fdvUSD) : "—"}</span>
                </div>
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.tradingVolume24h", "Trading volume 24h")}</span>
                  <span className="fs-info-value">{quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}</span>
                </div>
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.allTimeHigh", "All time high")}</span>
                  <span className="fs-info-value">{coinMeta?.athUSD != null ? formatLivePrice(coinMeta.athUSD) : "—"}</span>
                </div>
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.circulatingSupply", "Circulating supply")}</span>
                  <span className="fs-info-value">{coinMeta?.circulatingSupply != null ? `${formatCompactNumber(coinMeta.circulatingSupply)} ${coin}` : "—"}</span>
                </div>
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.totalSupply", "Total supply")}</span>
                  <span className="fs-info-value">{coinMeta?.totalSupply != null ? `${formatCompactNumber(coinMeta.totalSupply)} ${coin}` : "—"}</span>
                </div>
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.openInterest", "Open interest")}</span>
                  <span className="fs-info-value">{oiUSD != null ? formatCompactVolume(oiUSD) : "—"}</span>
                </div>
              </div>

              <div className="mss-section-title">{t("chart.about", "About")}</div>
              <div className="fs-info-list">
                <div className="fs-info-row">
                  <span className="fs-info-label">{t("chart.category", "Category")}</span>
                  <span className="fs-info-value">{coinMeta?.category ?? "—"}</span>
                </div>
                {([
                  ["chart.website", "Website", coinMeta?.homepage],
                  ["chart.sourceCode", "Source Code", coinMeta?.sourceCode],
                  ["chart.explorers", "Explorers", coinMeta?.explorer],
                  ["chart.whitepaper", "Whitepaper", coinMeta?.whitepaper],
                  ["chart.community", "Community", coinMeta?.subreddit],
                ] as const).map(([key, fallback, url]) => (
                  <div className="fs-info-row" key={key}>
                    <span className="fs-info-label">{t(key, fallback)}</span>
                    {url ? (
                      <a className="fs-info-link" href={url} target="_blank" rel="noopener noreferrer">
                        {url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                      </a>
                    ) : (
                      <span className="fs-info-value">—</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
