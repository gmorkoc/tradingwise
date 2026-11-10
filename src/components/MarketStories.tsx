// Markets page (desktop): a Coinbase-style horizontal carousel that replaces
// the Daily Brief column. Three kinds of panels:
//   • odds — a live Polymarket prediction (outcome lines + volume), paired
//     with a matching news story (photo + summary)
//   • news — a Daily Brief story with its photo
//   • coin — a top mover: logo, price, 24h change, 7d sparkline, volume
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { useTranslation } from "react-i18next";
import { fetchBrief, extractChips, renderChip, type BriefItem } from "./DailyBrief";
import type { Ticker24h } from "../services/coinglass";
import { getMarkets, requestSparklines, useSparklines, withSparklines } from "../services/marketData";
import "../styles/MarketStories.css";

type Outcome = { label: string; prob: number; color: string; history: number[] };
type OddsEvent = { eyebrow: string; title: string; url: string; volume: number; outcomes: Outcome[]; match: RegExp };
type CgCoin = {
  id: string; symbol: string; name: string; image: string; market_cap_rank: number;
  current_price: number; price_change_percentage_24h: number | null; total_volume: number;
  sparkline_in_7d?: { price: number[] };
};

// Top-100 coins (no stablecoins), biggest 24h gainer first.
const sortedMovers = (coins: CgCoin[]) =>
  coins
    .filter((c) => c.market_cap_rank && c.market_cap_rank <= 100 && c.price_change_percentage_24h != null && !/usd|dai/i.test(c.symbol))
    .sort((x, y) => (y.price_change_percentage_24h ?? 0) - (x.price_change_percentage_24h ?? 0));

const LINE_COLORS = ["#3dbf84", "#2a4fd6", "#e8742c"];

// Which Polymarket events to show: the biggest macro (Fed) question and the
// biggest crypto one, each with a pattern to find a matching news story.
const ODDS_SOURCES = [
  // eyebrow = translation key under marketStories.eyebrow
  { tag: "fed-rates", eyebrow: "usFed", match: /\b(fed|fomc|powell)\b|\brate (cut|hike)|\binterest rates?\b/i },
  { tag: "crypto", eyebrow: "cryptoOdds", match: /\b(bitcoin|btc)\b/i },
];

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

async function loadOdds(): Promise<OddsEvent[]> {
  const out: OddsEvent[] = [];
  for (const src of ODDS_SOURCES) {
    try {
      const evs = await (await fetch(`${GAMMA}/events?tag_slug=${src.tag}&active=true&closed=false&order=volume24hr&ascending=false&limit=10`)).json();
      // Skip markets that end within 3 days — too little history to chart.
      const ev = (evs ?? []).find((e: { endDate?: string; markets?: unknown[] }) =>
        e.markets?.length && (!e.endDate || Date.parse(e.endDate) - Date.now() > 3 * 86_400_000));
      if (!ev?.markets?.length) continue;
      type M = { groupItemTitle?: string; outcomePrices?: string; clobTokenIds?: string; closed?: boolean; active?: boolean };
      const open = (ev.markets as M[])
        .filter((m) => m.active && !m.closed && m.outcomePrices && m.clobTokenIds)
        .map((m) => ({ label: m.groupItemTitle || "Yes", prob: parseFloat(JSON.parse(m.outcomePrices!)[0]), token: JSON.parse(m.clobTokenIds!)[0] as string }))
        .sort((a, b) => b.prob - a.prob)
        .slice(0, 3);
      if (!open.length) continue;
      const outcomes = await Promise.all(open.map(async (o, i) => {
        let history: number[] = [];
        try {
          const h = await (await fetch(`${CLOB}/prices-history?market=${o.token}&interval=1m&fidelity=60`)).json();
          history = (h?.history ?? []).map((p: { p: number }) => p.p);
        } catch { /* keep the current price only */ }
        if (history.length < 2) history = [o.prob, o.prob];
        history[history.length - 1] = o.prob;
        return { label: o.label, prob: o.prob, color: LINE_COLORS[i], history };
      }));
      out.push({ eyebrow: src.eyebrow, title: ev.title, url: `https://polymarket.com/event/${ev.slug}`, volume: Number(ev.volume) || 0, outcomes, match: src.match });
    } catch { /* skip this source */ }
  }
  return out;
}

const openLink = (url: string) => {
  if (Capacitor.isNativePlatform()) Browser.open({ url });
  else window.open(url, "_blank", "noopener,noreferrer");
};
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
// Time on each card before auto-play moves on — long enough to read.
const AUTO_MS = 10000;
const ago = (ts: number, t: (key: string, opts?: Record<string, unknown>) => string) => {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60_000));
  return m < 60 ? t("marketStories.ago.m", { n: m }) : m < 1440 ? t("marketStories.ago.h", { n: Math.round(m / 60) }) : t("marketStories.ago.d", { n: Math.round(m / 1440) });
};const price = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: n >= 1 ? 2 : 4, maximumFractionDigits: n >= 1 ? 3 : 6 })}`;

// ── Pieces ────────────────────────────────────────────────────────────────────
// Covers for stories with no photo: a gradient picked from the story's
// category + title (so neighbours differ), with the source's initials.
const COVERS: Record<BriefItem["category"], [string, string][]> = {
  crypto: [["#f59e0b", "#7c2d12"], ["#f97316", "#4c1d95"], ["#eab308", "#9a3412"], ["#fb923c", "#1e1b4b"]],
  markets: [["#38bdf8", "#1e3a8a"], ["#22d3ee", "#134e4a"], ["#60a5fa", "#312e81"], ["#34d399", "#0f172a"]],
  geopolitics: [["#a78bfa", "#1e1b4b"], ["#c084fc", "#3b0764"], ["#818cf8", "#0f172a"], ["#f472b6", "#312e81"]],
};
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
function GenericCover({ item }: { item: BriefItem }) {
  const set = COVERS[item.category] ?? COVERS.crypto;
  const [a, b] = set[hash(item.title) % set.length];
  const angle = 110 + (hash(item.url) % 70);
  const initials = item.source.replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <span className="mkst-cover" style={{ background: `radial-gradient(120% 90% at 85% 10%, ${a}cc, transparent 60%), linear-gradient(${angle}deg, ${b}, ${a})` }}>
      <span className="mkst-cover-mark">{initials}</span>
    </span>
  );
}

// The whole panel is the click target (see `open` in the panel list). A
// story paired with an odds chart opens its own article instead (`own`).
function NewsBlock({ item, own, tickers }: { item: BriefItem; own?: boolean; tickers?: Map<string, Ticker24h> }) {
  // Same chips as the Daily Brief: a live price for coins it mentions,
  // topic tags (CPI, FED, ETF…) for the rest.
  const { t } = useTranslation();
  const chips = extractChips(item.title);
  const [broken, setBroken] = useState(false);
  return (
    <div className="mkst-news" onClick={own ? (e) => { e.stopPropagation(); openLink(item.url); } : undefined}>
      <span className="mkst-news-img">
        {item.thumbnail && !broken
          ? <img src={item.thumbnail} alt="" loading="lazy" onError={() => setBroken(true)} />
          : <GenericCover item={item} />}
      </span>
      <div className="mkst-news-meta">
        <i className={`mkst-cat mkst-cat--${item.category}`} />
        {item.source}<span>·</span>{ago(item.pubDate, t)}
      </div>
      <p className="mkst-news-text">{item.title}</p>
      {chips.length > 0 && (
        <div className="mkst-chips">{chips.map((c) => renderChip(c, item.category, tickers))}</div>
      )}
      <span className="mkst-more">
        {t("marketStories.readMore")}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </span>
    </div>
  );
}

function OddsBlock({ ev }: { ev: OddsEvent }) {
  const { t } = useTranslation();
  // Lines on a 0–100% scale, stretched to the box; end dots placed in % so
  // they stay round.
  const W = 100, H = 100;
  const lines = ev.outcomes.map((o) => {
    const n = o.history.length;
    const pts = o.history.map((p, i) => `${((i / (n - 1)) * W).toFixed(2)},${((1 - p) * H).toFixed(2)}`);
    return { ...o, d: `M${pts.join("L")}` };
  });
  return (
    <div className="mkst-odds">
      <div className="mkst-eyebrow">{t(`marketStories.eyebrow.${ev.eyebrow}`, ev.eyebrow)}<span className="mkst-live"><i />{t("marketStories.live")}</span></div>
      <div className="mkst-title">{ev.title}</div>
      <div className="mkst-legend">
        {ev.outcomes.map((o) => (
          <span key={o.label} className="mkst-legend-item">
            <i style={{ background: o.color }} />
            {o.label === "Yes" ? t("marketStories.yes") : o.label} <b>{Math.round(o.prob * 100)}%</b>
          </span>
        ))}
      </div>
      <div className="mkst-chart">
        <div className="mkst-plot">
          <span className="mkst-grid" style={{ top: "0%" }} />
          <span className="mkst-grid" style={{ top: "50%" }} />
          <span className="mkst-grid" style={{ top: "100%" }} />
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {lines.map((l) => (
              <path key={l.label} className="mkst-draw" pathLength={1} d={l.d} fill="none" stroke={l.color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            ))}
          </svg>
          {lines.map((l) => (
            <span key={l.label} className="mkst-enddot" style={{ top: `${(1 - l.prob) * 100}%`, color: l.color }} />
          ))}
        </div>
        <div className="mkst-axis"><span>100%</span><span>50%</span><span>0%</span></div>
      </div>
      <div className="mkst-foot">{t("marketStories.volume", { value: usd(ev.volume) })}</div>
    </div>
  );
}

// eyebrow = translation key under marketStories.movers
function CoinBlock({ coin, eyebrow }: { coin: CgCoin; eyebrow: string }) {
  const { t } = useTranslation();
  const pct = coin.price_change_percentage_24h ?? 0;
  const up = pct >= 0;
  const series = coin.sparkline_in_7d?.price ?? [];
  const { d, area, lastY } = useMemo(() => {
    if (series.length < 2) return { d: "", area: "", lastY: null as number | null };
    const lo = Math.min(...series), hi = Math.max(...series), span = hi - lo || 1;
    const y = (p: number) => 8 + (1 - (p - lo) / span) * 84;
    const pts = series.map((p, i) => `${((i / (series.length - 1)) * 100).toFixed(2)},${y(p).toFixed(2)}`);
    const line = `M${pts.join("L")}`;
    return { d: line, area: `${line}L100,100L0,100Z`, lastY: y(series[series.length - 1]) };
  }, [series]);
  const color = up ? "#16a34a" : "#e5484d";
  return (
    <div className={`mkst-coin mkst-coin--${up ? "up" : "down"}`}>
      <div className="mkst-eyebrow">{t(`marketStories.movers.${eyebrow}`, eyebrow)}</div>
      <div className="mkst-coin-head">
        <img src={coin.image} alt="" />
        <span className="mkst-coin-sym">{coin.symbol.toUpperCase()}</span>
        <span className="mkst-coin-name">{coin.name}</span>
        <span className="mkst-coin-rank">#{coin.market_cap_rank}</span>
      </div>
      <div className="mkst-coin-price">
        {price(coin.current_price)}
        <span style={{ color }}>{up ? "+" : ""}{pct.toFixed(2)}% 1D</span>
      </div>
      <div className="mkst-chart mkst-chart--coin">
        <div className="mkst-plot">
          <span className="mkst-grid" style={{ top: "0%" }} />
          <span className="mkst-grid" style={{ top: "50%" }} />
          <span className="mkst-grid" style={{ top: "100%" }} />
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id={`mkst-g-${coin.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.18" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path className="mkst-area" d={area} fill={`url(#mkst-g-${coin.id})`} />
            <path className="mkst-draw" pathLength={1} d={d} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
          {lastY != null && <span className="mkst-enddot" style={{ top: `${lastY}%`, color }} />}
        </div>
      </div>
      <div className="mkst-foot">{t("marketStories.volume24h", { value: usd(coin.total_volume) })}</div>
    </div>
  );
}

// ── Carousel ──────────────────────────────────────────────────────────────────
export function MarketStories({ onSelectCoin, coinTickers }: { onSelectCoin: (symbol: string) => void; coinTickers?: Map<string, Ticker24h> }) {
  const { t } = useTranslation();
  const [news, setNews] = useState<BriefItem[]>([]);
  // The first news fetch has finished (or timed out) — until then the
  // placeholders stay, so cards don't arrive in two waves.
  const [newsDone, setNewsDone] = useState(false);
  const [odds, setOdds] = useState<OddsEvent[]>([]);
  const [coins, setCoins] = useState<CgCoin[]>([]);
  const sparkVersion = useSparklines();
  const trackRef = useRef<HTMLDivElement>(null);
  // Phones (≤960px): swipe, one card at a time, odds and story split.
  const [isPhone, setIsPhone] = useState(() => window.matchMedia("(max-width: 960px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 960px)");
    const on = () => setIsPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    let alive = true;
    // Every Daily Brief story (newest first), refreshed like the brief.
    const loadNews = () => fetchBrief()
      .then((b) => { if (alive && b.length) setNews(b); })
      .catch(() => {})
      .finally(() => { if (alive) setNewsDone(true); });
    // Never hold the placeholders forever if the news is slow.
    const giveUp = window.setTimeout(() => { if (alive) setNewsDone(true); }, 8000);
    // No Polymarket odds in the iOS app: they link to real-money betting
    // markets, which App Review treats as gambling (guideline 5.3).
    const loadOddsNow = () => {
      if (Capacitor.isNativePlatform()) return;
      loadOdds().then((o) => { if (alive && o.length) setOdds(o); }).catch(() => {});
    };
    const loadCoins = () => getMarkets().then((c) => {
      if (!alive || !Array.isArray(c)) return;
      setCoins(c);
      // 7-day sparklines for the movers these panels can show.
      const s = sortedMovers(c);
      requestSparklines([...s.slice(0, 21), ...s.slice(-21)]);
    }).catch(() => {});
    loadNews(); loadOddsNow(); loadCoins();
    const a = window.setInterval(loadNews, 10 * 60_000);
    const b = window.setInterval(loadOddsNow, 5 * 60_000);
    const c = window.setInterval(loadCoins, 2 * 60_000);
    return () => { alive = false; window.clearInterval(a); window.clearInterval(b); window.clearInterval(c); window.clearTimeout(giveUp); };
  }, []);

  // Build the panel order: news · odds+story · gainer · news · odds+story · loser · rest of the news.
  const panels = useMemo(() => {
    const used = new Set<string>();
    // Stories with no photo of their own show the generic category cover.
    const generic = (n: BriefItem) => !n.thumbnail;
    const take = (re?: RegExp) => {
      // A matching story only — an odds panel with no related news stands alone.
      // The opening stories prefer ones with real photos.
      const hit = news.find((n) => !used.has(n.url) && (!re || re.test(n.title)) && (re || !generic(n)))
        ?? news.find((n) => !used.has(n.url) && (!re || re.test(n.title)));
      if (hit) used.add(hit.url);
      return hit;
    };
    const sorted = withSparklines(sortedMovers(coins));
    const gainer = sorted[0], loser = sorted[sorted.length - 1];
    // More movers to sprinkle between the remaining stories:
    // 2nd gainer, 2nd loser, 3rd gainer, 3rd loser…
    const extraMovers: { coin: CgCoin; label: string }[] = [];
    for (let i = 1; i < 21; i++) {
      const g = sorted[i], l = sorted[sorted.length - 1 - i];
      if (g && (g.price_change_percentage_24h ?? 0) > 0) extraMovers.push({ coin: g, label: "gainer" });
      if (l && l !== g && (l.price_change_percentage_24h ?? 0) < 0) extraMovers.push({ coin: l, label: "loser" });
    }
    // `open` = what clicking anywhere on the panel does.
    const list: { key: string; el: React.ReactNode; size?: "wide" | "odds"; open: () => void }[] = [];
    const pushNews = (n: BriefItem) => list.push({ key: `n:${n.url}`, el: <NewsBlock item={n} tickers={coinTickers} />, open: () => openLink(n.url) });
    const pushCoin = (c: CgCoin, label: string) =>
      list.push({ key: `c:${c.id}`, el: <CoinBlock coin={c} eyebrow={label} />, open: () => onSelectCoin(c.symbol.toUpperCase()) });
    // Odds stories pick their matching news first so the generic ones don't take it.
    const oddsStories = odds.map((ev) => ({ ev, story: take(ev.match) }));
    const lead = take();
    if (lead) pushNews(lead);
    const pushOdds = (i: number) => {
      const o = oddsStories[i];
      if (!o) return;
      // Every card is the same width (so the centred card leaves equal
      // peeks on both sides): the odds card, then its matching story as
      // the next card.
      list.push({
        key: `o:${o.ev.url}`,
        el: <OddsBlock ev={o.ev} />,
        open: () => openLink(o.ev.url),
      });
      if (o.story) pushNews(o.story);
    };
    pushOdds(0);
    if (gainer) pushCoin(gainer, "topGainer");
    const second = take();
    if (second) pushNews(second);
    pushOdds(1);
    if (loser && loser !== gainer) pushCoin(loser, "topLoser");
    // Then every remaining story, each followed by a mover card.
    // Generic-cover stories are spread evenly between the ones with photos
    // (never two side by side); any extras get a mover card between them.
    const rest = news.filter((x) => !used.has(x.url));
    const photos = rest.filter((x) => !generic(x));
    const covers = rest.filter(generic);
    const ordered: BriefItem[] = [];
    let ci = 0;
    photos.forEach((p, i) => {
      ordered.push(p);
      if (ci < covers.length && i + 1 >= Math.round(((ci + 1) * photos.length) / (covers.length + 1))) ordered.push(covers[ci++]);
    });
    const leftover = covers.slice(ci);
    // If the movers run out, the remaining stories are left out rather
    // than shown side by side.
    // Never two stories side by side: a mover goes between every pair.
    let run = 0;
    for (const n of ordered) {
      if (run >= 1) {
        const m = extraMovers.shift();
        if (!m) break;
        pushCoin(m.coin, m.label);
        run = 0;
      }
      pushNews(n);
      run++;
    }
    // Extra covers each get a mover in front (never two covers together).
    for (const n of leftover) {
      const m = extraMovers.shift();
      if (!m) break;
      pushCoin(m.coin, m.label);
      pushNews(n);
      run = 1;
    }
    // The loop wraps back to the opening story — don't end on a story.
    if (run >= 1 && extraMovers.length) {
      const m = extraMovers.shift()!;
      pushCoin(m.coin, m.label);
    }
    return list;
  }, [news, odds, coins, onSelectCoin, isPhone, coinTickers, sparkVersion]);

  // Endless loop: the panels are rendered three times and the track sits on
  // the middle copy; once scrolling settles in an outer copy it jumps back
  // by exactly one copy's width (identical content, so it's invisible).
  // One copy's exact width = distance between the first card of copy 1
  // and the first card of copy 2 (gaps included, padding excluded).
  const setWidth = () => {
    const el = trackRef.current;
    const a = el?.children[0] as HTMLElement | undefined;
    const b = el?.children[panels.length] as HTMLElement | undefined;
    return a && b ? b.offsetLeft - a.offsetLeft : 0;
  };
  // How far the "current" card sits from the track's left edge: it's
  // centred (desktop and phones), so the neighbours peek in equally.
  const edgeOffset = () => {
    const el = trackRef.current;
    if (!el) return 0;
    const cw = (el.children[0] as HTMLElement | undefined)?.offsetWidth ?? 0;
    return Math.max(0, (el.clientWidth - cw) / 2);
  };
  useLayoutEffect(() => {
    const el = trackRef.current;
    // Desktop: the last item of the previous copy peeks in (faded); phones:
    // the first card centred with both neighbours peeking.
    if (el && panels.length) el.scrollLeft = setWidth() - edgeOffset();
  }, [panels.length, isPhone]);
  const settleTimer = useRef<number>();
  const onScroll = () => {
    if (auto) updateDot();
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const el = trackRef.current;
      const w = setWidth();
      if (!el || !w) return;
      if (el.scrollLeft < w * 0.5) el.scrollLeft += w;
      else if (el.scrollLeft > w * 1.5) el.scrollLeft -= w;
    }, 140);
  };
  // Phones: one card (+ gap) per step; desktop: ¾ of the visible width.
  const pageW = () => {
    const el = trackRef.current;
    if (!el) return 0;
    if (isPhone) return ((el.children[0] as HTMLElement | undefined)?.offsetWidth ?? 0) + 10;
    return el.clientWidth * 0.75;
  };
  const scroll = (dir: 1 | -1) => {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: dir * pageW(), behavior: "smooth" });
  };

  // Auto-play toggle (remembered on this device). On: advances one step
  // every AUTO_MS, paused while hovered, with position dots underneath.
  const [autoPick, setAuto] = useState(() => { try { return localStorage.getItem("mkst-auto") === "1"; } catch { return false; } });
  // Phones: always auto-playing (no switch). Desktop: the viewer's choice.
  const auto = isPhone || autoPick;
  const [hovered, setHovered] = useState(false);
  const [dot, setDot] = useState({ i: 0, n: 0 });
  const toggleAuto = () => setAuto((v) => {
    try { localStorage.setItem("mkst-auto", v ? "0" : "1"); } catch { /* ignore */ }
    return !v;
  });
  // Which "page" of one copy is showing (copies repeat, so modulo a copy).
  const updateDot = () => {
    const el = trackRef.current;
    const w = setWidth(), pw = pageW();
    const first = (el?.children[0] as HTMLElement | undefined)?.offsetLeft ?? 0;
    if (!el || !w || !pw) return;
    const n = Math.max(1, Math.ceil(w / pw));
    // + the desktop peek (the previous card shows 140px on the left).
    const pos = (((el.scrollLeft + edgeOffset() - first - w) % w) + w) % w;
    const i = Math.round(pos / pw) % n;
    setDot((d) => (d.i === i && d.n === n ? d : { i, n }));
  };
  const goDot = (i: number) => {
    const el = trackRef.current;
    const first = (el?.children[0] as HTMLElement | undefined)?.offsetLeft ?? 0;
    if (el) el.scrollTo({ left: first + setWidth() + i * pageW() - edgeOffset(), behavior: "smooth" });
  };
  useEffect(() => {
    // Hover-pause is desktop only (a tap on a phone counts as "hover" and
    // would never clear).
    if (!auto || (hovered && !isPhone)) return;
    const id = window.setInterval(() => { if (!document.hidden) scroll(1); }, AUTO_MS);
    return () => window.clearInterval(id);
  }, [auto, hovered, isPhone]);
  useEffect(() => { if (auto) requestAnimationFrame(updateDot); }, [auto, panels.length, isPhone]);

  if (!panels.length || !newsDone) {
    return (
      <section className="mkst mkst--loading" aria-busy="true">
        <div className="mkst-track">
          {[0, 1, 2].map((i) => <div key={i} className="mkst-panel"><div className="mkst-skel" /></div>)}
        </div>
      </section>
    );
  }

  return (
    <div className="mkst-wrap">
    <section
      className="mkst"
      aria-label={t("marketStories.ariaStories")}
      // Hover-pause is desktop only; on phones a tap fires these too and
      // would re-render the whole carousel for nothing.
      onMouseEnter={isPhone ? undefined : () => setHovered(true)}
      onMouseLeave={isPhone ? undefined : () => setHovered(false)}
    >
      <div className="mkst-track" ref={trackRef} onScroll={onScroll}>
        {[0, 1, 2].flatMap((copy) => panels.map((p, i) => (
          <div
            key={`${copy}:${p.key}`}
            className={`mkst-panel${p.size ? ` mkst-panel--${p.size}` : ""}`}
            style={{ animationDelay: `${Math.min(i, 6) * 70}ms` }}
            aria-hidden={copy !== 1 || undefined}
            role="link"
            tabIndex={copy === 1 ? 0 : -1}
            onClick={p.open}
            onKeyDown={(e) => { if (e.key === "Enter") p.open(); }}
          >
            {p.el}
          </div>
        )))}
      </div>
      <button type="button" className="mkst-arrow mkst-arrow--prev" onClick={() => scroll(-1)} aria-label={t("marketStories.previous")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <button type="button" className="mkst-arrow mkst-arrow--next" onClick={() => scroll(1)} aria-label={t("marketStories.next")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </section>
    {/* Under the carousel: position dots (auto-play on) · Auto-play switch. */}
    <div className={`mkst-ctrl${isPhone ? " mkst-ctrl--phone" : ""}`}>
      {auto && dot.n > 1 ? (
        <div className="mkst-dots" role="tablist" aria-label={t("marketStories.carouselPosition")}>
          {/* At most 7 dots: a window that follows the current position
              (it loops, so it wraps); the outer ones shrink. */}
          {Array.from({ length: Math.min(7, dot.n) }, (_, k) => {
            const span = Math.min(7, dot.n);
            const off = k - Math.floor(span / 2);
            const i = (((dot.i + off) % dot.n) + dot.n) % dot.n;
            const edge = span >= 7 ? Math.abs(off) : 0;
            return (
              <button
                key={`${k}:${i}`}
                type="button"
                role="tab"
                aria-selected={i === dot.i}
                aria-label={t("marketStories.goTo", { n: i + 1, total: dot.n })}
                className={`mkst-dot${i === dot.i ? " mkst-dot--on" : ""}${i === dot.i && (!hovered || isPhone) ? " mkst-dot--run" : ""}${edge === 3 ? " mkst-dot--xs" : edge === 2 ? " mkst-dot--sm" : ""}`}
                style={{ ["--mkst-auto" as string]: `${AUTO_MS}ms` }}
                onClick={() => goDot(i)}
              />
            );
          })}
        </div>
      ) : <span />}
      {/* Desktop only — phones always auto-play. */}
      {!isPhone && (
        <button type="button" className={`mkst-auto${auto ? " mkst-auto--on" : ""}`} role="switch" aria-checked={auto} onClick={toggleAuto}>
          {t("marketStories.autoPlay")}
          <span className="mkst-auto-sw" aria-hidden="true"><i /></span>
        </button>
      )}
    </div>
    </div>
  );
}
