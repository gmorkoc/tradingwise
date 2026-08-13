import { useEffect, useRef } from "react";
import "../styles/MMNarrationFeed.css";

export interface MMFeedEntry {
  id: string;
  time: number;
  price: number;
  mmAction:
    | "liquidity_grab"
    | "stop_hunt"
    | "accumulation"
    | "distribution"
    | "breakout"
    | "retest"
    | "consolidation"
    | "continuation"
    | "reversal";
  bias: "bullish" | "bearish" | "neutral";
  confidence: "high" | "medium" | "low";
  mmReading: string;
}

const ACTION_LABEL: Record<MMFeedEntry["mmAction"], string> = {
  liquidity_grab: "Liquidity Grab",
  stop_hunt: "Stop Hunt",
  accumulation: "Accumulation",
  distribution: "Distribution",
  breakout: "Breakout",
  retest: "Retest",
  consolidation: "Consolidation",
  continuation: "Continuation",
  reversal: "Reversal",
};

function badgeClass(entry: MMFeedEntry): string {
  if (entry.mmAction === "liquidity_grab" || entry.mmAction === "stop_hunt") {
    return "mm-narr-badge--trap";
  }
  if (entry.bias === "bullish") return "mm-narr-badge--bull";
  if (entry.bias === "bearish") return "mm-narr-badge--bear";
  return "mm-narr-badge--neutral";
}

export function MMNarrationFeed({ entries, loading }: { entries: MMFeedEntry[]; loading: boolean }) {
  const prevLen = useRef(0);
  useEffect(() => {
    prevLen.current = entries.length;
  }, [entries.length]);

  const isNewest = entries.length > 0 && entries.length > prevLen.current;
  const ordered = [...entries].reverse();

  return (
    <div className="mm-narr-panel">
      <div className="mm-narr-header">
        <span className="mm-narr-title">
          <span className="mm-narr-live-dot" />
          MM Narration
        </span>
        {loading && <span className="mm-narr-status">narrating…</span>}
      </div>

      {ordered.length === 0 ? (
        <div className="mm-narr-empty">
          {loading ? "Reading the tape…" : "Watching for the next candle close…"}
        </div>
      ) : (
        <div className="mm-narr-list">
          {ordered.map((entry, i) => (
            <div
              key={entry.id}
              className={`mm-narr-row${i === 0 && isNewest ? " mm-narr-row--new" : ""}`}
            >
              <div className="mm-narr-row-top">
                <span className="mm-narr-time">
                  {new Date(entry.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="mm-narr-price">${entry.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                <span className={`mm-narr-badge ${badgeClass(entry)}`}>{ACTION_LABEL[entry.mmAction]}</span>
              </div>
              <div className="mm-narr-reading">{entry.mmReading}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
