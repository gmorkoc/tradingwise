import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { useTranslation } from "react-i18next";
import type { Ticker24h } from "../services/coinglass";
import { formatLivePrice } from "./PriceChart";
import "../styles/DailyBrief.css";

const IS_IOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

// Native: keep the reader inside the app via an in-app browser instead of
// handing off to Safari. Web: let the anchor's own target="_blank" handle it.
const openNewsLink = (e: React.MouseEvent<HTMLAnchorElement>, url: string) => {
  if (Capacitor.isNativePlatform()) {
    e.preventDefault();
    Browser.open({ url });
  }
};

// Same in-app-browser behavior as openNewsLink, but for a <button> (no
// href/target of its own to fall back on for the web case).
const openExternalLink = (url: string) => {
  if (Capacitor.isNativePlatform()) Browser.open({ url });
  else window.open(url, "_blank", "noopener,noreferrer");
};

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
        {ticker.price > 0 && <span className="db-chip-price">{formatLivePrice(ticker.price)}</span>}{" "}
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

// ── Featured video ────────────────────────────────────────────────────────────
// A video actually about the lead story, not just whatever a fixed
// channel uploaded most recently — search.list ranked by relevance
// against the headline itself. Costs 100 quota units/call (vs. 1 for a
// plain playlist fetch), but this only re-runs when the featured headline
// itself changes (see the effect below), and results are cached per
// headline in localStorage, so a 10,000/day free quota comfortably covers
// real usage.
const YT_API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY as string | undefined;
const YT_LS_PREFIX = "db-video-cache-v2:";

interface FeaturedVideo { videoId: string; title: string; channel: string; thumb: string; publishedAt: number }

async function fetchVideoForTitle(title: string): Promise<FeaturedVideo | null> {
  if (!YT_API_KEY || !title.trim()) return null;
  const cacheKey = YT_LS_PREFIX + title.trim().toLowerCase();
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) return JSON.parse(raw) as FeaturedVideo;
  } catch { /* ignore */ }

  const base = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=relevance&maxResults=1&safeSearch=strict&q=${encodeURIComponent(title)}&key=${YT_API_KEY}`;
  try {
    // This headline is live news, so a video actually made about it (last
    // 2 weeks) reads as relevant — a plain relevance sort with no date
    // bound tends to surface old, high-engagement explainer videos that
    // happen to share keywords instead. Falls back to that broader search
    // only when nothing recent exists, rather than showing nothing.
    const publishedAfter = new Date(Date.now() - 14 * 86_400_000).toISOString();
    let res = await fetch(`${base}&publishedAfter=${publishedAfter}`);
    let data = await res.json();
    let item = data?.items?.[0];
    if (!item?.id?.videoId) {
      res = await fetch(base);
      data = await res.json();
      item = data?.items?.[0];
    }
    if (!item?.id?.videoId) return null;

    const video: FeaturedVideo = {
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumb: item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.default?.url ?? "",
      publishedAt: new Date(item.snippet.publishedAt).getTime(),
    };
    try { localStorage.setItem(cacheKey, JSON.stringify(video)); } catch { /* ignore */ }
    return video;
  } catch {
    return null;
  }
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
// A tap-detected sheet toggle waits this long before actually applying —
// long enough to see a same-instant backgrounding (see endDrag), short
// enough that a real tap still feels instant.
const TAP_CONFIRM_DELAY_MS = 200;

// No thumbnail in the feed — a real category-themed photo (stored locally
// in /public/daily-brief, not hotlinked) reads far better than an icon.
// Same three images regardless of which specific outlet/article is missing
// one, just varied by category.
const CATEGORY_FALLBACK_IMG: Record<Category, string> = {
  crypto: "/daily-brief/crypto.jpg",
  markets: "/daily-brief/markets.jpg",
  geopolitics: "/daily-brief/geopolitics.jpg",
};

const ThumbPlaceholder: React.FC<{ category: Category; className: string }> = ({ category, className }) => (
  <img
    className={`${className} db-thumb-placeholder db-thumb-placeholder--${category}`}
    src={CATEGORY_FALLBACK_IMG[category]}
    alt=""
    loading="lazy"
  />
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
  const [newUrls, setNewUrls] = useState<Set<string>>(new Set());
  const [video, setVideo] = useState<FeaturedVideo | null>(null);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoEmbedFailed, setVideoEmbedFailed] = useState(false);
  const dragStartY = useRef<number | null>(null);
  const knownUrlsRef = useRef<Set<string> | null>(null);
  const listRowsRef = useRef<HTMLDivElement>(null);
  const prevRowRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const listMountedRef = useRef(false);

  // Coin chat (mobile sheet / reply takeover) dispatches this when it
  // opens/closes — hide completely rather than risk stacking on top of it
  // and looking cluttered.
  useEffect(() => {
    const onCoinChat = (e: Event) => setChatActive((e as CustomEvent<boolean>).detail);
    window.addEventListener("coin-chat-active", onCoinChat);
    return () => window.removeEventListener("coin-chat-active", onCoinChat);
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

  // Diffs each fetch against the URLs we've already shown so genuinely new
  // stories (not just the same feed re-sorted) get an entrance animation —
  // skipped on the very first load (knownUrlsRef starts null) so the whole
  // initial 25-item list doesn't animate in at once.
  const load = useCallback(async (cancelledRef?: { current: boolean }) => {
    const brief = await fetchBrief();
    if (cancelledRef?.current || brief.length === 0) return;
    const freshUrls = new Set(brief.map((i) => i.url));
    if (knownUrlsRef.current) {
      const added = new Set<string>();
      for (const url of freshUrls) if (!knownUrlsRef.current.has(url)) added.add(url);
      if (added.size > 0) {
        setNewUrls(added);
        window.setTimeout(() => setNewUrls(new Set()), 900);
      }
    }
    knownUrlsRef.current = freshUrls;
    setItems(brief);
  }, []);

  useEffect(() => {
    const cancelledRef = { current: false };
    load(cancelledRef);
    const interval = window.setInterval(() => load(), 10 * 60 * 1000);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(interval);
    };
  }, [load]);

  // FLIP: animate the flat list settling into its new order whenever a
  // fresh story pushes everything else down a slot — measures each row's
  // position before this render (captured at the end of the previous run)
  // against where it landed just now, then plays the delta as a transform
  // instead of letting the reorder snap instantly. Skipped on the very
  // first mount (nothing to animate from yet).
  useLayoutEffect(() => {
    const container = listRowsRef.current;
    if (!container) return;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-db-flip]"));
    if (!listMountedRef.current) {
      rows.forEach((el) => prevRowRectsRef.current.set(el.dataset.dbFlip!, el.getBoundingClientRect()));
      listMountedRef.current = true;
      return;
    }
    rows.forEach((el) => {
      const key = el.dataset.dbFlip!;
      const newRect = el.getBoundingClientRect();
      const oldRect = prevRowRectsRef.current.get(key);
      el.style.transition = "none";
      if (oldRect) {
        const dy = oldRect.top - newRect.top;
        if (Math.abs(dy) > 1) el.style.transform = `translateY(${dy}px)`;
      } else {
        el.style.transform = "translateY(-10px)";
        el.style.opacity = "0";
      }
      // Force layout so the "from" state above actually applies before the
      // transition-on rAF flips it — otherwise the browser coalesces both
      // style writes into one frame and nothing animates.
      void el.offsetHeight;
      requestAnimationFrame(() => {
        el.style.transition = "transform 0.35s ease, opacity 0.35s ease";
        el.style.transform = "";
        el.style.opacity = "";
      });
      prevRowRectsRef.current.set(key, newRect);
    });
    const currentKeys = new Set(rows.map((el) => el.dataset.dbFlip));
    for (const key of prevRowRectsRef.current.keys()) {
      if (!currentKeys.has(key)) prevRowRectsRef.current.delete(key);
    }
  }, [items]);

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
      // Splitting pointercancel from pointerup (below) turned out not to be
      // the whole story — on a real device this still toggled the sheet
      // open on some app-minimizes, meaning iOS sometimes delivers a
      // genuine pointerup (not cancel) with near-zero movement for the
      // exact same reason: the swipe-to-home gesture zone and this drag
      // handle both live at the bottom of the screen, so the touch that
      // starts the system gesture also reads as a real tap here before iOS
      // finishes taking over. Since the event type alone can't be trusted,
      // this buffers the actual toggle by one tick and cancels it if the
      // page is backgrounded within that window on either side — covers
      // both "tap event, then hide" and "hide, then tap event" orderings.
      setTimeout(() => {
        if (document.visibilityState === "hidden") return;
        setSheetState((s) => (s === "collapsed" ? "expanded" : "collapsed"));
      }, TAP_CONFIRM_DELAY_MS);
    } else if (delta < -DRAG_THRESHOLD) {
      // dragged up
      setSheetState((s) => (s === "minimized" ? "collapsed" : "expanded"));
    } else if (delta > DRAG_THRESHOLD) {
      // dragged down
      setSheetState((s) => (s === "expanded" ? "collapsed" : "minimized"));
    }
  };

  // A pointercancel is NOT a completed tap — iOS fires exactly this right as
  // its own swipe-to-home/app-switcher gesture takes over a touch that
  // started on the sheet (minimizing/backgrounding the app), typically
  // before any real movement was recorded. Reusing endDrag's tap-detection
  // for it meant that interrupted touch — near-zero delta, same as a real
  // tap — was toggling the sheet open every time someone backgrounded the
  // app with a finger over it. Cancel just abandons the gesture: reset drag
  // state, don't touch sheetState at all.
  const cancelDrag = () => {
    dragStartY.current = null;
    setDragging(false);
    setDragY(0);
  };

  // The "blog" card — a single, always-crypto lead story with its own
  // mini timeline of the next couple of updates underneath it (the Yahoo
  // Finance "markets blog" layout this was asked to match), pulled out of
  // the flat list rather than just being items[0]/[1]/[2]: the full feed
  // is a mix of crypto/markets/geopolitics sorted purely by time, so the
  // newest item overall isn't reliably a crypto story.
  const cryptoItems = items.filter((i) => i.category === "crypto");
  const featured = cryptoItems[0];
  const timelineItems = featured ? cryptoItems.slice(1, 3) : [];
  const usedUrls = new Set([featured, ...timelineItems].filter(Boolean).map((i) => i!.url));
  const latestItems = items.filter((item) => !usedUrls.has(item.url));

  // Re-searches only when the lead headline itself changes, not on a
  // timer — same "don't spend quota on an answer that can't have
  // changed" principle as Inside the Candle's AI cache.
  useEffect(() => {
    if (!featured) { setVideo(null); return; }
    let cancelled = false;
    setVideoPlaying(false);
    setVideoEmbedFailed(false);
    fetchVideoForTitle(featured.title).then((v) => { if (!cancelled) setVideo(v); });
    return () => { cancelled = true; };
  }, [featured?.title]);

  // YouTube's embedded player posts its own error events (invalid embed
  // origin, or the uploader disabled embedding for this specific video) —
  // catch that and swap to a plain "watch on YouTube" link instead of
  // leaving YouTube's own error card sitting inside the card.
  useEffect(() => {
    if (!videoPlaying) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== "https://www.youtube.com") return;
      try {
        const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (data?.event === "onError") setVideoEmbedFailed(true);
      } catch { /* ignore non-JSON postMessages */ }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [videoPlaying]);

  const renderRow = (item: BriefItem) => {
    const chips = extractChips(item.title);
    return (
      <a
        key={item.url}
        data-db-flip={item.url}
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`db-list-item${newUrls.has(item.url) ? " db-item--new" : ""}`}
        onClick={(e) => openNewsLink(e, item.url)}
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
  };

  const latestRows = latestItems.map((item) => renderRow(item));

  const featuredCard = featured && (
    <div className={`db-featured${newUrls.has(featured.url) ? " db-item--new" : ""}`}>
      <div className="db-featured-badge">
        <div className="top-nav-logo">
          coinhint<span className="top-nav-logo-accent">z</span>
        </div>
        <span className="db-featured-brand-sub">{t("dailyBrief.blogBrandSub", "crypto market blog")}</span>
      </div>
      <div className="db-featured-main">
        {/* A video actually about this headline (see fetchVideoForTitle)
            replaces the static photo entirely — click-to-play, so no
            iframe loads until tapped. Falls back to the plain photo when
            no matching video was found. */}
        {video ? (
          videoPlaying ? (
            videoEmbedFailed ? (
              <div className="db-video-frame-wrap">
                <button
                  type="button"
                  className="db-video-thumb-btn"
                  onClick={() => openExternalLink(`https://www.youtube.com/watch?v=${video.videoId}`)}
                >
                  {featured.thumbnail ? (
                    <img className="db-video-thumb" src={featured.thumbnail} alt="" loading="lazy" />
                  ) : (
                    <ThumbPlaceholder className="db-video-thumb" category={featured.category} />
                  )}
                  <span className="db-video-play">▶</span>
                  <span className="db-video-info">
                    <span className="db-video-channel">Can't play here — watch on YouTube</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="db-video-close"
                  onClick={() => { setVideoPlaying(false); setVideoEmbedFailed(false); }}
                  aria-label="Back to thumbnail"
                  title="Back to thumbnail"
                >
                  ✕
                </button>
              </div>
            ) : (
              <div className="db-video-frame-wrap">
                <iframe
                  className="db-video-frame"
                  // "origin" has to be the app's real https:// domain, not
                  // wherever this is actually running — on iOS, Capacitor
                  // serves from capacitor://localhost, which YouTube's
                  // player rejects as an invalid embed origin (error 153)
                  // without this override.
                  src={`https://www.youtube.com/embed/${video.videoId}?autoplay=1&playsinline=1&enablejsapi=1&origin=https://www.coinhintz.io`}
                  title={video.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
                <button
                  type="button"
                  className="db-video-close"
                  onClick={() => setVideoPlaying(false)}
                  aria-label="Back to thumbnail"
                  title="Back to thumbnail"
                >
                  ✕
                </button>
              </div>
            )
          ) : (
            <button
              type="button"
              className="db-video-thumb-btn"
              onClick={() => {
                // YouTube's embedded player won't initialize inside
                // Capacitor's capacitor://localhost WebView on iOS (not
                // an https origin, regardless of the ?origin= param) —
                // open it in the in-app browser instead of trying to
                // embed it inline there. A real web browser has no such
                // restriction, so the inline embed stays for web.
                if (Capacitor.isNativePlatform()) {
                  openExternalLink(`https://www.youtube.com/watch?v=${video.videoId}`);
                } else {
                  setVideoPlaying(true);
                }
              }}
            >
              {featured.thumbnail ? (
                <img className="db-video-thumb" src={featured.thumbnail} alt="" loading="lazy" />
              ) : (
                <ThumbPlaceholder className="db-video-thumb" category={featured.category} />
              )}
              <span className="db-video-play">▶</span>
            </button>
          )
        ) : (
          <a
            href={featured.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => openNewsLink(e, featured.url)}
          >
            {featured.thumbnail ? (
              <img className="db-featured-thumb" src={featured.thumbnail} alt="" loading="lazy" />
            ) : (
              <ThumbPlaceholder className="db-featured-thumb" category={featured.category} />
            )}
          </a>
        )}
        <a
          href={featured.url}
          target="_blank"
          rel="noopener noreferrer"
          className="db-featured-title-link"
          onClick={(e) => openNewsLink(e, featured.url)}
        >
          <span className="db-featured-title">{featured.title}</span>
          {(() => {
            const chips = extractChips(featured.title);
            return chips.length > 0 && (
              <span className="db-list-chips">{chips.map((c) => renderChip(c, featured.category, coinTickers))}</span>
            );
          })()}
        </a>
      </div>
      {timelineItems.length > 0 && (
        <div className="db-timeline">
          {timelineItems.map((item, i) => (
            <a
              key={item.url}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`db-timeline-item${i === timelineItems.length - 1 ? " db-timeline-item--last" : ""}${newUrls.has(item.url) ? " db-item--new" : ""}`}
              onClick={(e) => openNewsLink(e, item.url)}
            >
              <span className="db-timeline-marker" />
              <span className="db-timeline-time">{timeAgo(item.pubDate, t)}</span>
              <span className="db-timeline-title">{item.title}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );

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
        <div className="db-page-list">
          {featuredCard}
          {latestRows.length > 0 && <div className="db-section-label">{t("dailyBrief.latest", "Your latest")}</div>}
          <div ref={listRowsRef} className="db-list-rows">
            {latestRows}
          </div>
        </div>
      </aside>
    );
  }

  if (items.length === 0 || dismissed || chatActive) return null;

  // Collapsed teaser shows the same lead story the featured blog card
  // below expands into, not just whatever's newest overall (which could
  // be a non-crypto item).
  const current = featured ?? items[0];

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
          onPointerCancel={cancelDrag}
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
          <div className="db-card-list">
            {featuredCard}
            {latestRows.length > 0 && <div className="db-section-label">{t("dailyBrief.latest", "Your latest")}</div>}
            <div ref={listRowsRef} className="db-list-rows">
              {latestRows}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
