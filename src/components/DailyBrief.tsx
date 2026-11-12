import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { useTranslation } from "react-i18next";
import type { Ticker24h } from "../services/coinglass";
import { formatLivePrice } from "./PriceChart";
import { BottomSheet } from "./BottomSheet";
import { GenericCover } from "./MarketStories";
import "../styles/DailyBrief.css";

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

export interface BriefItem {
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
  { url: "https://www.theblock.co/rss.xml", source: "The Block", category: "crypto" },
  { url: "https://bitcoinmagazine.com/.rss/full/", source: "Bitcoin Magazine", category: "crypto" },
  { url: "https://cryptoslate.com/feed/", source: "CryptoSlate", category: "crypto" },
  { url: "https://cryptonews.com/news/feed/", source: "Cryptonews", category: "crypto" },
  // Stock market — filtered for crypto/macro relevance
  { url: "https://www.cnbc.com/id/20910258/device/rss/rss.html", source: "CNBC Markets", category: "markets" },
  { url: "https://feeds.marketwatch.com/marketwatch/topstories/", source: "MarketWatch", category: "markets" },
  { url: "https://www.investing.com/rss/news_301.rss", source: "Investing.com", category: "markets" },
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

// Whole words only — "eth" must not match "Hegseth", "war" not "warn".
const CHIP_RES: [RegExp, string][] = CHIP_MAP.map(([kw, chip]) => [
  new RegExp(`\\b${kw.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
  chip,
]);
export function extractChips(title: string): string[] {
  const chips: string[] = [];
  for (const [re, chip] of CHIP_RES) {
    if (re.test(title) && !chips.includes(chip)) chips.push(chip);
    if (chips.length >= 3) break;
  }
  return chips;
}

// A chip whose label happens to be a symbol we already have a live 24h
// ticker for (coinTickers, fetched once at the App.tsx level for the coin
// picker — no extra API call here) gets the real price instead of a plain
// static tag.
export function renderChip(label: string, _category: Category, coinTickers?: Map<string, Ticker24h>) {
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

// Feeds often hand out small thumbnails (BBC: 240px) that look blurry when
// shown full width. Ask the image CDN for a bigger version where the URL
// pattern allows it.
function upscaleThumb(url: string): string {
  if (!url) return url;
  // BBC ichef: /ace/standard/240/… → 976px (a size BBC serves).
  let u = url.replace(/(ichef\.bbci\.co\.uk\/(?:ace|news)\/(?:standard|ws))\/\d+\//, "$1/976/");
  // WordPress resized copies: name-150x150.jpg → name.jpg (the original).
  u = u.replace(/-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp))(\?|$)/i, "$1$2");
  // ?w=300 style width params below 600px → 1200.
  u = u.replace(/([?&](?:w|width)=)(\d+)/i, (m, p, n) => (Number(n) < 600 ? `${p}1200` : m));
  return u;
}

// rss2json usually resolves `thumbnail`/`enclosure`, but some feeds only embed the
// image inline in the HTML body — fall back to scraping the first <img src>.
function extractImgFromHtml(html?: string): string {
  if (!html) return "";
  const match = html.match(/<img[^>]+src=["']([^"'>]+)["']/i);
  return match ? match[1] : "";
}

// Unauthenticated rss2json requests share one global free-tier quota
// across every site using it, not just this app — easy to exhaust after
// enough reloads in a single day (confirmed directly: "Daily rate limit
// exceeded"). A registered key gets its own dedicated quota instead; a
// second, different account's key as backup means one account running
// out doesn't take the whole Daily Brief down until the next reset.
// Both optional — with neither set, this falls back to exactly today's
// unauthenticated behavior.
const RSS2JSON_API_KEY = import.meta.env.VITE_RSS2JSON_API_KEY as string | undefined;
const RSS2JSON_API_KEY_BACKUP = import.meta.env.VITE_RSS2JSON_API_KEY_BACKUP as string | undefined;

async function fetchRss2Json(rssUrl: string, apiKey?: string): Promise<{ data: any; rateLimited: boolean }> {
  const keyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : "";
  const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}${keyParam}`);
  const data = await res.json();
  const rateLimited = data.status !== "ok" && typeof data.message === "string" && /rate limit/i.test(data.message);
  return { data, rateLimited };
}

async function fetchFeed(feed: FeedDef): Promise<BriefItem[]> {
  try {
    let { data, rateLimited } = await fetchRss2Json(feed.url, RSS2JSON_API_KEY);
    if (rateLimited && RSS2JSON_API_KEY_BACKUP && RSS2JSON_API_KEY_BACKUP !== RSS2JSON_API_KEY) {
      ({ data } = await fetchRss2Json(feed.url, RSS2JSON_API_KEY_BACKUP));
    }
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
        // rss2json sends "YYYY-MM-DD HH:mm:ss" in UTC with no zone — read
        // it as UTC (as local time it lands in the future → always "1m").
        pubDate: item.pubDate
          ? new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(item.pubDate) ? `${item.pubDate.replace(" ", "T")}Z` : item.pubDate).getTime()
          : Date.now(),
        thumbnail: upscaleThumb(
          item.thumbnail ||
          item.enclosure?.link ||
          extractImgFromHtml(item.content) ||
          extractImgFromHtml(item.description) ||
          ""),
      })
    );
    return feed.category === "crypto" ? items : items.filter((i) => isRelevant(i.title));
  } catch {
    return [];
  }
}

// One shared copy for everything that shows the brief (Daily Brief sheet,
// Markets carousel, coin page News, Agent Ready opener): reused for 5 min,
// and simultaneous callers share the same in-flight fetch — so the feeds
// are hit once, not once per component.
let briefCache: { at: number; items: BriefItem[] } | null = null;
let briefInFlight: Promise<BriefItem[]> | null = null;
const BRIEF_TTL = 5 * 60_000;

export async function fetchBrief(): Promise<BriefItem[]> {
  if (briefCache && Date.now() - briefCache.at < BRIEF_TTL) return briefCache.items;
  if (briefInFlight) return briefInFlight;
  briefInFlight = fetchBriefFresh()
    .then((items) => {
      if (items.length) briefCache = { at: Date.now(), items };
      return items.length ? items : briefCache?.items ?? items;
    })
    .finally(() => { briefInFlight = null; });
  return briefInFlight;
}

async function fetchBriefFresh(): Promise<BriefItem[]> {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  const seen = new Set<string>();
  const deduped = all.filter((item) => {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.sort((a, b) => b.pubDate - a.pubDate).slice(0, 40);
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

export function timeAgo(ts: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return t("dailyBrief.minutesAgo", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("dailyBrief.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  return t("dailyBrief.daysAgo", { count: days });
}

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

// A story photo that never shows a broken-image icon: http → https, no
// Referer sent (several news CDNs refuse hotlinks from the app's
// capacitor:// origin), and if it still fails — or there's no photo — the
// same generated cover the Markets news carousel uses.
function NewsThumb({ item, className }: { item: BriefItem; className: string }) {
  const [broken, setBroken] = useState(false);
  const src = item.thumbnail ? item.thumbnail.replace(/^http:\/\//i, "https://") : "";
  if (!src || broken) {
    return <span className={`${className} dby-cover`}><GenericCover item={item} /></span>;
  }
  return (
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

// "collapsed" = the small persistent dock (title + handle only). "expanded"
// = the compact teaser card (title + one featured story) that now auto-
// opens on page load. "full" = the big reading view (title + featured
// story + the rest of the list), reached by tapping/dragging up from
// "expanded" — what "expanded" itself used to mean before this became a
// 4-size sheet instead of 3. "minimized" = almost fully closed; reaching
// it is what actually dismisses the whole thing (see the effect below).
type SheetState = "minimized" | "collapsed" | "expanded" | "full";

interface Props {
  // Same 24h ticker map App.tsx already fetches for the coin picker —
  // reused here to upgrade a chip to a live price instead of a plain tag.
  coinTickers?: Map<string, Ticker24h>;
  // "sheet" (default) is the draggable, collapsible bottom sheet used on
  // mobile/narrow widths. "page" is an always-visible panel meant to be
  // rendered in-flow next to the chart on desktop — see its render branch
  // below and .db-page in DailyBrief.css.
  variant?: "sheet" | "page";
  // Fires when sheetState reaches "minimized" (dragged down past
  // "collapsed" — there's no close (X) button anymore) — lets a parent
  // that conditionally mounts this component (e.g. FloatingNavBar's morph
  // toggle) know to unmount it too, instead of the parent still thinking
  // it's open while this has quietly gone dormant.
  onDismiss?: () => void;
  // Lets a freshly-mounted instance skip straight to "expanded" instead of
  // always starting at the small docked pill — used by App.tsx's News
  // icon (FloatingNavBar), which mounts this fresh on each tap rather than
  // keeping it mounted-but-collapsed the way the old auto-open sheet did.
  initialState?: SheetState;
}

export const DailyBrief: React.FC<Props> = ({ coinTickers, variant = "sheet", onDismiss, initialState = "collapsed" }) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<BriefItem[]>([]);
  // First fetch finished (even with nothing) — until then the sheet shows
  // placeholder rows instead of staying hidden.
  const [briefDone, setBriefDone] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // Forces a re-render every 30s purely so the "Updated Xm ago" label
  // next to the title keeps advancing between actual data refreshes —
  // timeAgo() itself has no way to re-trigger a render on its own.
  const [, setFreshnessTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setFreshnessTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  // Defaults to "collapsed" (the docked pill) for any caller that doesn't
  // pass initialState — App.tsx's News icon passes "expanded" explicitly,
  // since it mounts this fresh on each tap rather than keeping it mounted
  // in the background the old auto-open sheet did.
  const [sheetState, setSheetState] = useState<SheetState>(initialState);
  // "page" variant only — how many of the 3 topic sections (Top Stories/
  // Markets & Economy/Geopolitics) render side by side vs. stacked.
  // Starts at 1 (single column) on every load/reload, regardless of
  // screen width or any earlier session's choice — the 1/2/3 buttons
  // below are the only way to widen it, and it's a plain in-session
  // value (no persistence, no live width-triggered override): an earlier
  // version auto-corrected this on every resize event, which fought a
  // deliberate manual pick (or this new default) the moment the window
  // moved by a pixel — not what either is for.
  // Column picker removed — always one column.
  const sectionCols = 1 as 1 | 2 | 3;
  // Drives .chart-three-col-right's own width (App.css) — that's an
  // ancestor App.tsx renders, not this component, so a CSS custom
  // property on the document root is the simplest way to reach it
  // without prop-drilling sectionCols back up through App.tsx. Only
  // takes effect for variant==="page" (desktop sidebar); the mobile
  // sheet never reads this variable.
  useEffect(() => {
    if (variant !== "page") return;
    const widths: Record<1 | 2 | 3, string> = {
      1: "clamp(340px, 22vw, 420px)",
      2: "clamp(380px, 26vw, 480px)",
      3: "clamp(440px, 30vw, 600px)",
    };
    document.documentElement.style.setProperty("--db-page-width", widths[sectionCols]);
  }, [sectionCols, variant]);
  const [chatActive, setChatActive] = useState(false);
  const [newUrls, setNewUrls] = useState<Set<string>>(new Set());
  const [video, setVideo] = useState<FeaturedVideo | null>(null);
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

  // Diffs each fetch against the URLs we've already shown so genuinely new
  // stories (not just the same feed re-sorted) get an entrance animation —
  // skipped on the very first load (knownUrlsRef starts null) so the whole
  // initial 25-item list doesn't animate in at once.
  const load = useCallback(async (cancelledRef?: { current: boolean }) => {
    const brief = await fetchBrief().catch(() => [] as BriefItem[]);
    if (!cancelledRef?.current) setBriefDone(true);
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
    setUpdatedAt(Date.now());
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

  // "collapsed" (the dock) used to be a legitimate persistent resting
  // state, reached by scrolling, tapping, or dragging, that kept the
  // brief sitting there docked rather than closing. News is now mounted
  // fresh on each icon tap (not kept around in the background) — there's
  // no docked state for it to return to, so reaching "collapsed" by any
  // path now closes it outright, same as "minimized".
  useEffect(() => {
    if (sheetState === "minimized" || sheetState === "collapsed") onDismiss?.();
  }, [sheetState, onDismiss]);

  // The "blog" card — a single, always-crypto lead story with its own
  // mini timeline of the next couple of updates underneath it (the Yahoo
  // Finance "markets blog" layout this was asked to match), pulled out of
  // the flat list rather than just being items[0]/[1]/[2]: the full feed
  // is a mix of crypto/markets/geopolitics sorted purely by time, so the
  // newest item overall isn't reliably a crypto story.
  // Bitcoin stories first (titles that name Bitcoin/BTC), then other crypto.
  const cryptoItems = items.filter((i) => i.category === "crypto");
  const isBtc = (i: BriefItem) => /\bbitcoin\b|\bbtc\b/i.test(i.title);
  const btcFirst = [...cryptoItems.filter(isBtc), ...cryptoItems.filter((i) => !isBtc(i))];
  const featured = btcFirst[0];
  const timelineItems = featured ? btcFirst.slice(1, 3) : [];
  const pairItems = featured ? btcFirst.slice(3, 5) : [];
  const usedUrls = new Set([featured, ...timelineItems, ...pairItems].filter(Boolean).map((i) => i!.url));
  const latestItems = items.filter((item) => !usedUrls.has(item.url));

  // Re-searches only when the lead headline itself changes, not on a
  // timer — same "don't spend quota on an answer that can't have
  // changed" principle as Inside the Candle's AI cache.
  useEffect(() => {
    if (!featured) { setVideo(null); return; }
    let cancelled = false;
    fetchVideoForTitle(featured.title).then((v) => { if (!cancelled) setVideo(v); });
    return () => { cancelled = true; };
  }, [featured?.title]);

  // ── Yahoo Finance "daily brief" layout (phone sheet), Bitcoin-led ──────
  // Coin chips the way Yahoo shows tickers: symbol + live 24h change in
  // red/green, no pill. Only coins we have a live ticker for.
  const tickerChips = (title: string, lead?: string) => {
    const syms = extractChips(title).filter((s) => coinTickers?.has(s));
    if (lead && coinTickers?.has(lead) && !syms.includes(lead)) syms.unshift(lead);
    return syms.slice(0, 3).map((s) => {
      const tk = coinTickers!.get(s)!;
      const up = tk.change >= 0;
      return (
        <span key={s} className={`dby-tk${up ? " dby-tk--up" : " dby-tk--dn"}`}>
          {s} <b>{up ? "+" : ""}{tk.change.toFixed(2)}%</b>
        </span>
      );
    });
  };
  const thumb = (item: BriefItem, cls: string) => <NewsThumb key={item.url} item={item} className={cls} />;

  // "Your latest": bordered card — source • time, headline, chips, photo right.
  const renderRow = (item: BriefItem) => {
    const chips = tickerChips(item.title);
    return (
      <a
        key={item.url}
        data-db-flip={item.url}
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`dby-row${newUrls.has(item.url) ? " db-item--new" : ""}`}
        onClick={(e) => openNewsLink(e, item.url)}
      >
        <span className="dby-row-body">
          <span className="dby-meta">{item.source} • {timeAgo(item.pubDate, t)}</span>
          <span className="dby-row-title">{item.title}</span>
          {chips.length > 0 && <span className="dby-tks">{chips}</span>}
        </span>
        {thumb(item, "dby-row-thumb")}
      </a>
    );
  };
  const latestRows = latestItems.map((item) => renderRow(item));

  // Lead card: "coinhintz markets blog • LIVE", headline + photo, chips,
  // then a two-step timeline. With a matching video, the photo opens it.
  const featuredCard = featured && (
    <div className={`dby-lead${newUrls.has(featured.url) ? " db-item--new" : ""}`}>
      <div className="dby-blog">
        <span className="dby-blog-name"><span className="dby-blog-brand">coinhintz</span> {t("dailyBrief2.blog", "markets blog")}</span>
        <span className="dby-live"><i />{t("dailyBrief2.live", "LIVE")}</span>
      </div>
      <div className="dby-lead-main">
        <a href={featured.url} target="_blank" rel="noopener noreferrer" className="dby-lead-text" onClick={(e) => openNewsLink(e, featured.url)}>
          <span className="dby-lead-title">{featured.title}</span>
          <span className="dby-tks">{tickerChips(featured.title, "BTC")}</span>
        </a>
        {video ? (
          <button type="button" className="dby-lead-media" onClick={() => openExternalLink(`https://www.youtube.com/watch?v=${video.videoId}`)} aria-label={video.title}>
            {thumb(featured, "dby-lead-thumb")}
            <span className="dby-play">▶</span>
          </button>
        ) : (
          <a href={featured.url} target="_blank" rel="noopener noreferrer" className="dby-lead-media" onClick={(e) => openNewsLink(e, featured.url)}>
            {thumb(featured, "dby-lead-thumb")}
          </a>
        )}
      </div>
      {timelineItems.length > 0 && (
        <div className="dby-tl">
          {timelineItems.map((item) => (
            <a key={item.url} href={item.url} target="_blank" rel="noopener noreferrer" className="dby-tl-item" onClick={(e) => openNewsLink(e, item.url)}>
              <span className="dby-tl-dot" />
              <span className="dby-tl-time">{timeAgo(item.pubDate, t)}</span>
              <span className="dby-tl-title">{item.title}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );

  // BTC block + "Why BTC is moving".
  const btc = coinTickers?.get("BTC");
  const btcMove = btc ? Math.abs(btc.change) : 0;
  const coinBlock = btc && btc.price > 0 && (
    <>
      <div className="dby-coin">
        <div className="dby-coin-left">
          <span className="dby-coin-sym">BTC</span>
          <span className="dby-coin-px">
            {formatLivePrice(btc.price)}{" "}
            <b className={btc.change >= 0 ? "dby-up" : "dby-dn"}>{btc.change >= 0 ? "+" : ""}{btc.change.toFixed(2)}%</b>
          </span>
        </div>
        <span className="dby-coin-pill">
          {btcMove >= 3 ? t("dailyBrief2.bigMove", "Significant price movement")
            : btcMove >= 1 ? t("dailyBrief2.notableMove", "Notable price movement")
            : t("dailyBrief2.steady", "Steady today")}
        </span>
      </div>
      {featured && (
        <div className="dby-why">
          <span className="dby-why-icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor" /></svg>
          </span>
          <div className="dby-why-body">
            <span className="dby-why-title">{t("dailyBrief2.whyMoving", { coin: "BTC", defaultValue: "Why BTC is moving" })}</span>
            <span className="dby-why-text">
              {t(btc.change >= 0 ? "dailyBrief2.whyUp" : "dailyBrief2.whyDown", {
                name: "Bitcoin",
                pct: Math.abs(btc.change).toFixed(2),
                price: formatLivePrice(btc.price),
                headline: featured.title,
              })}
            </span>
            <span className="dby-why-foot">
              <span>{updatedAt !== null ? t("dailyBrief2.updated", { ago: timeAgo(updatedAt, t) }) : ""}</span>
              <a href={featured.url} target="_blank" rel="noopener noreferrer" onClick={(e) => openNewsLink(e, featured.url)}>{t("dailyBrief2.viewMore", "View more")}</a>
            </span>
          </div>
        </div>
      )}
    </>
  );

  // Two side-by-side cards: photo on top, source • time, headline, chips.
  const pairCards = pairItems.length === 2 && (
    <div className="dby-pair">
      {pairItems.map((item) => (
        <a key={item.url} href={item.url} target="_blank" rel="noopener noreferrer" className="dby-tile" onClick={(e) => openNewsLink(e, item.url)}>
          {thumb(item, "dby-tile-img")}
          <span className="dby-tile-body">
            <span className="dby-meta">{item.source} • {timeAgo(item.pubDate, t)}</span>
            <span className="dby-tile-title">{item.title}</span>
            <span className="dby-tks">{tickerChips(item.title)}</span>
          </span>
        </a>
      ))}
    </div>
  );

  if (variant === "page") {
    if (items.length === 0) return null;

    // Yahoo Finance-style section layout: one big hero lead story, then
    // labeled topic sections (first item of each shown with its own
    // thumbnail, the rest as compact text rows) — stacked, not literal
    // side-by-side columns, since .db-page is still a sidebar next to
    // the chart, not a full page width. "Earnings" isn't a real section
    // here (no earnings data source) — these are the app's own actual
    // categories instead.
    const heroChips = featured ? extractChips(featured.title) : [];
    const topStories = cryptoItems.slice(1, 6);
    const marketsItems = items.filter((i) => i.category === "markets").slice(0, 5);
    const geoItems = items.filter((i) => i.category === "geopolitics").slice(0, 5);
    const sections: { label: string; category: Category; rows: BriefItem[] }[] = [
      { label: t("dailyBrief.sectionTopStories", "Top Stories"), category: "crypto" as const, rows: topStories },
      { label: t("dailyBrief.sectionMarkets", "Markets & Economy"), category: "markets" as const, rows: marketsItems },
      { label: t("dailyBrief.sectionGeopolitics", "Geopolitics"), category: "geopolitics" as const, rows: geoItems },
    ].filter((s) => s.rows.length > 0);

    const renderSectionRow = (item: BriefItem, withThumb: boolean) => {
      const chips = extractChips(item.title);
      return (
        <a
          key={item.url}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`db-section-row${withThumb ? " db-section-row--lead" : ""}${newUrls.has(item.url) ? " db-item--new" : ""}`}
          onClick={(e) => openNewsLink(e, item.url)}
        >
          {withThumb && (
            item.thumbnail ? (
              <img className="db-section-row-thumb" src={item.thumbnail} alt="" loading="lazy" />
            ) : (
              <ThumbPlaceholder className="db-section-row-thumb" category={item.category} />
            )
          )}
          <span className="db-section-row-title">{item.title}</span>
          <span className="db-list-meta">
            <span className={`db-cat-dot db-cat-dot--${item.category}`} />
            {item.source} <span className="db-list-dot">•</span> {timeAgo(item.pubDate, t)}
          </span>
          {chips.length > 0 && (
            <span className="db-list-chips">{chips.map((c) => renderChip(c, item.category, coinTickers))}</span>
          )}
        </a>
      );
    };

    return (
      <aside className="db-page">
        <div className="db-page-head">
          <span className="db-page-head-left">
            {/* Plain title (the 1/2/3 column picker was removed). */}
            <span className="db-head-title db-head-title-static">
              <span>{t("dailyBrief.title")}</span>
            </span>
          </span>
          {/* Just when it was last updated — no LIVE badge or heartbeat. */}
          {updatedAt !== null && (
            <span className="db-live">
              <span className="db-live-updated">
                {t("dailyBrief.lastUpdated", "Updated")} {timeAgo(updatedAt, t)}
              </span>
            </span>
          )}
        </div>
        <div className="db-page-list">
          {featured && (
            <a
              href={featured.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`db-hero${newUrls.has(featured.url) ? " db-item--new" : ""}`}
              onClick={(e) => openNewsLink(e, featured.url)}
            >
              {featured.thumbnail ? (
                <img className="db-hero-thumb" src={featured.thumbnail} alt="" loading="lazy" />
              ) : (
                <ThumbPlaceholder className="db-hero-thumb" category={featured.category} />
              )}
              <span className="db-hero-title">{featured.title}</span>
              <span className="db-list-meta db-hero-meta">
                <span className={`db-cat-dot db-cat-dot--${featured.category}`} />
                {featured.source} <span className="db-list-dot">•</span> {timeAgo(featured.pubDate, t)}
              </span>
              {heroChips.length > 0 && (
                <span className="db-list-chips">{heroChips.map((c) => renderChip(c, featured.category, coinTickers))}</span>
              )}
            </a>
          )}
          <div className={`db-sections-grid db-sections-grid--cols-${sectionCols}`}>
            {sections.map((section) => (
              <div key={section.category} className="db-section">
                <div className="db-section-head">
                  <span className={`db-cat-dot db-cat-dot--${section.category}`} />
                  {section.label}
                </div>
                {renderSectionRow(section.rows[0], true)}
                {section.rows.slice(1).map((item) => renderSectionRow(item, false))}
              </div>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  // Hidden only once the brief has genuinely come back empty; while it's
  // still loading the sheet shows placeholder rows.
  if (chatActive || (items.length === 0 && briefDone)) return null;
  const briefLoading = items.length === 0;

  // Phones: the app's shared BottomSheet (same drag, pull-up-to-full and
  // ✕ as every other sheet) — replaces the old hand-built drag sheet.
  // Closing it ("minimized") fires onDismiss, which unmounts the brief.
  return (
    <BottomSheet
      open={sheetState !== "minimized" && sheetState !== "collapsed"}
      onClose={() => setSheetState("minimized")}
      title={<>{t("dailyBrief.title")}</>}
      ariaLabel={t("dailyBrief.title")}
      className="db-bsheet"
    >
        {/* .db-sheet keeps the brief's content styles; --in-bs switches off
            the old sheet's own position/size (DailyBrief.css). */}
        <div className="db-sheet db-sheet--in-bs">
          <div className="db-card">
            {briefLoading ? (
              <div className="db-skel" aria-busy="true" aria-label={t("dailyBrief2.loadingBrief")}>
                <span className="db-skel-hero" />
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className="db-skel-row" style={{ animationDelay: `${i * 0.1}s` }}>
                    <span className="db-skel-thumb" />
                    <span className="db-skel-lines"><i /><i /></span>
                  </span>
                ))}
              </div>
            ) : (
            <div className="dby">
              {featuredCard}
              {coinBlock}
              {pairCards}
              {latestRows.length > 0 && <h3 className="dby-h">{t("dailyBrief2.yourLatest", "Your latest")}</h3>}
              <div ref={listRowsRef} className="dby-rows">
                {latestRows}
              </div>
            </div>
            )}
          </div>
        </div>
    </BottomSheet>
  );
};
