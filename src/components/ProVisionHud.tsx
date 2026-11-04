// ProVision Signal Check, compact.
// Desktop #trade ("bar"): one clean line above the chart — score, verdict
// and the 7 indicator bars; ⌄ opens the details (buyers vs sellers,
// timeframes, track record) in a dropdown panel under it.
// Phones ("card"): everything stacked, on the page.
import { useEffect, useRef, useState } from "react";
import type { PvResult } from "../services/proVision";
import "../styles/ProVisionHud.css";

type Bias = "bull" | "bear" | "neutral";

interface Props {
  result: PvResult;
  mtf: { label: string; bias: Bias | null }[];
  /** Index into the 7 rows (MA, DMI, Ichimoku, RSI, Stochastic, MACD, Volume). */
  onRow: (r: number) => void;
  /** e.g. "1d 5h" while on the free trial. */
  trialLeft?: string | null;
  onKeep?: () => void;
  onHowTo?: () => void;
  /** One short heads-up (upcoming event, sideways market, short timeframe). */
  notice?: { icon: string; text: string; hot?: boolean } | null;
  /** "bar" = the desktop strip above the chart; "card" = stacked (phones). */
  layout?: "bar" | "card";
}

const ROWS = ["MA", "DMI", "Ichimoku", "RSI", "Stoch", "MACD", "Volume"];
const SEG = 5;

export function ProVisionHud({ result, mtf, onRow, trialLeft, onKeep, onHowTo, notice, layout = "bar" }: Props) {
  const card = layout === "card";
  // Desktop: the details dropdown. Closes on an outside click or Escape.
  const [open, setOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || card) return;
    const onDown = (e: PointerEvent) => {
      if (shellRef.current && !shellRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, card]);
  // Mouse wheel scrolls the line sideways (desktop mice only scroll
  // vertically) while it has more to show. Native listener: React's wheel
  // handler is passive and can't stop the page scrolling.
  const lineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = lineRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      const next = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY));
      if (next === el.scrollLeft) return;
      el.scrollLeft = next;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const vb = result.verdict.bias as Bias;
  const word = vb === "bull" ? "Bullish" : vb === "bear" ? "Bearish" : "Mixed";
  const buy = result.volume.buyPct;
  const sell = result.volume.sellPct;
  const st = result.stats;
  const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);

  // Buyers vs sellers + timeframes, then track record, notice and links.
  const details = (
    <>
      <div className="pvh-line pvh-line--2">
        <div className="pvh-sec-head">
          <span>Buyers vs sellers</span>
          <span className="pvh-track-n">last 20 candles</span>
        </div>
        <div className="pvh-flow" title="Order flow, last 20 candles">
          <span className="pvh-flow-bar" aria-hidden="true"><i style={{ width: `${buy}%` }} /></span>
          <span className="pvh-flow-txt">{buy >= sell ? `Buyers ${buy}%` : `Sellers ${sell}%`}</span>
        </div>
        {mtf.length > 0 && (
          <div className="pvh-tf" aria-label="Timeframes">
            {mtf.map((m) => (
              <span key={m.label} className={`pvh-tf-item pvh-tf--${m.bias ?? "none"}`} title={`${m.label}: ${m.bias === "bull" ? "bullish" : m.bias === "bear" ? "bearish" : m.bias ? "mixed" : "loading"}`}>
                <i aria-hidden="true" />{m.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="pvh-line pvh-line--2 pvh-line--3">
        {/* Track record: every past signal on this chart, scored after fees. */}
        <div className="pvh-track" aria-label="Track record">
          <div className="pvh-track-head">
            <span>Track record</span>
            <span className="pvh-track-n">{st.total} signal{st.total === 1 ? "" : "s"}</span>
          </div>
          <div className="pvh-track-grid">
            <span><em>Hit rate</em><b>{st.winRate === null ? "—" : `${st.winRate}%`}</b></span>
            <span><em>Won / lost</em><b><i className="pvh-up">{st.worked}</i> / <i className="pvh-dn">{st.failed}</i></b></span>
            <span><em>Avg win</em><b className="pvh-up">{pct(st.avgWinPct)}</b></span>
            <span><em>Avg loss</em><b className="pvh-dn">{pct(st.avgLossPct)}</b></span>
          </div>
        </div>
        {notice && (
          <div className={`pvh-notice${notice.hot ? " pvh-notice--hot" : ""}`} role="status">
            <span aria-hidden="true">{notice.icon}</span>{notice.text}
          </div>
        )}
        {(trialLeft || onHowTo) && (
          <div className="pvh-foot">
            {onHowTo && (
              <button type="button" className="pvh-link pvh-link--how" onClick={onHowTo}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
                How it works
              </button>
            )}
            {trialLeft && onKeep && <button type="button" className="pvh-link pvh-link--keep" onClick={onKeep}>Enjoying? Keep it · {trialLeft} left ›</button>}
          </div>
        )}
      </div>
    </>
  );

  return (
    <div ref={shellRef} className={`pvh-shell pvh--${vb}${card ? " pvh-shell--card" : ""}${open ? " pvh-shell--open" : ""}`}>
      {/* ⌄ opens the details dropdown (stays put while the line scrolls). */}
      {!card && (
        <button
          type="button"
          className="pvh-close pvh-close--shell pvh-expand"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide Signal Check details" : "Show Signal Check details"}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      )}
      <div className={`pvh ${card ? "pvh--card" : "pvh--bar"} pvh--${vb}`} role="group" aria-label="ProVision Signal Check">
        <div className="pvh-line" ref={lineRef}>
          <div className="pvh-head">
            <span className="pvh-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>
            </span>
            <span className="pvh-title">Signal Check</span>
            <b className="pvh-score">{result.bullStrength}<span>/100</span></b>
          </div>
          <div className="pvh-verdict">
            <span className="pvh-dot" aria-hidden="true" />
            {word} · {result.verdict.agree} of {result.verdict.total}
          </div>
          <div className="pvh-rows">
            {ROWS.map((name, r) => {
              const b = (result.checks[r] ?? "neutral") as Bias;
              const s = result.checkStrength[r] ?? 0.5;
              const lit = b === "neutral" ? 0 : Math.max(1, Math.round(Math.abs((s - 0.5) * 2) * SEG));
              const label = r === 3 && result.checkReadout[3]?.big ? `RSI ${result.checkReadout[3].big}` : name;
              return (
                <button key={name} type="button" className={`pvh-row pvh-row--${b}`} onClick={() => onRow(r)} title={`${label}: ${b === "bull" ? "bullish" : b === "bear" ? "bearish" : "neutral"}`}>
                  <span className="pvh-row-name">{label}</span>
                  <span className="pvh-bar" aria-hidden="true" style={{ ["--row" as string]: r }}>
                    {Array.from({ length: SEG }, (_, i) => (
                      <i
                        key={`${i}:${lit}:${b}`}
                        className={i < lit ? (i === lit - 1 ? "on tip" : "on") : ""}
                        style={{ ["--k" as string]: i }}
                      />
                    ))}
                  </span>
                  <span className="pvh-arrow" aria-hidden="true">{b === "bull" ? "▲" : b === "bear" ? "▼" : "–"}</span>
                </button>
              );
            })}
          </div>
        </div>
        {card && details}
      </div>
      {/* Desktop: details in a dropdown panel under the strip. */}
      {!card && open && (
        <div className="pvh-drop" role="region" aria-label="Signal Check details">
          <div className={`pvh pvh--card pvh--${vb}`}>{details}</div>
        </div>
      )}
    </div>
  );
}

// Full ProVision Signal panel (phone analysis sheet): score ring + verdict,
// a readable indicator list, buyers vs sellers, timeframes, track record.
const ROW_NAMES = ["MA 20/200", "DMI", "Ichimoku", "RSI", "Stochastic", "MACD", "Volume"];
export function ProVisionSignalPanel({ result, mtf, onRow, trialLeft, onKeep, onHowTo }: Props) {
  const vb = result.verdict.bias as Bias;
  const score = Math.round(Math.max(0, Math.min(100, result.bullStrength)));
  const buy = result.volume.buyPct;
  const sell = result.volume.sellPct;
  const st = result.stats;
  const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
  const value = (r: number) =>
    r < 6 ? (result.tiles[r]?.value ?? "").replace(/\s*[↑↓▲▼]$/, "") : `${buy >= sell ? "Buyers" : "Sellers"} ${Math.max(buy, sell)}%`;
  const tag = (b: Bias | null | undefined) => (b === "bull" ? "BUY" : b === "bear" ? "SELL" : "—");
  const bullN = result.checks.filter((c) => c === "bull").length;
  const bearN = result.checks.filter((c) => c === "bear").length;
  const neutN = result.checks.length - bullN - bearN;
  return (
    <div className={`pvp2 pvp2--${vb}`}>
      {/* Summary: score meter + verdict, like a terminal technicals gauge */}
      <div className="pvp2-hero">
        <div className="pvp2-hero-top">
          <div className="pvp2-hero-l">
            <span className="pvp2-kicker">Signal</span>
            <span className="pvp2-verdict">{vb === "bull" ? "Long bias" : vb === "bear" ? "Short bias" : "Neutral"}</span>
          </div>
          <div className="pvp2-hero-r">
            <span className="pvp2-score">{score}<small>/100</small></span>
            <span className="pvp2-sub">{result.verdict.agree}/{result.verdict.total} confluence</span>
          </div>
        </div>
        <div className="pvp2-meter" aria-hidden="true">
          <div className="pvp2-meter-track"><i className="pvp2-meter-dot" style={{ left: `${score}%` }} /></div>
          <div className="pvp2-meter-scale"><span>Strong sell</span><span>Sell</span><span>Neutral</span><span>Buy</span><span>Strong buy</span></div>
        </div>
        <div className="pvp2-tally">
          <span><em>Buy</em><b className="pvp2-up">{bullN}</b></span>
          <span><em>Neutral</em><b>{neutN}</b></span>
          <span><em>Sell</em><b className="pvp2-dn">{bearN}</b></span>
        </div>
      </div>

      <section className="pvp2-sec">
        <h4>Indicators</h4>
        <div className="pvp2-table">
          <div className="pvp2-th"><span>Name</span><span>Value</span><span>Strength</span><span>Action</span></div>
          {ROW_NAMES.map((name, r) => {
            const b = (result.checks[r] ?? "neutral") as Bias;
            const s = result.checkStrength[r] ?? 0.5;
            const mag = b === "neutral" ? 0 : Math.max(0.12, Math.min(1, Math.abs((s - 0.5) * 2)));
            return (
              <button key={name} type="button" className={`pvp2-row pvp2-row--${b}`} onClick={() => onRow(r)}>
                <span className="pvp2-row-name">{name}</span>
                <span className="pvp2-row-val">{value(r) || "—"}</span>
                <span className="pvp2-div" aria-hidden="true">
                  <i className={b === "bear" ? "l" : "r"} style={{ width: `${(mag * 50).toFixed(1)}%` }} />
                </span>
                <span className="pvp2-act">{tag(b)}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="pvp2-sec">
        <h4>Order flow <span>20 bars</span></h4>
        <div className="pvp2-flow">
          <span className="pvp2-up">{buy}%</span>
          <div className="pvp2-flow-bar" aria-hidden="true">
            <i className="pvp2-flow-buy" style={{ width: `${buy}%` }} />
            <i className="pvp2-flow-sell" style={{ width: `${sell}%` }} />
          </div>
          <span className="pvp2-dn">{sell}%</span>
        </div>
        <div className="pvp2-flow-cap"><span>Buy vol</span><span>Δ {buy - sell > 0 ? "+" : ""}{buy - sell}%</span><span>Sell vol</span></div>
      </section>

      {mtf.length > 0 && (
        <section className="pvp2-sec">
          <h4>Multi-timeframe</h4>
          <div className="pvp2-tf" style={{ gridTemplateColumns: `repeat(${mtf.length}, minmax(0, 1fr))` }}>
            {mtf.map((m) => (
              <span key={m.label} className={`pvp2-tf-cell pvp2-tf--${m.bias ?? "none"}`}>
                <em>{m.label}</em>
                <b>{tag(m.bias as Bias | null)}</b>
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="pvp2-sec">
        <h4>Track record <span>{st.total} signal{st.total === 1 ? "" : "s"}</span></h4>
        <div className="pvp2-stats">
          <span><em>Win rate</em><b>{st.winRate === null ? "—" : `${st.winRate}%`}</b></span>
          <span><em>W / L</em><b><i className="pvp2-up">{st.worked}</i>/<i className="pvp2-dn">{st.failed}</i></b></span>
          <span><em>Avg win</em><b className="pvp2-up">{pct(st.avgWinPct)}</b></span>
          <span><em>Avg loss</em><b className="pvp2-dn">{pct(st.avgLossPct)}</b></span>
        </div>
      </section>

      <div className="pvp2-foot">
        {trialLeft && onKeep && <button type="button" className="pvp2-keep" onClick={onKeep}>Enjoying? Keep it · {trialLeft} left ›</button>}
        {onHowTo && (
          <button type="button" className="pvp2-how" onClick={onHowTo}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
            How it works
          </button>
        )}
      </div>
    </div>
  );
}
