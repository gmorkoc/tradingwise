import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { CoinRow, COINS_MARKETS_URL, TTL, cgFetch, fmtPrice } from "./GlobalMarkets";
import { signalOf } from "./MarketSignalTable";
import { fetchBrief, type BriefItem } from "./DailyBrief";
import { COINS, getCoinGeckoId, fetchFundingRate, getPositionData } from "../services/coinglass";
import "../styles/TradeInsights.css";

// Chart page right column, under Paper Trading (CMC's "BTC Insights" +
// "Why Trade on…" block), built from our own data:
//  - structure: our signal + where price sits vs MA20/50/200
//  - two latest headlines about the coin
//  - 30d range / change, MA position, RSI (CoinGecko daily, 1 year)
//  - derivatives: funding rate + long/short accounts (what the app uses)
//  - "Full analysis" asks the Agent.

type Daily = { t: number; p: number }[];
const YEAR_TTL = 1_800_000;

const sma = (a: number[], n: number) => (a.length >= n ? a.slice(-n).reduce((s, v) => s + v, 0) / n : null);
function rsi14(a: number[]) {
  if (a.length < 15) return null;
  let g = 0, l = 0;
  for (let i = a.length - 14; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const short = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : fmtPrice(v));
const ago = (ms: number) => {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
  return m < 60 ? i18n.t("tradeInsights.agoShort.m", { n: m })
    : m < 1440 ? i18n.t("tradeInsights.agoShort.h", { n: Math.round(m / 60) })
    : i18n.t("tradeInsights.agoShort.d", { n: Math.round(m / 1440) });
};

export function TradeInsights({ coin, onAsk }: {
  coin: string;
  /** Opens the Agent with a full-analysis question. */
  onAsk?: (prompt: string) => void;
}) {
  const name = COINS.find((c) => c.symbol === coin)?.name ?? coin;
  const { t } = useTranslation();
  const [row, setRow] = useState<CoinRow | null>(null);
  const [daily, setDaily] = useState<Daily | null>(null);
  const [news, setNews] = useState<BriefItem[]>([]);
  const [deriv, setDeriv] = useState<{ funding: number | null; long: number | null } | null>(null);
  const [at, setAt] = useState<number>(Date.now());
  // Full read hidden until asked for (remembered).
  const [open, setOpenState] = useState(() => {
    try { return localStorage.getItem("tixOpen") === "1"; } catch { return false; }
  });
  const setOpen = (f: (v: boolean) => boolean) => setOpenState((v) => {
    const n = f(v);
    try { localStorage.setItem("tixOpen", n ? "1" : "0"); } catch { /* ignore */ }
    return n;
  });

  useEffect(() => {
    let alive = true;
    setRow(null); setDaily(null); setNews([]); setDeriv(null);
    cgFetch<CoinRow[]>(COINS_MARKETS_URL, TTL.coins)
      .then((rows) => { if (alive) setRow(rows.find((r) => r.symbol.toUpperCase() === coin) ?? null); })
      .catch(() => {});
    getCoinGeckoId(coin)
      .then((id) => (id ? cgFetch<{ prices?: [number, number][] }>(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`, YEAR_TTL) : null))
      .then((j) => { if (alive && j?.prices) setDaily(j.prices.map(([t, p]) => ({ t, p }))); })
      .catch(() => {});
    fetchBrief()
      .then((items) => {
        if (!alive) return;
        const re = new RegExp(`\\b(${coin}|${name})\\b`, "i");
        const crypto = items.filter((i) => i.category === "crypto");
        const about = crypto.filter((i) => re.test(i.title));
        setNews((about.length ? about : crypto).slice(0, 2));
      })
      .catch(() => {});
    Promise.all([fetchFundingRate(coin).catch(() => null), getPositionData(coin, "1h", 2).catch(() => null)])
      .then(([funding, pos]) => {
        if (!alive) return;
        const r = pos?.retail?.[pos.retail.length - 1];
        setDeriv({ funding, long: r ? r.longRatio * 100 : null });
      });
    setAt(Date.now());
    return () => { alive = false; };
  }, [coin, name]);

  // 30d + moving averages + RSI from the daily closes.
  const closes = daily?.map((d) => d.p) ?? [];
  const last30 = closes.slice(-31);
  const lo30 = last30.length ? Math.min(...last30) : null;
  const hi30 = last30.length ? Math.max(...last30) : null;
  const chg30 = last30.length > 1 ? ((last30[last30.length - 1] - last30[0]) / last30[0]) * 100 : null;
  const px = row?.current_price ?? closes[closes.length - 1] ?? null;
  const ma20 = sma(closes, 20), ma50 = sma(closes, 50), ma200 = sma(closes, 200);
  const rsi = rsi14(closes);
  const above = (m: number | null) => (m != null && px != null ? px >= m : null);

  // Structure: our signal, confirmed (or not) by the MA position.
  const sig = row ? signalOf(row) : null;
  const maUp = [ma20, ma50, ma200].filter((m) => above(m) === true).length;
  const maKnown = [ma20, ma50, ma200].filter((m) => m != null).length;
  const tone: "bull" | "bear" | "mixed" =
    sig?.tone === "bull" && maUp >= 2 ? "bull" : sig?.tone === "bear" && maKnown - maUp >= 2 ? "bear" : "mixed";
  const crowd = deriv?.long == null ? null : deriv.long >= 60 ? t("tradeInsights.crowd.long") : deriv.long <= 40 ? t("tradeInsights.crowd.short") : t("tradeInsights.crowd.balanced");
  const maParts = [
    [ma20, "MA20"], [ma50, "MA50"], [ma200, "MA200"],
  ].filter(([m]) => m != null).map(([m, label]) => ({ label: label as string, up: above(m as number) }));
  // Structure sentence, from full templates: technicals clause, MA clause, crowd clause.
  const maUpList = maParts.filter((m) => m.up).map((m) => m.label).join(" & ");
  const maDnList = maParts.filter((m) => !m.up).map((m) => m.label).join(" & ");
  const maClause = !maParts.length ? ""
    : maUpList && maDnList ? t("tradeInsights.maAboveBelow", { above: maUpList, below: maDnList })
    : maUpList ? t("tradeInsights.maAbove", { above: maUpList })
    : maDnList ? t("tradeInsights.maBelow", { below: maDnList }) : "";
  const structLine = t("tradeInsights.structLine", {
    tech: sig ? t("tradeInsights.techRead", { word: t(`tradeInsights.sigWord.${sig.tone}`), score: sig.score }) : t("tradeInsights.techLoading"),
    ma: maClause,
    crowd: crowd ? t("tradeInsights.crowdClause", { crowd }) : "",
  });

  return (
    <div className="tix">
      <section className="tix-card" aria-label={t("tradeInsights.aria", { coin })}>
        {/* No title row — the structure line leads, "updated" time on its right. */}
        {/* Collapsed by default: just the structure line — "Show" opens the
            full read (headlines, 30d, derivatives, technicals). */}
        <button
          type="button"
          className={`tix-struct tix-struct--${tone} tix-toggle`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <i aria-hidden="true" />
          <b>{t(`tradeInsights.structUpper.${tone}`)}</b>
          {crowd && <span>· {crowd}</span>}
          <span className="tix-show">
            {open ? t("tradeInsights.hide") : t("tradeInsights.show")}
            <svg className={open ? "tix-chev tix-chev--open" : "tix-chev"} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </span>
        </button>
        {open && (<>
        <span className="tix-time tix-time--row">{t("tradeInsights.updated", { ago: ago(at) })}</span>

        {/* Live Hintz: the read as steps (Paper Trading's step-list look) —
            accent bar · icon tile · bold takeaway · plain-language detail.
            Structure leads (highlighted like the active step). */}
        <ol className="tix-steps">
          <li className={`tix-step tix-step--on tix-step--${tone}`}>
            <span className="tix-step-bar" aria-hidden="true" />
            <span className="tix-step-ic" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                {tone === "bear" ? <><path d="M3 7l6 6 4-4 8 8" /><path d="M15 17h6v-6" /></> : <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>}
              </svg>
            </span>
            <span className="tix-step-text">
              <span className="tix-step-t">{t(`tradeInsights.structTitle.${tone}`)}</span>
              <span className="tix-step-s">{structLine}</span>
            </span>
          </li>

          <li className="tix-step">
            <span className="tix-step-bar" aria-hidden="true" />
            <span className="tix-step-ic" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>
            </span>
            <span className="tix-step-text">
              <span className="tix-step-t">
                {lo30 != null && hi30 != null ? (
                  <>{t("tradeInsights.range30", { lo: short(lo30), hi: short(hi30) })}{chg30 != null && <> · <span className={chg30 >= 0 ? "tix-up" : "tix-dn"}>{chg30 >= 0 ? "+" : ""}{chg30.toFixed(1)}%</span></>}</>
                ) : <span className="tix-skel" />}
              </span>
              <span className="tix-step-s">
                {rsi != null
                  ? t(rsi >= 70 ? "tradeInsights.rsi.overbought" : rsi <= 30 ? "tradeInsights.rsi.oversold" : rsi >= 50 ? "tradeInsights.rsi.up" : "tradeInsights.rsi.down", { v: Math.round(rsi) })
                  : t("tradeInsights.rangeFallback")}
              </span>
            </span>
          </li>

          {!(deriv && deriv.funding == null && deriv.long == null) && (
            <li className="tix-step">
              <span className="tix-step-bar" aria-hidden="true" />
              <span className="tix-step-ic" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18" /><path d="M5 8l7-5 7 5" /><path d="M5 16l7 5 7-5" /></svg>
              </span>
              <span className="tix-step-text">
                <span className="tix-step-t">
                  {deriv ? (
                    <>{t("tradeInsights.funding")} <span className={deriv.funding != null && deriv.funding < 0 ? "tix-dn" : "tix-up"}>{deriv.funding != null ? `${deriv.funding >= 0 ? "+" : ""}${deriv.funding.toFixed(4)}%` : "—"}</span></>
                  ) : <span className="tix-skel" />}
                </span>
                <span className="tix-step-s">
                  {deriv?.long != null
                    ? t("tradeInsights.longShare", { pct: deriv.long.toFixed(0), crowd: crowd ?? t("tradeInsights.crowd.balanced") })
                    : t("tradeInsights.futuresFallback")}
                </span>
              </span>
            </li>
          )}

          {news.length > 0 && (
            <li className="tix-step">
              <span className="tix-step-bar" aria-hidden="true" />
              <span className="tix-step-ic" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>
              </span>
              <span className="tix-step-text">
                <span className="tix-step-t">{t("tradeInsights.whatsMoving")}</span>
                {news.map((n) => (
                  <a key={n.url} className="tix-step-s tix-step-link" href={n.url} target="_blank" rel="noopener noreferrer">
                    {n.title}<em> · {ago(n.pubDate)}</em>
                  </a>
                ))}
              </span>
            </li>
          )}
        </ol>

        <div className="tix-foot">
          <span>{t("tradeInsights.nfa")}<br />{t("tradeInsights.poweredBy")}</span>
          {onAsk && (
            <button type="button" className="tix-more" onClick={() => onAsk(t("tradeInsights.askPrompt", { name, coin }))}>
              {t("tradeInsights.fullAnalysis")}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
            </button>
          )}
        </div>
        </>)}
      </section>

    </div>
  );
}
