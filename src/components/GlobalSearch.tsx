import { useState, useEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { COINS, CoinSymbol } from "../services/coinglass";
import "../styles/GlobalSearch.css";

/* ── Types ─────────────────────────────────────────────────────────────────── */
// Mirrors App.tsx's own SectionId — kept as a separate literal union since
// App.tsx casts this component's onSectionSelect value with `as SectionId`
// rather than importing this type, so nothing else enforces the two stay
// in sync. If a section is added/renamed in App.tsx's NAV_ITEMS, add it
// here too (and to SECTIONS below) or search for it silently goes nowhere.
export type SectionId =
  | "chart" | "candleai" | "heatmap" | "onchain" | "positions" | "htf"
  | "orderflow" | "signals" | "fundingbot" | "riskcalc" | "markets"
  | "marketheatmap" | "altanalysis" | "options" | "correlation" | "strategyalerts";

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

// `keywords` catches the natural-language way someone would actually type
// a query — not just the page's own title — so e.g. "monthly returns"
// finds HTF Analysis and "heatmap" doesn't only find the (differently
// named) Liquidation Heatmap. Sourced from each page's own
// sectionBanner.<id>.tags in en.json plus common phrasing on top.
const SECTIONS: { id: SectionId; label: string; desc: string; icon: string; keywords: string[] }[] = [
  { id: "chart", label: "Price Chart", desc: "Live candlestick chart with indicators", icon: "📈",
    keywords: ["candles", "candlestick", "live chart", "technical chart", "price action", "tradingview"] },
  { id: "candleai", label: "Inside the Candle", desc: "AI pattern analysis, smart money, forecasts", icon: "✦",
    keywords: ["pattern recognition", "market maker", "smart money", "candle reading", "ai candle", "order blocks", "fair value gap", "wyckoff", "elliott wave"] },
  { id: "heatmap", label: "Liquidation Heatmap", desc: "Futures liquidation zones and stop-hunt levels", icon: "🔥",
    keywords: ["liquidation map", "liquidity zones", "stop hunt", "liq levels", "long liquidations", "short liquidations", "leverage liquidations", "liquidation clusters"] },
  { id: "onchain", label: "On-Chain Metrics", desc: "Network data, exchange flows and whale activity", icon: "⛓",
    keywords: ["whale activity", "whale movements", "exchange flows", "blockchain data", "wallet tracking", "miner data", "network activity", "hash rate"] },
  { id: "positions", label: "Positions & Flows", desc: "Long/short ratios and taker buy/sell volume", icon: "⚖",
    keywords: ["long short ratio", "crowd positioning", "taker volume", "traders", "squeeze risk"] },
  { id: "htf", label: "HTF Analysis", desc: "Higher timeframe structure, macro trend and bias", icon: "🔭",
    keywords: ["higher timeframe", "monthly returns", "weekly returns", "monthly performance", "weekly performance", "multi-timeframe", "macro trend", "monthly chart", "weekly chart", "structure levels", "returns"] },
  { id: "orderflow", label: "Order Flow", desc: "Footprint chart, delta and large-order tape", icon: "📊",
    keywords: ["footprint chart", "delta analysis", "tape reading", "large orders", "institutional orders", "smart money flow"] },
  { id: "signals", label: "Signals", desc: "AI-generated, multi-exchange confluence trade signals", icon: "⚡",
    keywords: ["trade signals", "buy sell signals", "confluence", "momentum signals", "ai signals"] },
  { id: "fundingbot", label: "Funding Bot", desc: "Perpetual funding rates across exchanges", icon: "%",
    keywords: ["funding rate", "perp funding", "carry trade", "leverage extremes"] },
  { id: "riskcalc", label: "Position Size Calc", desc: "Position sizing, dollar risk and R:R calculator", icon: "🧮",
    keywords: ["position size", "risk calculator", "position sizing", "stop loss calculator", "lot size", "risk management", "trade size"] },
  { id: "markets", label: "Global Markets", desc: "Market cap, dominance, top coins overview", icon: "🌐",
    keywords: ["market overview", "market cap", "dominance", "top coins", "volume leaders", "sector performance"] },
  { id: "marketheatmap", label: "Market Heatmap", desc: "Top coins by market cap, sized by cap, colored by 24h change", icon: "▦",
    keywords: ["treemap", "coin map", "market cap map", "visual market overview", "coinmarketcap heatmap"] },
  { id: "altanalysis", label: "Alt Analysis", desc: "AI-powered analysis for alternative cryptocurrencies", icon: "◈",
    keywords: ["altcoin analysis", "alt prediction", "altcoin ai", "alt coin", "altseason"] },
  { id: "options", label: "Options", desc: "BTC/ETH options data — open interest, max pain, IV", icon: "◎",
    keywords: ["options data", "deribit", "max pain", "open interest", "implied volatility", "put call ratio"] },
  { id: "correlation", label: "Correlation", desc: "Cross-asset correlation vs gold, DXY and the S&P 500", icon: "⇄",
    keywords: ["correlation matrix", "btc eth correlation", "cross asset", "gold correlation", "sp500 correlation", "dxy", "regime shift"] },
  { id: "strategyalerts", label: "Strategy Alerts", desc: "Custom rules engine — indicator and price alerts", icon: "🔔",
    keywords: ["custom alerts", "rules engine", "strategy builder", "price condition alerts", "if this then alert"] },
];

/* ── Props ─────────────────────────────────────────────────────────────────── */
interface Props {
  open: boolean;
  onClose: () => void;
  onCoinSelect: (coin: CoinSymbol) => void;
  onSectionSelect: (section: SectionId) => void;
  // "modal" (default): the existing centered, backdrop-dimmed ⌘K-style
  // overlay. "docked": renders as a card directly above FloatingNavBar
  // instead — no dark backdrop, positioned to read as physically attached
  // to the nav bar rather than a separate floating layer.
  variant?: "modal" | "docked";
}

/* ── Component ─────────────────────────────────────────────────────────────── */
export function GlobalSearch({ open, onClose, onCoinSelect, onSectionSelect, variant = "modal" }: Props) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef  = useRef<HTMLInputElement>(null);
  const listRef   = useRef<HTMLUListElement>(null);
  const dockedRef = useRef<HTMLDivElement>(null);

  /* Reset on open */
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // capacitor.config.ts sets Keyboard resize:'none', so .gs-docked (a
  // position:fixed card already anchored just above FloatingNavBar) never
  // shrinks away from the keyboard on its own — the keyboard just covers
  // it. Same fix CoinChat.tsx/TradingAgent.tsx already use for their own
  // fixed-position panels: push it up by the keyboard height on show, put
  // it back on hide. The base offset is .gs-docked's own CSS `bottom`
  // (nav-bar height + gaps), so this adds on top of it rather than
  // replacing it.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || variant !== "docked") return;
    const showSub = Keyboard.addListener("keyboardWillShow", (info) => {
      if (dockedRef.current) {
        dockedRef.current.style.bottom = `calc(18px + env(safe-area-inset-bottom) + 62px + 8px + ${info.keyboardHeight}px)`;
      }
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      if (dockedRef.current) dockedRef.current.style.bottom = "";
    });
    return () => { showSub.then(s => s.remove()); hideSub.then(s => s.remove()); };
  }, [variant]);

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

    /* Section matches — every word in the query has to show up somewhere
       in the section's label/desc/id/keywords (in any order), not just as
       one literal substring of the label. Catches phrasing like "monthly
       returns" (an HTF keyword) or "heatmap market" typed out of order. */
    const qWords = q.split(/\s+/).filter(Boolean);
    SECTIONS.forEach(s => {
      const haystack = `${s.label} ${s.desc} ${s.id} ${s.keywords.join(" ")}`.toLowerCase();
      if (qWords.every(w => haystack.includes(w))) {
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
  const docked = variant === "docked";

  const content = (
    <>
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
        {/* "esc" is a desktop-keyboard concept — meaningless (and nothing
            to tap) on the docked mobile variant, so it's modal-only. */}
        {!docked && <kbd className="gs-esc-hint">esc</kbd>}
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

      {!docked && (
        <div className="gs-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      )}
    </>
  );

  if (docked) {
    return ReactDOM.createPortal(
      <>
        {/* Invisible click-outside catcher — unlike the modal variant,
            there's no dimmed backdrop (the chart stays fully visible), but
            tapping anywhere outside the docked card still closes it. */}
        <div className="gs-docked-catcher" onMouseDown={onClose} />
        <div className="gs-docked" ref={dockedRef}>{content}</div>
      </>,
      document.body
    );
  }

  return ReactDOM.createPortal(
    <div className="gs-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gs-modal">{content}</div>
    </div>,
    document.body
  );
}
