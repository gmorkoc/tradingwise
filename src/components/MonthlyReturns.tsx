import { useState, useEffect, useMemo } from "react";
import { coinglass, MonthlyReturn, CoinSymbol } from "../services/coinglass";
import "../styles/MonthlyReturns.css";

interface Props {
  coin?: CoinSymbol;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function cellBg(pct: number): string {
  if (pct >= 80)  return "rgba(34,197,94,1)";
  if (pct >= 50)  return "rgba(34,197,94,0.85)";
  if (pct >= 30)  return "rgba(34,197,94,0.65)";
  if (pct >= 15)  return "rgba(34,197,94,0.45)";
  if (pct >= 5)   return "rgba(34,197,94,0.28)";
  if (pct >= 0)   return "rgba(34,197,94,0.12)";
  if (pct >= -5)  return "rgba(239,68,68,0.12)";
  if (pct >= -15) return "rgba(239,68,68,0.28)";
  if (pct >= -30) return "rgba(239,68,68,0.48)";
  if (pct >= -50) return "rgba(239,68,68,0.68)";
  return "rgba(239,68,68,0.88)";
}

function cellText(pct: number): string {
  const abs = Math.abs(pct);
  if (abs >= 30) return "#fff";
  return pct >= 0 ? "#22c55e" : "#ef4444";
}

function fmtPct(n: number, compact = false): string {
  const abs = Math.abs(n);
  const str = abs >= 100
    ? abs.toFixed(0)
    : abs >= 10
    ? abs.toFixed(1)
    : abs.toFixed(1);
  return (n >= 0 ? "+" : "−") + str + (compact ? "" : "%");
}

export const MonthlyReturns: React.FC<Props> = ({ coin = "BTC" }) => {
  const [data, setData] = useState<MonthlyReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    coinglass.getMonthlyReturns(coin)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError("Failed to load monthly data"); setLoading(false); });
  }, [coin]);

  const byYear = useMemo(() => {
    const map = new Map<number, (MonthlyReturn | null)[]>();
    for (const m of data) {
      if (!map.has(m.year)) map.set(m.year, Array(12).fill(null));
      map.get(m.year)![m.month] = m;
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([year, months]) => {
        const valid = months.filter(Boolean) as MonthlyReturn[];
        const yearPct = valid.length > 0
          ? (valid[valid.length - 1].close / valid[0].open - 1) * 100
          : null;
        return { year, months, yearPct };
      });
  }, [data]);

  const stats = useMemo(() => {
    if (data.length === 0) return null;
    const sorted = [...data].sort((a, b) => b.pct - a.pct);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    const green = data.filter(m => m.pct >= 0).length;
    const avg = data.reduce((s, m) => s + m.pct, 0) / data.length;
    return { best, worst, green, total: data.length, avg };
  }, [data]);

  const monthStats = useMemo(() => {
    return MONTHS.map((_, i) => {
      const ms = data.filter(m => m.month === i);
      if (ms.length === 0) return null;
      const green = ms.filter(m => m.pct >= 0).length;
      const avg = ms.reduce((s, m) => s + m.pct, 0) / ms.length;
      return { green, total: ms.length, avg };
    });
  }, [data]);

  if (loading) {
    return (
      <div className="mr-loading">
        <div className="mr-spinner" />
        <span>Loading historical monthly data…</span>
      </div>
    );
  }

  if (error) return <div className="mr-error">{error}</div>;

  return (
    <div className="mr-wrap">

      {/* ── Summary stats ── */}
      {stats && (
        <div className="mr-stats">
          <div className="mr-stat">
            <span className="mr-stat-label">Green Months</span>
            <span className="mr-stat-val mr-green">{stats.green}/{stats.total} ({((stats.green/stats.total)*100).toFixed(0)}%)</span>
          </div>
          <div className="mr-stat">
            <span className="mr-stat-label">Avg Monthly Return</span>
            <span className={`mr-stat-val ${stats.avg >= 0 ? "mr-green" : "mr-red"}`}>{fmtPct(stats.avg)}</span>
          </div>
          <div className="mr-stat">
            <span className="mr-stat-label">Best Month</span>
            <span className="mr-stat-val mr-green">
              {MONTHS[stats.best.month]} {stats.best.year} {fmtPct(stats.best.pct)}
            </span>
          </div>
          <div className="mr-stat">
            <span className="mr-stat-label">Worst Month</span>
            <span className="mr-stat-val mr-red">
              {MONTHS[stats.worst.month]} {stats.worst.year} {fmtPct(stats.worst.pct)}
            </span>
          </div>
        </div>
      )}

      {/* ── Heatmap ── */}
      <div className="mr-scroll">
        <table className="mr-table">
          <thead>
            <tr>
              <th className="mr-th mr-th--year">Year</th>
              {MONTHS.map(m => <th key={m} className="mr-th">{m}</th>)}
              <th className="mr-th mr-th--total">Total</th>
            </tr>
            {/* Month stats row */}
            <tr className="mr-month-avg-row">
              <td className="mr-year-cell mr-avg-label">Avg</td>
              {monthStats.map((ms, i) => (
                <td key={i} className="mr-avg-cell">
                  {ms ? (
                    <span style={{ color: ms.avg >= 0 ? "#22c55e" : "#ef4444", fontSize: "10px", fontWeight: 600 }}>
                      {fmtPct(ms.avg, true)}%
                    </span>
                  ) : "—"}
                </td>
              ))}
              <td />
            </tr>
          </thead>
          <tbody>
            {byYear.map(({ year, months, yearPct }) => (
              <tr key={year} className="mr-row">
                <td className="mr-year-cell">{year}</td>
                {months.map((m, i) => (
                  <td key={i} className="mr-cell-wrap">
                    {m ? (
                      <div
                        className="mr-cell"
                        style={{ background: cellBg(m.pct), color: cellText(m.pct) }}
                        title={`${MONTHS[i]} ${year}: ${fmtPct(m.pct)}\nOpen: $${m.open.toLocaleString()}\nClose: $${m.close.toLocaleString()}`}
                      >
                        {fmtPct(m.pct, true)}%
                      </div>
                    ) : (
                      <div className="mr-cell mr-cell--empty">—</div>
                    )}
                  </td>
                ))}
                <td className="mr-cell-wrap">
                  {yearPct !== null ? (
                    <div
                      className="mr-cell mr-cell--year"
                      style={{ background: cellBg(yearPct), color: cellText(yearPct) }}
                    >
                      {fmtPct(yearPct, true)}%
                    </div>
                  ) : <div className="mr-cell mr-cell--empty">—</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Month win rate ── */}
      <div className="mr-winrate">
        {MONTHS.map((m, i) => {
          const ms = monthStats[i];
          if (!ms) return null;
          const rate = (ms.green / ms.total) * 100;
          return (
            <div key={m} className="mr-wr-item">
              <span className="mr-wr-month">{m}</span>
              <div className="mr-wr-bar-wrap">
                <div className="mr-wr-bar" style={{ width: `${rate}%`, background: rate >= 50 ? "#22c55e" : "#ef4444" }} />
              </div>
              <span className="mr-wr-pct" style={{ color: rate >= 50 ? "#22c55e" : "#ef4444" }}>
                {rate.toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
      <p className="mr-footnote">Win rate = % of years that month closed green</p>
    </div>
  );
};
