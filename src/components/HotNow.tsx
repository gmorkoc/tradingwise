// Desktop Markets page: the pinned first card of the stories carousel — a
// live feed that scrolls upward every few seconds, mixing breaking news,
// sudden coin moves and this week's high-impact macro releases. Static in
// place (the carousel rotates beside it); pauses while hovered.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BriefItem } from "./DailyBrief";
import { getMacroEvents, type MacroEvent } from "../services/macroEvents";

export type HotCoin = {
  symbol: string; name: string; image: string; market_cap_rank: number;
  current_price: number;
  price_change_percentage_24h: number | null;
  price_change_percentage_1h_in_currency?: number | null;
};

type Kind = "breaking" | "news" | "drop" | "pump" | "macro";
interface Hot { key: string; kind: Kind; title: string; sub: string; img?: string; open?: () => void }

const STEP_MS = 3800;   // one item scrolls up this often
const ROW_H = 74;       // fixed row height so the scroll is exact
const VISIBLE = 5;

const price = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: n >= 1 ? 2 : 4, maximumFractionDigits: n >= 1 ? 2 : 6 })}`;

export function HotNow({ news, coins, onSelectCoin, openLink }: {
  news: BriefItem[];
  coins: HotCoin[];
  onSelectCoin: (symbol: string) => void;
  openLink: (url: string) => void;
}) {
  const { t } = useTranslation();
  const [macro, setMacro] = useState<MacroEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = () => getMacroEvents().then((e) => { if (alive) setMacro(e); }).catch(() => {});
    load();
    const a = window.setInterval(load, 30 * 60_000);
    const b = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { alive = false; window.clearInterval(a); window.clearInterval(b); };
  }, []);

  const items = useMemo<Hot[]>(() => {
    const ago = (ts: number) => {
      const m = Math.max(1, Math.round((now - ts) / 60_000));
      return m < 60 ? t("marketStories.ago.m", { n: m }) : t("marketStories.ago.h", { n: Math.round(m / 60) });
    };
    // Macro: due in the next 24h, or released in the last 2h — soonest first.
    const macroItems: Hot[] = macro
      .filter((e) => e.time > now - 2 * 3600_000 && e.time < now + 24 * 3600_000)
      .sort((a, b) => Math.abs(a.time - now) - Math.abs(b.time - now))
      .slice(0, 3)
      .map((e) => {
        const mins = Math.round((e.time - now) / 60_000);
        const when = mins >= 60 ? t("marketStories.hot.inH", { n: Math.round(mins / 60) })
          : mins > 0 ? t("marketStories.hot.inM", { n: mins })
          : -mins < 60 ? t("marketStories.hot.outM", { n: Math.max(1, -mins) })
          : t("marketStories.hot.outH", { n: Math.round(-mins / 60) });
        return {
          key: `m:${e.title}:${e.time}`,
          kind: "macro" as const,
          title: e.title,
          sub: e.forecast ? `${when} · ${t("marketStories.hot.forecast", { v: e.forecast })}` : when,
        };
      });
    // Sudden moves: top-100 coins moving ≥1.5% in the last hour (or ≥7% in
    // 24h when there's no hourly figure).
    const moves: Hot[] = coins
      .filter((c) => c.market_cap_rank && c.market_cap_rank <= 100 && !/usd|dai/i.test(c.symbol))
      .map((c) => {
        const h1 = c.price_change_percentage_1h_in_currency;
        const d1 = c.price_change_percentage_24h;
        const use1h = h1 != null && Math.abs(h1) >= 1.5;
        const use24 = !use1h && d1 != null && Math.abs(d1) >= 7;
        return { c, pct: use1h ? h1! : use24 ? d1! : null, use1h };
      })
      .filter((x) => x.pct != null)
      .sort((a, b) => Math.abs(b.pct!) - Math.abs(a.pct!))
      .slice(0, 6)
      .map(({ c, pct, use1h }) => {
        const sym = c.symbol.toUpperCase();
        const p = `${pct! > 0 ? "+" : ""}${pct!.toFixed(2)}`;
        return {
          key: `c:${sym}`,
          kind: pct! < 0 ? "drop" as const : "pump" as const,
          title: t(use1h ? "marketStories.hot.move1h" : "marketStories.hot.move24h", { sym, pct: p }),
          sub: t("marketStories.hot.price", { price: price(c.current_price) }),
          img: c.image,
          open: () => onSelectCoin(sym),
        };
      });
    // News, newest first; under 90 minutes old counts as breaking.
    const newsItems: Hot[] = [...news]
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(0, 12)
      .map((n) => ({
        key: `n:${n.url}`,
        kind: now - n.pubDate < 90 * 60_000 ? "breaking" as const : "news" as const,
        title: n.title,
        sub: `${n.source} · ${ago(n.pubDate)}`,
        open: () => openLink(n.url),
      }));
    // Interleave so the feed never runs one type for long: macro first,
    // then news / move / news …
    const out: Hot[] = [...macroItems];
    let ni = 0, mi = 0;
    while (ni < newsItems.length || mi < moves.length) {
      if (ni < newsItems.length) out.push(newsItems[ni++]);
      if (ni < newsItems.length && newsItems[ni].kind === "breaking") out.push(newsItems[ni++]);
      if (mi < moves.length) out.push(moves[mi++]);
    }
    return out;
  }, [news, coins, macro, now, t, onSelectCoin, openLink]);

  // Upward ticker: shift by one row (animated), then rotate the list.
  const [offset, setOffset] = useState(0);
  const [shifting, setShifting] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  useEffect(() => {
    if (items.length <= VISIBLE) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = window.setInterval(() => {
      if (pausedRef.current || document.hidden) return;
      if (reduce) { setOffset((o) => o + 1); return; }
      setShifting(true);
      window.setTimeout(() => { setShifting(false); setOffset((o) => o + 1); }, 520);
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, [items.length]);

  const n = items.length;
  const rows = n === 0 ? [] : Array.from({ length: Math.min(n, VISIBLE + 1) }, (_, k) => items[(offset + k) % n]);

  return (
    <div
      className="hot"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="hot-head">
        <span className="hot-pulse" aria-hidden="true" />
        <span className="hot-title">{t("marketStories.hot.title")}</span>
        <span className="hot-live">{t("marketStories.live")}</span>
      </div>
      <div className="hot-window" style={{ height: ROW_H * VISIBLE }}>
        {rows.length === 0 ? (
          <div className="hot-empty">{t("marketStories.hot.empty")}</div>
        ) : (
          <ul
            className={`hot-list${shifting ? " hot-list--shift" : ""}`}
            style={{ ["--hot-row" as string]: `${ROW_H}px` }}
          >
            {rows.map((it, k) => (
              <li
                key={`${it.key}:${k}`}
                className={`hot-row hot-row--${it.kind}${k === (shifting ? 1 : 0) ? " hot-row--top" : ""}`}
                style={{ height: ROW_H }}
              >
                <button type="button" className="hot-btn" onClick={(e) => { e.stopPropagation(); it.open?.(); }} disabled={!it.open}>
                  {it.img ? <img className="hot-coin" src={it.img} alt="" loading="lazy" /> : <span className={`hot-ic hot-ic--${it.kind}`} aria-hidden="true" />}
                  <span className="hot-text">
                    <span className="hot-meta">
                      <span className={`hot-tag hot-tag--${it.kind}`}>{t(`marketStories.hot.${it.kind}`)}</span>
                      <span className="hot-sub">{it.sub}</span>
                    </span>
                    <span className="hot-line">{it.title}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
