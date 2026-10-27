import { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import type { CoinSymbol, ExchangeRatioRow } from "../services/coinglass";
import { getPositionIntel, PositionIntelRow } from "../services/positionIntel";
import "../styles/PositionIntelligence.css";

// "Position Intelligence" tab next to Paper Trading (Chart page column).
// Long/short positioning of Smart Money (top accounts), Whales (top
// positions) and Retail (all accounts), averaged across OKX and Gate.io
// (services/positionIntel.ts), plus the per-exchange breakdown.
//
// Gating: locked behind a blurred preview with one Unlock button —
//   signed out  → onOpenAuth (sign in / sign up)
//   free tier   → onOpenUpgrade (Pro required)
//   pro / elite → no lock at all, data shows directly.
// Data is only fetched once unlocked, so locked viewers never hit the API.

interface Props {
  coin: CoinSymbol;
  onOpenAuth: () => void;
  onOpenUpgrade: () => void;
  // Off when the surrounding tab row already names the panel.
  showHeader?: boolean;
}

type GroupKey = "whaleAccount" | "whalePosition" | "retail";

const GROUPS: { key: GroupKey; label: string; hint: string; short: string }[] = [
  { key: "whaleAccount", label: "Smart Money", hint: "Top trader accounts", short: "SM" },
  { key: "whalePosition", label: "Whales", hint: "Top trader positions, by size", short: "W" },
  { key: "retail", label: "Retail", hint: "All accounts", short: "R" },
];

// Exchanges publish a new 5-minute point every 5 min; polling every 60s
// picks each one up within a minute of it landing.
const REFRESH_MS = 60 * 1000;

function average(rows: (ExchangeRatioRow | null)[]): ExchangeRatioRow | null {
  const ok = rows.filter((r): r is ExchangeRatioRow => !!r);
  if (!ok.length) return null;
  const longPct = ok.reduce((s, r) => s + r.longPct, 0) / ok.length;
  const shortPct = ok.reduce((s, r) => s + r.shortPct, 0) / ok.length;
  return { longPct, shortPct, ratio: shortPct > 0 ? longPct / shortPct : 1 };
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

const ICONS: Record<GroupKey, JSX.Element> = {
  whaleAccount: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 10h.01M16 10h.01M8.5 15c1 1 2.2 1.5 3.5 1.5s2.5-.5 3.5-1.5" />
    </svg>
  ),
  whalePosition: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 13c0 4 3.5 7 9 7 4.5 0 8-2.5 8-6 0-2-1.2-3.4-3-3.4-1.6 0-2.6 1.1-2.6 2.4" />
      <path d="M20 14c.5-2.8 1.8-4.4 3-5-1.6-.3-3 .2-4 1.2" />
      <circle cx="8" cy="15" r=".8" fill="currentColor" stroke="none" />
    </svg>
  ),
  retail: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </svg>
  ),
};

// One card per group, matching the reference: icon + name and the
// total on the top line, Longs (left) / Shorts (right) under it with the
// winning side colored, then one bar on a gray track filled by the winning
// side (green from the left, or red from the right).
function GroupCard({
  groupKey, label, row, usd, index,
}: {
  groupKey: GroupKey;
  label: string;
  hint: string;
  row: ExchangeRatioRow;
  usd?: { longUsd: number; shortUsd: number };
  index: number;
}) {
  const total = row.longPct + row.shortPct || 1;
  const longShare = (row.longPct / total) * 100;
  const longWins = longShare >= 50;
  return (
    <div className="pi-gc" style={{ animationDelay: `${index * 0.06}s` }}>
      <div className="pi-gc-top">
        <span className="pi-gc-name">
          <span className="pi-gc-icon">{ICONS[groupKey]}</span>
          {label}
        </span>
        <span className="pi-gc-total">
          {usd ? fmtUsd(usd.longUsd + usd.shortUsd) : `L/S ${row.ratio.toFixed(2)}`}
        </span>
      </div>
      <div className="pi-gc-sides">
        <span>
          <span className={longWins ? "pi-long" : "pi-gc-dim"}>Longs</span>{" "}
          {usd ? fmtUsd(usd.longUsd) : `${row.longPct.toFixed(1)}%`}
        </span>
        <span>
          <span className={!longWins ? "pi-short" : "pi-gc-dim"}>Shorts</span>{" "}
          {usd ? fmtUsd(usd.shortUsd) : `${row.shortPct.toFixed(1)}%`}
        </span>
      </div>
      <div className="pi-gc-track">
        <div
          className={`pi-gc-fill ${longWins ? "pi-gc-fill--long" : "pi-gc-fill--short"}`}
          style={{ width: `${longWins ? longShare : 100 - longShare}%` }}
        />
      </div>
    </div>
  );
}

// Placeholder rows for the locked preview — fixed fake values, blurred, so
// the shape of the panel shows through without fetching or leaking data.
const PREVIEW: { key: GroupKey; label: string; hint: string; row: ExchangeRatioRow }[] = [
  { key: "whaleAccount", label: "Smart Money", hint: "Top trader accounts", row: { longPct: 58, shortPct: 42, ratio: 1.38 } },
  { key: "whalePosition", label: "Whales", hint: "Top trader positions", row: { longPct: 51, shortPct: 49, ratio: 1.04 } },
  { key: "retail", label: "Retail", hint: "All accounts", row: { longPct: 44, shortPct: 56, ratio: 0.79 } },
];

export function PositionIntelligence({ coin, onOpenAuth, onOpenUpgrade, showHeader = true }: Props) {
  const { user, tier } = useAuth();
  const unlocked = !!user && (tier === "pro" || tier === "elite");

  const [data, setData] = useState<PositionIntelRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const res = await getPositionIntel(coin);
        if (!cancelled) setData(res);
      } catch {
        if (!cancelled) setData([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setData(null);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [coin, unlocked]);

  const onUnlock = () => {
    if (!user) onOpenAuth();
    else onOpenUpgrade();
  };

  const header = showHeader && (
    <div className="pi-header">
      <span className="pi-title">Position Intelligence</span>
      <span
        className="pi-info"
        title="Long/short split of Smart Money (top accounts), Whales (top positions by size) and Retail (all accounts), averaged across OKX and Gate.io. 5-minute data, refreshed every minute."
        aria-label="About Position Intelligence"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </span>
    </div>
  );

  if (!unlocked) {
    return (
      <div className="pi-card pi-card--locked">
        {header}
        <div className="pi-locked">
          <div className="pi-locked-preview" aria-hidden="true">
            {PREVIEW.map((p, i) => (
              <GroupCard key={p.key} groupKey={p.key} label={p.label} hint={p.hint} row={p.row} index={i} />
            ))}
          </div>
          <div className="pi-locked-overlay">
            <p className="pi-locked-title">See how Smart Money is positioned</p>
            <p className="pi-locked-sub">
              Long/short breakdowns from Smart Money, Whales and Retail traders across OKX and Gate.io.
            </p>
            <button type="button" className="pi-unlock-btn" onClick={onUnlock}>
              Unlock
            </button>
            <p className="pi-locked-note">{user ? "Pro plan required" : "Free account required to start"}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pi-card">
      {header}
      {loading && !data && (
        <div className="pi-skeleton">
          {[0, 1, 2].map((i) => <span key={i} className="pi-skeleton-row" />)}
        </div>
      )}
      {data && data.length === 0 && <div className="pi-empty">Positioning data unavailable for {coin}.</div>}
      {data && data.length > 0 && (
        <>
          {GROUPS.map(({ key, label, hint }, i) => {
            const row = average(data.map((d) => d[key]));
            if (!row) return null;
            // Dollar sizes (Gate.io only) on the Whales row.
            const usd = key === "whalePosition" ? data.find((d) => d.whaleUsd)?.whaleUsd : undefined;
            return <GroupCard key={key} groupKey={key} label={label} hint={hint} row={row} usd={usd} index={i} />;
          })}

          <p className="pi-foot">OKX + Gate.io · 5m data, refreshes every minute · Whale sizes from Gate.io</p>
        </>
      )}
    </div>
  );
}
