// Phones, coin page: "Bitcoin News" in CoinMarketCap's app layout —
// Top | Latest tabs, a big image story, then headline rows (source · time).
// Top = headlines that mention this coin (falls back to crypto news when
// there are none); Latest = every crypto headline, newest first.
import { useEffect, useMemo, useState } from "react";
import { fetchBrief, type BriefItem } from "./DailyBrief";
import { COINS } from "../services/coinglass";
import "../styles/CoinNews.css";

const timeAgo = (ms: number) => {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};

const SHOW = 6;

export function CoinNews({ coin }: { coin: string }) {
  const name = COINS.find((c) => c.symbol === coin)?.name ?? coin;
  const [items, setItems] = useState<BriefItem[] | null>(null);
  const [tab, setTab] = useState<"top" | "latest">("top");
  const [all, setAll] = useState(false);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setAll(false);
    fetchBrief().then((r) => { if (alive) setItems(r); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [coin]);

  const { top, latest, coinOnly } = useMemo(() => {
    const crypto = (items ?? []).filter((i) => i.category === "crypto");
    const re = new RegExp(`\\b(${coin}|${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`, "i");
    const matched = crypto.filter((i) => re.test(i.title));
    return { top: matched.length ? matched : crypto, latest: crypto, coinOnly: matched.length > 0 };
  }, [items, coin, name]);

  const list = tab === "top" ? top : latest;
  // Lead story: the first one with a picture.
  const lead = list.find((i) => i.thumbnail) ?? null;
  const rest = list.filter((i) => i !== lead);
  const shown = all ? rest : rest.slice(0, SHOW - (lead ? 1 : 0));

  return (
    <section className="cnews" aria-label={`${name} news`}>
      <h2 className="cnews-h">{name} News</h2>
      <div className="cnews-seg" role="tablist" aria-label="News">
        {(["top", "latest"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`cnews-seg-btn${tab === k ? " cnews-seg-btn--on" : ""}`}
            onClick={() => { setTab(k); setAll(false); }}
          >
            {k === "top" ? "Top" : "Latest"}
          </button>
        ))}
      </div>

      {!items ? (
        <div className="cnews-skel" aria-label="Loading news">
          <span className="cnews-skel-img" />
          <span className="cnews-skel-line" />
          <span className="cnews-skel-line cnews-skel-line--short" />
        </div>
      ) : !list.length ? (
        <p className="cnews-empty">No headlines right now — check back in a bit.</p>
      ) : (
        <>
          {tab === "top" && !coinOnly && <p className="cnews-note">No {name}-specific headlines right now — latest across crypto.</p>}
          {lead && (
            <a className="cnews-lead" href={lead.url} target="_blank" rel="noreferrer">
              <img className="cnews-lead-img" src={lead.thumbnail} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />
              <strong className="cnews-title">{lead.title}</strong>
              <span className="cnews-meta"><b>{lead.source}</b> • {timeAgo(lead.pubDate)}</span>
            </a>
          )}
          {shown.map((n) => (
            <a key={n.url} className="cnews-row" href={n.url} target="_blank" rel="noreferrer">
              <strong className="cnews-title">{n.title}</strong>
              <span className="cnews-meta"><b>{n.source}</b> • {timeAgo(n.pubDate)}</span>
            </a>
          ))}
          {!all && rest.length > shown.length && (
            <button type="button" className="cnews-more" onClick={() => setAll(true)}>Show more</button>
          )}
        </>
      )}
    </section>
  );
}
