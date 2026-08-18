import { useEffect, useState } from "react";
import { fetchStockMovers, hasStockApiKey, MOVERS_WATCHLIST, type QuoteRow, type StockMovers as StockMoversData } from "../services/marketOverview";
import { usePollWhileVisible } from "../hooks/usePollWhileVisible";
import "../styles/StockMovers.css";

type Tab = "gainers" | "losers" | "active";

const TABS: { key: Tab; label: string }[] = [
  { key: "gainers", label: "Gainers" },
  { key: "losers", label: "Losers" },
  { key: "active", label: "Most Active" },
];

function fmtPrice(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function StockMovers() {
  const [data, setData] = useState<StockMoversData | null>(null);
  const [tab, setTab] = useState<Tab>("gainers");
  const [loading, setLoading] = useState(true);

  // Every 20 minutes, paused while the tab is hidden — TwelveData's free
  // tier is 800 requests/DAY total (shared across every visitor), so this
  // batched call still needs to stay infrequent even though it's just one
  // request per poll.
  useEffect(() => {
    if (!hasStockApiKey) { setLoading(false); return; }
    let cancelled = false;
    fetchStockMovers().then(movers => {
      if (!cancelled) { setData(movers); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []);
  usePollWhileVisible(() => {
    if (!hasStockApiKey) return;
    fetchStockMovers().then(setData);
  }, 20 * 60_000);

  const rows: QuoteRow[] = data
    ? tab === "gainers" ? data.gainers : tab === "losers" ? data.losers : data.mostActive
    : [];

  return (
    <div className="stm-card">
      <div className="stm-header">
        <span className="stm-title">Movers</span>
        <div className="stm-tabs">
          {TABS.map(t => (
            <button
              key={t.key}
              className={`stm-tab${tab === t.key ? " stm-tab--active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {!hasStockApiKey ? (
        <p className="stm-empty">Stock data requires a TwelveData API key.</p>
      ) : loading ? (
        <p className="stm-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="stm-empty">No data available right now.</p>
      ) : (
        <table className="stm-table">
          <tbody>
            {rows.map(r => {
              const up = r.percentChange >= 0;
              return (
                <tr key={r.symbol} className="stm-tr">
                  <td className="stm-td stm-td--sym">
                    <span className="stm-sym">{r.symbol}</span>
                    <span className="stm-name">{r.name}</span>
                  </td>
                  <td className="stm-td stm-td--r">{fmtPrice(r.price)}</td>
                  <td className={`stm-td stm-td--r stm-pct${up ? "--pos" : "--neg"}`}>
                    {up ? "▲" : "▼"} {Math.abs(r.percentChange).toFixed(2)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="stm-disclaimer">
        Ranked within a watchlist of {MOVERS_WATCHLIST.length} liquid US stocks, not the full market · Not financial advice
      </p>
    </div>
  );
}
