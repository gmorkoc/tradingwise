import { useState, useEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import { COINS, CoinSymbol } from "../services/coinglass";
import "../styles/GlobalSearch.css";

/* ── Types ─────────────────────────────────────────────────────────────────── */
export type SectionId =
  | "chart" | "candleai" | "feargreed" | "heatmap" | "onchain" | "gann"
  | "htf" | "chat" | "etf" | "positions" | "orderflow" | "signals"
  | "fundingbot" | "markets";

interface SearchResult {
  id: string;
  type: "coin" | "section";
  primary: string;
  secondary: string;
  icon: string;
  action: () => void;
}

const COIN_ICONS: Record<string, string> = {
  BTC: "₿", ETH: "Ξ", XRP: "◈", SOL: "◎", BNB: "⬡", SUI: "⬟",
  DOGE: "Ð", ADA: "₳", NEAR: "Ⓝ", RENDER: "⬡", ZEC: "ⓩ",
};

const SECTIONS: { id: SectionId; label: string; desc: string; icon: string }[] = [
  { id: "chart",      label: "Price Chart",       desc: "Live candlestick chart with indicators",     icon: "📈" },
  { id: "candleai",   label: "Candle AI",          desc: "AI pattern analysis, smart money, forecasts", icon: "✦" },
  { id: "feargreed",  label: "Fear & Greed",       desc: "Market sentiment gauge",                     icon: "🌡" },
  { id: "heatmap",    label: "Liquidation Heatmap",desc: "Futures liquidation zones",                  icon: "🔥" },
  { id: "onchain",    label: "On-Chain Metrics",   desc: "Network data and whale activity",            icon: "⛓" },
  { id: "etf",        label: "ETF Inflows",        desc: "Bitcoin ETF flow tracker",                   icon: "🏦" },
  { id: "positions",  label: "Positions & Flows",  desc: "Long/short ratios and taker volume",         icon: "⚖" },
  { id: "htf",        label: "HTF Analysis",       desc: "Higher timeframe structure and bias",        icon: "🔭" },
  { id: "orderflow",  label: "Order Flow",         desc: "Footprint chart and delta analysis",         icon: "📊" },
  { id: "signals",    label: "Signals",            desc: "AI-generated trade signals",                 icon: "⚡" },
  { id: "fundingbot", label: "Funding Bot",        desc: "Funding rates across exchanges",             icon: "%" },
  { id: "markets",    label: "Global Markets",     desc: "Market cap, dominance, top coins overview",  icon: "🌐" },
  { id: "chat",       label: "AI Chat",            desc: "Ask anything about crypto markets",          icon: "💬" },
];

/* ── Props ─────────────────────────────────────────────────────────────────── */
interface Props {
  open: boolean;
  onClose: () => void;
  onCoinSelect: (coin: CoinSymbol) => void;
  onSectionSelect: (section: SectionId) => void;
}

/* ── Component ─────────────────────────────────────────────────────────────── */
export function GlobalSearch({ open, onClose, onCoinSelect, onSectionSelect }: Props) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef  = useRef<HTMLInputElement>(null);
  const listRef   = useRef<HTMLUListElement>(null);

  /* Reset on open */
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  /* Build results */
  const results: SearchResult[] = [];
  if (query.trim()) {
    const q = query.toLowerCase();

    /* Coin matches */
    COINS.forEach(c => {
      if (c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) {
        results.push({
          id:        `coin-${c.symbol}`,
          type:      "coin",
          primary:   c.name,
          secondary: c.symbol,
          icon:      COIN_ICONS[c.symbol] ?? c.symbol[0],
          action:    () => { onCoinSelect(c.symbol); onClose(); },
        });
      }
    });

    /* Section matches */
    SECTIONS.forEach(s => {
      if (s.label.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) {
        results.push({
          id:        `section-${s.id}`,
          type:      "section",
          primary:   s.label,
          secondary: s.desc,
          icon:      s.icon,
          action:    () => { onSectionSelect(s.id); onClose(); },
        });
      }
    });
  } else {
    /* No query — show all sections */
    SECTIONS.forEach(s => results.push({
      id: `section-${s.id}`, type: "section",
      primary: s.label, secondary: s.desc, icon: s.icon,
      action: () => { onSectionSelect(s.id); onClose(); },
    }));
  }

  const clampedIdx = Math.min(activeIdx, Math.max(0, results.length - 1));

  /* Keyboard nav */
  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      results[clampedIdx]?.action();
    } else if (e.key === "Escape") {
      onClose();
    }
  }, [results, clampedIdx, onClose]);

  /* Scroll active item into view */
  useEffect(() => {
    const li = listRef.current?.children[clampedIdx] as HTMLElement | undefined;
    li?.scrollIntoView({ block: "nearest" });
  }, [clampedIdx]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  if (!open) return null;

  const coinResults    = results.filter(r => r.type === "coin");
  const sectionResults = results.filter(r => r.type === "section");

  return ReactDOM.createPortal(
    <div className="gs-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gs-modal">
        {/* Search input */}
        <div className="gs-input-wrap">
          <svg className="gs-input-icon" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            className="gs-input"
            placeholder="Search coins, sections, features…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKey}
          />
          {query && (
            <button className="gs-clear" onClick={() => setQuery("")}>✕</button>
          )}
          <kbd className="gs-esc-hint">esc</kbd>
        </div>

        {/* Results */}
        <ul className="gs-list" ref={listRef}>
          {results.length === 0 && (
            <li className="gs-empty">No results for "{query}"</li>
          )}

          {coinResults.length > 0 && (
            <>
              <li className="gs-group-label">Coins</li>
              {coinResults.map(r => {
                const idx = results.indexOf(r);
                return (
                  <li key={r.id}
                    className={`gs-item${idx === clampedIdx ? " gs-item--active" : ""}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={r.action}
                  >
                    <span className="gs-item-icon gs-item-icon--coin">{r.icon}</span>
                    <span className="gs-item-primary">{r.primary}</span>
                    <span className="gs-item-sym">{r.secondary}</span>
                    <span className="gs-item-arrow">→</span>
                  </li>
                );
              })}
            </>
          )}

          {sectionResults.length > 0 && (
            <>
              <li className="gs-group-label">{query ? "Pages" : "All Pages"}</li>
              {sectionResults.map(r => {
                const idx = results.indexOf(r);
                return (
                  <li key={r.id}
                    className={`gs-item${idx === clampedIdx ? " gs-item--active" : ""}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={r.action}
                  >
                    <span className="gs-item-icon">{r.icon}</span>
                    <span className="gs-item-body">
                      <span className="gs-item-primary">{r.primary}</span>
                      <span className="gs-item-secondary">{r.secondary}</span>
                    </span>
                    <span className="gs-item-arrow">→</span>
                  </li>
                );
              })}
            </>
          )}
        </ul>

        <div className="gs-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
