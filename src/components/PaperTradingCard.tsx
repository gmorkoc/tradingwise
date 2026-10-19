import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../contexts/AuthContext";
import { CoinSymbol, fetchLivePrice } from "../services/coinglass";
import {
  fetchPortfolio, fetchAgentPerformance, closePosition, executeTrade, updateCashBalance,
  PaperPortfolio, AgentPerformance, PaperPosition, AgentAction,
} from "../services/paperTrading";
import { LiquidationGauge } from "./LiquidationGauge";
import "../styles/PaperTradingCard.css";

interface Props {
  // Defaults the inline open-position form to whatever's on the chart
  // right now — the other reason to open the full page (App.tsx:
  // setActiveSection("riskcalc")) is TradeManager's own richer flows
  // (beginner wizard, AI review), not a missing capability here.
  coin: CoinSymbol;
  onOpen: () => void;
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "+";
  return `${n === 0 ? "" : sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function positionKey(p: PaperPosition): string {
  return `${p.coin}:${p.market}`;
}

// Same helper TradingAgent.tsx keeps for its own cash-balance edit field —
// lets digits and a single decimal point through, no stepper UI (what a
// bare type="number" would otherwise show).
function sanitizeAmountInput(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
}

// executeTrade's "blended leverage" math (paperTrading.ts) is a real
// division, not a clean input — adding to an existing position lands on
// values like 2.0000000000000004x, floating-point noise rather than a
// genuine fractional leverage. Rounded for display only.
function fmtLev(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

// Same math closePosition (paperTrading.ts) itself uses to settle P&L on
// close — mirrored here (not imported, that logic lives inside the
// service call, not as its own exported helper) just to show a live
// number before the user actually closes anything.
function unrealizedPnl(pos: PaperPosition, price: number | undefined): number | null {
  if (price === undefined) return null;
  if (pos.market === "spot") return (price - pos.avgEntryPrice) * pos.qty;
  return pos.side === "long"
    ? (price - pos.avgEntryPrice) * pos.qty
    : (pos.avgEntryPrice - price) * pos.qty;
}

// Spot positions have no liquidation price (LiquidationGauge hard-
// requires one, so it renders nothing for them) — this is the same
// "mirror the missing bound around entry" trick that component uses
// internally, just generalized to plain stop-loss/take-profit instead of
// liquidation specifically, so a spot position with either (or both) set
// still gets a live progress bar. Null when NEITHER bound is set —
// nothing meaningful to show a range against.
function spotRangeBar(entry: number, tp: number | null, sl: number | null, current: number) {
  if (tp == null && sl == null) return null;
  const low = sl ?? (2 * entry - (tp as number));
  const high = tp ?? (2 * entry - (sl as number));
  if (high === low) return null;
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  return {
    pct: clamp(((current - low) / (high - low)) * 100),
    entryPct: clamp(((entry - low) / (high - low)) * 100),
    low,
    high,
  };
}


// Free-tier home-page card, right above OrderFlowPanel — real paper
// portfolio data (same service TradeManager.tsx/TradingAgent.tsx both
// read/write), with positions opened, watched live, and closed directly
// here instead of requiring a nav trip to the full page for any of it.
export function PaperTradingCard({ coin, onOpen }: Props) {
  const { user } = useAuth();
  const [portfolio, setPortfolio] = useState<PaperPortfolio | null>(null);
  const [perf, setPerf] = useState<AgentPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Fullscreen option — same content, rendered a second time (not instead
  // of, alongside) inside a portaled modal when true, so the inline card
  // never has to unmount/remount or lose its own scroll position.
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Editable cash balance — same manual-override pattern as TradingAgent.tsx's
  // own portfolio header (startEditCash/saveCash there), same underlying
  // updateCashBalance call.
  const [editingCash, setEditingCash] = useState(false);
  const [cashDraft, setCashDraft] = useState("");
  const [savingCash, setSavingCash] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);

  // Inline "open a position" form state.
  const [formOpen, setFormOpen] = useState(false);
  const [market, setMarket] = useState<"spot" | "futures">("spot");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amountUsd, setAmountUsd] = useState("100");
  const [leverage, setLeverage] = useState("2");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadPortfolio = async (userId: string) => {
    const [p, perfRes] = await Promise.all([
      fetchPortfolio(userId),
      fetchAgentPerformance(userId),
    ]);
    setPortfolio(p);
    setPerf(perfRes);
  };

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        await loadPortfolio(user.id);
      } catch {
        // Loading state just clears below either way — this card has no
        // dedicated error copy, a quiet "—" in each stat is enough for a
        // glance-only summary (the full page has real error handling).
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Live prices for whatever coins are actually open right now, PLUS the
  // form's own currently-selected coin (so the price preview and a just-
  // submitted trade both have a fresh number) — polled continuously, same
  // "watch it live" behavior the native app's own positions list has
  // (TradingAgent.tsx's livePrice, feeding its own LiquidationGauge).
  useEffect(() => {
    const coins = Array.from(new Set([
      ...(portfolio?.positions ?? []).map((p) => p.coin),
      coin,
    ]));
    let cancelled = false;
    const poll = async () => {
      const entries = await Promise.all(coins.map(async (c) => [c, await fetchLivePrice(c)] as const));
      if (cancelled) return;
      setLivePrices((prev) => {
        const next = { ...prev };
        for (const [c, price] of entries) if (price !== null) next[c] = price;
        return next;
      });
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [portfolio, coin]);

  const startEditCash = () => {
    if (!portfolio) return;
    setCashError(null);
    setCashDraft(String(portfolio.cashBalance));
    setEditingCash(true);
  };

  const saveCash = async () => {
    if (!user) return;
    const value = Number(cashDraft);
    if (!Number.isFinite(value) || value < 0) {
      setCashError("Enter a non-negative number.");
      return;
    }
    setSavingCash(true);
    setCashError(null);
    try {
      await updateCashBalance(user.id, value);
      await loadPortfolio(user.id);
      setEditingCash(false);
    } catch (err) {
      setCashError(err instanceof Error ? err.message : "Couldn't update cash balance.");
    } finally {
      setSavingCash(false);
    }
  };

  const handleClose = async (pos: PaperPosition) => {
    if (!user) return;
    const key = positionKey(pos);
    setClosingKey(key);
    try {
      await closePosition(user.id, pos);
      await loadPortfolio(user.id);
    } catch {
      // Quiet failure, same reasoning as the initial load above.
    } finally {
      setClosingKey(null);
    }
  };

  const handleSubmitOpen = async () => {
    if (!user) return;
    const amount = parseFloat(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) { setFormError("Enter a valid amount."); return; }
    const lev = market === "futures" ? Math.min(20, Math.max(1, parseFloat(leverage) || 1)) : 1;
    const tp = parseFloat(takeProfit);
    const sl = parseFloat(stopLoss);
    const action: AgentAction = {
      side, coin, market, amountUsd: amount, leverage: lev,
      takeProfit: Number.isFinite(tp) && tp > 0 ? tp : null,
      stopLoss: Number.isFinite(sl) && sl > 0 ? sl : null,
      reason: "Opened from home page", price: null,
    };
    setSubmitting(true);
    setFormError(null);
    try {
      await executeTrade(user.id, action);
      await loadPortfolio(user.id);
      setFormOpen(false);
      setTakeProfit("");
      setStopLoss("");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not open that position.");
    } finally {
      setSubmitting(false);
    }
  };

  const positions = portfolio?.positions ?? [];
  const openCount = positions.length;
  const formPrice = livePrices[coin];

  const body = (
    <>
      <div className="ptc-header">
        <span className="ptc-title">Paper Trading</span>
        <div className="ptc-header-right">
          <span className="ptc-live-badge"><span className="ptc-pulse-dot" />LIVE</span>
        </div>
      </div>

      {!user && (
        <>
          <p className="ptc-sub">Practice with real market prices and zero real risk.</p>
          <button type="button" className="ptc-cta" onClick={onOpen}>Start paper trading</button>
        </>
      )}

      {user && loading && (
        <div className="ptc-skeleton">
          <div className="ptc-skeleton-stats">
            <span className="ptc-skeleton-box" />
            <span className="ptc-skeleton-box" />
            <span className="ptc-skeleton-box" />
          </div>
          <span className="ptc-skeleton-row" />
          <span className="ptc-skeleton-row" style={{ width: "70%" }} />
        </div>
      )}

      {user && !loading && (
        <>
          <div className="ptc-stats">
            <div className="ptc-stat">
              {editingCash ? (
                <span className="ptc-cash-edit">
                  <span className="ptc-cash-edit-prefix">$</span>
                  <input
                    type="text"
                    autoFocus
                    className="ptc-cash-edit-input"
                    value={cashDraft}
                    disabled={savingCash}
                    onChange={(e) => setCashDraft(sanitizeAmountInput(e.target.value))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveCash();
                      if (e.key === "Escape") setEditingCash(false);
                    }}
                    onBlur={saveCash}
                  />
                </span>
              ) : (
                <button type="button" className="ptc-stat-value ptc-stat-value--editable" onClick={startEditCash}>
                  {portfolio ? `$${portfolio.cashBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
                </button>
              )}
              <span className="ptc-stat-label">Cash</span>
              {cashError && <span className="ptc-cash-error">{cashError}</span>}
            </div>
            <div className="ptc-stat">
              <span className="ptc-stat-value">{openCount}</span>
              <span className="ptc-stat-label">Open</span>
            </div>
            <div className="ptc-stat">
              <span className={`ptc-stat-value${perf && perf.totalPnl !== 0 ? (perf.totalPnl > 0 ? " ptc-up" : " ptc-down") : ""}`}>
                {perf ? fmtUsd(perf.totalPnl) : "—"}
              </span>
              <span className="ptc-stat-label">Realized P&L</span>
            </div>
          </div>

          {openCount > 0 && (
            <div className="ptc-positions">
              {positions.map((pos) => {
                const key = positionKey(pos);
                const livePrice = livePrices[pos.coin];
                const pnl = unrealizedPnl(pos, livePrice);
                const isExpanded = expandedKey === key;
                return (
                  <div key={key} className="ptc-position-wrap">
                    <button
                      type="button"
                      className="ptc-position"
                      onClick={() => setExpandedKey(isExpanded ? null : key)}
                    >
                      <div className="ptc-position-main">
                        <span className={`ptc-position-side ptc-position-side--${pos.side}`}>
                          {pos.side === "long" ? "LONG" : "SHORT"}
                        </span>
                        <span className="ptc-position-coin">{pos.coin}</span>
                        {pos.leverage > 1 && <span className="ptc-position-lev">{fmtLev(pos.leverage)}x</span>}
                        <span className="ptc-position-qty">
                          {pos.qty} @ ${pos.avgEntryPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </span>
                      </div>
                      <div className="ptc-position-right">
                        <span className={`ptc-position-pnl${pnl !== null ? (pnl >= 0 ? " ptc-up" : " ptc-down") : ""}`}>
                          {pnl !== null ? fmtUsd(pnl) : "…"}
                        </span>
                        <button
                          type="button"
                          className="ptc-close-btn"
                          onClick={(e) => { e.stopPropagation(); handleClose(pos); }}
                          disabled={closingKey === key}
                        >
                          {closingKey === key ? "…" : "Close"}
                        </button>
                        <span className={`ptc-chevron${isExpanded ? " ptc-chevron--open" : ""}`}>▾</span>
                      </div>
                    </button>
                    {/* Always visible once open (not gated behind expand) —
                        same as TradingAgent.tsx's own positions list: this
                        is the "watch it live" view, the click-to-expand
                        detail below is extra context on top of it. */}
                    {pos.market === "futures" && pos.liquidationPrice != null && livePrice ? (
                      <div className="ptc-gauge-wrap">
                        <LiquidationGauge
                          side={pos.side}
                          entryPrice={pos.avgEntryPrice}
                          liquidationPrice={pos.liquidationPrice}
                          takeProfitPrice={pos.takeProfitPrice ?? null}
                          currentPrice={livePrice}
                        />
                      </div>
                    ) : pos.market === "spot" && livePrice ? (() => {
                      const bar = spotRangeBar(pos.avgEntryPrice, pos.takeProfitPrice, pos.stopLossPrice, livePrice);
                      if (!bar) return null;
                      return (
                        <div className="ptc-gauge-wrap">
                          <div className="ptc-range-bar">
                            <div className="ptc-range-track">
                              <span className="ptc-range-entry-tick" style={{ left: `${bar.entryPct}%` }} title={`Entry $${pos.avgEntryPrice.toLocaleString()}`} />
                              <span className="ptc-range-marker" style={{ left: `${bar.pct}%` }} />
                            </div>
                            <div className="ptc-range-labels">
                              <span className="ptc-range-label ptc-range-label--sl">SL ${bar.low.toLocaleString()}</span>
                              <span className="ptc-range-label ptc-range-label--tp">TP ${bar.high.toLocaleString()}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })() : null}
                    {/* Always mounted (not gated behind isExpanded) — the
                        grid-template-rows 0fr/1fr transition below needs
                        real content present to animate TO; conditionally
                        rendering it would just pop in/out with no slide. */}
                    <div className={`ptc-position-detail${isExpanded ? " ptc-position-detail--open" : ""}`}>
                      <div className="ptc-position-detail-inner">
                        <div className="ptc-detail-row"><span>Side</span><strong>{pos.market === "futures" ? `${pos.side === "long" ? "LONG" : "SHORT"} ${fmtLev(pos.leverage)}x` : "SPOT"}</strong></div>
                        <div className="ptc-detail-row"><span>Size</span><strong>{pos.qty} {pos.coin}</strong></div>
                        <div className="ptc-detail-row"><span>Entry</span><strong>${pos.avgEntryPrice.toLocaleString()}</strong></div>
                        <div className="ptc-detail-row"><span>Current</span><strong>{livePrice ? `$${livePrice.toLocaleString()}` : "—"}</strong></div>
                        {pos.market === "futures" && pos.liquidationPrice != null && (
                          <div className="ptc-detail-row"><span>Liquidation</span><strong>${pos.liquidationPrice.toLocaleString()}</strong></div>
                        )}
                        {pos.takeProfitPrice != null && (
                          <div className="ptc-detail-row"><span>Take Profit</span><strong className="ptc-up">${pos.takeProfitPrice.toLocaleString()}</strong></div>
                        )}
                        {pos.stopLossPrice != null && (
                          <div className="ptc-detail-row"><span>Stop Loss</span><strong className="ptc-down">${pos.stopLossPrice.toLocaleString()}</strong></div>
                        )}
                        <div className="ptc-detail-row"><span>Opened</span><strong>{new Date(pos.updatedAt).toLocaleString()}</strong></div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!formOpen && (
            <button type="button" className="ptc-new-position" onClick={() => setFormOpen(true)}>
              + Open {coin} position
            </button>
          )}

          {formOpen && (
            <div className="ptc-form">
              <div className="ptc-form-row">
                <div className="ptc-segmented">
                  <button type="button" className={market === "spot" ? "ptc-segment ptc-segment--active" : "ptc-segment"} onClick={() => setMarket("spot")}>Spot</button>
                  <button type="button" className={market === "futures" ? "ptc-segment ptc-segment--active" : "ptc-segment"} onClick={() => setMarket("futures")}>Futures</button>
                </div>
                <div className="ptc-segmented">
                  <button
                    type="button"
                    className={`ptc-segment ptc-segment--buy${side === "buy" ? " ptc-segment--active" : ""}`}
                    onClick={() => setSide("buy")}
                  >
                    {market === "futures" ? "Long" : "Buy"}
                  </button>
                  <button
                    type="button"
                    className={`ptc-segment ptc-segment--sell${side === "sell" ? " ptc-segment--active" : ""}`}
                    onClick={() => setSide("sell")}
                  >
                    {market === "futures" ? "Short" : "Sell"}
                  </button>
                </div>
              </div>
              <div className="ptc-form-row">
                <label className="ptc-field">
                  <span>Amount (USD)</span>
                  <input type="number" min="1" value={amountUsd} onChange={(e) => setAmountUsd(e.target.value)} />
                </label>
                {market === "futures" && (
                  <label className="ptc-field ptc-field--narrow">
                    <span>Leverage</span>
                    <input type="number" min="1" max="20" value={leverage} onChange={(e) => setLeverage(e.target.value)} />
                  </label>
                )}
              </div>
              <div className="ptc-form-row">
                <label className="ptc-field">
                  <span>Take Profit (optional)</span>
                  <input type="number" min="0" placeholder="$" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} />
                </label>
                <label className="ptc-field">
                  <span>Stop Loss (optional)</span>
                  <input type="number" min="0" placeholder="$" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
                </label>
              </div>
              {formPrice !== undefined && (
                <span className="ptc-form-price">{coin} live: ${formPrice.toLocaleString()}</span>
              )}
              {formError && <span className="ptc-form-error">{formError}</span>}
              <div className="ptc-form-row">
                <button type="button" className="ptc-form-cancel" onClick={() => { setFormOpen(false); setFormError(null); }}>Cancel</button>
                <button type="button" className="ptc-cta" onClick={handleSubmitOpen} disabled={submitting}>
                  {submitting ? "Opening…" : "Open position"}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <button
        type="button"
        className="ptc-agent-nudge"
        onClick={() => window.dispatchEvent(new CustomEvent("open-trading-agent"))}
      >
        <span className="ptc-agent-nudge-link">Not sure what to trade? Ask Agent ready.</span>
      </button>

      {/* Promotes the full Trade Manager page (App.tsx: setActiveSection
          "riskcalc") — this card covers open/close/manage already, but
          the full page has the richer flows (beginner wizard, AI review)
          this one deliberately doesn't try to replicate. */}
      <button type="button" className="ptc-page-link" onClick={onOpen}>
        Want more tools? Open the full Trade Manager →
      </button>
    </>
  );

  return (
    <>
      {/* Double-click anywhere on the card toggles fullscreen — same
          double-click-to-expand convention the chart canvas itself uses
          (.chart-dblclick-wrap, PriceChart.tsx), no dedicated button. */}
      <div className="ptc-card" onDoubleClick={() => setIsFullscreen((v) => !v)}>{body}</div>
      {isFullscreen && createPortal(
        <div className="ptc-modal-backdrop" onClick={() => setIsFullscreen(false)}>
          <div
            className="ptc-card ptc-card--modal"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => { e.stopPropagation(); setIsFullscreen(false); }}
          >
            {body}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
