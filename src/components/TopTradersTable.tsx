import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { fmtPrice } from "./GlobalMarkets";
import "../styles/GlobalMarkets.css";
import "../styles/TopTradersTable.css";
import { useSort, SortTh } from "./SortableTh";

// "Top Traders" tab (Trade page bottom panel): Hyperliquid's top traders'
// open positions on the current coin, from public.hl_top_traders (filled
// every 5 min by the hl-top-traders edge function). Public data — no
// sign-in needed.

export type TopTradersFilter = "winners" | "losers" | "all";

interface Row {
  coin: string;
  address: string;
  label: string;
  side: "long" | "short";
  size: number;
  position_value: number;
  entry_px: number;
  mark_px: number;
  liquidation_px: number | null;
  leverage: number;
  unrealized_pnl: number;
  roe: number;
  funding: number;
  account_value: number;
  updated_at: string;
}

const REFRESH_MS = 60_000;
// Same page size as Top Cryptocurrencies, so the panel height is the same
// on both tabs.
const PAGE_SIZE = 15;

// Compact dollars: $17.81M, $987.10K, $640.
function fmtBig(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(a / 1e3).toFixed(2)}K`;
  return `$${a.toFixed(0)}`;
}
function signedUsd(n: number): string {
  return `${n >= 0 ? "+" : "-"}${fmtBig(Math.abs(n))}`;
}
// "Whale · Smart Money · Swing Trader" → "Whale · Smart Money" (the
// trading style only shows when it's the only tag); full label on hover.
function shortLabel(label: string): string {
  const parts = label.split(" · ");
  return parts.length > 1 ? parts.filter((p) => !/Trader$/.test(p)).join(" · ") : label;
}
function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
function ago(iso: string | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export function TopTradersTable({ coin, filter }: { coin: string; filter: TopTradersFilter }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data, error: err } = await supabase
        .from("hl_top_traders")
        .select("*")
        .eq("coin", coin)
        .order("unrealized_pnl", { ascending: false })
        .limit(200);
      if (!alive) return;
      if (err) { setError(true); setRows([]); return; }
      setError(false);
      setRows((data ?? []) as Row[]);
    };
    setRows(null);
    load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [coin]);

  const shown = useMemo(() => {
    if (!rows) return [];
    if (filter === "winners") return rows.filter((r) => r.unrealized_pnl > 0);
    if (filter === "losers") return rows.filter((r) => r.unrealized_pnl < 0).sort((a, b) => a.unrealized_pnl - b.unrealized_pnl);
    return rows;
  }, [rows, filter]);

  const liqDistOf = (r: Row) =>
    r.liquidation_px && r.mark_px ? Math.abs(r.liquidation_px - r.mark_px) / r.mark_px : null;
  const { sorted, sort } = useSort(shown, {
    trader: (r) => r.label,
    pnl: (r) => r.unrealized_pnl,
    value: (r) => r.position_value,
    entry: (r) => r.entry_px,
    liq: liqDistOf,
    funding: (r) => r.funding,
    acct: (r) => r.account_value,
  });
  useEffect(() => { setPage(1); }, [coin, filter, sort.key, sort.dir]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paged = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const updated = rows?.[0]?.updated_at;

  return (
    <div className="ttt">
      <div className="gm-table-wrap">
        <table className="gm-table ttt-table">
          <colgroup>
            <col style={{ width: 60 }} />
            <col />
            <col style={{ width: "13%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "10%" }} />
          </colgroup>
          <thead>
            <tr>
              <th className="gm-th">Chart</th>
              <SortTh label="Trader" k="trader" sort={sort} />
              <SortTh className="gm-th gm-th--r" label="Unrealized PnL" k="pnl" sort={sort} />
              <SortTh className="gm-th gm-th--r" label="Position Value" k="value" sort={sort} />
              <SortTh className="gm-th gm-th--r" label="Entry" k="entry" sort={sort} />
              <SortTh className="gm-th gm-th--r" label="Liquidation" k="liq" sort={sort} title="Sorts by distance to liquidation" />
              <SortTh className="gm-th gm-th--r" label="Funding" k="funding" sort={sort} />
              <SortTh className="gm-th gm-th--r" label="Account Value" k="acct" sort={sort} />
            </tr>
          </thead>
          <tbody>
            {paged.map((r) => {
              const liqDist = r.liquidation_px && r.mark_px
                ? (Math.abs(r.liquidation_px - r.mark_px) / r.mark_px) * 100
                : null;
              return (
                <tr key={r.address} className="gm-tr ttt-tr">
                  <td className="gm-td">
                    <a
                      className="ttt-chart-link"
                      href={`https://app.hyperliquid.xyz/explorer/address/${r.address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open this trader on Hyperliquid"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="3" />
                        <path d="M7 15l3-3 3 2 4-5" />
                      </svg>
                    </a>
                  </td>
                  <td className="gm-td ttt-trader" title={`${r.label} · ${r.address}`}>
                    <span className={`ttt-side ttt-side--${r.side}`}>{r.side === "long" ? "LONG" : "SHORT"}</span>
                    <span className="ttt-label">{shortLabel(r.label)}</span>
                    <span className="ttt-addr">[{shortAddr(r.address)}]</span>
                  </td>
                  <td className={`gm-td gm-td--r ${r.unrealized_pnl >= 0 ? "gm-pct--pos" : "gm-pct--neg"}`}>
                    {signedUsd(r.unrealized_pnl)}
                    <span className="ttt-sub">{r.roe >= 0 ? "+" : ""}{(r.roe * 100).toFixed(2)}%</span>
                  </td>
                  <td className="gm-td gm-td--r">
                    {fmtBig(r.position_value)}
                    <span className={`ttt-lev ttt-lev--${r.side}`}>{Math.round(r.leverage)}X</span>
                  </td>
                  <td className="gm-td gm-td--r">{fmtPrice(r.entry_px)}</td>
                  <td className="gm-td gm-td--r">
                    {r.liquidation_px ? fmtPrice(r.liquidation_px) : "—"}
                    {liqDist !== null && <span className="ttt-sub ttt-muted">{liqDist.toFixed(2)}%</span>}
                  </td>
                  <td className={`gm-td gm-td--r ${r.funding >= 0 ? "gm-pct--pos" : "gm-pct--neg"}`}>
                    {signedUsd(r.funding)}
                  </td>
                  <td className="gm-td gm-td--r">{fmtBig(r.account_value)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows === null && <div className="cbp-empty">Loading top traders…</div>}
        {rows !== null && shown.length === 0 && (
          <div className="cbp-empty">
            {error
              ? "Top traders data isn't available yet."
              : `No ${filter === "all" ? "" : filter === "winners" ? "winning " : "losing "}top-trader positions on ${coin} right now.`}
          </div>
        )}
      </div>
      <div className="gm-pagination">
        <span className="gm-pagination-info">
          {shown.length ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, shown.length)} of ${shown.length}` : "0 of 0"}
          {updated && <span className="ttt-foot-inline"> · Hyperliquid top traders by 30-day PnL · updated {ago(updated)}</span>}
        </span>
        <div className="gm-pagination-controls">
          <button type="button" className="gm-page-btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">‹</button>
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
            .map((p, i, arr) => (
              <span key={p} style={{ display: "contents" }}>
                {i > 0 && arr[i - 1] !== p - 1 && <span className="gm-page-ellipsis">…</span>}
                <button type="button" className={`gm-page-btn${p === page ? " gm-page-btn--active" : ""}`} onClick={() => setPage(p)}>{p}</button>
              </span>
            ))}
          <button type="button" className="gm-page-btn" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">›</button>
        </div>
      </div>
    </div>
  );
}
