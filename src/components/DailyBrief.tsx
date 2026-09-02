import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import "../styles/DailyBrief.css";

type Category = "crypto" | "markets" | "geopolitics";

interface BriefItem {
  title: string;
  url: string;
  source: string;
  category: Category;
  pubDate: number;
  thumbnail: string;
}

interface FeedDef {
  url: string;
  source: string;
  category: Category;
}

const FEEDS: FeedDef[] = [
  // Crypto — always relevant, no filtering needed
  { url: "https://cointelegraph.com/rss", source: "CoinTelegraph", category: "crypto" },
  { url: "https://coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk", category: "crypto" },
  { url: "https://decrypt.co/feed", source: "Decrypt", category: "crypto" },
  // Stock market — filtered for crypto/macro relevance
  { url: "https://www.cnbc.com/id/20910258/device/rss/rss.html", source: "CNBC Markets", category: "markets" },
  { url: "https://feeds.marketwatch.com/marketwatch/topstories/", source: "MarketWatch", category: "markets" },
  // Government / geopolitics — filtered for crypto/macro relevance
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", source: "BBC World", category: "geopolitics" },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", source: "Al Jazeera", category: "geopolitics" },
];

// Only applied to "markets" and "geopolitics" feeds — crypto feeds are inherently on-topic.
const RELEVANCE_KEYWORDS = [
  "bitcoin", "crypto", "btc", "eth", "ethereum", "blockchain", "stablecoin", "defi",
  "sec ", "cftc", "etf", "coinbase", "binance", "regulation", "regulator",
  "federal reserve", "the fed", "fed rate", "interest rate", "rate cut", "rate hike",
  "inflation", "cpi", "tariff", "sanction", "war", "ukraine", "russia", "israel",
  "gaza", "iran", "china", "taiwan", "geopolitic", "treasury", "dollar", "recession",
  "stock market", "s&p 500", "nasdaq", "dow jones", "oil price", "shutdown",
  "election", "trump", "debt ceiling", "gold price", "sell-off", "selloff",
  "rally", "volatility", "wall street", "central bank", "jerome powell", "imf",
];

// Short tag chips surfaced under a headline — mapped from the same relevance keywords.
const CHIP_MAP: [string, string][] = [
  ["bitcoin", "BTC"], ["btc", "BTC"], ["ethereum", "ETH"], ["eth", "ETH"],
  ["stablecoin", "STABLECOIN"], ["defi", "DEFI"], ["etf", "ETF"],
  ["sec ", "SEC"], ["cftc", "CFTC"], ["coinbase", "COINBASE"], ["binance", "BINANCE"],
  ["regulation", "REGULATION"], ["regulator", "REGULATION"],
  ["federal reserve", "FED"], ["the fed", "FED"], ["fed rate", "FED"],
  ["interest rate", "RATES"], ["rate cut", "RATES"], ["rate hike", "RATES"],
  ["inflation", "CPI"], ["cpi", "CPI"], ["tariff", "TARIFFS"],
  ["sanction", "SANCTIONS"], ["war", "WAR"], ["ukraine", "WAR"], ["russia", "WAR"],
  ["israel", "WAR"], ["gaza", "WAR"], ["iran", "WAR"], ["taiwan", "GEOPOLITICS"],
  ["china", "CHINA"], ["treasury", "TREASURY"], ["dollar", "DOLLAR"],
  ["recession", "RECESSION"], ["s&p 500", "S&P 500"], ["nasdaq", "NASDAQ"],
  ["dow jones", "DOW"], ["oil price", "OIL"], ["shutdown", "SHUTDOWN"],
  ["election", "ELECTION"], ["trump", "POLICY"], ["debt ceiling", "DEBT CEILING"],
  ["gold price", "GOLD"], ["wall street", "WALL ST"], ["central bank", "CENTRAL BANK"],
];

function isRelevant(title: string): boolean {
  const t = title.toLowerCase();
  return RELEVANCE_KEYWORDS.some((kw) => t.includes(kw));
}

function extractChips(title: string): string[] {
  const t = title.toLowerCase();
  const chips: string[] = [];
  for (const [kw, chip] of CHIP_MAP) {
    if (t.includes(kw) && !chips.includes(chip)) chips.push(chip);
    if (chips.length >= 3) break;
  }
  return chips;
}

// rss2json usually resolves `thumbnail`/`enclosure`, but some feeds only embed the
// image inline in the HTML body — fall back to scraping the first <img src>.
function extractImgFromHtml(html?: string): string {
  if (!html) return "";
  const match = html.match(/<img[^>]+src=["']([^"'>]+)["']/i);
  return match ? match[1] : "";
}

async function fetchFeed(feed: FeedDef): Promise<BriefItem[]> {
  try {
    const res = await fetch(
      `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed.url)}`
    );
    const data = await res.json();
    if (data.status !== "ok") return [];
    const items: BriefItem[] = data.items.map(
      (item: {
        title: string;
        link: string;
        pubDate: string;
        thumbnail?: string;
        enclosure?: { link?: string };
        description?: string;
        content?: string;
      }) => ({
        title: item.title,
        url: item.link,
        source: feed.source,
        category: feed.category,
        pubDate: item.pubDate ? new Date(item.pubDate).getTime() : Date.now(),
        thumbnail:
          item.thumbnail ||
          item.enclosure?.link ||
          extractImgFromHtml(item.content) ||
          extractImgFromHtml(item.description) ||
          "",
      })
    );
    return feed.category === "crypto" ? items : items.filter((i) => isRelevant(i.title));
  } catch {
    return [];
  }
}

async function fetchBrief(): Promise<BriefItem[]> {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  const seen = new Set<string>();
  const deduped = all.filter((item) => {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.sort((a, b) => b.pubDate - a.pubDate).slice(0, 25);
}

function timeAgo(ts: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return t("dailyBrief.minutesAgo", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("dailyBrief.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  return t("dailyBrief.daysAgo", { count: days });
}

const CATEGORY_LABEL_KEY: Record<Category, string> = {
  crypto: "dailyBrief.categoryCrypto",
  markets: "dailyBrief.categoryMarkets",
  geopolitics: "dailyBrief.categoryGeopolitics",
};

const DRAG_THRESHOLD = 40;
const TAP_THRESHOLD = 6;

const ThumbPlaceholder: React.FC<{ category: Category; className: string }> = ({ category, className }) => (
  <div className={`${className} db-thumb-placeholder db-thumb-placeholder--${category}`}>
    <svg width="40%" height="40%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 4v5M8 13h8M8 17h5" />
    </svg>
  </div>
);

type SheetState = "minimized" | "collapsed" | "expanded";

export const DailyBrief: React.FC = () => {
  const { t } = useTranslation();
  const [items, setItems] = useState<BriefItem[]>([]);
  const [index, setIndex] = useState(0);
  const [sheetState, setSheetState] = useState<SheetState>("minimized");
  const [dismissed, setDismissed] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [scrollHidden, setScrollHidden] = useState(false);
  const dragStartY = useRef<number | null>(null);

  // Yahoo Finance-style auto-hide: slide the (collapsed, resting) sheet out
  // of the way while the user scrolls down through the page, back in on any
  // scroll-up. Listens in the capture phase on document so it picks up
  // whichever nested panel is actually scrolling (chart, watchlist, etc.)
  // without needing to know which one that is.
  useEffect(() => {
    const SCROLL_HIDE_THRESHOLD = 8;
    const lastScrollTop = new WeakMap<EventTarget, number>();
    const onScroll = (e: Event) => {
      const target = e.target as HTMLElement | Document;
      const scrollTop = target instanceof Document
        ? (target.scrollingElement?.scrollTop ?? 0)
        : target.scrollTop;
      const prev = lastScrollTop.get(target) ?? scrollTop;
      lastScrollTop.set(target, scrollTop);
      const delta = scrollTop - prev;
      if (Math.abs(delta) < SCROLL_HIDE_THRESHOLD) return;
      if (delta > 0 && scrollTop > 40) setScrollHidden(true);
      else if (delta < 0) setScrollHidden(false);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  const load = useCallback(async () => {
    const brief = await fetchBrief();
    if (brief.length > 0) setItems(brief);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const brief = await fetchBrief();
      if (!cancelled && brief.length > 0) setItems(brief);
    })();
    const interval = window.setInterval(load, 15 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [load]);

  const onPointerDown = (e: React.PointerEvent) => {
    dragStartY.current = e.clientY;
    setDragging(true);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragStartY.current === null) return;
    const delta = e.clientY - dragStartY.current;
    // Resist dragging past the sheet's natural resting bounds — collapsed can
    // go either way (up to expand, down to minimize), the other two states
    // can only be dragged back toward collapsed.
    let clamped = delta;
    if (sheetState === "expanded") clamped = Math.max(0, delta);
    if (sheetState === "minimized") clamped = Math.min(0, delta);
    setDragY(clamped);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (dragStartY.current === null) return;
    const delta = e.clientY - dragStartY.current;
    dragStartY.current = null;
    setDragging(false);
    setDragY(0);

    if (Math.abs(delta) < TAP_THRESHOLD) {
      setSheetState((s) => (s === "collapsed" ? "expanded" : "collapsed"));
    } else if (delta < -DRAG_THRESHOLD) {
      // dragged up
      setSheetState((s) => (s === "minimized" ? "collapsed" : "expanded"));
    } else if (delta > DRAG_THRESHOLD) {
      // dragged down
      setSheetState((s) => (s === "expanded" ? "collapsed" : "minimized"));
    }
  };

  if (items.length === 0 || dismissed) return null;

  const current = items[index];
  const chips = [t(CATEGORY_LABEL_KEY[current.category]), ...extractChips(current.title)].slice(0, 4);

  const cyclePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIndex((i) => (i - 1 + items.length) % items.length);
  };
  const cycleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIndex((i) => (i + 1) % items.length);
  };

  return (
    <>
      {sheetState === "expanded" && (
        <div className="db-backdrop" onClick={() => setSheetState("collapsed")} />
      )}
      <div
        className={`db-sheet${sheetState === "expanded" ? " db-sheet--expanded" : ""}${sheetState === "minimized" ? " db-sheet--minimized" : ""}${sheetState !== "expanded" && scrollHidden ? " db-sheet--scroll-hidden" : ""}`}
        style={{ "--db-drag-y": `${dragY}px` } as React.CSSProperties}
      >
        {sheetState !== "minimized" && (
          <div className="db-traffic-lights">
            <button
              className="db-tl-btn db-tl-btn--close"
              onClick={(e) => { e.stopPropagation(); setDismissed(true); }}
              aria-label={t("dailyBrief.close")}
              title={t("dailyBrief.close")}
            >
              <svg className="db-tl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <div
          className="db-drag-zone"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={dragging ? { transition: "none" } : undefined}
        >
          <span className="db-handle" />
          <div className="db-head">
            <span className="db-head-title-row">
              <span className="db-head-title">{t("dailyBrief.title")}</span>
              <span className="db-live">
                {t("nav.live")}
                <span className="db-live-dot" />
              </span>
            </span>
            {sheetState !== "expanded" && (
              <span className="db-head-teaser">{current.title}</span>
            )}
          </div>
        </div>

        <div className="db-card">
          {/* Desktop / wide viewports — single featured story with prev/next pager */}
          <div className="db-card-featured">
            <div className="db-card-top">
              <span className={`db-source db-source--${current.category}`}>{current.source}</span>
              <span className="db-live">
                {t("nav.live")}
                <span className="db-live-dot" />
              </span>
            </div>
            <a
              href={current.url}
              target="_blank"
              rel="noopener noreferrer"
              className="db-card-body"
            >
              <span className="db-headline">{current.title}</span>
              {current.thumbnail ? (
                <img className="db-thumb" src={current.thumbnail} alt="" loading="lazy" />
              ) : (
                <ThumbPlaceholder className="db-thumb" category={current.category} />
              )}
            </a>
            <div className="db-chips">
              {chips.map((c) => (
                <span key={c} className={`db-chip db-chip--${current.category}`}>
                  {c}
                </span>
              ))}
            </div>
            <div className="db-card-footer">
              <span className="db-item-meta">{timeAgo(current.pubDate, t)}</span>
              <div className="db-nav">
                <button className="db-nav-btn" onClick={cyclePrev} aria-label="Previous">‹</button>
                <span className="db-counter">{index + 1} / {items.length}</span>
                <button className="db-nav-btn" onClick={cycleNext} aria-label="Next">›</button>
              </div>
            </div>
          </div>

          {/* Mobile — vertically scrollable list of every story, no pager */}
          <div className="db-card-list">
            {items.map((item, i) => (
              <a
                key={`${item.url}-${i}`}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="db-list-item"
              >
                {item.thumbnail ? (
                  <img className="db-list-thumb" src={item.thumbnail} alt="" loading="lazy" />
                ) : (
                  <ThumbPlaceholder className="db-list-thumb" category={item.category} />
                )}
                <span className="db-list-body">
                  <span className={`db-source db-source--${item.category} db-list-source`}>
                    {item.source}
                  </span>
                  <span className="db-list-title">{item.title}</span>
                  <span className="db-item-meta">{timeAgo(item.pubDate, t)}</span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </>
  );
};
