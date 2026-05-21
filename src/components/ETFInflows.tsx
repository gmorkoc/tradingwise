import { useEffect, useState } from "react";
import { getETFData, ETFData, ETFDayTotal } from "../services/etf";
import "../styles/ETFInflows.css";

const fmtUsd = (v: number, decimals = 1): string => {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : v > 0 ? "+" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(decimals)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(decimals)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(decimals)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

const cls = (v: number) => (v > 0 ? "positive" : v < 0 ? "negative" : "zero");

function FlowBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? (Math.abs(value) / max) * 100 : 0;
  return (
    <div className="etf-flow-bar-wrap">
      <div className={`etf-flow-bar-fill ${cls(value)}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function HistoryChart({ history, selectedDate, onSelect }: {
  history: ETFDayTotal[];
  selectedDate: string | null;
  onSelect: (date: string) => void;
}) {
  const recent = history.slice(-30);
  const maxAbs = Math.max(...recent.map(d => Math.abs(d.flowUsd)), 1);
  return (
    <div className="etf-chart-card">
      <div className="etf-chart-title">Daily Net Inflow — 30 Days (USD)</div>
      <div className="etf-hist-bars">
        {recent.map((day, i) => {
          const pct = (Math.abs(day.flowUsd) / maxAbs) * 96;
          const isPos = day.flowUsd >= 0;
          const isSelected = day.date === selectedDate;
          return (
            <div
              key={i}
              className={`etf-hist-col${isSelected ? " selected" : ""}`}
              title={`${day.date}\n${fmtUsd(day.flowUsd)}\nBTC: $${day.priceUsd.toLocaleString()}`}
              onClick={() => onSelect(day.date)}
            >
              <div className="etf-hist-bar-wrap">
                <div
                  className={`etf-hist-bar ${isPos ? "pos" : "neg"}`}
                  style={{ height: `${Math.max(pct, 2)}%` }}
                />
              </div>
              {i % 5 === 0 && <div className="etf-bar-label">{day.date.slice(5)}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function DatePicker({ history, selectedDate, onSelect }: {
  history: ETFDayTotal[];
  selectedDate: string | null;
  onSelect: (date: string | null) => void;
}) {
  const dataMap = Object.fromEntries(history.map(d => [d.date, d]));
  const months = [...new Set(history.map(d => d.date.slice(0, 7)))].sort();
  const today = new Date().toISOString().slice(0, 10);
  const [monthIdx, setMonthIdx] = useState(months.length - 1);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"days" | "months">("days");
  const years = [...new Set(months.map(m => m.slice(0, 4)))].sort();
  const [yearIdx, setYearIdx] = useState(years.length - 1);
  if (!months.length) return null;

  const month = months[monthIdx];
  const [year, mon] = month.split("-").map(Number);
  const label = new Date(year, mon - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  const visibleYear = years[yearIdx];
  const daysInMonth = new Date(year, mon, 0).getDate();
  const firstDow = new Date(year, mon - 1, 1).getDay();
  const cells: (string | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      `${month}-${String(i + 1).padStart(2, "0")}`
    ),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const headerLabel = selectedDate
    ? (() => { const [y,m,d] = selectedDate.split("-"); const mn = new Date(+y,+m-1,1).toLocaleString("en-US",{month:"short"}); return `${mn} - ${d} - ${y.slice(2)}`; })()
    : label;

  return (
    <div className={`etf-cal-wrap${open ? " open" : ""}`}>
      <div className="etf-cal-head">
        <button className="etf-cal-nav" onClick={e => {
          e.stopPropagation();
          if (view === "months") setYearIdx(i => Math.max(0, i - 1));
          else { setMonthIdx(i => Math.max(0, i - 1)); }
        }} disabled={view === "months" ? yearIdx === 0 : monthIdx === 0} style={{ visibility: open ? "visible" : "hidden" }}>‹</button>
        <span className="etf-cal-month" onClick={() => { if (!open) { setOpen(true); setView("days"); } else if (view === "days") { setYearIdx(years.indexOf(String(year))); setView("months"); } else { setView("days"); } }} style={{ cursor: "pointer", flex: 1, textAlign: "center" }}>
          {view === "months" && open ? visibleYear : headerLabel}
          <span className="etf-cal-chevron">{open ? (view === "months" ? " ▲" : " ▼") : " ▼"}</span>
        </span>
        <button className="etf-cal-nav" onClick={e => {
          e.stopPropagation();
          if (view === "months") setYearIdx(i => Math.min(years.length - 1, i + 1));
          else { setMonthIdx(i => Math.min(months.length - 1, i + 1)); }
        }} disabled={view === "months" ? yearIdx === years.length - 1 : monthIdx === months.length - 1} style={{ visibility: open ? "visible" : "hidden" }}>›</button>
      </div>

      {open && view === "months" && (
        <div className="etf-cal-month-list">
          {months.filter(m => m.startsWith(visibleYear)).map((m, i) => {
            const [, mm] = m.split("-").map(Number);
            const mlabel = new Date(+visibleYear, mm - 1, 1).toLocaleString("en-US", { month: "short" });
            return (
              <button
                key={i}
                className={`etf-cal-month-item${m === month ? " active" : ""}`}
                onClick={() => { setMonthIdx(months.indexOf(m)); setView("days"); }}
              >
                {mlabel}
              </button>
            );
          })}
        </div>
      )}

      {open && view === "days" && (
        <>
          <div className="etf-cal-grid">
            {WEEKDAYS.map((w, i) => <div key={i} className="etf-cal-wd">{w}</div>)}
            {cells.map((date, i) => {
              if (!date) return <div key={i} />;
              const day = dataMap[date];
              const isSelected = date === selectedDate;
              const isToday = date === today;
              const flowCls = !day ? "" : day.flowUsd > 0 ? " inflow" : " outflow";
              return (
                <button
                  key={date}
                  className={`etf-cal-day${flowCls}${isSelected ? " selected" : ""}${isToday && !isSelected ? " today" : ""}${!day ? " muted" : ""}`}
                  onClick={() => { if (day) { onSelect(isSelected ? null : date); setOpen(false); } }}
                  title={day ? fmtUsd(day.flowUsd) : undefined}
                  disabled={!day}
                >
                  {parseInt(date.slice(8))}
                </button>
              );
            })}
          </div>
          <div className="etf-cal-footer">
            <button className="etf-cal-action" onClick={() => { onSelect(null); setOpen(false); }}>Clear</button>
            <button className="etf-cal-action accent" onClick={() => {
              const todayMonth = today.slice(0, 7);
              const ti = months.indexOf(todayMonth);
              if (ti >= 0) setMonthIdx(ti);
              if (dataMap[today]) { onSelect(today); setOpen(false); }
            }}>Today</button>
          </div>
        </>
      )}
    </div>
  );
}

export function ETFInflows() {
  const [data,         setData]         = useState<ETFData | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState("");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [retryKey,     setRetryKey]     = useState(0);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    setError("");

    getETFData()
      .then(d => { if (!dead) { setData(d); setLoading(false); } })
      .catch(err => { if (!dead) { setError(err?.message ?? "Failed"); setLoading(false); } });

    const id = setInterval(() => {
      getETFData().then(d => { if (!dead) setData(d); }).catch(() => {});
    }, 5 * 60 * 1000);

    return () => { dead = true; clearInterval(id); };
  }, [retryKey]);

  if (loading) {
    return (
      <div className="etf-wrap">
        <div className="etf-loading"><div className="etf-spinner" />Loading ETF data…</div>
      </div>
    );
  }

  if (error || !data || data.rows.length === 0) {
    return (
      <div className="etf-wrap">
        <div className="etf-error">
          {error || "No data available."}
          {error && <button className="etf-retry" onClick={() => setRetryKey(k => k + 1)}>Retry</button>}
        </div>
      </div>
    );
  }

  // Resolve which day's per-fund data to show
  const historyDay = selectedDate
    ? data.history.find(d => d.date === selectedDate) ?? null
    : null;

  const flowMap: Record<string, number> = {};
  if (historyDay) {
    historyDay.perFund.forEach(f => { flowMap[f.etf_ticker] = f.flow_usd; });
  }

  const sorted = [...data.rows].sort((a, b) => b.aumUsd - a.aumUsd).map(r => ({
    ...r,
    dailyFlowUsd: historyDay ? (flowMap[r.ticker] ?? 0) : r.dailyFlowUsd,
  }));

  const totalFlow = sorted.reduce((s, r) => s + r.dailyFlowUsd, 0);
  const totalAum  = data.rows.reduce((s, r) => s + r.aumUsd, 0);
  const totalVol  = data.rows.reduce((s, r) => s + r.volumeUsd, 0);
  const maxAbsFlow = Math.max(...sorted.map(r => Math.abs(r.dailyFlowUsd)), 1);

  const latest30 = data.history.slice(-30);
  const inDays  = latest30.filter(d => d.flowUsd > 0).length;
  const outDays = latest30.filter(d => d.flowUsd < 0).length;

  const displayDate = historyDay ? historyDay.date : data.latestDate;

  return (
    <div className="etf-wrap">
      <div className="etf-header">
        <div>
          <h2 className="etf-title">Bitcoin Spot ETF Tracker</h2>
          <div className="etf-date">
            Data from Coinglass · {displayDate} · {inDays} inflow days / {outDays} outflow days (30d)
          </div>
        </div>
      </div>

      {/* Date filter */}
      <DatePicker
        history={data.history}
        selectedDate={selectedDate}
        onSelect={setSelectedDate}
      />

      {/* Summary cards */}
      <div className="etf-summary-row">
        <div className="etf-summary-card">
          <div className="etf-summary-label">Net Flow{historyDay ? ` · ${historyDay.date}` : ""}</div>
          <div className={`etf-summary-value ${cls(totalFlow)}`}>{fmtUsd(totalFlow)}</div>
        </div>
        <div className="etf-summary-card">
          <div className="etf-summary-label">Total AUM</div>
          <div className="etf-summary-value">{fmtUsd(totalAum, 2)}</div>
        </div>
        <div className="etf-summary-card">
          <div className="etf-summary-label">Daily Volume</div>
          <div className="etf-summary-value">{fmtUsd(totalVol)}</div>
        </div>
      </div>

      {/* 30-day inflow/outflow bar chart */}
      <HistoryChart
        history={data.history}
        selectedDate={selectedDate}
        onSelect={d => setSelectedDate(prev => prev === d ? null : d)}
      />

      {/* Per-fund table */}
      <div className="etf-table-card">
        <table className="etf-table">
          <thead>
            <tr>
              <th>Fund</th>
              <th>Daily Flow</th>
              <th>Price</th>
              <th>Day %</th>
              <th>AUM</th>
              <th>Volume</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => (
              <tr key={row.ticker}>
                <td>
                  <div className="etf-ticker">{row.ticker}</div>
                  <div className="etf-name-sub">{row.name}</div>
                </td>
                <td className="etf-flow-cell">
                  <div className={`etf-flow-val ${cls(row.dailyFlowUsd)}`}>
                    {row.dailyFlowUsd === 0 ? "–" : fmtUsd(row.dailyFlowUsd)}
                  </div>
                  <FlowBar value={row.dailyFlowUsd} max={maxAbsFlow} />
                </td>
                <td className="etf-flow-cell">
                  <div className="etf-flow-val zero">
                    ${row.priceUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                </td>
                <td className="etf-flow-cell">
                  <div className={`etf-flow-val ${cls(row.priceChangePct)}`}>
                    {fmtPct(row.priceChangePct)}
                  </div>
                </td>
                <td className="etf-aum">{row.aumUsd > 0 ? fmtUsd(row.aumUsd, 2) : "–"}</td>
                <td className="etf-aum">{row.volumeUsd > 0 ? fmtUsd(row.volumeUsd) : "–"}</td>
              </tr>
            ))}
            <tr className="etf-total-row">
              <td>Total ({data.rows.length} funds)</td>
              <td className="etf-flow-cell">
                <div className={`etf-flow-val ${cls(totalFlow)}`}>{fmtUsd(totalFlow)}</div>
              </td>
              <td></td>
              <td></td>
              <td className="etf-aum">{fmtUsd(totalAum, 2)}</td>
              <td className="etf-aum">{fmtUsd(totalVol)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
