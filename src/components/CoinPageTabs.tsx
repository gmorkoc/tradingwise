// Trade page (#trade) section tabs under the coin header, TradingView-style:
// Overview (the chart page itself) · News · Technicals · Seasonals ·
// Markets · Fundamentals. Everything except Overview
// renders its own panel in place of the chart (the chart stays mounted).
import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import i18n from "../i18n";
import { coinglass, fetchBn, COINS, type CandleDataPoint } from "../services/coinglass";
import { calcEMA, calcRSIArray, calcBB, calcATR } from "../services/indicators";
import { fetchBrief, type BriefItem } from "./DailyBrief";
import { BottomSheet } from "./BottomSheet";
import { getExchangeMarkets, getCoinDetails, usePaprikaShown, type ExchangeMarket, type CoinDetails } from "../services/marketData";
import "../styles/CoinPageTabs.css";

// Exchange pairs and fundamentals come from services/marketData.ts —
// CoinGecko first, CoinPaprika then CoinLore if it fails — cached on the
// device (the last good copy is shown when every source is busy). The tabs
// below keep their loader and retry every 30s if nothing loads at all.

// CoinPaprika's free tier requires a credit — shown under a tab only while
// its data is the one on screen.
function PaprikaCredit({ keyPrefix }: { keyPrefix: string }) {
  const { t } = useTranslation();
  return usePaprikaShown([keyPrefix]) ? <span className="cpt-stat-sub">{t("globalMarkets.dataCoinPaprika")}</span> : null;
}

export type CoinPageTab = "overview" | "news" | "technicals" | "seasonals" | "markets" | "fundamentals";

export const COIN_PAGE_TABS: { id: CoinPageTab; label: string }[] = [
  { id: "overview", label: "Chart" },
  { id: "news", label: "News" },
  { id: "technicals", label: "Technicals" },
  { id: "seasonals", label: "Seasonals" },
  { id: "markets", label: "Markets" },
  { id: "fundamentals", label: "Fundamentals" },
];

const coinName = (sym: string) => COINS.find((c) => c.symbol === sym)?.name ?? sym;

const fmtUsd = (v: number | null | undefined, digits = 2): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: a < 1 ? 6 : digits })}`;
};
const fmtNum = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
};

// Desktop tab bar: the phone's "More" sections, in page order — minus
// Statistics, which desktop always shows in its side column.
// "stats" (Statistics) only exists on iPad 13" portrait-width screens, where
// the left coin-info column is moved into a section under the chart.
export type DeskTab = CoinPageTab | "stats" | "cycles" | "traders";
export const DESK_ANCHORS = ["stats", "cycles", "news", "technicals", "seasonals", "markets", "fundamentals", "traders"] as const;
const DESK_TABS: { id: DeskTab; label: string }[] = [
  { id: "overview", label: "Chart" },
  { id: "stats", label: "Statistics" },
  { id: "cycles", label: "Market Cycles" },
  ...COIN_PAGE_TABS.filter((t) => t.id !== "overview"),
  { id: "traders", label: "Top Traders" },
];

// ── Tab bar ─────────────────────────────────────────────────────────────
export function CoinPageTabBar({ tab, onChange, onProVision, proVisionOn, hasCycles, hasStats }: {
  tab: DeskTab;
  onChange: (t: DeskTab) => void;
  /** Desktop: a "ProVision" toggle after Chart — draws it on this chart. */
  onProVision?: () => void;
  proVisionOn?: boolean;
  /** Market Cycles only exists for Bitcoin. */
  hasCycles?: boolean;
  /** Statistics tab: only when the coin-info column is shown as a section. */
  hasStats?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="cpt-bar" role="tablist" aria-label={t("coinTabs.coinSections")}>
      {DESK_TABS.filter((tb) => (tb.id !== "cycles" || hasCycles) && (tb.id !== "stats" || hasStats)).map((tb) => (
        <Fragment key={tb.id}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === tb.id}
            className={`cpt-tab${tab === tb.id ? " cpt-tab--active" : ""}`}
            onClick={() => onChange(tb.id)}
          >
            {t(`coinTabs.tabs.${tb.id}`)}
          </button>
          {/* ProVision right after Chart: it's the chart's analysis layer. */}
          {tb.id === "overview" && onProVision && (
            <button
              type="button"
              className={`cpt-tab cpt-tab--pv${proVisionOn ? " cpt-tab--pv-on" : ""}`}
              aria-pressed={!!proVisionOn}
              title={proVisionOn ? t("coinTabs.proVisionOff") : t("coinTabs.proVisionOn")}
              onClick={onProVision}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
              ProVision
              <span className="cpt-pv-switch" aria-hidden="true"><i /></span>
            </button>
          )}
        </Fragment>
      ))}
    </div>
  );
}

const SECTION_META: Record<CoinPageTab, { sub: string; icon: React.ReactNode }> = {
  overview: { sub: "Live chart, stats and ProVision", icon: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></> },
  news: { sub: "Latest headlines for this coin", icon: <><path d="M4 22h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" /><path d="M10 6h6M10 10h6M10 14h4" /></> },
  technicals: { sub: "Buy/sell read from oscillators & averages", icon: <><path d="M12 20a8 8 0 1 1 8-8" /><path d="M12 12l4-4" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /></> },
  seasonals: { sub: "How every month did, year by year", icon: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></> },
  markets: { sub: "Where it trades and at what volume", icon: <><path d="M3 21h18" /><path d="M5 21V10l7-6 7 6v11" /><path d="M9 21v-6h6v6" /></> },
  fundamentals: { sub: "Market cap, supply and about", icon: <><circle cx="12" cy="12" r="9" /><path d="M12 3v9l6.5 4" /></> },
};

// Sheet title: coin logo + text (logo hides itself if it fails to load).
function CoinSheetTitle({ coin, text }: { coin: string; text: string }) {
  return (
    <span className="cps-coin-title">
      <img
        className="cps-coin-logo"
        src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
        alt=""
        onError={(e) => { e.currentTarget.style.display = "none"; }}
      />
      {text}
    </span>
  );
}

// Phones: "More ▾" at the end of the Chart / Order Book / Trades row opens
// the Explore list; each section opens in its own bottom sheet.
// Phones: every section lives on the page itself (CoinPageSections, the
// news / stats / cycles sections, ids "coin-sec-<id>"); the "More" list
// just scrolls to it.
type PageOnlySection = "chart" | "stats" | "cycles" | "traders";
const PAGE_ONLY_ROWS: { id: PageOnlySection; label: string; sub: string; icon: React.ReactNode }[] = [
  { id: "chart", label: "Chart", sub: "Price, intervals and drawing tools", icon: <><path d="M3 3v18h18" /><path d="m7 15 4-5 3 3 5-7" /></> },
  { id: "stats", label: "Statistics", sub: "Market cap, volume, supply and links", icon: <><path d="M3 3v18h18" /><path d="M7 16v-4M12 16V8M17 16v-7" /></> },
  { id: "cycles", label: "Market Cycles", sub: "Puell Multiple, Pi Cycle Top, Rainbow", icon: <><path d="M3 12a9 9 0 0 1 15.5-6.2" /><path d="M21 12a9 9 0 0 1-15.5 6.2" /><path d="M18 2v4h-4M6 22v-4h4" /></> },
  { id: "traders", label: "Top Traders", sub: "Biggest positions, winners and losers", icon: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-3-5.5" /></> },
];

export function CoinPageSections({ coin }: { coin: string }) {
  return (
    <div className="cps-inline">
      {(["technicals", "seasonals", "markets", "fundamentals"] as CoinPageTab[]).map((t) => (
        <section key={t} id={`coin-sec-${t}`} className="cps-inline-sec">
          <CoinPageTabContent tab={t} coin={coin} />
        </section>
      ))}
    </div>
  );
}

// Desktop: every tab's content lives on the page, one section after another
// below the chart; the tab bar scrolls to them. Each has an anchor —
// /chart/bitcoin#technicals opens straight at Technicals.
export const COIN_SECTION_ANCHORS = ["news", "technicals", "seasonals", "markets", "fundamentals"] as const;
export function CoinPageDesktopSections({ coin }: { coin: string }) {
  return (
    <div className="cps-desk">
      {COIN_SECTION_ANCHORS.map((t) => (
        <section key={t} id={`coin-sec-${t}`} className="cps-desk-sec">
          <CoinPageTabContent tab={t} coin={coin} />
        </section>
      ))}
    </div>
  );
}

export function CoinPagePicker({ coin }: { coin: string }) {
  const [listOpen, setListOpen] = useState(false);
  const [section, setSection] = useState<CoinPageTab | null>(null);
  const { t: tr } = useTranslation();
  const label = (t: CoinPageTab) => (COIN_PAGE_TABS.some((x) => x.id === t) ? tr(`coinTabs.tabs.${t}`) : "");
  // A section row: scroll to it on the page (after the sheet closes); only
  // if it isn't on the page does it open inside the sheet as before.
  const go = (t: CoinPageTab | PageOnlySection) => {
    if (t === "chart") {
      setListOpen(false);
      setSection(null);
      window.setTimeout(() => {
        document.querySelector(".main-content")?.scrollTo({ top: 0, behavior: "smooth" });
        window.scrollTo({ top: 0, behavior: "smooth" });
      }, 260);
      return;
    }
    if (document.getElementById(`coin-sec-${t}`)) {
      setListOpen(false);
      setSection(null);
      window.setTimeout(() => document.getElementById(`coin-sec-${t}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 260);
      return;
    }
    if (t === "stats" || t === "cycles" || t === "traders") return;
    // Not on the page (e.g. another layout): show it inside the sheet.
    setSection(t);
    setListOpen(true);
  };
  // Opened from elsewhere (e.g. the Consensus card's Technicals row).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: CoinPageTab }>).detail?.tab;
      if (!tab || tab === "overview") return;
      go(tab);
    };
    window.addEventListener("open-coin-section", onOpen);
    return () => window.removeEventListener("open-coin-section", onOpen);
  }, []);
  return (
    <>
      <button type="button" className="cpt-picker cpt-picker--more" onClick={() => setListOpen(true)} aria-haspopup="dialog">
        {tr("coinTabs.more")}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {/* One sheet with in-sheet navigation: the list, or a section with a
          ‹ back button to the list. ✕ closes the whole thing. */}
      <BottomSheet
        open={listOpen}
        onClose={() => { setListOpen(false); setSection(null); }}
        title={section ? (
          <span className="cps-nav-title">
            <button type="button" className="cps-back" onClick={() => setSection(null)} aria-label={tr("coinTabs.backToSections")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <CoinSheetTitle coin={coin} text={`${coinName(coin)} · ${label(section)}`} />
          </span>
        ) : <CoinSheetTitle coin={coin} text={tr("coinTabs.explore", { name: coinName(coin) })} />}
        ariaLabel={section ? `${coinName(coin)} ${label(section)}` : tr("coinTabs.explore", { name: coinName(coin) })}
        className={section ? "cpt-sheet" : undefined}
        floating
      >
        {section ? (
          <div key={section} className="cps-page">
            <CoinPageTabContent tab={section} coin={coin} />
          </div>
        ) : (
        <div className="cps-list" role="listbox" aria-label={tr("coinTabs.coinSections")}>
          {/* Page order: Statistics, Market Cycles (when on the page), News …
              Fundamentals, then Top Traders. */}
          {[
            ...PAGE_ONLY_ROWS.filter((r) => (r.id === "stats" || r.id === "cycles") && !!document.getElementById(`coin-sec-${r.id}`)),
            ...COIN_PAGE_TABS.filter((t) => t.id !== "overview").map((t) => ({ id: t.id as CoinPageTab | PageOnlySection, label: t.label, ...SECTION_META[t.id] })),
            ...PAGE_ONLY_ROWS.filter((r) => r.id === "traders" && !!document.getElementById("coin-sec-traders")),
          ].map((t, i) => {
            const meta = t;
            return (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={false}
                className={`cps-row cps-row--${t.id}`}
                style={{ animationDelay: `${i * 40}ms` }}
                onClick={() => go(t.id)}
              >
                <span className="cps-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{meta.icon}</svg>
                </span>
                <span className="cps-text">
                  <span className="cps-title">{tr(`coinTabs.tabs.${t.id}`)}</span>
                  <span className="cps-sub">{tr(`coinTabs.sub.${t.id}`)}</span>
                </span>
                <svg className="cps-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18" /></svg>
              </button>
            );
          })}
        </div>
        )}
      </BottomSheet>
    </>
  );
}

// ── Content ─────────────────────────────────────────────────────────────
export function CoinPageTabContent({ tab, coin }: {
  tab: CoinPageTab;
  coin: string;
  onOpenAuth?: () => void;
  onOpenUpgrade?: (plan?: "pro" | "elite") => void;
}) {
  if (tab === "overview") return null;
  return (
    <div className="cpt-panel" role="tabpanel">
      {tab === "news" && <NewsTab coin={coin} />}
      {tab === "technicals" && <TechnicalsTab coin={coin} />}
      {tab === "seasonals" && <SeasonalsTab coin={coin} />}
      {tab === "markets" && <MarketsTab coin={coin} />}
      {tab === "fundamentals" && <FundamentalsTab coin={coin} />}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="cpt-loading" role="status">
      <span className="cpt-spin" aria-hidden="true" />
      {label}
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="cpt-empty">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

// ── News: latest crypto headlines mentioning this coin ─────────────────
function NewsTab({ coin }: { coin: string }) {
  const [items, setItems] = useState<BriefItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    setItems(null);
    fetchBrief().then((all) => { if (alive) setItems(all); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [coin]);
  const name = coinName(coin);
  const { matched, others } = useMemo(() => {
    const list = (items ?? []).filter((i) => i.category === "crypto");
    const re = new RegExp(`\\b(${coin}|${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`, "i");
    const m = list.filter((i) => re.test(i.title));
    return { matched: m, others: list.filter((i) => !m.includes(i)).slice(0, 12) };
  }, [items, coin, name]);
  // CoinMarketCap layout: Top (this coin's stories first) / Latest (newest
  // crypto stories); a big featured story with its photo on the left, a
  // headline list on the right.
  const [mode, setMode] = useState<"top" | "latest">("top");
  const { t } = useTranslation();
  if (!items) return <Loading label={t("coinTabs.news.loading", { name })} />;
  const crypto = (items ?? []).filter((i) => i.category === "crypto");
  const rows = mode === "top"
    ? [...matched, ...others]
    : [...crypto].sort((a, b) => b.pubDate - a.pubDate);
  if (!rows.length) return <Empty title={t("coinTabs.news.emptyTitle")} text={t("coinTabs.news.emptyText")} />;
  const lead = rows.find((r) => r.thumbnail) ?? rows[0];
  const list = rows.filter((r) => r !== lead).slice(0, 6);
  return (
    <div className="cpt-section cnw">
      <div className="cnw-head">
        <h2 className="cpt-h"><CoinSheetTitle coin={coin} text={t("coinTabs.news.title", { name })} /></h2>
        <div className="cnw-seg" role="tablist" aria-label={t("coinTabs.news.sortAria")}>
          {(["top", "latest"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={`cnw-seg-btn${mode === m ? " cnw-seg-btn--on" : ""}`} onClick={() => setMode(m)}>
              {m === "top" ? t("coinTabs.news.top") : t("coinTabs.news.latest")}
            </button>
          ))}
        </div>
      </div>
      {mode === "top" && !matched.length && <p className="cpt-note">{t("coinTabs.news.noCoinNews", { name })}</p>}
      <div className="cnw-body">
        <a className="cnw-lead" href={lead.url} target="_blank" rel="noreferrer">
          <span className="cnw-lead-img">
            {lead.thumbnail ? <img src={lead.thumbnail} alt="" loading="lazy" /> : <span className="cpt-news-thumb" aria-hidden="true" />}
          </span>
          <strong className="cnw-lead-title">{lead.title}</strong>
          <span className="cnw-meta">{lead.source} · {timeAgo(lead.pubDate)}</span>
        </a>
        <div className="cnw-list">
          {list.map((n) => (
            <a key={n.url} className="cnw-item" href={n.url} target="_blank" rel="noreferrer">
              <strong>{n.title}</strong>
              <span className="cnw-meta">{n.source} · {timeAgo(n.pubDate)}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
function timeAgo(ms: number): string {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return i18n.t("coinTabs.ago.m", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return i18n.t("coinTabs.ago.h", { n: h });
  return i18n.t("coinTabs.ago.d", { n: Math.round(h / 24) });
}

// ── Technicals: oscillators + moving averages → buy/sell summary ────────
type Signal = "buy" | "sell" | "neutral";
interface TechRow { name: string; value: string; signal: Signal }
interface MaRow extends TechRow { distPct: number }
interface TechData {
  px: number;
  oscillators: TechRow[];
  mas: MaRow[];
  /** Volatility / band readings shown in the table but not voted. */
  extras: TechRow[];
  rsi: { v: number | null; series: number[] };
  stoch: { k: number; hi: number; lo: number };
  macd: { line: number | null; signal: number | null; hist: number[] };
  mom: { pct: number; closes: number[] };
  atr: number | null;
  /** Classic pivots from the last completed bar. */
  pivots: { name: string; v: number }[];
}

// Wilder's smoothing (RMA), as TradingView uses for ADX / DI.
function rma(vals: number[], n: number): number[] {
  const out: number[] = [];
  let prev = NaN;
  vals.forEach((v, i) => {
    if (i < n - 1) { out.push(NaN); return; }
    if (i === n - 1) { prev = vals.slice(0, n).reduce((a, b) => a + b, 0) / n; out.push(prev); return; }
    prev = (prev * (n - 1) + v) / n;
    out.push(prev);
  });
  return out;
}
function adxOf(c: CandleDataPoint[], n = 14): { adx: number; pdi: number; mdi: number } | null {
  if (c.length < n * 2 + 2) return null;
  const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  }
  const atr = rma(tr, n), sp = rma(pdm, n), sm = rma(mdm, n);
  const dx: number[] = [];
  const pdiA: number[] = [], mdiA: number[] = [];
  for (let i = 0; i < tr.length; i++) {
    const p = (100 * sp[i]) / atr[i], m = (100 * sm[i]) / atr[i];
    pdiA.push(p); mdiA.push(m);
    dx.push(Number.isFinite(p) && Number.isFinite(m) && p + m > 0 ? (100 * Math.abs(p - m)) / (p + m) : NaN);
  }
  const adxA = rma(dx.filter(Number.isFinite), n);
  const adx = adxA[adxA.length - 1];
  const pdi = pdiA[pdiA.length - 1], mdi = mdiA[mdiA.length - 1];
  return Number.isFinite(adx) && Number.isFinite(pdi) && Number.isFinite(mdi) ? { adx, pdi, mdi } : null;
}
const SPARK_N = 48;
const sigOf = (px: number, lvl: number): Signal => (px > lvl ? "buy" : px < lvl ? "sell" : "neutral");
function technicalsFor(c: CandleDataPoint[]): TechData {
  const close = c.map((x) => x.close);
  const px = close[close.length - 1];
  // RSI (14) history
  const rsiSeries = calcRSIArray(c).slice(-SPARK_N).filter((v): v is number => v !== null);
  const rsi = rsiSeries.length ? rsiSeries[rsiSeries.length - 1] : null;
  // Stochastic %K(14)
  const last14 = c.slice(-14);
  const hi = Math.max(...last14.map((x) => x.high)), lo = Math.min(...last14.map((x) => x.low));
  const k = hi > lo ? ((px - lo) / (hi - lo)) * 100 : 50;
  // MACD (12, 26, 9) history for the histogram
  const e12 = calcEMA(close, 12), e26 = calcEMA(close, 26);
  const macdArr = close.map((_, i) => e12[i] - e26[i]).filter((v) => Number.isFinite(v));
  const sigArr = calcEMA(macdArr, 9);
  const hist = macdArr.map((v, i) => v - sigArr[i]).filter((v) => Number.isFinite(v)).slice(-SPARK_N);
  const macdLine = macdArr.length ? macdArr[macdArr.length - 1] : null;
  const lastSig = sigArr[sigArr.length - 1];
  const macdSig = Number.isFinite(lastSig) ? lastSig : null;
  // Momentum (10) as % change
  const ref = close.length > 10 ? close[close.length - 11] : px;
  const momPct = ref ? ((px - ref) / ref) * 100 : 0;
  // CCI (20): typical price vs its 20-bar mean, scaled by mean deviation.
  const tp = c.slice(-20).map((x) => (x.high + x.low + x.close) / 3);
  const tpMean = tp.reduce((a, b) => a + b, 0) / (tp.length || 1);
  const meanDev = tp.reduce((a, b) => a + Math.abs(b - tpMean), 0) / (tp.length || 1);
  const cci = meanDev ? (tp[tp.length - 1] - tpMean) / (0.015 * meanDev) : 0;
  // Williams %R (14)
  const wr = hi > lo ? ((hi - px) / (hi - lo)) * -100 : -50;
  const dmi = adxOf(c);
  const bb = calcBB(c, 20);
  const atr = calcATR(c, 14);
  // The first four stay in this order (the oscillator cards use them).
  const oscillators: TechRow[] = [
    { name: "RSI (14)", value: rsi === null ? "—" : rsi.toFixed(1), signal: rsi === null ? "neutral" : rsi < 30 ? "buy" : rsi > 70 ? "sell" : rsi > 55 ? "buy" : rsi < 45 ? "sell" : "neutral" },
    { name: "Stochastic %K (14)", value: k.toFixed(1), signal: k < 20 ? "buy" : k > 80 ? "sell" : "neutral" },
    { name: "MACD (12, 26)", value: macdLine === null ? "—" : macdLine.toFixed(2), signal: macdLine === null || macdSig === null ? "neutral" : macdLine > macdSig ? "buy" : "sell" },
    { name: "Momentum (10)", value: `${momPct >= 0 ? "+" : ""}${momPct.toFixed(2)}%`, signal: momPct > 0 ? "buy" : momPct < 0 ? "sell" : "neutral" },
    { name: "CCI (20)", value: cci.toFixed(1), signal: cci < -100 ? "buy" : cci > 100 ? "sell" : "neutral" },
    { name: "Williams %R (14)", value: wr.toFixed(1), signal: wr < -80 ? "buy" : wr > -20 ? "sell" : "neutral" },
    ...(dmi ? [{
      name: "ADX (14) · DI",
      value: `${dmi.adx.toFixed(1)} · +${dmi.pdi.toFixed(0)} / −${dmi.mdi.toFixed(0)}`,
      signal: (dmi.adx > 25 ? (dmi.pdi > dmi.mdi ? "buy" : "sell") : "neutral") as Signal,
    }] : []),
  ];
  const extras: TechRow[] = [
    ...(bb ? [{
      name: "Bollinger %B (20, 2)",
      value: bb.pct.toFixed(2),
      signal: (bb.pct < 0 ? "buy" : bb.pct > 1 ? "sell" : "neutral") as Signal,
    }, {
      name: "Bollinger width",
      value: `${(((bb.upper - bb.lower) / bb.middle) * 100).toFixed(2)}%`,
      signal: "neutral" as Signal,
    }] : []),
    ...(atr ? [{ name: "ATR (14)", value: `${fmtUsd(atr)} · ${((atr / px) * 100).toFixed(2)}%`, signal: "neutral" as Signal }] : []),
  ];
  // Classic floor pivots from the last completed bar.
  const pb = c[c.length - 2] ?? c[c.length - 1];
  const P = (pb.high + pb.low + pb.close) / 3;
  const rng = pb.high - pb.low;
  const pivots = [
    { name: "R3", v: pb.high + 2 * (P - pb.low) },
    { name: "R2", v: P + rng },
    { name: "R1", v: 2 * P - pb.low },
    { name: "Pivot", v: P },
    { name: "S1", v: 2 * P - pb.high },
    { name: "S2", v: P - rng },
    { name: "S3", v: pb.low - 2 * (pb.high - P) },
  ];
  const mas: MaRow[] = [10, 20, 30, 50, 100, 200].flatMap((n) => {
    if (close.length < n) return [];
    const ema = calcEMA(close, n);
    const e = ema[ema.length - 1];
    const sma = close.slice(-n).reduce((a, b) => a + b, 0) / n;
    return [
      { name: `EMA (${n})`, value: fmtUsd(e), signal: sigOf(px, e), distPct: ((px - e) / e) * 100 },
      { name: `SMA (${n})`, value: fmtUsd(sma), signal: sigOf(px, sma), distPct: ((px - sma) / sma) * 100 },
    ];
  });
  return {
    px, oscillators, mas, extras,
    rsi: { v: rsi, series: rsiSeries },
    stoch: { k, hi, lo },
    macd: { line: macdLine, signal: macdSig, hist },
    mom: { pct: momPct, closes: close.slice(-SPARK_N) },
    atr,
    pivots,
  };
}
function verdictOf(rows: TechRow[]) {
  const b = rows.filter((r) => r.signal === "buy").length;
  const s = rows.filter((r) => r.signal === "sell").length;
  const n = rows.length - b - s;
  const score = rows.length ? (b - s) / rows.length : 0; // -1 … 1
  const labelKey = score > 0.5 ? "strongBuy" : score > 0.1 ? "buy" : score < -0.5 ? "strongSell" : score < -0.1 ? "sell" : "neutral";
  return { b, s, n, score, label: i18n.t(`coinTabs.verdict.${labelKey}`) };
}
const toneOfScore = (score: number): Signal => (score > 0.1 ? "buy" : score < -0.1 ? "sell" : "neutral");

/** Technicals' overall lean for the Consensus strip: score −1…1 plus a
 *  descriptive label (never "buy"/"sell" wording). Null if too few candles. */
export function technicalsLean(c: CandleDataPoint[]): { score: number; tone: "bull" | "bear" | "neutral"; label: string } | null {
  if (c.length < 30) return null;
  const d = technicalsFor(c);
  const v = verdictOf([...d.oscillators, ...d.mas]);
  const s = toneOfScore(v.score);
  return {
    score: v.score,
    tone: s === "buy" ? "bull" : s === "sell" ? "bear" : "neutral",
    label: s === "buy" ? "Lean bullish" : s === "sell" ? "Lean bearish" : "Mixed",
  };
}
const sigLabel = (s: Signal) => i18n.t(`coinTabs.verdict.${s}`);

// ── Signal desk: score + its history, group read-outs, indicator heatmap ──
function SignalDesk({ data, history }: { data: TechData; history: number[] }) {
  const all = verdictOf([...data.oscillators, ...data.mas]);
  const osc = verdictOf(data.oscillators), ma = verdictOf(data.mas);
  const tone = toneOfScore(all.score);
  const sc = (s: number) => { const n = Math.round(s * 100); return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`; };
  const { t } = useTranslation();
  const r = data.rsi.v;
  const rsiWord = r === null ? t("coinTabs.desk.rsiNA") : r < 30 ? t("coinTabs.desk.rsiOversold", { v: r.toFixed(0) }) : r > 70 ? t("coinTabs.desk.rsiOverbought", { v: r.toFixed(0) }) : t("coinTabs.desk.rsiNeutral", { v: r.toFixed(0) });
  const above = data.mas.filter((m) => m.signal === "buy").length;
  // History chart: −1…1 → y; split fill above / below zero.
  const W = 400, H = 120, n = history.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : 0);
  const y = (v: number) => H / 2 - v * (H / 2 - 6);
  const line = history.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = n > 1 ? `${line} L${W} ${H / 2} L0 ${H / 2} Z` : "";
  const prev = history.length > 10 ? history[history.length - 11] : null;
  const delta = prev === null ? null : Math.round((all.score - prev) * 100);
  const tiles = [
    ...data.oscillators.map((o) => ({ k: o.name.replace(/ \(.*\)| · DI/g, ""), v: o.value.split(" · ")[0], s: o.signal })),
    ...data.mas.map((m) => ({ k: m.name.replace(/[()]/g, "").replace("  ", " "), v: `${m.distPct >= 0 ? "+" : ""}${m.distPct.toFixed(1)}%`, s: m.signal })),
  ];
  return (
    <div className="sgd">
      <div className="sgd-top">
        <div className="sgd-score">
          <span className="sgd-kicker">{t("coinTabs.desk.kicker")}</span>
          <div className="sgd-score-row">
            <strong className={`sgd-num cpt-tone--${tone}`}>{sc(all.score)}</strong>
            <span className={`sgd-verdict sgd-verdict--${tone}`}>{all.label}</span>
          </div>
          <div className="sgd-votes">
            <span><b className="cpt-tone--buy">{all.b}</b> {t("coinTabs.desk.votesBuy")}</span>
            <span><b>{all.n}</b> {t("coinTabs.desk.votesNeutral")}</span>
            <span><b className="cpt-tone--sell">{all.s}</b> {t("coinTabs.desk.votesSell")}</span>
            {delta !== null && (
              <span className="sgd-delta">
                <b className={delta > 0 ? "cpt-tone--buy" : delta < 0 ? "cpt-tone--sell" : ""}>{delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} {Math.abs(delta)}</b> {t("coinTabs.desk.vsBarsAgo", { n: 10 })}
              </span>
            )}
          </div>
          <div className="sgd-groups">
            <div><span>{t("coinTabs.oscillators")}</span><strong className={`cpt-tone--${toneOfScore(osc.score)}`}>{sc(osc.score)}</strong><em>{osc.label}</em></div>
            <div><span>{t("coinTabs.movingAverages")}</span><strong className={`cpt-tone--${toneOfScore(ma.score)}`}>{sc(ma.score)}</strong><em>{ma.label}</em></div>
          </div>
        </div>
        <div className="sgd-hist">
          <div className="sgd-hist-head"><span>{t("coinTabs.desk.history", { n })}</span><span>{t("coinTabs.desk.histScale")}</span></div>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="sgd-hist-svg" aria-hidden="true">
            <defs>
              <clipPath id="sgd-up"><rect x="0" y="0" width={W} height={H / 2} /></clipPath>
              <clipPath id="sgd-dn"><rect x="0" y={H / 2} width={W} height={H / 2} /></clipPath>
            </defs>
            {[0.5, -0.5].map((g) => <line key={g} x1="0" x2={W} y1={y(g)} y2={y(g)} className="sgd-grid" />)}
            <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="sgd-zero" />
            <path d={area} clipPath="url(#sgd-up)" className="sgd-area sgd-area--up" />
            <path d={area} clipPath="url(#sgd-dn)" className="sgd-area sgd-area--dn" />
            <path d={line} className="sgd-line" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      </div>
      <div className="sgd-heat" aria-label={t("coinTabs.desk.everyIndicator")}>
        {tiles.map((t) => (
          <div key={t.k} className={`sgd-tile sgd-tile--${t.s}`} title={`${t.k}: ${t.v} — ${sigLabel(t.s)}`}>
            <span className="sgd-tile-k">{t.k}</span>
            <span className="sgd-tile-v">{t.v}</span>
          </div>
        ))}
      </div>
      <p className="sgd-read">
        {t("coinTabs.desk.read", {
          ma: above >= data.mas.length - above
            ? t("coinTabs.desk.readMaAbove", { n: above, total: data.mas.length })
            : t("coinTabs.desk.readMaBelow", { n: data.mas.length - above, total: data.mas.length }),
          rsi: rsiWord,
          macd: data.macd.line !== null && data.macd.signal !== null && data.macd.line > data.macd.signal ? t("coinTabs.desk.macdAbove") : t("coinTabs.desk.macdBelow"),
          mom: `${data.mom.pct >= 0 ? "+" : "−"}${Math.abs(data.mom.pct).toFixed(1)}`,
        })}
      </p>
    </div>
  );
}


// Tiny line chart. `zones` shade value bands; `lines` draw dashed guides.
function Spark({ values, min, max, cls, zones = [], lines = [], dots = [] }: {
  values: number[]; min?: number; max?: number; cls: string;
  zones?: { from: number; to: number; cls: string }[]; lines?: number[]; dots?: number[];
}) {
  const W = 240, H = 64, P = 4;
  if (values.length < 2) return null;
  const lo = min ?? Math.min(...values), hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => P + (1 - (v - lo) / span) * (H - 2 * P);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="tch-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {zones.map((z) => <rect key={z.cls} x="0" width={W} y={y(z.to)} height={Math.max(0, y(z.from) - y(z.to))} className={z.cls} />)}
      {lines.map((l) => <line key={l} x1="0" x2={W} y1={y(l)} y2={y(l)} className="tch-spark-guide" />)}
      <path d={`${d} L${W} ${H} L0 ${H} Z`} className={`tch-spark-area ${cls}`} />
      <path d={d} className={`tch-spark-line ${cls}`} />
      {dots.map((i) => <circle key={i} cx={x(i)} cy={y(values[i])} r="3.2" className={`tch-spark-dot ${cls}`} />)}
    </svg>
  );
}
function MacdBars({ hist }: { hist: number[] }) {
  const W = 240, H = 64;
  if (!hist.length) return null;
  const m = Math.max(...hist.map(Math.abs)) || 1;
  const bw = W / hist.length;
  return (
    <svg className="tch-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="tch-spark-guide" />
      {hist.map((v, i) => {
        const h = (Math.abs(v) / m) * (H / 2 - 3);
        const prev = i ? hist[i - 1] : v;
        const fading = Math.abs(v) < Math.abs(prev);
        return (
          <rect key={i} x={i * bw + bw * 0.15} width={bw * 0.7} y={v >= 0 ? H / 2 - h : H / 2} height={Math.max(0.5, h)}
            className={`tch-bar tch-bar--${v >= 0 ? "up" : "down"}${fading ? " tch-bar--fade" : ""}`} />
        );
      })}
    </svg>
  );
}
function OscCard({ row, caption, children }: { row: TechRow | undefined; caption: string; children: React.ReactNode }) {
  if (!row) return null;
  return (
    <div className="tch-card">
      <div className="tch-card-head">
        <span className="tch-card-name">{row.name}</span>
        <span className={`tch-chip tch-chip--${row.signal}`}>{sigLabel(row.signal)}</span>
      </div>
      <strong className="tch-card-value">{row.value}</strong>
      <div className="tch-card-viz">{children}</div>
      <p className="tch-card-cap">{caption}</p>
    </div>
  );
}
function Oscillators({ data }: { data: TechData }) {
  const [rsiRow, stochRow, macdRow, momRow] = data.oscillators;
  const r = data.rsi.v;
  const { k, hi, lo } = data.stoch;
  const h = data.macd.hist;
  const { t } = useTranslation();
  const hLast = h[h.length - 1] ?? 0, hPrev = h[h.length - 2] ?? hLast;
  const macdCap = hLast >= 0
    ? Math.abs(hLast) >= Math.abs(hPrev) ? t("coinTabs.osc.macdBullUp") : t("coinTabs.osc.macdBullFade")
    : Math.abs(hLast) >= Math.abs(hPrev) ? t("coinTabs.osc.macdBearUp") : t("coinTabs.osc.macdBearFade");
  const closes = data.mom.closes;
  return (
    <div className="tch-cards">
      <OscCard row={rsiRow} caption={r === null ? t("coinTabs.osc.rsiNA") : r < 30 ? t("coinTabs.osc.rsiOversold") : r > 70 ? t("coinTabs.osc.rsiOverbought") : t("coinTabs.osc.rsiMid")}>
        <Spark values={data.rsi.series} min={0} max={100} cls="tch-c-violet"
          zones={[{ from: 0, to: 30, cls: "tch-zone-buy" }, { from: 70, to: 100, cls: "tch-zone-sell" }]} lines={[30, 70]} dots={[data.rsi.series.length - 1]} />
      </OscCard>
      <OscCard row={stochRow} caption={t("coinTabs.osc.stoch", { k: k.toFixed(0) })}>
        <div className="tch-range">
          <div className="tch-range-track">
            <span className="tch-range-zone tch-range-zone--low" />
            <span className="tch-range-zone tch-range-zone--high" />
            <span className="tch-range-marker" style={{ left: `${Math.min(100, Math.max(0, k))}%` }} />
          </div>
          <div className="tch-range-labels">
            <span>{t("coinTabs.osc.low", { v: fmtUsd(lo) })}</span>
            <span>{t("coinTabs.osc.high", { v: fmtUsd(hi) })}</span>
          </div>
        </div>
      </OscCard>
      <OscCard row={macdRow} caption={macdCap}>
        <MacdBars hist={h} />
      </OscCard>
      <OscCard row={momRow} caption={t(data.mom.pct >= 0 ? "coinTabs.osc.momUp" : "coinTabs.osc.momDown", { v: Math.abs(data.mom.pct).toFixed(2) })}>
        <Spark values={closes} cls={data.mom.pct >= 0 ? "tch-c-up" : "tch-c-down"} dots={closes.length > 10 ? [closes.length - 11, closes.length - 1] : [closes.length - 1]} />
      </OscCard>
    </div>
  );
}
// Price vs each moving average: how far above (green, right) or below
// (red, left) the price sits, in %.
function MaLadder({ px, rows }: { px: number; rows: MaRow[] }) {
  const max = Math.max(0.5, ...rows.map((r) => Math.abs(r.distPct)));
  const above = rows.filter((r) => r.signal === "buy").length;
  const { t } = useTranslation();
  return (
    <div className="tch-ma">
      <div className="tch-ma-head">
        <span className="cpt-table-title">{t("coinTabs.movingAverages")}</span>
        <span className="tch-ma-sub"><Trans i18nKey="coinTabs.ma.sub" values={{ px: fmtUsd(px), n: above, total: rows.length }} components={{ b: <b /> }} /></span>
      </div>
      <div className="tch-ma-axis" aria-hidden="true"><span>{t("coinTabs.ma.priceBelow")}</span><span>{t("coinTabs.ma.priceAbove")}</span></div>
      <div className="tch-ma-list">
        {rows.map((r) => (
          <div key={r.name} className="tch-ma-row">
            <span className="tch-ma-name">{r.name}</span>
            <span className="tch-ma-val">{r.value}</span>
            <div className="tch-ma-bar" aria-hidden="true">
              <span className="tch-ma-mid" />
              <span className={`tch-ma-fill tch-ma-fill--${r.distPct >= 0 ? "up" : "down"}`} style={{ width: `${(Math.abs(r.distPct) / max) * 50}%` }} />
            </div>
            <span className={`tch-ma-pct cpt-tone--${r.signal}`}>{r.distPct >= 0 ? "+" : ""}{r.distPct.toFixed(2)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
// ── Pro views ───────────────────────────────────────────────────────────
type TechFrame = "15min" | "1h" | "4h" | "1day" | "1week";
const MTF: { id: TechFrame; label: string }[] = [
  { id: "15min", label: "15m" }, { id: "1h", label: "1H" }, { id: "4h", label: "4H" }, { id: "1day", label: "1D" }, { id: "1week", label: "1W" },
];
function Pill({ rows }: { rows: TechRow[] }) {
  const v = verdictOf(rows);
  return <span className={`tch-pill tch-pill--${toneOfScore(v.score)}${Math.abs(v.score) > 0.5 ? " tch-pill--strong" : ""}`}>{v.label}</span>;
}
// Every timeframe at a glance: oscillators, moving averages, overall, plus
// RSI and where price sits vs the 20 / 50 EMA. Click a row to open it.
function MtfMatrix({ coin, frame, onPick }: { coin: string; frame: TechFrame; onPick: (f: TechFrame) => void }) {
  const [rows, setRows] = useState<Partial<Record<TechFrame, TechData | null>>>({});
  useEffect(() => {
    let alive = true;
    setRows({});
    MTF.forEach((f) => {
      coinglass.getHistoricalCandles(f.id, coin)
        .then((c) => { if (alive) setRows((r) => ({ ...r, [f.id]: c.length >= 30 ? technicalsFor(c) : null })); })
        .catch(() => { if (alive) setRows((r) => ({ ...r, [f.id]: null })); });
    });
    return () => { alive = false; };
  }, [coin]);
  const { t } = useTranslation();
  const emaPos = (d: TechData, n: number) => {
    const m = d.mas.find((x) => x.name === `EMA (${n})`);
    return m ? <span className={`cpt-tone--${m.signal}`}>{m.distPct >= 0 ? "▲" : "▼"} {Math.abs(m.distPct).toFixed(1)}%</span> : <span className="tch-mtf-na">—</span>;
  };
  return (
    <div className="tch-mtf">
      <div className="tch-mtf-row tch-mtf-row--head">
        <span>{t("coinTabs.mtf.timeframe")}</span><span>{t("coinTabs.oscillators")}</span><span>{t("coinTabs.mtf.movingAvgs")}</span><span>{t("coinTabs.mtf.summary")}</span><span>RSI</span><span>{t("coinTabs.mtf.vsEma", { n: 20 })}</span><span>{t("coinTabs.mtf.vsEma", { n: 50 })}</span>
      </div>
      {MTF.map((f) => {
        const d = rows[f.id];
        return (
          <button key={f.id} type="button" className={`tch-mtf-row${frame === f.id ? " tch-mtf-row--on" : ""}`} onClick={() => onPick(f.id)}>
            <span className="tch-mtf-tf">{f.label}</span>
            {d === undefined ? (
              <span className="tch-mtf-load">{t("coinTabs.loading")}</span>
            ) : d === null ? (
              <span className="tch-mtf-load">{t("coinTabs.notEnoughData")}</span>
            ) : (
              <>
                <Pill rows={d.oscillators} />
                <Pill rows={d.mas} />
                <Pill rows={[...d.oscillators, ...d.mas]} />
                <span className="tch-mtf-num">{d.rsi.v === null ? "—" : d.rsi.v.toFixed(1)}</span>
                <span className="tch-mtf-num">{emaPos(d, 20)}</span>
                <span className="tch-mtf-num">{emaPos(d, 50)}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
// Dense TradingView-style table: every indicator, its value, its action.
function TechTable({ data }: { data: TechData }) {
  const all = [...data.oscillators, ...data.extras];
  const { t } = useTranslation();
  return (
    <div className="tch-table">
      <div className="tch-table-row tch-table-row--head"><span>{t("coinTabs.table.indicator")}</span><span>{t("coinTabs.table.value")}</span><span>{t("coinTabs.table.action")}</span></div>
      {all.map((r) => (
        <div key={r.name} className="tch-table-row">
          <span className="tch-table-name">{r.name === "Bollinger width" ? t("coinTabs.table.bbWidth") : r.name}</span>
          <span className="tch-table-val">{r.value}</span>
          {/* Volatility readings have no direction — no action. */}
          {r.name.startsWith("ATR") || r.name === "Bollinger width"
            ? <span className="tch-table-act tch-mtf-na">—</span>
            : <span className={`tch-table-act cpt-tone--${r.signal}`}>{sigLabel(r.signal)}</span>}
        </div>
      ))}
    </div>
  );
}
// Pivot ladder (R3 … S3) with the current price slotted in, plus ATR-based
// stop distances for a long and a short.
function KeyLevels({ data }: { data: TechData }) {
  const px = data.px;
  const lv = [...data.pivots, { name: "Price", v: px }].sort((a, b) => b.v - a.v);
  const atr = data.atr;
  const { t } = useTranslation();
  return (
    <div className="tch-levels">
      <div className="tch-levels-list">
        {lv.map((l) => {
          const isPx = l.name === "Price";
          const tone = l.name.startsWith("R") ? "sell" : l.name.startsWith("S") ? "buy" : "neutral";
          const dist = ((l.v - px) / px) * 100;
          return (
            <div key={l.name} className={`tch-level${isPx ? " tch-level--px" : ""}`}>
              <span className={`tch-level-name${isPx ? "" : ` cpt-tone--${tone}`}`}>{isPx ? `● ${t("coinTabs.levels.price")}` : l.name === "Pivot" ? t("coinTabs.levels.pivot") : l.name}</span>
              <span className="tch-level-v">{fmtUsd(l.v)}</span>
              <span className="tch-level-d">{isPx ? "" : `${dist >= 0 ? "+" : ""}${dist.toFixed(2)}%`}</span>
            </div>
          );
        })}
      </div>
      {atr ? (
        <div className="tch-stops">
          <div><span>{t("coinTabs.levels.longStop")}</span><strong className="cpt-tone--sell">{fmtUsd(px - 1.5 * atr)}</strong></div>
          <div><span>{t("coinTabs.levels.shortStop")}</span><strong className="cpt-tone--buy">{fmtUsd(px + 1.5 * atr)}</strong></div>
        </div>
      ) : null}
    </div>
  );
}

const TECH_FRAMES: { id: TechFrame; label: string }[] = [
  { id: "15min", label: "15 min" }, { id: "1h", label: "1 hour" }, { id: "4h", label: "4 hours" }, { id: "1day", label: "1 day" }, { id: "1week", label: "1 week" },
];
function TechnicalsTab({ coin }: { coin: string }) {
  const [frame, setFrame] = useState<(typeof TECH_FRAMES)[number]["id"]>("1day");
  const [data, setData] = useState<ReturnType<typeof technicalsFor> | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [err, setErr] = useState(false);
  const { t } = useTranslation();
  useEffect(() => {
    let alive = true;
    setData(null); setErr(false); setHistory([]);
    coinglass.getHistoricalCandles(frame, coin)
      .then((c) => {
        if (!alive) return;
        if (c.length < 30) { setErr(true); return; }
        setData(technicalsFor(c));
        // The overall score as it stood at each of the last 40 bars.
        const h: number[] = [];
        for (let k = Math.min(39, c.length - 30); k >= 0; k--) {
          const d = technicalsFor(c.slice(0, c.length - k));
          h.push(verdictOf([...d.oscillators, ...d.mas]).score);
        }
        setHistory(h);
      })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [coin, frame]);
  return (
    <div className="cpt-section">
      <div className="cpt-row-head">
        <h2 className="cpt-h"><CoinSheetTitle coin={coin} text={t("coinTabs.tech.title", { name: coinName(coin) })} /></h2>
        <div className="cpt-seg" role="tablist" aria-label={t("coinTabs.mtf.timeframe")}>
          {TECH_FRAMES.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={frame === f.id} className={`cpt-seg-btn${frame === f.id ? " cpt-seg-btn--on" : ""}`} onClick={() => setFrame(f.id)}>{t(`coinTabs.frames.${f.id}`)}</button>
          ))}
        </div>
      </div>
      {err ? <Empty title={t("coinTabs.notEnoughData")} text={t("coinTabs.tech.notEnoughText")} /> : !data ? <Loading label={t("coinTabs.tech.reading")} /> : (
        <>
          <SignalDesk data={data} history={history} />
          <span className="cpt-table-title">{t("coinTabs.tech.acrossTf")}</span>
          <MtfMatrix coin={coin} frame={frame} onPick={setFrame} />
          <span className="cpt-table-title">{t("coinTabs.oscillators")}</span>
          <Oscillators data={data} />
          <div className="tch-pro-grid">
            <div>
              <span className="cpt-table-title">{t("coinTabs.tech.allIndicators")}</span>
              <TechTable data={data} />
            </div>
            <div>
              <span className="cpt-table-title">{t("coinTabs.tech.keyLevels")}</span>
              <KeyLevels data={data} />
            </div>
          </div>
          <MaLadder px={data.px} rows={data.mas} />
          <p className="cpt-note">{t("coinTabs.tech.disclaimer")}</p>
        </>
      )}
    </div>
  );
}

// ── Seasonals: monthly returns by year (heatmap) ───────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function SeasonalsTab({ coin }: { coin: string }) {
  const [grid, setGrid] = useState<Map<number, (number | null)[]> | null>(null);
  const [err, setErr] = useState(false);
  const { t } = useTranslation();
  useEffect(() => {
    let alive = true;
    setGrid(null); setErr(false);
    fetchBn(`/api/v3/klines?symbol=${coin}USDT&interval=1M&limit=120`)
      .then((rows: unknown[][]) => {
        if (!alive) return;
        const g = new Map<number, (number | null)[]>();
        for (const r of rows) {
          const d = new Date(Number(r[0]));
          const o = Number(r[1]), c = Number(r[4]);
          const y = d.getUTCFullYear();
          if (!g.has(y)) g.set(y, new Array(12).fill(null));
          g.get(y)![d.getUTCMonth()] = o > 0 ? ((c - o) / o) * 100 : null;
        }
        setGrid(g);
      })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [coin]);
  if (err) return <Empty title={t("coinTabs.seasonals.emptyTitle")} text={t("coinTabs.seasonals.emptyText", { name: coinName(coin) })} />;
  if (!grid) return <Loading label={t("coinTabs.seasonals.building")} />;
  // Month names in the app's language (MONTHS stays the stable key).
  const monthName = (i: number) => new Date(Date.UTC(2000, i, 1)).toLocaleString(i18n.language, { month: "short", timeZone: "UTC" });
  const years = [...grid.keys()].sort((a, b) => b - a);
  const avg = MONTHS.map((_, m) => {
    const vals = years.map((y) => grid.get(y)![m]).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
  const nowM = new Date().getUTCMonth();
  return (
    <div className="cpt-section">
      <h2 className="cpt-h"><CoinSheetTitle coin={coin} text={t("coinTabs.seasonals.title", { name: coinName(coin) })} /></h2>
      <p className="cpt-note">
        <Trans
          i18nKey="coinTabs.seasonals.note"
          values={{ month: monthName(nowM), avg: avg[nowM] === null ? "—" : `${avg[nowM]! >= 0 ? "+" : ""}${avg[nowM]!.toFixed(1)}%` }}
          components={{ m: <strong />, v: <strong className={avg[nowM] !== null && avg[nowM]! >= 0 ? "cpt-tone--buy" : "cpt-tone--sell"} /> }}
        />
      </p>
      <div className="cpt-heat-wrap">
        <table className="cpt-heat">
          <thead>
            <tr><th>{t("coinTabs.seasonals.year")}</th>{MONTHS.map((m, i) => <th key={m} className={i === nowM ? "cpt-heat-now" : undefined}>{monthName(i)}</th>)}</tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr key={y}>
                <th>{y}</th>
                {grid.get(y)!.map((v, i) => (
                  <td key={i} style={heatStyle(v)} className={i === nowM ? "cpt-heat-now" : undefined}>{v === null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}</td>
                ))}
              </tr>
            ))}
            <tr className="cpt-heat-avg">
              <th>{t("coinTabs.seasonals.avg")}</th>
              {avg.map((v, i) => <td key={i} style={heatStyle(v)} className={i === nowM ? "cpt-heat-now" : undefined}>{v === null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
function heatStyle(v: number | null): React.CSSProperties | undefined {
  if (v === null) return undefined;
  const a = Math.min(1, Math.abs(v) / 40) * 0.75 + 0.08;
  return { background: v >= 0 ? `rgba(34, 197, 94, ${a})` : `rgba(239, 68, 68, ${a})` };
}

// ── Markets: where it trades (top pairs by volume) ─────────────────────
function MarketsTab({ coin }: { coin: string }) {
  const [rows, setRows] = useState<ExchangeMarket[] | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let alive = true;
    let retry = 0;
    if (tries === 0) setRows(null);
    getExchangeMarkets(coin).then((r) => { if (alive) setRows(r); }).catch(() => {
      // Never "unavailable": keep the loader and try again shortly.
      if (alive) retry = window.setTimeout(() => setTries((n) => n + 1), 30_000);
    });
    return () => { alive = false; window.clearTimeout(retry); };
  }, [coin, tries]);
  useEffect(() => setTries(0), [coin]);
  const { t: tr } = useTranslation();
  if (!rows) return <Loading label={tries ? tr("coinTabs.markets.stillLoading") : tr("coinTabs.markets.finding")} />;
  return (
    <div className="cpt-section">
      <h2 className="cpt-h"><CoinSheetTitle coin={coin} text={tr("coinTabs.markets.title", { name: coinName(coin) })} /></h2>
      <div className="cpt-table-wrap cpt-table-wrap--scroll">
        <table className="cpt-table">
          <thead><tr><th>#</th><th>{tr("coinTabs.markets.exchange")}</th><th>{tr("coinTabs.markets.pair")}</th><th className="cpt-num">{tr("coinTabs.markets.price")}</th><th className="cpt-num">{tr("coinTabs.vol24")}</th><th>{tr("coinTabs.markets.trust")}</th></tr></thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={`${t.exchange}:${t.base}/${t.target}:${i}`}>
                <td className="cpt-dim">{i + 1}</td>
                <td>
                  <span className="cpt-ex">
                    {t.logo && <img src={t.logo} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />}
                    {t.exchange}
                  </span>
                </td>
                <td>{t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.base}/{t.target}</a> : `${t.base}/${t.target}`}</td>
                <td className="cpt-num">{t.price < 1 ? t.price.toPrecision(4) : t.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                <td className="cpt-num">{fmtUsd(t.volumeUsd)}</td>
                <td><span className={`cpt-trust cpt-trust--${t.trust ?? "na"}`} aria-label={t.trust ? tr("coinTabs.markets.trustAria", { v: t.trust }) : tr("coinTabs.markets.trustUnknown")} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaprikaCredit keyPrefix={`pairs:${coin.toUpperCase()}`} />
    </div>
  );
}

// ── Fundamentals: supply, valuation, records, about ─────────────────────
function FundamentalsTab({ coin }: { coin: string }) {
  const [data, setData] = useState<CoinDetails | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let alive = true;
    let retry = 0;
    if (tries === 0) setData(null);
    getCoinDetails(coin).then((j) => {
      if (!j) throw new Error("no data");
      if (alive) setData(j);
    }).catch(() => {
      // Never "unavailable": keep the loader and try again shortly.
      if (alive) retry = window.setTimeout(() => setTries((n) => n + 1), 30_000);
    });
    return () => { alive = false; window.clearTimeout(retry); };
  }, [coin, tries]);
  useEffect(() => setTries(0), [coin]);
  const { t } = useTranslation();
  if (!data) return <Loading label={tries ? t("coinTabs.fund.stillLoading") : t("coinTabs.fund.loading")} />;
  const m = data.market;
  const circ = m?.circulating_supply ?? null, max = m?.max_supply ?? m?.total_supply ?? null;
  const pct = circ && max ? Math.min(100, (circ / max) * 100) : null;
  const about = data.description;
  const date = (s?: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
  return (
    <div className="cpt-section">
      <h2 className="cpt-h"><CoinSheetTitle coin={coin} text={t("coinTabs.fund.title", { name: coinName(coin) })} />{data.rank ? <span className="cpt-rank">#{data.rank}</span> : null}</h2>
      <div className="cpt-stats">
        <Stat label={t("coinTabs.fund.marketCap")} value={fmtUsd(m?.market_cap)} />
        <Stat label={t("coinTabs.fund.fdv")} value={fmtUsd(m?.fdv)} />
        <Stat label={t("coinTabs.vol24")} value={fmtUsd(m?.total_volume)} />
        <Stat label={t("coinTabs.fund.volMcap")} value={m?.total_volume && m?.market_cap ? `${((m.total_volume / m.market_cap) * 100).toFixed(2)}%` : "—"} />
      </div>
      <div className="cpt-supply">
        <div className="cpt-supply-head">
          <span>{t("coinTabs.fund.circ")}</span>
          <strong>{fmtNum(circ)} {coin}</strong>
        </div>
        {pct !== null && (
          <>
            <span className="cpt-supply-bar"><span style={{ width: `${pct}%` }} /></span>
            <span className="cpt-supply-sub">{t(m?.max_supply ? "coinTabs.fund.ofMax" : "coinTabs.fund.ofTotal", { pct: pct.toFixed(1), n: fmtNum(max) })}</span>
          </>
        )}
      </div>
      <div className="cpt-stats">
        {/* ATH / ATL — "—" with no sub-line when the answering source lacks them. */}
        <Stat label={t("coinTabs.fund.ath")} value={fmtUsd(m?.ath)} sub={m?.ath ? t("coinTabs.fund.fromAth", { date: date(m.ath_date), pct: m.ath_change_percentage?.toFixed(1) ?? "—" }) : undefined} />
        <Stat label={t("coinTabs.fund.atl")} value={fmtUsd(m?.atl)} sub={m?.atl ? t("coinTabs.fund.sinceAtl", { date: date(m.atl_date), pct: m.atl_change_percentage?.toFixed(0) ?? "—" }) : undefined} />
      </div>
      {about && (
        <div className="cpt-about">
          <span className="cpt-table-title">{t("coinTabs.fund.about", { name: data.name })}</span>
          <p>{about.length > 700 ? `${about.slice(0, 700)}…` : about}</p>
          {data.links.website[0] && <a href={data.links.website[0]} target="_blank" rel="noreferrer">{t("coinTabs.fund.website")}</a>}
        </div>
      )}
      <PaprikaCredit keyPrefix={`details:${coin.toUpperCase()}`} />
    </div>
  );
}
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="cpt-stat">
      <span className="cpt-stat-label">{label}</span>
      <strong className="cpt-stat-value">{value}</strong>
      {sub && <span className="cpt-stat-sub">{sub}</span>}
    </div>
  );
}

