import { useState, useEffect, useCallback, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { useTranslation } from "react-i18next";
import type { Ticker24h } from "../services/coinglass";
import "../styles/DailyBrief.css";

const IS_IOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

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
// Coin-symbol entries (bitcoin/btc, ethereum/eth, solana, xrp, etc.) get a live
// price chip instead of a plain tag when that symbol is in `coinTickers` — see
// renderChip() below.
const CHIP_MAP: [string, string][] = [
  ["bitcoin", "BTC"], ["btc", "BTC"], ["ethereum", "ETH"], ["eth", "ETH"],
  ["solana", "SOL"], ["xrp", "XRP"], ["ripple", "XRP"], ["cardano", "ADA"],
  ["dogecoin", "DOGE"], ["binance coin", "BNB"], ["bnb", "BNB"],
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

// A chip whose label happens to be a symbol we already have a live 24h
// ticker for (coinTickers, fetched once at the App.tsx level for the coin
// picker — no extra API call here) gets the real price instead of a plain
// static tag.
function renderChip(label: string, _category: Category, coinTickers?: Map<string, Ticker24h>) {
  const ticker = coinTickers?.get(label);
  if (ticker) {
    const up = ticker.change >= 0;
    return (
      <span key={label} className={`db-chip db-chip--ticker${up ? " up" : " down"}`}>
        <span className="db-chip-symbol">{label}</span>{" "}
        <span className="db-chip-change">{up ? "+" : ""}{ticker.change.toFixed(2)}%</span>
      </span>
    );
  }
  return (
    <span key={label} className="db-chip db-chip--tag">{label}</span>
  );
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

interface Props {
  // Same 24h ticker map App.tsx already fetches for the coin picker —
  // reused here to upgrade a chip to a live price instead of a plain tag.
  coinTickers?: Map<string, Ticker24h>;
  // "sheet" (default) is the draggable, collapsible bottom sheet used on
  // mobile/narrow widths. "page" is an always-visible panel meant to be
  // rendered in-flow next to the chart on desktop — see its render branch
  // below and .db-page in DailyBrief.css.
  variant?: "sheet" | "page";
}

export const DailyBrief: React.FC<Props> = ({ coinTickers, variant = "sheet" }) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<BriefItem[]>([]);
  const [sheetState, setSheetState] = useState<SheetState>("collapsed");
  const [dismissed, setDismissed] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [scrollHidden, setScrollHidden] = useState(false);
  const [chatActive, setChatActive] = useState(false);
  const dragStartY = useRef<number | null>(null);

  // Coin chat (mobile sheet / reply takeover) and the AI chat panel both
  // dispatch these when they open/close — hide completely rather than
  // risk stacking on top of them and looking cluttered.
  useEffect(() => {
    const coinChatOpen = { current: false };
    const aiChatOpen = { current: false };
    const recompute = () => setChatActive(coinChatOpen.current || aiChatOpen.current);
    const onCoinChat = (e: Event) => { coinChatOpen.current = (e as CustomEvent<boolean>).detail; recompute(); };
    const onAiChat = (e: Event) => { aiChatOpen.current = (e as CustomEvent<boolean>).detail; recompute(); };
    window.addEventListener("coin-chat-active", onCoinChat);
    window.addEventListener("ai-chat-active", onAiChat);
    return () => {
      window.removeEventListener("coin-chat-active", onCoinChat);
      window.removeEventListener("ai-chat-active", onAiChat);
    };
  }, []);

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

  const rows = items.map((item, i) => {
    const chips = extractChips(item.title);
    return (
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
          <span className="db-list-title">{item.title}</span>
          <span className="db-list-meta">
            {item.source} <span className="db-list-dot">•</span> {timeAgo(item.pubDate, t)}
          </span>
          {chips.length > 0 && (
            <span className="db-list-chips">
              {chips.map((c) => renderChip(c, item.category, coinTickers))}
            </span>
          )}
        </span>
      </a>
    );
  });

  if (variant === "page") {
    if (items.length === 0) return null;
    return (
      <aside className="db-page">
        <div className="db-page-head">
          <span className="db-head-title">{t("dailyBrief.title")}</span>
          <span className="db-live">
            <span className="db-live-dot" />
            {t("nav.live")}
          </span>
        </div>
        <div className="db-page-list">{rows}</div>
      </aside>
    );
  }

  if (items.length === 0 || dismissed || chatActive) return null;

  // Collapsed teaser always shows the latest headline — the pager (and the
  // single-story "featured" card it drove) is gone now that the full list
  // renders at every width, see .db-card-list below.
  const current = items[0];

  return (
    <>
      {sheetState === "expanded" && (
        <div className="db-backdrop" onClick={() => setSheetState("collapsed")} />
      )}
      <div
        className={`db-sheet${sheetState === "expanded" ? " db-sheet--expanded" : ""}${sheetState === "minimized" ? " db-sheet--minimized" : ""}${(sheetState === "collapsed" || (IS_IOS && sheetState === "minimized")) && scrollHidden ? " db-sheet--scroll-hidden" : ""}`}
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
                <span className="db-live-dot" />
                {t("nav.live")}
              </span>
            </span>
            {sheetState !== "expanded" && (
              <span className="db-head-teaser">{current.title}</span>
            )}
          </div>
        </div>

        <div className="db-card">
          <div className="db-card-list">{rows}</div>
        </div>
      </div>
    </>
  );
};
