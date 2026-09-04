import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import i18n from "../i18n";
import { CoinHintzLogo } from "./CoinHintzLogo";
import "../styles/LandingPage.css";

const LANGUAGES = [
  { code: "en", flag: "🇬🇧", label: "EN", name: "English" },
  { code: "es", flag: "🇪🇸", label: "ES", name: "Español" },
  { code: "tr", flag: "🇹🇷", label: "TR", name: "Türkçe" },
  { code: "it", flag: "🇮🇹", label: "IT", name: "Italiano" },
];

function changeLang(code: string) {
  i18n.changeLanguage(code);
  try { localStorage.setItem("lang", code); } catch { /* noop */ }
}

function LangPicker() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = LANGUAGES.find(l => l.code === i18n.language) ?? LANGUAGES[0];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="lp-lang-picker" ref={ref}>
      <button className="lp-lang-trigger" onClick={() => setOpen(o => !o)}>
        {current.flag} {current.label}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style={{ marginLeft: 3, opacity: 0.6 }}>
          <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
        </svg>
      </button>
      {open && (
        <div className="lp-lang-dropdown">
          {LANGUAGES.map(l => (
            <button
              key={l.code}
              className={`lp-lang-option${l.code === current.code ? " lp-lang-option--active" : ""}`}
              onClick={() => { changeLang(l.code); setOpen(false); }}
            >
              <span>{l.flag}</span>
              <span>{l.name}</span>
              {l.code === current.code && <span className="lp-lang-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  onSignIn: () => void;
  onSignUp: () => void;
}

// Adds "lp-reveal-in" to a container the first time it scrolls into view —
// child elements key their staggered entrance animation off that class
// (see .lp-features-bento.lp-reveal-in .lp-feature-tile etc. in
// LandingPage.css) so cards animate in on scroll, not all at once on load.
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add("lp-reveal-in");
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

// [open, high, low, close, volume] — prices in $K
const CANDLES: [number, number, number, number, number][] = [
  [96.5, 97.2, 96.1, 97.0, 42], [97.0, 97.8, 96.7, 97.5, 38],
  [97.5, 98.3, 97.2, 98.1, 55], [98.1, 98.6, 97.4, 97.8, 46],
  [97.8, 98.1, 96.9, 97.2, 50], [97.2, 97.6, 96.4, 96.8, 43],
  [96.8, 98.4, 96.6, 98.2, 73], [98.2, 99.8, 98.0, 99.5, 91],
  [99.5, 101.0, 99.2, 100.8, 98], [100.8, 102.2, 100.5, 102.0, 112],
  [102.0, 102.8, 101.3, 102.5, 78], [102.5, 103.2, 101.8, 103.0, 85],
  [103.0, 103.5, 102.0, 102.6, 68], [102.6, 104.2, 102.3, 104.0, 97],
  [104.0, 105.5, 103.8, 105.2, 120], [105.2, 106.4, 104.9, 106.0, 135],
  [106.0, 106.8, 105.3, 106.4, 118], [106.4, 107.8, 106.1, 107.5, 152],
  [107.5, 108.2, 107.0, 107.8, 130], [107.8, 108.8, 107.5, 108.6, 168],
];

function computeEMA(closes: number[], period = 9): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = Array(period - 1).fill(null);
  const sma = closes.slice(0, period).reduce((a, b) => a + b) / period;
  out.push(sma);
  for (let i = period; i < closes.length; i++) out.push(closes[i] * k + out[out.length - 1]! * (1 - k));
  return out;
}


const HEATMAP: number[][] = [
  [0,0,0,1,2,2,1,0,0,0,0,1,1,2,2,3,2,1,0,0],
  [0,0,1,2,4,5,3,2,1,0,1,2,3,4,6,5,4,2,1,0],
  [0,1,2,4,6,8,5,3,2,1,2,4,5,7,8,7,5,3,1,0],
  [1,2,3,6,8,9,7,4,2,1,2,4,7,8,9,8,6,3,2,1],
  [0,1,2,4,7,8,6,4,2,0,1,3,6,8,9,8,5,3,1,0],
  [0,0,1,3,5,7,5,3,1,0,0,2,4,6,7,6,4,2,0,0],
  [1,2,4,7,9,9,8,5,2,1,2,5,8,9,9,9,7,4,2,1],
  [0,1,2,5,7,8,6,4,2,1,2,4,7,8,8,7,5,2,1,0],
  [0,0,1,3,5,6,4,2,1,0,1,2,4,5,6,5,3,1,0,0],
  [0,0,0,1,2,4,2,1,0,0,0,1,2,3,4,3,2,1,0,0],
];
const HMAP_LABELS = ["$109K","$107K","$105K","$103K","$101K","$99K","$97K","$95K","$93K","$91K"];

const FEATURE_COLORS = ["#38bdf8", "#818cf8", "#22c55e", "#fb7185", "#f59e0b", "#a78bfa"];
const PLAN_COLORS = ["#94a3b8", "#38bdf8", "#a78bfa"];
const PLAN_PRIMARY = [false, true, false];
const PLAN_ELITE   = [false, false, true];

// ── Sub-components ──────────────────────────────────────────────────────



function HeatmapPreview() {
  const heatColor = (v: number) => {
    if (v === 0) return "transparent";
    const t = v / 9;
    if (t < 0.35) return `rgba(59,130,246,${t * 0.9})`;
    if (t < 0.65) return `rgba(245,158,11,${t})`;
    return `rgba(239,68,68,${0.45 + t * 0.55})`;
  };
  return (
    <div className="lp-heatmap">
      {HEATMAP.map((row, r) => (
        <div key={r} className="lp-heatmap-row">
          {row.map((v, c) => (
            <div key={c} className="lp-heatmap-cell" style={{ background: heatColor(v) }} />
          ))}
          <span className="lp-heatmap-label">{HMAP_LABELS[r]}</span>
        </div>
      ))}
    </div>
  );
}

function FearGreedGauge({ value = 72 }: { value?: number }) {
  const cx = 70, cy = 66, r = 50;
  const angle = Math.PI - (value / 100) * Math.PI;
  const nx = cx + r * Math.cos(angle), ny = cy - r * Math.sin(angle);
  const arc = (from: number, to: number) => {
    const x1 = cx + r * Math.cos(from), y1 = cy - r * Math.sin(from);
    const x2 = cx + r * Math.cos(to),   y2 = cy - r * Math.sin(to);
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  };
  const label = value >= 75 ? "Extreme Greed" : value >= 55 ? "Greed" : value >= 45 ? "Neutral" : value >= 25 ? "Fear" : "Extreme Fear";
  const color = value >= 55 ? "#22c55e" : value >= 45 ? "#f59e0b" : "#fb7185";
  return (
    <svg viewBox="0 0 140 82" className="lp-fg-gauge">
      <defs>
        <linearGradient id="fgG" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"   stopColor="#ef4444" />
          <stop offset="25%"  stopColor="#fb7185" />
          <stop offset="50%"  stopColor="#f59e0b" />
          <stop offset="75%"  stopColor="#84cc16" />
          <stop offset="100%" stopColor="#22c55e" />
        </linearGradient>
      </defs>
      <path d={arc(Math.PI, 0)} stroke="rgba(255,255,255,0.08)" strokeWidth="11" fill="none" strokeLinecap="round" />
      <path d={arc(Math.PI, 0)} stroke="url(#fgG)" strokeWidth="11" fill="none" strokeLinecap="round" opacity="0.75" />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="white" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={4.5} fill="white" />
      <text x={cx} y={cy - 16} textAnchor="middle" fontSize="20" fontWeight="900" fill={color} fontFamily="sans-serif">{value}</text>
      <text x={cx} y={cy - 3}  textAnchor="middle" fontSize="8"  fill="rgba(148,163,184,0.7)" fontFamily="sans-serif">{label}</text>
    </svg>
  );
}

// Mini annotated candlestick chart for the CandleAI flagship promo — same
// OHLC series + EMA math shared with the hero's card collage, plus the
// smart-money overlays (order block, fair value gap, CHoCH/BOS, AI target)
// that make this read as the real AI Candle Watcher screen rather than a
// generic price chart. Colors are fixed semantic hex (bull/bear/AI accent),
// not a theme-token violation — see LandingPage.css's CandleAI promo
// comment for why.
const CAI_MIN_P = 95.5, CAI_MAX_P = 110.5, CAI_W = 600, CAI_PAD_R = 54, CAI_H = 150, CAI_PAD_T = 8;
function caiToY(p: number) { return CAI_PAD_T + (1 - (p - CAI_MIN_P) / (CAI_MAX_P - CAI_MIN_P)) * CAI_H; }

function CandleAIChart() {
  const usableW = CAI_W - CAI_PAD_R;
  const cW = usableW / CANDLES.length;
  const bodyW = Math.max(4, cW * 0.55);
  const closes = CANDLES.map(c => c[3]);
  const ema = computeEMA(closes, 9);
  const emaLine = ema
    .map((v, i) => v != null ? `${(i + 0.5) * cW},${caiToY(v)}` : null)
    .filter(Boolean).join(" ");
  const svgH = CAI_PAD_T + CAI_H + 10;
  const lastClose = CANDLES[CANDLES.length - 1][3];
  const targetY = caiToY(CAI_MAX_P - 0.5);

  return (
    <svg viewBox={`0 0 ${CAI_W} ${svgH}`} className="lp-cai-chart-svg" preserveAspectRatio="xMidYMid meet">
      {[98, 101, 104, 107].map(p => (
        <React.Fragment key={p}>
          <line x1={0} y1={caiToY(p)} x2={usableW} y2={caiToY(p)} stroke="rgba(148,163,184,0.16)" strokeWidth="1" strokeDasharray="4,4" />
          <text x={usableW + 4} y={caiToY(p) + 3} fontSize="8" fill="rgba(148,163,184,0.6)" fontFamily="'JetBrains Mono', monospace">${p}K</text>
        </React.Fragment>
      ))}

      {/* Bull order block */}
      <rect x={8 * cW} y={caiToY(101.2)} width={3 * cW} height={caiToY(99.3) - caiToY(101.2)} fill="rgba(34,197,94,0.10)" stroke="rgba(34,197,94,0.35)" strokeWidth="1" strokeDasharray="2,2" />
      <text x={8 * cW + 3} y={caiToY(101.2) - 4} fontSize="7.5" fontWeight="700" fill="#22c55e" fontFamily="'JetBrains Mono', monospace">Bull OB</text>

      {/* Fair value gap */}
      <rect x={14 * cW} y={caiToY(106.4)} width={2.3 * cW} height={caiToY(104.6) - caiToY(106.4)} fill="rgba(56,189,248,0.10)" stroke="rgba(56,189,248,0.4)" strokeWidth="1" strokeDasharray="2,2" />
      <text x={14 * cW + 2} y={caiToY(106.4) - 4} fontSize="7.5" fontWeight="700" fill="#38bdf8" fontFamily="'JetBrains Mono', monospace">FVG</text>

      {CANDLES.map(([o, h, l, c], i) => {
        const cx = (i + 0.5) * cW;
        const green = c >= o;
        const bodyTop = caiToY(Math.max(o, c)), bodyBot = caiToY(Math.min(o, c));
        const bodyH = Math.max(1.5, bodyBot - bodyTop);
        const isLast = i === CANDLES.length - 1;
        const fill = green ? "rgba(34,197,94,0.85)" : "rgba(251,113,133,0.85)";
        const lastFill = green ? "#22c55e" : "#fb7185";
        return (
          <g key={i}>
            <line x1={cx} y1={caiToY(h)} x2={cx} y2={caiToY(l)} stroke={isLast ? lastFill : fill} strokeWidth={isLast ? 1.5 : 1} />
            <rect x={cx - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} fill={isLast ? lastFill : fill} rx="1" />
          </g>
        );
      })}

      <text x={5.5 * cW} y={caiToY(96.2) + 14} fontSize="7.5" fontWeight="700" fill="#f59e0b" fontFamily="'JetBrains Mono', monospace">CHoCH ↓</text>
      <text x={16.6 * cW} y={caiToY(107.9) - 6} fontSize="7.5" fontWeight="700" fill="#22c55e" fontFamily="'JetBrains Mono', monospace">BOS ↑</text>

      {emaLine && <polyline points={emaLine} fill="none" stroke="#a78bfa" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />}

      <line x1={0} y1={targetY} x2={usableW} y2={targetY} stroke="#818cf8" strokeWidth="1.2" strokeDasharray="5,3" opacity="0.8" />
      <rect x={usableW} y={targetY - 8} width={CAI_PAD_R - 2} height={16} fill="#818cf8" rx="3" />
      <text x={usableW + CAI_PAD_R / 2 - 1} y={targetY + 4} textAnchor="middle" fontSize="7.5" fill="white" fontWeight="bold" fontFamily="'JetBrains Mono', monospace">AI $111K</text>

      <rect x={usableW} y={caiToY(lastClose) - 8} width={CAI_PAD_R - 2} height={16} fill="#22c55e" rx="3" />
      <text x={usableW + CAI_PAD_R / 2 - 1} y={caiToY(lastClose) + 4} textAnchor="middle" fontSize="7.5" fill="white" fontWeight="bold" fontFamily="'JetBrains Mono', monospace">$108.6K</text>
    </svg>
  );
}

// ── Main ────────────────────────────────────────────────────────────────

export const LandingPage: React.FC<Props> = ({ onSignIn, onSignUp }) => {
  const { t } = useTranslation();
  const featureList = t("landing.features.list", { returnObjects: true }) as { icon: string; title: string; desc: string }[];
  const pricingPlans = t("landing.pricing.plans", { returnObjects: true }) as { label: string; price: string; per: string; cta: string; features: string[] }[];

  const candleAIRevealRef = useReveal<HTMLDivElement>();
  const featuresRevealRef = useReveal<HTMLDivElement>();
  const strategyAlertsRevealRef = useReveal<HTMLDivElement>();
  const pricingRevealRef = useReveal<HTMLDivElement>();
  const ctaRevealRef = useReveal<HTMLElement>();

  return (
  <div className="lp-root">

    {/* ── Nav ──────────────────────────────────────────────────────────── */}
    <nav className="lp-nav">
      <div className="lp-nav-logo">
        <CoinHintzLogo variant="nav" />
      </div>
      <div className="lp-nav-actions">
        <button className="lp-btn-ghost lp-nav-signin" onClick={onSignIn}>{t("landing.signin")}</button>
        <LangPicker />
      </div>
    </nav>

    {/* ── Hero — established copy on the left, the bold glowing card
        collage on the right: deep brand-gradient background, split so
        the text has room to breathe beside the animation instead of
        sitting on top of it. */}
    <section className="lp-hero">
      <div className="lp-bold-glow" />
      <div className="lp-bold-inner lp-hero-split">
        <div className="lp-hero-text lp-hero-cascade">
          <div className="lp-hero-badge">{t("landing.hero.badge")}</div>
          <h1 className="lp-hero-title">{t("landing.hero.titleLine1")}<br /><span className="lp-hero-gradient">{t("landing.hero.titleGradient")}</span></h1>
          <p className="lp-hero-sub">{t("landing.hero.desc")}</p>
          <div className="lp-hero-actions">
            <button className="lp-btn-hero-primary lp-btn-glow" onClick={onSignUp}>{t("landing.hero.startFree")}</button>
          </div>
        </div>

        <div className="lp-bold-collage">
          <h2 className="lp-bold-headline">
            {t("landing.morph.title")}{" "}
            <span className="lp-bold-word-cycle">
              <span>{t("landing.morph.word1")}</span>
              <span>{t("landing.morph.word2")}</span>
              <span>{t("landing.morph.word3")}</span>
            </span>
          </h2>

          <div className="lp-bold-card lp-bold-card--price">
            <div className="lp-bold-card-top">
              <span className="lp-bold-coin">₿</span>
              <div>
                <div className="lp-bold-card-name">BTC/USD</div>
                <div className="lp-bold-card-price">$108,642 <span className="up">▲ 3.24%</span></div>
              </div>
            </div>
            <svg className="lp-bold-spark" viewBox="0 0 160 40" preserveAspectRatio="none">
              <polyline points="0,32 20,28 40,30 60,22 80,24 100,14 120,16 140,6 160,8" />
              <circle cx="160" cy="8" r="3" />
            </svg>
          </div>

          <div className="lp-bold-card lp-bold-card--signal">
            <span className="lp-bold-dot" />✦ AI Signal: ACCUMULATE
          </div>

          <div className="lp-bold-card lp-bold-card--forecast">
            <div className="lp-bold-pill">▲ {t("landing.candleAI.bullishBias")}</div>
            <div className="lp-bold-card-sub">{t("landing.candleAI.bullCaseText")} <b>$118,000</b></div>
          </div>

          <div className="lp-bold-card lp-bold-card--alert">
            <div className="lp-bold-card-kicker">{t("landing.strategyAlertsPromo.firesLabel")}</div>
            <div className="lp-bold-card-sub">{t("landing.strategyAlertsPromo.fire1")}</div>
          </div>

          <div className="lp-bold-card lp-bold-card--icons">
            <div className="lp-bold-icon-row"><span>📊</span>{t("landing.morph.screen1")}</div>
            <div className="lp-bold-icon-row"><span>⚡</span>{t("landing.morph.screen2")}</div>
            <div className="lp-bold-icon-row"><span>◎</span>{t("landing.morph.screen3")}</div>
          </div>

          <span className="lp-bold-tag lp-bold-tag--1">{t("landing.morph.tag1")}</span>
          <span className="lp-bold-tag lp-bold-tag--2">{t("landing.morph.tag2")}</span>
          <span className="lp-bold-tag lp-bold-tag--3">{t("landing.morph.tag3")}</span>
          <span className="lp-bold-tag lp-bold-tag--4">{t("landing.morph.tag4")}</span>
        </div>
      </div>
    </section>

    {/* ── CandleAI flagship promo ─────────────────────────────────────────
        Built from the real AI Candle Watcher screen (annotated chart, AI
        Read panel, Live Tape) — replaces the old Sidekick chat mock and
        AI panel mock, merged into one bento section right after the hero,
        TickScan's own pattern of leading with the real tool. */}
    <section className="lp-cai-promo">
      <div className="lp-cai-head">
        <div className="lp-section-label">{t("landing.candleAI.label")}</div>
        <h2 className="lp-section-title">{t("landing.candleAI.title")}</h2>
        <p className="lp-cai-promo-desc">{t("landing.candleAI.desc")}</p>
      </div>

      <div className="lp-cai-bento" ref={candleAIRevealRef}>
        <div className="lp-cai-tile lp-cai-tile--chart">
          <div className="lp-cai-chart-hd">
            <span className="lp-cai-chart-logo">✦</span>
            <span className="lp-cai-chart-name">AI Candle Watcher</span>
            <span className="lp-cai-chart-pair">BTC/USD · 4H</span>
            <span className="lp-cai-forecast-pill"><span className="dot" />{t("landing.candleAI.forecastPill")}</span>
          </div>
          <div className="lp-cai-chart-canvas"><CandleAIChart /></div>
          <div className="lp-cai-chart-strip">
            <div className="lp-cai-chart-stat"><div className="l">RSI(14)</div><div className="v" style={{ color: "#f59e0b" }}>54.7</div></div>
            <div className="lp-cai-chart-stat"><div className="l">MACD</div><div className="v" style={{ color: "#22c55e" }}>+148.2</div></div>
            <div className="lp-cai-chart-stat"><div className="l">EMA20</div><div className="v" style={{ color: "#22c55e" }}>↑ Above</div></div>
            <div className="lp-cai-chart-stat"><div className="l">Wyckoff</div><div className="v" style={{ color: "#38bdf8" }}>Markup</div></div>
          </div>
        </div>

        <div className="lp-cai-tile lp-cai-tile--read">
          <div className="lp-cai-kicker">{t("landing.candleAI.readKicker")}</div>
          <div className="lp-cai-bias-row">
            <span className="lp-cai-bias-pill">▲ {t("landing.candleAI.bullishBias")}</span>
            <span className="lp-cai-conf-pill">{t("landing.candleAI.mediumConf")}</span>
          </div>
          <div className="lp-cai-case-box lp-cai-case-box--bull">
            <div className="lp-cai-case-lbl">▲ {t("landing.candleAI.bullCase")}</div>
            <div className="lp-cai-case-txt">{t("landing.candleAI.bullCaseText")} <b>$82,300</b>.</div>
          </div>
          <div className="lp-cai-case-box lp-cai-case-box--bear">
            <div className="lp-cai-case-lbl">▼ {t("landing.candleAI.bearCase")}</div>
            <div className="lp-cai-case-txt">{t("landing.candleAI.bearCaseText")} <b>$77,600</b>.</div>
          </div>
          <span className="lp-cai-favored-tag">{t("landing.candleAI.bullsFavored")}</span>
        </div>

        <div className="lp-cai-tile lp-cai-tile--tape">
          <div className="lp-cai-tape-hd"><span className="dot" />{t("landing.candleAI.liveTape")}</div>
          <div className="lp-cai-tape-row">
            <span className="lp-cai-tape-mk lp-cai-tape-mk--up" />
            <div className="lp-cai-tape-body">
              <div className="lp-cai-tape-nm">{t("landing.candleAI.tape1Title")} <span className="lp-cai-tape-live">LIVE</span></div>
              <div className="lp-cai-tape-desc">{t("landing.candleAI.tape1Desc")}</div>
            </div>
            <span className="lp-cai-tape-t">{t("landing.candleAI.tapeNow")}</span>
          </div>
          <div className="lp-cai-tape-row">
            <span className="lp-cai-tape-mk lp-cai-tape-mk--up" />
            <div className="lp-cai-tape-body">
              <div className="lp-cai-tape-nm">{t("landing.candleAI.tape2Title")}</div>
              <div className="lp-cai-tape-desc">{t("landing.candleAI.tape2Desc")}</div>
            </div>
            <span className="lp-cai-tape-t">4h</span>
          </div>
          <div className="lp-cai-tape-row">
            <span className="lp-cai-tape-mk lp-cai-tape-mk--down" />
            <div className="lp-cai-tape-body">
              <div className="lp-cai-tape-nm">{t("landing.candleAI.tape3Title")}</div>
              <div className="lp-cai-tape-desc">{t("landing.candleAI.tape3Desc")}</div>
            </div>
            <span className="lp-cai-tape-t">8h</span>
          </div>
        </div>
      </div>

      <div className="lp-cai-pills">
        <span className="lp-cai-pill">{t("landing.candleAI.pillPattern")}</span>
        <span className="lp-cai-pill">{t("landing.candleAI.pillMarketMaker")}</span>
        <span className="lp-cai-pill">{t("landing.candleAI.pillSmartMoney")}</span>
        <span className="lp-cai-pill">{t("landing.candleAI.pillWyckoff")}</span>
        <span className="lp-cai-pill">{t("landing.candleAI.pillElliott")}</span>
        <span className="lp-cai-pill">{t("landing.candleAI.pillTradePlan")}</span>
      </div>

      <div className="lp-cai-cta-row">
        <button className="lp-btn-hero-primary lp-btn-glow" onClick={onSignUp}>{t("landing.candleAI.cta")}</button>
      </div>
    </section>

    {/* ── Strategy Alerts promo ────────────────────────────────────────── */}
    <section className="lp-sa-promo">
      <div className="lp-sa-promo-head">
        <div className="lp-section-label">{t("landing.strategyAlertsPromo.label")}</div>
        <h2 className="lp-section-title">{t("landing.strategyAlertsPromo.title")}</h2>
        <p className="lp-sa-promo-desc">{t("landing.strategyAlertsPromo.desc")}</p>
      </div>

      <div className="lp-sa-bento" ref={strategyAlertsRevealRef}>
        <div className="lp-sa-tile lp-sa-tile--builder">
          <div className="lp-sa-tile-kicker">{t("landing.strategyAlertsPromo.builderKicker")}</div>
          <h3 className="lp-sa-tile-title">{t("landing.strategyAlertsPromo.builderTitle")}</h3>
          <p className="lp-sa-tile-body">{t("landing.strategyAlertsPromo.builderDesc")}</p>
          <div className="lp-sa-builder-demo">
            <div className="lp-sa-cond-row"><span className="ind">RSI(14)</span><span className="tf">1h</span><span className="cmp">&lt; 30</span></div>
            <div className="lp-sa-junc-row">AND</div>
            <div className="lp-sa-cond-row"><span className="ind">Volume(20)</span><span className="tf">15m</span><span className="cmp">&gt; 2.0×</span></div>
            <div className="lp-sa-preview-line">✓ {t("landing.strategyAlertsPromo.previewLine")}</div>
          </div>
        </div>

        <div className="lp-sa-tile lp-sa-tile--fires">
          <div className="lp-sa-fires-head"><span className="dot" />{t("landing.strategyAlertsPromo.firesLabel")}</div>
          <div className="lp-sa-fire-row"><span className="lp-sa-fire-coin">₿</span><span className="lp-sa-fire-text">{t("landing.strategyAlertsPromo.fire1")}</span><span className="lp-sa-fire-time">14:02</span></div>
          <div className="lp-sa-fire-row"><span className="lp-sa-fire-coin" style={{ background: "rgba(129,140,248,0.16)", color: "#818cf8" }}>Ξ</span><span className="lp-sa-fire-text">{t("landing.strategyAlertsPromo.fire2")}</span><span className="lp-sa-fire-time">13:41</span></div>
          <div className="lp-sa-fire-row"><span className="lp-sa-fire-coin" style={{ background: "rgba(34,197,94,0.16)", color: "#22c55e" }}>◎</span><span className="lp-sa-fire-text">{t("landing.strategyAlertsPromo.fire3")}</span><span className="lp-sa-fire-time">now</span></div>
        </div>

        <div className="lp-sa-tile lp-sa-tile--coverage">
          <div className="lp-sa-tile-kicker">{t("landing.strategyAlertsPromo.coverageKicker")}</div>
          <h3 className="lp-sa-tile-title">{t("landing.strategyAlertsPromo.coverageTitle")}</h3>
          <p className="lp-sa-tile-body">{t("landing.strategyAlertsPromo.coverageDesc")}</p>
          <div className="lp-sa-pill-row">
            <span className="lp-sa-pill">RSI</span>
            <span className="lp-sa-pill">EMA</span>
            <span className="lp-sa-pill">MACD</span>
            <span className="lp-sa-pill">Bollinger %B</span>
            <span className="lp-sa-pill">Volume Ratio</span>
            <span className="lp-sa-pill lp-sa-more-pill">{t("landing.strategyAlertsPromo.morePills")}</span>
          </div>
        </div>
      </div>

      <div className="lp-sa-cta-row">
        <button className="lp-btn-hero-primary lp-btn-glow" onClick={onSignUp}>{t("landing.strategyAlertsPromo.cta")}</button>
      </div>
    </section>

    {/* ── Features ─────────────────────────────────────────────────────── */}
    <section className="lp-features">
      <div className="lp-section-label">{t("landing.features.label")}</div>
      <h2 className="lp-section-title">{t("landing.features.sectionTitle")}</h2>
      <div className="lp-features-bento" ref={featuresRevealRef}>
        {/* The two live-data features get a real embedded mini-demo instead
            of icon+text — absorbs the old standalone Heatmap/Fear&Greed
            section, which just repeated this same content less vividly. */}
        <div className="lp-feature-tile lp-feature-tile--large">
          <div className="lp-feature-tile-head">
            <span className="lp-feature-icon">{featureList[3]?.icon}</span>
            <div>
              <h3 className="lp-feature-title">{featureList[3]?.title}</h3>
              <p className="lp-feature-desc">{featureList[3]?.desc}</p>
            </div>
          </div>
          <HeatmapPreview />
        </div>

        <div className="lp-feature-tile lp-feature-tile--large">
          <div className="lp-feature-tile-head">
            <span className="lp-feature-icon">{featureList[4]?.icon}</span>
            <div>
              <h3 className="lp-feature-title">{featureList[4]?.title}</h3>
              <p className="lp-feature-desc">{featureList[4]?.desc}</p>
            </div>
          </div>
          <div className="lp-fg-wrap">
            <FearGreedGauge value={72} />
            <div className="lp-onchain-mini">
              {[{l:"Hash Rate",v:"812 EH/s",up:true},{l:"Miner Rev",v:"$52.4M",up:true},{l:"Daily Txs",v:"420K",up:false},{l:"Difficulty",v:"113.76T",up:true}].map(m => (
                <div key={m.l} className="lp-onchain-row">
                  <span className="lp-onchain-label">{m.l}</span>
                  <span className={`lp-onchain-val${m.up?" up":""}`}>{m.v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {[0, 1, 2].map(i => (
          <div key={i} className="lp-feature-tile" style={{"--fc": FEATURE_COLORS[i]} as React.CSSProperties}>
            <div className="lp-feature-icon-wrap"><span className="lp-feature-icon">{featureList[i]?.icon}</span></div>
            <h3 className="lp-feature-title">{featureList[i]?.title}</h3>
            <p className="lp-feature-desc">{featureList[i]?.desc}</p>
          </div>
        ))}
      </div>
    </section>

    {/* ── Pricing ──────────────────────────────────────────────────────── */}
    <section className="lp-pricing">
      <div className="lp-section-label">{t("landing.pricing.label")}</div>
      <h2 className="lp-section-title">{t("landing.pricing.sectionTitle")}</h2>
      <div className="lp-plans" ref={pricingRevealRef}>
        {pricingPlans.map((plan, i) => (
          <div key={i} className={`lp-plan${PLAN_PRIMARY[i] ? " lp-plan--popular" : ""}${PLAN_ELITE[i] ? " lp-plan--elite" : ""}`} style={{"--pc": PLAN_COLORS[i]} as React.CSSProperties}>
            {PLAN_PRIMARY[i] && <div className="lp-plan-popular-tag">{t("landing.pricing.popularTag")}</div>}
            {PLAN_ELITE[i]   && <div className="lp-plan-elite-tag">✦ BEST VALUE</div>}
            <div className="lp-plan-label" style={{color: PLAN_COLORS[i]}}>{plan.label}</div>
            <div className="lp-plan-price"><span className="lp-plan-amount">{plan.price}</span>{plan.per && <span className="lp-plan-per">{plan.per}</span>}</div>
            <ul className="lp-plan-features">{plan.features.map(f => <li key={f}><span style={{color: PLAN_COLORS[i]}}>✓</span> {f}</li>)}</ul>
            {PLAN_ELITE[i] && <div className="lp-plan-elite-banner">🔓 Unlimited AI predictions</div>}
            <button className={`lp-plan-cta${PLAN_PRIMARY[i] ? " lp-plan-cta--primary lp-btn-glow" : ""}${PLAN_ELITE[i] ? " lp-plan-cta--elite" : ""}`} style={PLAN_PRIMARY[i] || PLAN_ELITE[i] ? {} : {borderColor: PLAN_COLORS[i], color: PLAN_COLORS[i]}} onClick={onSignUp}>{plan.cta}</button>
          </div>
        ))}
      </div>
    </section>

    {/* ── CTA ──────────────────────────────────────────────────────────── */}
    <section className="lp-cta lp-cta-reveal" ref={ctaRevealRef}>
      <h2 className="lp-cta-title">{t("landing.cta.title")}</h2>
      <p className="lp-cta-sub">{t("landing.cta.sub")}</p>
      <button className="lp-btn-hero-primary lp-btn-glow" onClick={onSignUp}>{t("landing.cta.btn")}</button>
    </section>

    {/* ── Footer — the mobile-app teaser lives inside it now, as one
        cohesive band, instead of a separate card floating on its own. */}
    <footer className="lp-footer">
      {!Capacitor.isNativePlatform() && (
        <div className="lp-footer-mobile">
          <div className="lp-footer-mobile-text">
            <span className="lp-footer-mobile-label">{t("landing.mobileApp.label")}</span>
            <span className="lp-footer-mobile-title">{t("landing.mobileApp.title")}</span>
          </div>
          <div className="lp-store-badges">
            <div className="lp-store-badge">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.94 1.36-1.92 2.72-3.45 2.75-1.514.03-2-.89-3.73-.89-1.73 0-2.27.87-3.694.92-1.5.05-2.64-1.47-3.59-2.82-1.94-2.75-3.44-7.75-1.44-11.13.99-1.68 2.76-2.75 4.68-2.78 1.47-.03 2.86.98 3.75.98.9 0 2.58-1.21 4.35-1.03.74.03 2.82.3 4.15 2.25-.11.07-2.47 1.44-2.45 4.31.03 3.43 3.02 4.57 3.05 4.58-.03.09-.48 1.62-1.6 3.24z"/></svg>
              <div className="lp-store-badge-text">
                <span className="lp-store-badge-eyebrow">{t("landing.mobileApp.appStoreEyebrow")}</span>
                <span className="lp-store-badge-name">{t("landing.mobileApp.appStore")}</span>
              </div>
              <span className="lp-soon-pill">{t("landing.mobileApp.comingSoon")}</span>
            </div>
            <div className="lp-store-badge">
              <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#00d9ff" d="M3.6 2.3c-.4.3-.6.8-.6 1.4v16.6c0 .6.2 1.1.6 1.4l.1.1L13 12.5v-.1L3.7 2.2z"/><path fill="#00e676" d="M16.1 15.6l-3.1-3.1v-.1l3.1-3.1 3.5 2c1 .6 1 1.6 0 2.2z"/><path fill="#ff3d00" d="M16.1 8.4L13 5.3 3.7 2.2c.3-.3.9-.4 1.5 0z"/><path fill="#ffc400" d="M13 12.5l3.1 3.1-9.9 5.6c-.6.4-1.2.3-1.5 0z"/></svg>
              <div className="lp-store-badge-text">
                <span className="lp-store-badge-eyebrow">{t("landing.mobileApp.googlePlayEyebrow")}</span>
                <span className="lp-store-badge-name">{t("landing.mobileApp.googlePlay")}</span>
              </div>
              <span className="lp-soon-pill">{t("landing.mobileApp.comingSoon")}</span>
            </div>
          </div>
        </div>
      )}
      <div className="lp-footer-bottom"><span>{t("landing.footer")}</span></div>
    </footer>
  </div>
  );
};
