import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import {
  fetchPortfolio, fetchClosedPositions, fetchAgentPerformance, closePosition,
  PaperPortfolio, PaperPosition, PositionsListItem, AgentPerformance,
} from "../services/paperTrading";
import { fetchBinancePrices } from "../services/binancePrices";
import { TopCryptoTable, TopCryptoFilter, Filter, FILTERS } from "./TopCryptoTable";
import { TopTradersTable, TopTradersFilter } from "./TopTradersTable";
import { fmtPrice } from "./GlobalMarkets";
import "../styles/GlobalMarkets.css";
import "../styles/ChartBottomPanel.css";
import { useSort, SortTh } from "./SortableTh";

// Chart page (wide desktop), under the chart: one tab row (reference:
// Hyperliquid's bottom panel) — the market table on the left, then the
// viewer's own paper-trading account: open positions, trade history,
// balance and performance. Account tabs need a signed-in user who has
// activated paper trading.

type Tab = "markets" | "toptraders" | "positions" | "history" | "balance" | "performance";
const MARKET_TABS: { key: Tab; label: string }[] = [
  { key: "markets", label: "Cryptocurrencies" },
  { key: "toptraders", label: "Top Traders" },
];
const ACCOUNT_TABS: { key: Tab; label: string }[] = [
  { key: "positions", label: "Positions" },
  { key: "history", label: "History" },
  { key: "balance", label: "Balance" },
  { key: "performance", label: "Performance" },
];

const REFRESH_MS = 15_000;

interface Props {
  coin: string;
  onSelectCoin: (symbol: string) => void;
  onOpenAuth: () => void;
  onOpenPaperTrading: () => void;
}

function usd(n: number, signed = false): string {
  const s = `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (!signed) return n < 0 ? `-${s}` : s;
  return `${n >= 0 ? "+" : "-"}${s}`;
}
function pnlOf(p: PaperPosition, mark: number | undefined): number | null {
  if (mark === undefined) return null;
  return (p.side === "long" ? mark - p.avgEntryPrice : p.avgEntryPrice - mark) * p.qty;
}
function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
const REASON: Record<string, string> = { manual: "Manual", take_profit: "Take profit", stop_loss: "Stop loss", liquidation: "Liquidated" };

export function ChartBottomPanel({ coin, onSelectCoin, onOpenAuth, onOpenPaperTrading }: Props) {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const v = localStorage.getItem("chartBottomTab") as Tab | null;
      return v && [...MARKET_TABS, ...ACCOUNT_TABS].some((t) => t.key === v) ? v : "markets";
    } catch { return "markets"; }
  });
  useEffect(() => { try { localStorage.setItem("chartBottomTab", tab); } catch { /* ignore */ } }, [tab]);
  // Other parts of the Chart page (Paper Trading card's "View all closed
  // positions") can open a tab here and bring the panel into view.
  const rootRef = useRef<HTMLDivElement>(null);
  // Tabs strip: right-edge fade only while there are more tabs to scroll to.
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const [tabsMore, setTabsMore] = useState(false);
  const updateTabsMore = useCallback(() => {
    const el = tabsScrollRef.current;
    if (el) setTabsMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);
  useEffect(() => {
    const el = tabsScrollRef.current;
    if (!el) return;
    updateTabsMore();
    const ro = new ResizeObserver(updateTabsMore);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab, updateTabsMore]);
  useEffect(() => {
    const onOpenTab = (e: Event) => {
      const t = (e as CustomEvent<{ tab?: Tab }>).detail?.tab;
      if (!t) return;
      setTab(t);
      requestAnimationFrame(() => rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    };
    window.addEventListener("chart-bottom-tab", onOpenTab);
    return () => window.removeEventListener("chart-bottom-tab", onOpenTab);
  }, []);
  // Arrived from another page's "View all closed positions": the tab was
  // already set via localStorage; once the chart above has laid out,
  // bring this panel into view.
  useEffect(() => {
    let pending = false;
    try { pending = sessionStorage.getItem("chartBottomScroll") === "1"; sessionStorage.removeItem("chartBottomScroll"); } catch { /* ignore */ }
    if (!pending) return;
    const id = window.setTimeout(() => rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 600);
    return () => window.clearTimeout(id);
  }, []);
  // Market table filter lives here so its dropdown can sit in the tab row.
  const [filter, setFilter] = useState<Filter>(() => {
    try {
      const v = localStorage.getItem("topCryptoFilter");
      return (FILTERS.some((f) => f.key === v) ? v : "all") as Filter;
    } catch { return "all"; }
  });
  useEffect(() => { try { localStorage.setItem("topCryptoFilter", filter); } catch { /* ignore */ } }, [filter]);
  const [ttFilter, setTtFilter] = useState<TopTradersFilter>("winners");

  const [portfolio, setPortfolio] = useState<PaperPortfolio | null>(null);
  const [closed, setClosed] = useState<PositionsListItem[] | null>(null);
  const [perf, setPerf] = useState<AgentPerformance | null>(null);
  const [marks, setMarks] = useState<Map<string, number>>(new Map());
  const [closing, setClosing] = useState<string | null>(null);

  const loadAccount = useCallback(async () => {
    if (!user) return;
    try {
      const [pf, cl, pr] = await Promise.all([
        fetchPortfolio(user.id),
        fetchClosedPositions(user.id),
        fetchAgentPerformance(user.id),
      ]);
      setPortfolio(pf);
      setClosed(cl.slice().reverse());
      setPerf(pr);
      const syms = [...new Set(pf.positions.map((p) => p.coin))];
      if (syms.length) {
        const m = await fetchBinancePrices(syms);
        setMarks(new Map([...m].map(([k, v]) => [k, v.price])));
      }
    } catch { /* keep last good data */ }
  }, [user]);

  // Account data only while an account tab is open.
  useEffect(() => {
    if (tab === "markets" || !user) return;
    loadAccount();
    const id = window.setInterval(loadAccount, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [tab, user, loadAccount]);

  const positions = portfolio?.positions ?? [];
  // Click-to-sort headers on the Positions and History tables.
  const { sorted: sortedPositions, sort: posSort } = useSort(positions, {
    coin: (p) => p.coin,
    side: (p) => p.side,
    size: (p) => p.qty,
    entry: (p) => p.avgEntryPrice,
    mark: (p) => marks.get(p.coin),
    pnl: (p) => pnlOf(p, marks.get(p.coin)),
    margin: (p) => p.marginUsd,
    liq: (p) => p.liquidationPrice,
    opened: (p) => Date.parse(p.updatedAt),
  });
  const { sorted: sortedClosed, sort: histSort } = useSort(closed ?? [], {
    coin: (c) => c.coin,
    side: (c) => c.side,
    size: (c) => c.qty,
    entry: (c) => c.avgEntryPrice,
    exit: (c) => c.exitPrice,
    pnl: (c) => c.realizedPnl,
    reason: (c) => c.closeReason ?? null,
    opened: (c) => (c.openedAt ? Date.parse(c.openedAt) : null),
    closed: (c) => (c.closedAt ? Date.parse(c.closedAt) : null),
  });
  const activated = !!portfolio?.consentAcceptedAt;

  const onClose = async (p: PaperPosition) => {
    if (!user) return;
    const key = `${p.coin}-${p.market}-${p.side}`;
    setClosing(key);
    try { await closePosition(user.id, p); await loadAccount(); } finally { setClosing(null); }
  };

  const accountGate = () => {
    if (!user) {
      return (
        <div className="cbp-gate">
          <p>Sign in to see your paper trading positions, history and performance.</p>
          <button type="button" className="cbp-gate-btn" onClick={onOpenAuth}>Sign in</button>
        </div>
      );
    }
    if (portfolio && !activated) {
      return (
        <div className="cbp-gate">
          <p>Activate paper trading to start tracking positions here.</p>
          <button type="button" className="cbp-gate-btn" onClick={onOpenPaperTrading}>Activate paper trading</button>
        </div>
      );
    }
    if (!portfolio) return <div className="cbp-empty">Loading…</div>;
    return null;
  };

  const renderPositions = () => {
    const gate = accountGate();
    if (gate) return gate;
    if (!positions.length) return <div className="cbp-empty">No open positions.</div>;
    return (
      <div className="gm-table-wrap">
        <table className="gm-table cbp-table">
          <thead>
            <tr>
              <SortTh label="Coin" k="coin" sort={posSort} />
              <SortTh label="Side" k="side" sort={posSort} />
              <SortTh className="gm-th gm-th--r" label="Size" k="size" sort={posSort} />
              <SortTh className="gm-th gm-th--r" label="Entry" k="entry" sort={posSort} />
              <SortTh className="gm-th gm-th--r" label="Mark" k="mark" sort={posSort} />
              <SortTh className="gm-th gm-th--r" label="PnL" k="pnl" sort={posSort} />
              <SortTh className="gm-th gm-th--r" label="Margin" k="margin" sort={posSort} />
              <SortTh className="gm-th gm-th--r" label="Liq. price" k="liq" sort={posSort} />
              <th className="gm-th gm-th--r">TP / SL</th>
              <SortTh className="gm-th gm-th--r" label="Opened" k="opened" sort={posSort} />
              <th className="gm-th gm-th--r" />
            </tr>
          </thead>
          <tbody>
            {sortedPositions.map((p) => {
              const mark = marks.get(p.coin);
              const pnl = pnlOf(p, mark);
              const pct = pnl !== null && p.marginUsd > 0 ? (pnl / p.marginUsd) * 100 : null;
              const key = `${p.coin}-${p.market}-${p.side}`;
              return (
                <tr key={key} className="gm-tr" onClick={() => onSelectCoin(p.coin)}>
                  <td className="gm-td"><b>{p.coin}</b><span className="cbp-muted"> {p.market === "futures" ? `${p.leverage}x` : "Spot"}</span></td>
                  <td className={`gm-td ${p.side === "long" ? "gm-pct--pos" : "gm-pct--neg"}`}>{p.side === "long" ? "Long" : "Short"}</td>
                  <td className="gm-td gm-td--r">{p.qty.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                  <td className="gm-td gm-td--r">{fmtPrice(p.avgEntryPrice)}</td>
                  <td className="gm-td gm-td--r">{mark !== undefined ? fmtPrice(mark) : "—"}</td>
                  <td className={`gm-td gm-td--r ${pnl === null ? "" : pnl >= 0 ? "gm-pct--pos" : "gm-pct--neg"}`}>
                    {pnl === null ? "—" : `${usd(pnl, true)}${pct !== null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : ""}`}
                  </td>
                  <td className="gm-td gm-td--r">{usd(p.marginUsd)}</td>
                  <td className="gm-td gm-td--r">{p.liquidationPrice ? fmtPrice(p.liquidationPrice) : "—"}</td>
                  <td className="gm-td gm-td--r">
                    {p.takeProfitPrice ? fmtPrice(p.takeProfitPrice) : "—"} / {p.stopLossPrice ? fmtPrice(p.stopLossPrice) : "—"}
                  </td>
                  <td className="gm-td gm-td--r cbp-muted">{when(p.updatedAt)}</td>
                  <td className="gm-td gm-td--r">
                    <button
                      type="button"
                      className="cbp-close-btn"
                      disabled={closing === key}
                      onClick={(e) => { e.stopPropagation(); onClose(p); }}
                    >
                      {closing === key ? "Closing…" : "Close"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderHistory = () => {
    const gate = accountGate();
    if (gate) return gate;
    if (!closed) return <div className="cbp-empty">Loading…</div>;
    if (!closed.length) return <div className="cbp-empty">No closed trades yet.</div>;
    return (
      <div className="gm-table-wrap">
        <table className="gm-table cbp-table">
          <thead>
            <tr>
              <SortTh label="Coin" k="coin" sort={histSort} />
              <SortTh label="Side" k="side" sort={histSort} />
              <SortTh className="gm-th gm-th--r" label="Size" k="size" sort={histSort} />
              <SortTh className="gm-th gm-th--r" label="Entry" k="entry" sort={histSort} />
              <SortTh className="gm-th gm-th--r" label="Exit" k="exit" sort={histSort} />
              <SortTh className="gm-th gm-th--r" label="Realized PnL" k="pnl" sort={histSort} />
              <SortTh className="gm-th gm-th--r" label="Reason" k="reason" sort={histSort} />
              <SortTh className="gm-th gm-th--r" label="Opened" k="opened" sort={histSort} />
              <SortTh className="gm-th gm-th--r" label="Closed" k="closed" sort={histSort} />
            </tr>
          </thead>
          <tbody>
            {sortedClosed.map((c, i) => (
              <tr key={`${c.coin}-${c.closedAt}-${i}`} className="gm-tr" onClick={() => onSelectCoin(c.coin)}>
                <td className="gm-td"><b>{c.coin}</b><span className="cbp-muted"> {c.market === "futures" ? `${c.leverage}x` : "Spot"}</span></td>
                <td className={`gm-td ${c.side === "long" ? "gm-pct--pos" : "gm-pct--neg"}`}>{c.side === "long" ? "Long" : "Short"}</td>
                <td className="gm-td gm-td--r">{c.qty.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                <td className="gm-td gm-td--r">{fmtPrice(c.avgEntryPrice)}</td>
                <td className="gm-td gm-td--r">{c.exitPrice !== undefined ? fmtPrice(c.exitPrice) : "—"}</td>
                <td className={`gm-td gm-td--r ${(c.realizedPnl ?? 0) >= 0 ? "gm-pct--pos" : "gm-pct--neg"}`}>
                  {c.realizedPnl !== undefined ? usd(c.realizedPnl, true) : "—"}
                </td>
                <td className="gm-td gm-td--r cbp-muted">{c.closeReason ? REASON[c.closeReason] ?? c.closeReason : "—"}</td>
                <td className="gm-td gm-td--r cbp-muted">{when(c.openedAt)}</td>
                <td className="gm-td gm-td--r cbp-muted">{when(c.closedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderBalance = () => {
    const gate = accountGate();
    if (gate) return gate;
    const cash = portfolio!.cashBalance;
    const margin = positions.reduce((s, p) => s + p.marginUsd, 0);
    const unrealized = positions.reduce((s, p) => s + (pnlOf(p, marks.get(p.coin)) ?? 0), 0);
    const equity = cash + margin + unrealized;
    return (
      <div className="cbp-stats">
        <div className="cbp-stat"><span>Equity</span><b>{usd(equity)}</b></div>
        <div className="cbp-stat"><span>Cash</span><b>{usd(cash)}</b></div>
        <div className="cbp-stat"><span>In positions (margin)</span><b>{usd(margin)}</b></div>
        <div className="cbp-stat"><span>Unrealized PnL</span><b className={unrealized >= 0 ? "gm-pct--pos" : "gm-pct--neg"}>{usd(unrealized, true)}</b></div>
        <div className="cbp-stat"><span>Open positions</span><b>{positions.length}</b></div>
      </div>
    );
  };

  const renderPerformance = () => {
    const gate = accountGate();
    if (gate) return gate;
    if (!perf) return <div className="cbp-empty">Loading…</div>;
    return (
      <div className="cbp-stats">
        <div className="cbp-stat"><span>Realized PnL</span><b className={perf.totalPnl >= 0 ? "gm-pct--pos" : "gm-pct--neg"}>{usd(perf.totalPnl, true)}</b></div>
        <div className="cbp-stat"><span>Win rate</span><b>{perf.winRate !== null ? `${(perf.winRate * (perf.winRate <= 1 ? 100 : 1)).toFixed(1)}%` : "—"}</b></div>
        <div className="cbp-stat"><span>Closed trades</span><b>{perf.totalClosed}</b></div>
        <div className="cbp-stat"><span>Wins</span><b className="gm-pct--pos">{perf.wins}</b></div>
        <div className="cbp-stat"><span>Losses</span><b className="gm-pct--neg">{perf.losses}</b></div>
      </div>
    );
  };

  const tabBtn = (t: { key: Tab; label: string }) => (
    <button
      key={t.key}
      type="button"
      role="tab"
      aria-selected={tab === t.key}
      className={`cbp-tab${tab === t.key ? " active" : ""}`}
      onClick={(e) => {
        setTab(t.key);
        // Slide a half-hidden tab fully into view.
        e.currentTarget.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
      }}
    >
      {t.label}
      {t.key === "positions" && positions.length > 0 && <span className="cbp-tab-count">{positions.length}</span>}
    </button>
  );

  return (
    <div className="cbp" ref={rootRef}>
      <div className="cbp-tabs" role="tablist">
        {/* Tabs in their own strip so they can scroll sideways on phones
            while the filter (right) stays put. */}
        <div className={`cbp-tabs-scroll-wrap${tabsMore ? " cbp-tabs-scroll-wrap--more" : ""}`}>
        <div className="cbp-tabs-scroll" ref={tabsScrollRef} onScroll={updateTabsMore}>
        {/* Divider between every market tab, and before the account tabs. */}
        {MARKET_TABS.map((t, i) => (
          <span key={t.key} style={{ display: "contents" }}>
            {i > 0 && <span className="cbp-tabs-divider" />}
            {tabBtn(t)}
          </span>
        ))}
        <span className="cbp-tabs-divider" />
        {ACCOUNT_TABS.map(tabBtn)}
        </div>
        </div>
        {tab === "markets" && (
          <div className="cbp-tabs-right">
            <TopCryptoFilter filter={filter} onChange={setFilter} />
          </div>
        )}
        {tab === "toptraders" && user && (
          <div className="cbp-tabs-right">
            <select
              className="cbp-tt-filter"
              value={ttFilter}
              onChange={(e) => setTtFilter(e.target.value as TopTradersFilter)}
              aria-label="Filter top traders"
            >
              <option value="winners">Winners</option>
              <option value="losers">Losers</option>
              <option value="all">All</option>
            </select>
          </div>
        )}
      </div>
      <div className="cbp-body">
        {tab === "markets" && <TopCryptoTable filterable filter={filter} onSelectCoin={onSelectCoin} />}
        {tab === "toptraders" && (user ? <TopTradersTable coin={coin} filter={ttFilter} /> : (
          // Top Traders needs an account (free).
          <div className="cbp-gate">
            <p>Sign in to see what Hyperliquid's top traders are holding on {coin}.</p>
            <button type="button" className="cbp-gate-btn" onClick={onOpenAuth}>Sign in</button>
          </div>
        ))}
        {tab === "positions" && renderPositions()}
        {tab === "history" && renderHistory()}
        {tab === "balance" && renderBalance()}
        {tab === "performance" && renderPerformance()}
      </div>
    </div>
  );
}
