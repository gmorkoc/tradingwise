import { useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { CoinSymbol, fetchLivePrice } from "../services/coinglass";
import {
  fetchPortfolio, fetchAgentPerformance, closePosition, executeTrade, updateCashBalance, fetchClosedPositions, acceptConsent,
  computeLiquidationPrice,
  PaperPortfolio, AgentPerformance, PaperPosition, AgentAction, PositionsListItem,
} from "../services/paperTrading";
import { LiquidationGauge } from "./LiquidationGauge";
import { formatRelativeTime } from "./ChartEventAnnotations";
import { HoverTip } from "./HoverTip";
import "../styles/PaperTradingCard.css";

interface Props {
  // Defaults the inline open-position form to whatever's on the chart
  // right now — the other reason to open the full page (App.tsx:
  // setActiveSection("riskcalc")) is TradeManager's own richer flows
  // (beginner wizard, AI review), not a missing capability here.
  coin: CoinSymbol;
  onOpen: () => void;
  // "Start paper trading" (signed-out promo CTA) needs to open the
  // sign-up/sign-in screen directly, not just navigate to a page that
  // would show this same promo again — separate from onOpen above,
  // which is for the signed-in "jump to the full page" case.
  onOpenAuth: () => void;
  // Chart page's Paper Trading column puts the "Paper Trading" title and
  // LIVE badge in its own tab row (App.tsx), so the card drops both and
  // keeps only the Open/Closed Positions switch in its header.
  inTabRow?: boolean;
  // "View all N closed positions" — where the full history lives. The
  // Chart page passes one that opens its own History tab under the chart;
  // without it, this falls back to onOpen (the Trade Manager page).
  onViewClosed?: () => void;
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

// Comma-grouped display of a sanitizeAmountInput string, e.g. "1234.5" ->
// "1,234.5" — purely cosmetic, the underlying state stays the plain digit
// string sanitizeAmountInput produces (what parseFloat/the trade math
// actually use); this only formats what's shown in the USD amount pill.
function formatUsdAmountDisplay(raw: string): string {
  if (!raw) return raw;
  const [intPart, decPart] = raw.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart !== undefined ? `${grouped}.${decPart}` : grouped;
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


// Shared pitch content — used for BOTH the signed-out state and the
// signed-in-but-hasn't-consented one, since Paper Trading is meant to
// actively drive sign-ups, not just explain itself once someone's
// already in. Only the CTA area below it differs (sign up vs.
// accept-and-activate), passed in by the caller.
// Matches a reference "How it works" marketing section exactly (plain
// small eyebrow label, bold headline, one-line subtitle, then a
// connecting-line timeline of icon steps — see .ptc-activate-steps
// below) rather than a badge-row/giant-stat-callout layout.
// Hero banner at the top of the promo: dark gradient card with a
// count-up virtual balance, a self-drawing sparkline, and two floating
// sample trade chips. All motion is CSS except the count-up, and all of it
// is skipped under prefers-reduced-motion.
const PTC_HERO_BALANCE = 100000;
// Sparkline points in a 0..300 x 0..90 box — a hand-shaped uptrend with a
// couple of pullbacks so it reads as a real chart, not a straight line.
const PTC_HERO_LINE = [
  [0, 72], [22, 66], [40, 70], [58, 58], [78, 61], [96, 48], [114, 52],
  [134, 40], [152, 44], [170, 34], [190, 38], [210, 26], [228, 30],
  [248, 20], [266, 23], [284, 12], [300, 14],
];
function PtcHero() {
  const [balance, setBalance] = useState(() =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ? PTC_HERO_BALANCE
      : 0,
  );
  useEffect(() => {
    if (balance === PTC_HERO_BALANCE) return;
    const start = performance.now();
    const dur = 1400;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      // easeOutCubic
      setBalance(Math.round(PTC_HERO_BALANCE * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const line = PTC_HERO_LINE.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
  const area = `${line} L300 90 L0 90 Z`;
  const [endX, endY] = PTC_HERO_LINE[PTC_HERO_LINE.length - 1];
  return (
    <div className="ptc-hero" aria-hidden="true">
      <span className="ptc-hero-orb ptc-hero-orb--a" />
      <span className="ptc-hero-orb ptc-hero-orb--b" />
      <span className="ptc-hero-grid" />
      <div className="ptc-hero-top">
        <span className="ptc-hero-pill">
          <span className="ptc-hero-pill-dot" />
          100% risk free
        </span>
        <span className="ptc-hero-pill ptc-hero-pill--ghost">Live prices</span>
      </div>
      <div className="ptc-hero-balance-label">Virtual balance</div>
      <div className="ptc-hero-balance">
        ${balance.toLocaleString("en-US")}
        <span className="ptc-hero-balance-cents">.00</span>
      </div>
      <div className="ptc-hero-chart">
        <svg viewBox="0 0 300 90" preserveAspectRatio="none">
          <defs>
            <linearGradient id="ptcHeroFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="ptcHeroStroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#60a5fa" />
              <stop offset="100%" stopColor="#34d399" />
            </linearGradient>
          </defs>
          <path className="ptc-hero-area" d={area} fill="url(#ptcHeroFill)" />
          <path className="ptc-hero-line" d={line} fill="none" stroke="url(#ptcHeroStroke)" strokeWidth="2.4"
            strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
        </svg>
        <span className="ptc-hero-end-dot" style={{ left: `${(endX / 300) * 100}%`, top: `${(endY / 90) * 100}%` }} />
        <div className="ptc-hero-chip ptc-hero-chip--a">
          <span className="ptc-hero-chip-side ptc-hero-chip-side--long">LONG</span>
          BTC 10x
          <b>+$2,418</b>
        </div>
        <div className="ptc-hero-chip ptc-hero-chip--b">
          <span className="ptc-hero-chip-side ptc-hero-chip-side--short">SHORT</span>
          ETH 5x
          <b>+$640</b>
        </div>
      </div>
      <div className="ptc-hero-feats">
        <span>Spot &amp; futures</span>
        <span>Up to 20x</span>
        <span>Reset anytime</span>
      </div>
    </div>
  );
}

function PtcPromo({ cta }: { cta: React.ReactNode }) {
  return (
    <>
      <PtcHero />
      <p className="ptc-activate-title">How Paper Trading works</p>
      <p className="ptc-activate-kicker">Real prices, zero real risk — $100,000 to start.</p>
      <ol className="ptc-activate-steps">
        {[
          {
            n: 1,
            label: "Create your free account",
            sub: "Sign up in seconds, no credit card needed. It unlocks a full practice trading environment instantly — no commitment, no hidden strings.",
            icon: (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="7" r="4" />
                <path d="M1 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
                <path d="M19 8v6M22 11h-6" />
              </svg>
            ),
          },
          {
            n: 2,
            label: "Get $100,000 in virtual cash",
            sub: "Start with a six-figure virtual balance you can reset anytime. It's real buying power to test sizing, risk management and entries exactly like a live account would.",
            icon: (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12V7H5a2 2 0 010-4h14v4" />
                <path d="M3 5v14a2 2 0 002 2h16v-5" />
                <path d="M18 12a2 2 0 000 4h4v-4h-4z" />
              </svg>
            ),
          },
          {
            n: 3,
            label: "Trade spot & futures, live",
            sub: "Every price is pulled from the real market in real time. Go long or short, use up to 20x leverage, and set take-profit/stop-loss orders — with zero dollars of real risk.",
            icon: (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="3" x2="6" y2="9" />
                <rect x="4" y="9" width="4" height="7" rx="1" />
                <line x1="6" y1="16" x2="6" y2="21" />
                <line x1="14" y1="2" x2="14" y2="7" />
                <rect x="12" y="7" width="4" height="9" rx="1" />
                <line x1="14" y1="16" x2="14" y2="22" />
                <line x1="20" y1="5" x2="20" y2="10" />
                <rect x="18" y="10" width="4" height="6" rx="1" />
                <line x1="20" y1="16" x2="20" y2="19" />
              </svg>
            ),
          },
        ].map((s) => (
          <li key={s.n} className={`ptc-activate-step${s.n === 1 ? " ptc-activate-step--active" : ""}`}>
            <span className="ptc-activate-step-bar" aria-hidden="true" />
            <span className="ptc-activate-step-icon">
              {s.icon}
            </span>
            <span className="ptc-activate-step-text">
              <span className="ptc-activate-step-label">{s.label}</span>
              <span className="ptc-activate-step-sub">{s.sub}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="ptc-activate-sub">
        Simulated money, simulated trades — not financial advice, and coinhintz isn't responsible for any
        losses, simulated or otherwise. We'll only ask you to accept this once.
      </p>
      {cta}
    </>
  );
}

// Small ⓘ next to each label in the card, with a plain-language
// explanation on hover (HoverTip — instant, portaled, never clipped).
const PTC_TIPS: Record<string, string> = {
  "Cash": "Virtual money you have available to open new trades.",
  "Open": "How many paper positions you currently have open.",
  "Realized P&L": "Total profit or loss locked in from positions you've already closed.",
  "Side": "Long profits when price goes up; short profits when it goes down. Futures also show the leverage used.",
  "Size": "How much of the coin this position holds.",
  "Entry": "The average price you opened this position at.",
  "Current": "The live market price right now \u2014 your P&L is based on this.",
  "Liquidation": "If price reaches this level, the position is closed automatically and its margin is lost.",
  "Take Profit": "Price at which the position closes automatically to lock in profit.",
  "Stop Loss": "Price at which the position closes automatically to limit losses.",
  "Opened": "When this position was opened or last changed.",
  "Margin": "The cash set aside from your balance to back this futures position.",
  "Position Size": "The full size of the position \u2014 your margin multiplied by the leverage.",
  "Est. Liquidation": "Roughly where the position would be liquidated at this leverage. Higher leverage puts it closer to the entry price.",
  "Profit at TP": "What you'd make if price reaches your take-profit level.",
  "Loss at SL": "What you'd lose if price reaches your stop-loss level.",
  "Amount": "How much to trade. Tap $ to switch between a dollar amount and an amount of the coin.",
  "Leverage": "Multiplies your position size (and your gains and losses) relative to the margin you put in. Higher leverage means liquidation is closer.",
  "Order Type": "Market orders fill right away at the live price. Limit and TWAP orders are coming soon.",
  "Isolated": "Isolated margin: only the margin of this position is at risk if it gets liquidated, not your whole balance.",
  "Spot / Futures": "Spot buys or sells the coin itself. Futures lets you go long or short with leverage.",
  "Short": "Profit if the price goes down.",
  "Long": "Profit if the price goes up.",
  "Sell": "Sell coins you hold at the live price.",
  "Buy": "Buy the coin at the live price.",
};
function InfoTip({ text }: { text: string }) {
  return (
    <HoverTip text={text} className="ptc-info">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    </HoverTip>
  );
}

const CTA_STEPS = ["Setting up…", "Opening…", "All set ✓", "Good luck!"];

// Leverage row + popover picker (reference: Hyperliquid): "Leverage" on
// the left, "Isolated" tag and an amber "20x ▾" button on the right. The
// button opens a panel with a 1–20x slider, a risk note and a green
// "Confirm Nx" — the value only changes on Confirm.
const LEV_MAX = 20;
const LEV_TICKS = [1, 5, 10, 15, 20];
function LeveragePicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) setDraft(value); }, [open, value]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);
  const pct = ((draft - 1) / (LEV_MAX - 1)) * 100;
  return (
    <div className="ptc-lev" ref={ref}>
      <div className="ptc-lev-row">
        <span className="ptc-lev-label">Leverage<InfoTip text={PTC_TIPS["Leverage"]} /></span>
        <span className="ptc-lev-right">
          <span className="ptc-lev-tag">Isolated<InfoTip text={PTC_TIPS["Isolated"]} /></span>
          <button type="button" className={`ptc-lev-btn${open ? " open" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {value}x
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
        </span>
      </div>
      {open && (
        <div className="ptc-lev-pop" role="dialog" aria-label="Set leverage">
          <div className="ptc-lev-slider">
            <input
              type="range"
              min={1}
              max={LEV_MAX}
              step={1}
              value={draft}
              onChange={(e) => setDraft(Number(e.target.value))}
              style={{ ["--lev-pct" as string]: `${pct}%` }}
              aria-label="Leverage"
            />
            <div className="ptc-lev-ticks" aria-hidden="true">
              {LEV_TICKS.map((t) => (
                <span key={t} className={`ptc-lev-tick${t <= draft ? " on" : ""}`} style={{ left: `${((t - 1) / (LEV_MAX - 1)) * 100}%` }}>
                  <i />
                  <b>{t}</b>
                </span>
              ))}
            </div>
          </div>
          <p className="ptc-lev-note">
            Higher leverage amplifies your gains and losses, and increases your risk of liquidation.
          </p>
          <button type="button" className="ptc-lev-confirm" onClick={() => { onChange(draft); setOpen(false); }}>
            Confirm {draft}x
          </button>
        </div>
      )}
    </div>
  );
}

// Order Type row + dropdown (reference: Hyperliquid). Paper trades only
// fill at the live market price today, so Market is the one real option;
// Limit / TWAP are listed but disabled ("Soon") until the paper engine
// supports resting orders.
const ORDER_TYPES = [
  { key: "market", label: "Market", available: true },
  { key: "limit", label: "Limit", available: false },
  { key: "twap", label: "TWAP", available: false },
] as const;
function OrderTypePicker() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<(typeof ORDER_TYPES)[number]["key"]>("market");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);
  const current = ORDER_TYPES.find((o) => o.key === value)!;
  return (
    <div className="ptc-lev ptc-ot" ref={ref}>
      <div className="ptc-lev-row">
        <span className="ptc-lev-label">Order Type<InfoTip text={PTC_TIPS["Order Type"]} /></span>
        <button type="button" className={`ptc-ot-btn${open ? " open" : ""}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
          {current.label}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            {open ? <polyline points="6 15 12 9 18 15" /> : <polyline points="6 9 12 15 18 9" />}
          </svg>
        </button>
      </div>
      {open && (
        <div className="ptc-ot-menu" role="listbox">
          {ORDER_TYPES.map((o) => (
            <button
              type="button"
              key={o.key}
              role="option"
              aria-selected={value === o.key}
              disabled={!o.available}
              className={`ptc-ot-item${value === o.key ? " active" : ""}`}
              onClick={() => { setValue(o.key); setOpen(false); }}
            >
              {o.label}
              {value === o.key && (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              )}
              {!o.available && <span className="ptc-ot-soon">Soon</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Free-tier home-page card, right above OrderFlowPanel — real paper
// portfolio data (same service TradeManager.tsx/TradingAgent.tsx both
// read/write), with positions opened, watched live, and closed directly
// here instead of requiring a nav trip to the full page for any of it.
export function PaperTradingCard({ coin, onOpen, onOpenAuth, inTabRow, onViewClosed }: Props) {
  const { user } = useAuth();
  const [portfolio, setPortfolio] = useState<PaperPortfolio | null>(null);
  const [perf, setPerf] = useState<AgentPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Same one-time risk-disclaimer gate TradingAgent.tsx already uses
  // (consentAcceptedAt/acceptConsent, paperTrading.ts) — a signed-in user
  // who hasn't accepted it yet sees the activation banner below instead
  // of live stats, same shared account-level flag either entry point sets.
  const [activating, setActivating] = useState(false);
  // Cinematic cross-dissolve on activation — real movie-cut grammar (two
  // scenes briefly overlapping, one dissolving out as the other's already
  // visible underneath) instead of an instant swap from banner to stats.
  // The stats view is free to mount underneath immediately (it already
  // has its own fade/rise-in entrance, .ptc-stats' animation below) since
  // consentAcceptedAt flips the instant loadPortfolio resolves; this flag
  // just keeps the banner alive a little longer, absolutely positioned
  // over it, fading/blurring out on its own instead of disappearing the
  // same frame the stats appear.
  const [dissolving, setDissolving] = useState(false);
  const handleActivate = async () => {
    if (!user || activating) return;
    setActivating(true);
    try {
      await acceptConsent(user.id);
      await loadPortfolio(user.id);
      setDissolving(true);
      setTimeout(() => setDissolving(false), 750);
    } finally {
      setActivating(false);
    }
  };
  // Editable cash balance — same manual-override pattern as TradingAgent.tsx's
  // own portfolio header (startEditCash/saveCash there), same underlying
  // updateCashBalance call.
  const [editingCash, setEditingCash] = useState(false);
  const [cashDraft, setCashDraft] = useState("");
  const [savingCash, setSavingCash] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);

  // Inline "open a position" form state.
  // Futures is the first tab, so it's also the default.
  const [market, setMarket] = useState<"spot" | "futures">("futures");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  // Starts empty (placeholder "0.00") — no preset amount.
  const [amountUsd, setAmountUsd] = useState("");
  const [showTpSl, setShowTpSl] = useState(false);
  const [ctaGo, setCtaGo] = useState(0);
  // Current Positions list open/closed — collapsed by default, then
  // remembered across visits. (Key bumped from "ptcPositionsOpen", which
  // had already saved "open" for everyone under the old default.)
  const [positionsOpen, setPositionsOpen] = useState(() => {
    try { return localStorage.getItem("ptcPositionsOpenV2") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("ptcPositionsOpenV2", positionsOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [positionsOpen]);
  // Submit sequence: Setting up… → Opening… → All set ✓ → Good luck!
  // (the last two only once the trade actually went through), then back
  // to the normal label.
  const [ctaStep, setCtaStep] = useState<number | null>(null);
  const runSubmitSequence = async () => {
    const STEP_MS = 650;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    setCtaStep(0);
    const [ok] = await Promise.all([
      (async () => { await wait(STEP_MS); setCtaStep(1); return handleSubmitOpen(); })(),
    ]);
    await wait(STEP_MS);
    if (ok) {
      setCtaStep(2);
      await wait(STEP_MS);
      setCtaStep(3);
      await wait(STEP_MS);
    }
    setCtaStep(null);
    setCtaGo((n) => n + 1);
  };
  // Wave (ripple) on every button in the card: one delegated pointerdown
  // listener drops a circle at the press point that expands and fades.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = cardRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const onDown = (e: PointerEvent) => {
      const btn = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
      if (!btn || btn.disabled || !root.contains(btn) || btn.closest(".ptc-info")) return;
      const r = btn.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 2;
      const wave = document.createElement("span");
      wave.className = "ptc-wave";
      wave.style.width = wave.style.height = `${size}px`;
      wave.style.left = `${e.clientX - r.left - size / 2}px`;
      wave.style.top = `${e.clientY - r.top - size / 2}px`;
      btn.classList.add("ptc-wave-host");
      btn.appendChild(wave);
      wave.addEventListener("animationend", () => wave.remove());
    };
    root.addEventListener("pointerdown", onDown);
    return () => root.removeEventListener("pointerdown", onDown);
  }, []);
  // Whichever unit the amount pill is currently in — the raw text above is
  // always interpreted against this (dollars or coin quantity), converted
  // live via formPrice whenever the user flips the toggle so the number
  // they see keeps meaning the same real size, not just a reinterpreted digit.
  const [amountUnit, setAmountUnit] = useState<"usd" | "coin">("usd");
  const [leverage, setLeverage] = useState("2");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Open/closed is a top-level view switch (same place/pattern as
  // OrderFlowPanel's own Flow/Book switcher), not a collapsible section
  // tucked somewhere in the card — closed positions kept getting moved
  // around (next to the open list: too busy together; at the very
  // bottom: still the wrong spot) because "a separate section" never had
  // a right place to live. Making it a view of the same list sidesteps
  // that entirely. Lazy-loaded the first time you switch to it, not
  // fetched alongside the portfolio on every mount, since most visits to
  // this card are just a glance at open positions/cash.
  const [positionsView, setPositionsView] = useState<"open" | "closed">("open");
  const [closedPositions, setClosedPositions] = useState<PositionsListItem[] | null>(null);
  const [closedLoading, setClosedLoading] = useState(false);
  const switchToClosed = async () => {
    setPositionsView("closed");
    if (closedPositions === null && user) {
      setClosedLoading(true);
      try {
        setClosedPositions(await fetchClosedPositions(user.id));
      } catch {
        setClosedPositions([]);
      } finally {
        setClosedLoading(false);
      }
    }
  };

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

  const handleSubmitOpen = async (): Promise<boolean> => {
    if (!user) return false;
    const raw = parseFloat(amountUsd);
    if (!Number.isFinite(raw) || raw <= 0) { setFormError("Enter a valid amount."); return false; }
    let amount = raw;
    if (amountUnit === "coin") {
      if (!formPrice) { setFormError("Waiting for a live price…"); return false; }
      amount = raw * formPrice;
    }
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
      setTakeProfit("");
      setStopLoss("");
      return true;
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not open that position.");
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const positions = portfolio?.positions ?? [];
  const openCount = positions.length;
  // "Open" stat tap → show the Current Positions list (open tab, expanded)
  // and bring it into view.
  const positionsRef = useRef<HTMLDivElement>(null);
  const showOpenPositions = () => {
    if (openCount === 0) return;
    setPositionsView("open");
    setPositionsOpen(true);
    requestAnimationFrame(() => {
      positionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  const formPrice = livePrices[coin];
  // Only meaningful when entering a coin quantity — in USD mode the input
  // IS the cost already, showing it again would just repeat the number.
  const amountNum = parseFloat(amountUsd);
  const totalCostUsd = amountUnit === "coin" && formPrice && Number.isFinite(amountNum) && amountNum > 0
    ? amountNum * formPrice
    : null;
  // Same thing, generalized across both input modes — what handleSubmitOpen
  // will actually send as amountUsd (margin, for futures) once submitted.
  const costUsd = amountUnit === "coin"
    ? totalCostUsd
    : (Number.isFinite(amountNum) && amountNum > 0 ? amountNum : null);
  // Live order-ticket preview — mirrors executeTrade's own futures math
  // (paperTrading.ts) exactly (same computeLiquidationPrice call, same
  // notional/qty formulas) so what's shown here never drifts from what
  // actually gets opened.
  const futuresPreview = (() => {
    if (market !== "futures" || costUsd === null || !formPrice) return null;
    const levNum = Math.min(20, Math.max(1, parseFloat(leverage) || 1));
    const notional = costUsd * levNum;
    const qty = notional / formPrice;
    const wantSide: "long" | "short" = side === "buy" ? "long" : "short";
    const liq = computeLiquidationPrice(formPrice, levNum, wantSide);
    const tp = parseFloat(takeProfit);
    const sl = parseFloat(stopLoss);
    const tpProfit = Number.isFinite(tp) && tp > 0
      ? (wantSide === "long" ? (tp - formPrice) * qty : (formPrice - tp) * qty)
      : null;
    const slLoss = Number.isFinite(sl) && sl > 0
      ? (wantSide === "long" ? (sl - formPrice) * qty : (formPrice - sl) * qty)
      : null;
    return { margin: costUsd, notional, qty, liq, tpProfit, slLoss };
  })();
  // Title/breadcrumb/LIVE badge are all "the real card is open" chrome —
  // none of it means anything before activation, whether that's because
  // there's no account yet (!user) or because there is one but it hasn't
  // accepted the one-time consent yet (needsActivation) — the whole
  // header hides for both cases and the promo/activation banner takes
  // over the full card instead (see .ptc-card--activating/.ptc-activate
  // below). Gated on the same "user && consentAcceptedAt" condition the
  // stats section further down already uses, not just !needsActivation,
  // which was true (so the header showed) for signed-out visitors too.
  const needsActivation = !!user && !loading && !portfolio?.consentAcceptedAt;

  const body = (
    <>
      {user && !loading && portfolio?.consentAcceptedAt && (
      <div className="ptc-header">
        <span className="ptc-title">
          {!inTabRow && "Paper Trading"}
          {/* Open/Closed switch moved to a button at the bottom of the card
              (.ptc-switch-view-btn). */}
        </span>
        {(!inTabRow || (positionsView === "closed" && !closedLoading && (closedPositions?.length ?? 0) > 5)) && (
          <div className="ptc-header-right">
            {/* Closed view only, once there's more than the 5 shown here:
                full history (Chart page: its History tab; elsewhere the
                Trade Manager page). */}
            {positionsView === "closed" && !closedLoading && closedPositions && closedPositions.length > 5 && (
              <button type="button" className="ptc-view-all-btn" onClick={onViewClosed ?? onOpen}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
                View all {closedPositions.length}
              </button>
            )}
            {!inTabRow && <span className="ptc-live-badge"><span className="ptc-pulse-dot" />LIVE</span>}
          </div>
        )}
      </div>
      )}

      {!user && (
        <div className="ptc-activate">
          <PtcPromo
            cta={
              <>
                <button type="button" className="ptc-activate-cta" onClick={onOpenAuth}>
                  <span className="ptc-activate-cta-shine" />
                  <span className="ptc-activate-cta-label">Start paper trading</span>
                </button>
                <p className="ptc-activate-sub ptc-activate-sub--muted">
                  Free account required ·{" "}
                  <button type="button" className="ptc-activate-auth-link" onClick={onOpenAuth}>Sign in or create an account</button>
                </p>
              </>
            }
          />
        </div>
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

      {user && !loading && (needsActivation || dissolving) && (
        <div className={`ptc-activate${dissolving ? " ptc-activate--dissolving" : ""}`}>
          <PtcPromo
            cta={
              <button type="button" className="ptc-activate-cta" onClick={handleActivate} disabled={activating}>
                <span className="ptc-activate-cta-shine" />
                <span className="ptc-activate-cta-label">
                  {activating ? "Activating…" : "Activate Paper Trading"}
                </span>
              </button>
            }
          />
        </div>
      )}

      {user && !loading && portfolio?.consentAcceptedAt && (
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
              <span className="ptc-stat-label">Cash<InfoTip text={PTC_TIPS["Cash"]} /></span>
              {cashError && <span className="ptc-cash-error">{cashError}</span>}
            </div>
            {/* Tappable when there are open positions: jumps to the
                Current Positions list, expanded. */}
            <div
              className={`ptc-stat${openCount > 0 ? " ptc-stat--link" : ""}`}
              role={openCount > 0 ? "button" : undefined}
              tabIndex={openCount > 0 ? 0 : undefined}
              aria-label={openCount > 0 ? `Show ${openCount} open position${openCount === 1 ? "" : "s"}` : undefined}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest(".ptc-info")) return; // the ⓘ keeps its own tooltip
                showOpenPositions();
              }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showOpenPositions(); } }}
            >
              <span className="ptc-stat-value">{openCount}</span>
              <span className="ptc-stat-label">Open<InfoTip text={PTC_TIPS["Open"]} />
                {openCount > 0 && (
                  <svg className="ptc-stat-link-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18" /></svg>
                )}
              </span>
            </div>
            <div className="ptc-stat">
              <span className={`ptc-stat-value${perf && perf.totalPnl !== 0 ? (perf.totalPnl > 0 ? " ptc-up" : " ptc-down") : ""}`}>
                {perf ? fmtUsd(perf.totalPnl) : "—"}
              </span>
              <span className="ptc-stat-label">Realized P&L<InfoTip text={PTC_TIPS["Realized P&L"]} /></span>
            </div>
          </div>

          {positionsView === "open" && (
            <div className="ptc-form ptc-form--hl">
              {/* Order panel, Hyperliquid-style: flat and dense — market
                  tabs, Long/Short segment, label/value rows, one amount
                  field with a % slider, optional TP/SL, one solid button. */}
              <div className={`ptc-hl-tabs ptc-hl-tabs--${market}`} role="tablist">
                <button type="button" role="tab" aria-selected={market === "futures"} className={`ptc-hl-tab${market === "futures" ? " active" : ""}`} onClick={() => setMarket("futures")}>Futures</button>
                <button type="button" role="tab" aria-selected={market === "spot"} className={`ptc-hl-tab${market === "spot" ? " active" : ""}`} onClick={() => setMarket("spot")}>Spot</button>
                {/* One underline that slides between the two tabs. */}
                <span className="ptc-hl-tabs-bar" aria-hidden="true" />
                <span className="ptc-hl-tabs-info"><InfoTip text={PTC_TIPS["Spot / Futures"]} /></span>
              </div>

              <div className={`ptc-hl-side ptc-hl-side--${side}`}>
                {/* One tinted pill that slides to the selected side. */}
                <span className="ptc-hl-side-glider" aria-hidden="true" />
                <button
                  type="button"
                  className={`ptc-hl-side-btn ptc-hl-side-btn--buy${side === "buy" ? " active" : ""}`}
                  onClick={() => setSide("buy")}
                >
                  <span key={`b-${market}`} className="ptc-hl-swap">{market === "futures" ? "Long" : "Buy"}</span>
                  <InfoTip text={market === "futures" ? PTC_TIPS["Long"] : PTC_TIPS["Buy"]} />
                </button>
                <button
                  type="button"
                  className={`ptc-hl-side-btn ptc-hl-side-btn--sell${side === "sell" ? " active" : ""}`}
                  onClick={() => setSide("sell")}
                >
                  <span key={`s-${market}`} className="ptc-hl-swap">{market === "futures" ? "Short" : "Sell"}</span>
                  <InfoTip text={market === "futures" ? PTC_TIPS["Short"] : PTC_TIPS["Sell"]} />
                </button>
              </div>

              <div className="ptc-hl-rows">
                {/* Futures-only row, kept mounted so it can expand/collapse
                    smoothly when switching between Futures and Spot. */}
                <div className={`ptc-hl-collapse${market === "futures" ? " open" : ""}`} aria-hidden={market !== "futures"}>
                  <div className="ptc-hl-collapse-inner">
                    <LeveragePicker
                      value={Math.min(20, Math.max(1, Math.round(parseFloat(leverage) || 1)))}
                      onChange={(v) => setLeverage(String(v))}
                    />
                  </div>
                </div>
                <OrderTypePicker />
                <div className="ptc-lev-row">
                  <span className="ptc-lev-label">Price<InfoTip text={PTC_TIPS["Current"]} /></span>
                  <span className="ptc-hl-value">
                    {formPrice !== undefined ? `$${formPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
                  </span>
                </div>
                <div className="ptc-lev-row">
                  <span className="ptc-lev-label">Available to Trade<InfoTip text={PTC_TIPS["Cash"]} /></span>
                  <span className="ptc-hl-value">
                    {portfolio ? `$${portfolio.cashBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
                  </span>
                </div>
              </div>

              <label className="ptc-hl-amount">
                <span className="ptc-hl-amount-icon" aria-hidden="true">{amountUnit === "usd" ? "$" : coin[0]}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-label="Amount"
                  value={amountUnit === "usd" ? formatUsdAmountDisplay(amountUsd) : amountUsd}
                  onChange={(e) => setAmountUsd(sanitizeAmountInput(e.target.value.replace(/,/g, "")))}
                />
                <button
                  type="button"
                  className="ptc-hl-unit"
                  onClick={() => {
                    const current = parseFloat(amountUsd);
                    const nextUnit = amountUnit === "usd" ? "coin" : "usd";
                    if (formPrice && Number.isFinite(current) && current > 0) {
                      const converted = nextUnit === "coin" ? current / formPrice : current * formPrice;
                      setAmountUsd(String(Math.round(converted * 1e6) / 1e6));
                    }
                    setAmountUnit(nextUnit);
                  }}
                  title={amountUnit === "usd" ? `Switch to ${coin}` : "Switch to USD"}
                >
                  {amountUnit === "usd" ? "USD" : coin}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                </button>
              </label>

              {(() => {
                // % of available cash, driving / driven by the amount field.
                const cash = portfolio?.cashBalance ?? 0;
                const n = parseFloat(amountUsd);
                const usdAmt = !Number.isFinite(n) ? 0 : amountUnit === "usd" ? n : formPrice ? n * formPrice : 0;
                const pct = cash > 0 ? Math.max(0, Math.min(100, Math.round((usdAmt / cash) * 100))) : 0;
                const setPct = (v: number) => {
                  const usd = Math.floor(cash * (v / 100) * 100) / 100;
                  if (v === 0) { setAmountUsd(""); return; }
                  if (amountUnit === "usd" || !formPrice) setAmountUsd(String(usd));
                  else setAmountUsd(String(Math.round((usd / formPrice) * 1e6) / 1e6));
                };
                return (
                  <div className="ptc-hl-pct">
                    <div className="ptc-hl-pct-track">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={pct}
                        onChange={(e) => setPct(Number(e.target.value))}
                        style={{ ["--hl-pct" as string]: `${pct}%` }}
                        aria-label="Percent of available balance"
                      />
                      <div className="ptc-hl-pct-marks" aria-hidden="true">
                        {[0, 25, 50, 75, 100].map((m) => (
                          <button key={m} type="button" tabIndex={-1} className={`ptc-hl-pct-mark${pct >= m ? " on" : ""}`} style={{ left: `${m}%` }} onClick={() => setPct(m)}>
                            <i />
                            <b>{m === 100 ? "Max" : `${m}%`}</b>
                          </button>
                        ))}
                      </div>
                    </div>
                    <span className="ptc-hl-pct-box">{pct}%</span>
                  </div>
                );
              })()}

              <label className="ptc-hl-check">
                <input type="checkbox" checked={showTpSl} onChange={(e) => setShowTpSl(e.target.checked)} />
                <span>Take Profit / Stop Loss</span>
              </label>
              {showTpSl && (
                <div className="ptc-form-row">
                  <label className="ptc-field">
                    <span>Take Profit<InfoTip text={PTC_TIPS["Take Profit"]} /></span>
                    <input type="number" min="0" placeholder="TP price" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} />
                  </label>
                  <label className="ptc-field">
                    <span>Stop Loss<InfoTip text={PTC_TIPS["Stop Loss"]} /></span>
                    <input type="number" min="0" placeholder="SL price" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
                  </label>
                </div>
              )}
              {futuresPreview && (
                <div className="ptc-futures-preview">
                  <div className="ptc-detail-row"><span>Margin<InfoTip text={PTC_TIPS["Margin"]} /></span><strong>${futuresPreview.margin.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div>
                  <div className="ptc-detail-row"><span>Position Size<InfoTip text={PTC_TIPS["Position Size"]} /></span><strong>{futuresPreview.qty.toLocaleString(undefined, { maximumFractionDigits: 6 })} {coin} (${futuresPreview.notional.toLocaleString(undefined, { maximumFractionDigits: 2 })})</strong></div>
                  <div className="ptc-detail-row"><span>Est. Liquidation<InfoTip text={PTC_TIPS["Est. Liquidation"]} /></span><strong className="ptc-down">${futuresPreview.liq.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div>
                  {futuresPreview.tpProfit !== null && (
                    <div className="ptc-detail-row"><span>Profit at TP<InfoTip text={PTC_TIPS["Profit at TP"]} /></span><strong className="ptc-up">{fmtUsd(futuresPreview.tpProfit)}</strong></div>
                  )}
                  {futuresPreview.slLoss !== null && (
                    <div className="ptc-detail-row"><span>Loss at SL<InfoTip text={PTC_TIPS["Loss at SL"]} /></span><strong className="ptc-down">{fmtUsd(futuresPreview.slLoss)}</strong></div>
                  )}
                </div>
              )}
              {formError && <span className="ptc-form-error">{formError}</span>}
              <div className="ptc-form-row">
                <button
                  type="button"
                  className={`ptc-cta ptc-cta--${side}`}
                  onClick={runSubmitSequence}
                  disabled={submitting || ctaStep !== null}
                >
                  {/* Default label, or one step of the submit sequence —
                      each step slides in from the left and out to the right
                      (re-keyed so the animation replays per step). */}
                  <span
                    key={ctaStep === null ? `idle-${ctaGo}` : `step-${ctaStep}`}
                    className={`ptc-cta-label${
                      // "Opening…" only slides in and holds (the trade can take
                      // longer than one step); the others slide in and out.
                      ctaStep === 1 ? " ptc-cta-label--in" : ctaStep !== null ? " ptc-cta-label--step" : ctaGo ? " ptc-cta-label--in" : ""
                    }`}
                  >
                    {ctaStep !== null ? CTA_STEPS[ctaStep] : market === "futures"
                      ? `${side === "buy" ? "Long" : "Short"} ${coin} · ${Math.min(20, Math.max(1, Math.round(parseFloat(leverage) || 1)))}x`
                      : `${side === "buy" ? "Buy" : "Sell"} ${coin}`}
                  </span>
                </button>
              </div>
            </div>
          )}

          {positionsView === "open" && openCount > 0 && (
            <div className="ptc-positions" ref={positionsRef}>
              <button
                type="button"
                className={`ptc-positions-title${positionsOpen ? " open" : ""}`}
                onClick={() => setPositionsOpen((o) => !o)}
                aria-expanded={positionsOpen}
              >
                Current Positions
                <span className="ptc-positions-count">{openCount}</span>
                <svg className="ptc-positions-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {/* Whole list collapses/expands (grid 0fr ↔ 1fr) so the card
                  doesn't get crowded; individual rows still expand on
                  their own. */}
              <div className={`ptc-positions-collapse${positionsOpen ? " open" : ""}`}>
              <div className="ptc-positions-list">
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
                          {pos.qty.toLocaleString(undefined, { maximumFractionDigits: 6 })} @ ${pos.avgEntryPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}
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
                        <div className="ptc-detail-row"><span>Side<InfoTip text={PTC_TIPS["Side"]} /></span><strong>{pos.market === "futures" ? `${pos.side === "long" ? "LONG" : "SHORT"} ${fmtLev(pos.leverage)}x` : "SPOT"}</strong></div>
                        <div className="ptc-detail-row"><span>Size<InfoTip text={PTC_TIPS["Size"]} /></span><strong>{pos.qty.toLocaleString(undefined, { maximumFractionDigits: 6 })} {pos.coin}</strong></div>
                        <div className="ptc-detail-row"><span>Entry<InfoTip text={PTC_TIPS["Entry"]} /></span><strong>${pos.avgEntryPrice.toLocaleString()}</strong></div>
                        <div className="ptc-detail-row"><span>Current<InfoTip text={PTC_TIPS["Current"]} /></span><strong>{livePrice ? `$${livePrice.toLocaleString()}` : "—"}</strong></div>
                        {pos.market === "futures" && pos.liquidationPrice != null && (
                          <div className="ptc-detail-row"><span>Liquidation<InfoTip text={PTC_TIPS["Liquidation"]} /></span><strong>${pos.liquidationPrice.toLocaleString()}</strong></div>
                        )}
                        {pos.takeProfitPrice != null && (
                          <div className="ptc-detail-row"><span>Take Profit<InfoTip text={PTC_TIPS["Take Profit"]} /></span><strong className="ptc-up">${pos.takeProfitPrice.toLocaleString()}</strong></div>
                        )}
                        {pos.stopLossPrice != null && (
                          <div className="ptc-detail-row"><span>Stop Loss<InfoTip text={PTC_TIPS["Stop Loss"]} /></span><strong className="ptc-down">${pos.stopLossPrice.toLocaleString()}</strong></div>
                        )}
                        <div className="ptc-detail-row"><span>Opened<InfoTip text={PTC_TIPS["Opened"]} /></span><strong>{new Date(pos.updatedAt).toLocaleString()}</strong></div>
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
              </div>
            </div>
          )}

          {/* Same list area, the other view (the .ptc-header-top switcher
              above swaps between them) — not a separate section bolted
              on somewhere else in the card, which never had a right
              place to live (busy next to the open list, still wrong at
              the very bottom). */}
          {positionsView === "closed" && (
            <div className="ptc-closed-list">
              {closedLoading && <p className="ptc-closed-empty">Loading…</p>}
              {!closedLoading && closedPositions && closedPositions.length === 0 && (
                <p className="ptc-closed-empty">No closed positions yet.</p>
              )}
              {!closedLoading && closedPositions && closedPositions.slice(0, 5).map((item, i) => (
                <div key={`${item.coin}-${item.closedAt}-${i}`} className="ptc-closed-row">
                  <span className={`ptc-position-side ptc-position-side--${item.side}`}>
                    {item.side === "long" ? "LONG" : "SHORT"}
                  </span>
                  <span className="ptc-position-coin">{item.coin}</span>
                  {item.leverage > 1 && <span className="ptc-position-lev">{fmtLev(item.leverage)}x</span>}
                  <span className="ptc-closed-exit">@ ${item.exitPrice?.toLocaleString()}</span>
                  <span className="ptc-closed-time">{item.closedAt ? formatRelativeTime(Math.floor(new Date(item.closedAt).getTime() / 1000)) : ""}</span>
                  <span className={`ptc-closed-pnl ${(item.realizedPnl ?? 0) >= 0 ? "ptc-up" : "ptc-down"}`}>
                    {fmtUsd(item.realizedPnl ?? 0)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {user && !loading && portfolio?.consentAcceptedAt && (
        <>
          <button
            type="button"
            className="ptc-agent-nudge"
            onClick={() => window.dispatchEvent(new CustomEvent("open-trading-agent"))}
          >
            <span className="ptc-agent-nudge-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z" /></svg>
            </span>
            <span className="ptc-agent-nudge-link">Not sure what to trade? <b>Ask Agent ready</b></span>
          </button>

          {/* Promotes the full Trade Manager page (App.tsx: setActiveSection
              "riskcalc") — this card covers open/close/manage already, but
              the full page has the richer flows (beginner wizard, AI review)
              this one deliberately doesn't try to replicate. */}
          <button type="button" className="ptc-page-link" onClick={onOpen}>
            Want more tools? Open the full Trade Manager →
          </button>
          <button
            type="button"
            className="ptc-switch-view-btn"
            onClick={() => (positionsView === "open" ? switchToClosed() : setPositionsView("open"))}
          >
            {positionsView === "open" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
                <path d="M12 7v5l3 2" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 17l6-6 4 4 8-8" />
                <path d="M15 7h6v6" />
              </svg>
            )}
            {positionsView === "open" ? "Closed Positions" : "Current Positions"}
          </button>
        </>
      )}
    </>
  );

  return (
    <div ref={cardRef} className={`ptc-card${!user || needsActivation || dissolving ? " ptc-card--activating" : ""}${dissolving ? " ptc-card--revealing" : ""}`}>{body}</div>
  );
}
