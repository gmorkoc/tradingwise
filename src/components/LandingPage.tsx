import React from "react";
import "../styles/LandingPage.css";

interface Props {
  onSignIn: () => void;
  onSignUp: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
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

const MIN_P = 95.5, MAX_P = 110.0, CHART_H = 180, VOL_H = 40, PAD_T = 10, PAD_R = 56;
const SVG_W = 620;

function toY(p: number) { return PAD_T + (1 - (p - MIN_P) / (MAX_P - MIN_P)) * CHART_H; }

function computeEMA(closes: number[], period = 9): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = Array(period - 1).fill(null);
  const sma = closes.slice(0, period).reduce((a, b) => a + b) / period;
  out.push(sma);
  for (let i = period; i < closes.length; i++) out.push(closes[i] * k + out[out.length - 1]! * (1 - k));
  return out;
}

const RSI_VALUES = [45, 52, 58, 55, 48, 42, 55, 65, 72, 78, 73, 75, 70, 74, 78, 80, 77, 82, 79, 85];


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

const FEATURES = [
  { icon: "📊", title: "Live Price Charts", color: "#38bdf8", desc: "Real-time candlestick charts with EMA, Bollinger Bands, RSI, and MACD. Powered by TradingView Lightweight Charts." },
  { icon: "🤖", title: "AI Market Intelligence", color: "#818cf8", desc: "GPT-4o analyzes funding rate, liquidations, open interest, and on-chain data to deliver a full market thesis in seconds." },
  { icon: "🎯", title: "Price Prediction Scenarios", color: "#22c55e", desc: "Bull, base, and bear case projections with probability scores and projected price paths drawn directly on the chart." },
  { icon: "🔥", title: "Liquidation Heatmap", color: "#fb7185", desc: "See where billions in leveraged positions are clustered. Know the price levels that attract the most liquidity." },
  { icon: "⛓", title: "On-Chain AI Analysis", color: "#f59e0b", desc: "Hash rate, miner revenue, transaction volume — interpreted by AI into actionable market signals." },
  { icon: "📐", title: "Gann Analysis", color: "#a78bfa", desc: "Advanced geometric price & time theory. Square of 9, Gann angles, and cycle forecasts used by professional traders." },
];

const PLANS = [
  { label: "Free",  price: "$0",     color: "#94a3b8", per: undefined, primary: false, cta: "Get Started Free", features: ["Live charts & order book","Watchlist","Fear & Greed gauge","ETF flows dashboard"] },
  { label: "Pro",   price: "$10.99", color: "#38bdf8", per: "/mo",     primary: true,  cta: "Start Pro",        features: ["Everything in Free","AI Market Intelligence","On-Chain AI Analysis","Price Prediction with scenarios","Liquidation Heatmap AI","35 AI requests / week"] },
  { label: "Elite", price: "$29.99", color: "#a78bfa", per: "/mo",     primary: false, cta: "Go Elite",         features: ["Everything in Pro — unlimited","Gann Analysis AI","HTF Multi-Timeframe AI","Coinbase Premium AI","Early access to features"] },
];

// ── Sub-components ──────────────────────────────────────────────────────


function MockChart() {
  const usableW = SVG_W - PAD_R;
  const candleW = usableW / CANDLES.length;
  const bodyW = Math.max(4, candleW * 0.55);
  const closes = CANDLES.map(c => c[3]);
  const ema = computeEMA(closes, 9);
  const maxVol = Math.max(...CANDLES.map(c => c[4]));
  const gridPrices = [96, 98, 100, 102, 104, 106, 108];
  const labelPrices = [96, 98, 100, 102, 104, 106, 108, 110];
  const volBase = PAD_T + CHART_H + 14;
  const svgH = volBase + VOL_H;

  const emaLine = ema
    .map((v, i) => v != null ? `${(i + 0.5) * candleW},${toY(v)}` : null)
    .filter(Boolean).join(" ");

  return (
    <svg viewBox={`0 0 ${SVG_W} ${svgH}`} className="lp-chart-svg" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="mcEma" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#fbbf24" />
        </linearGradient>
        <filter id="mcGlow"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <filter id="mcLast"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>

      {/* Grid */}
      {gridPrices.map(p => (
        <line key={p} x1={0} y1={toY(p)} x2={usableW} y2={toY(p)} stroke="rgba(148,163,184,0.08)" strokeWidth="1" strokeDasharray="4,4" />
      ))}
      {/* Price labels */}
      {labelPrices.map(p => (
        <text key={p} x={usableW + 4} y={toY(p) + 3.5} fontSize="8.5" fill="rgba(148,163,184,0.55)" fontFamily="monospace">${p}K</text>
      ))}

      {/* Candles + volume */}
      {CANDLES.map(([o, h, l, c, v], i) => {
        const cx = (i + 0.5) * candleW;
        const green = c >= o;
        const bodyTop = toY(Math.max(o, c)), bodyBot = toY(Math.min(o, c));
        const bodyH = Math.max(1.5, bodyBot - bodyTop);
        const isLast = i === CANDLES.length - 1;
        const vH = (v / maxVol) * VOL_H;
        const fill = green ? "rgba(34,197,94,0.82)" : "rgba(251,113,133,0.82)";
        const lastFill = green ? "#22c55e" : "#fb7185";
        return (
          <g key={i} filter={isLast ? "url(#mcLast)" : undefined}>
            <rect x={cx - bodyW / 2} y={volBase + VOL_H - vH} width={bodyW} height={vH}
              fill={green ? "rgba(34,197,94,0.28)" : "rgba(251,113,133,0.28)"} rx="1" />
            <line x1={cx} y1={toY(h)} x2={cx} y2={toY(l)} stroke={isLast ? lastFill : fill} strokeWidth={isLast ? 1.5 : 1} />
            <rect x={cx - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} fill={isLast ? lastFill : fill} rx="1" />
            {/* Buy signal at candle 13 */}
            {i === 13 && (
              <>
                <polygon points={`${cx},${toY(l)+16} ${cx-7},${toY(l)+28} ${cx+7},${toY(l)+28}`} fill="#22c55e" filter="url(#mcGlow)" />
                <text x={cx} y={toY(l)+40} textAnchor="middle" fontSize="7.5" fill="#22c55e" fontWeight="bold" fontFamily="sans-serif">BUY</text>
              </>
            )}
          </g>
        );
      })}

      {/* EMA */}
      {emaLine && <polyline points={emaLine} fill="none" stroke="url(#mcEma)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" filter="url(#mcGlow)" />}

      {/* Labels */}
      <text x={6} y={22} fontSize="11" fill="rgba(241,245,249,0.85)" fontWeight="bold" fontFamily="sans-serif">BTC / USD</text>
      <text x={6} y={35} fontSize="8.5" fill="rgba(148,163,184,0.55)" fontFamily="sans-serif">1H · EMA(9)</text>
      <text x={6} y={volBase + 9} fontSize="7.5" fill="rgba(148,163,184,0.4)" fontFamily="sans-serif">VOL</text>

      {/* Current price badge */}
      <rect x={usableW} y={toY(CANDLES[19][3]) - 8} width={PAD_R - 2} height={15} fill="#22c55e" rx="3" />
      <text x={usableW + PAD_R / 2 - 1} y={toY(CANDLES[19][3]) + 3} textAnchor="middle" fontSize="8" fill="white" fontWeight="bold" fontFamily="monospace">$108.6K</text>
    </svg>
  );
}

function RSIChart() {
  const W = SVG_W - PAD_R, H = 44;
  const n = RSI_VALUES.length;
  const cW = W / n;
  const pts = RSI_VALUES.map((v, i) => `${(i + 0.5) * cW},${H - (v / 100) * H}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="lp-rsi-svg" preserveAspectRatio="xMidYMid meet">
      <line x1={0} y1={H * 0.3} x2={W} y2={H * 0.3} stroke="rgba(251,113,133,0.2)" strokeWidth="0.8" strokeDasharray="3,3" />
      <line x1={0} y1={H * 0.7} x2={W} y2={H * 0.7} stroke="rgba(34,197,94,0.2)"   strokeWidth="0.8" strokeDasharray="3,3" />
      <polyline points={pts} fill="none" stroke="#a78bfa" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <text x={4} y={11} fontSize="7.5" fill="rgba(148,163,184,0.45)" fontFamily="sans-serif">RSI(14)</text>
      <text x={W - 3} y={H * 0.3 + 3} textAnchor="end" fontSize="7" fill="rgba(251,113,133,0.5)" fontFamily="monospace">70</text>
      <text x={W - 3} y={H * 0.7 + 3} textAnchor="end" fontSize="7" fill="rgba(34,197,94,0.5)"   fontFamily="monospace">30</text>
    </svg>
  );
}

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

function AIChatMock() {
  const metrics = [
    { l: "Trend",   v: "BULLISH",  c: "#22c55e" },
    { l: "RSI(14)", v: "72",       c: "#f59e0b" },
    { l: "Funding", v: "+0.018%",  c: "#38bdf8" },
  ];
  return (
    <div className="lp-chat-window">
      <div className="lp-chat-header">
        <span className="lp-chat-header-logo">✦</span>
        <span className="lp-chat-header-title">TradingWise AI</span>
        <span className="lp-chat-header-live"><span className="lp-chat-live-dot" />Live</span>
      </div>
      <div className="lp-chat-body">
        <div className="lp-chat-row lp-chat-row--user">
          <div className="lp-chat-user-bubble">What's the current BTC market setup?</div>
        </div>
        <div className="lp-chat-row lp-chat-row--ai">
          <span className="lp-chat-avatar">✦</span>
          <div className="lp-chat-bubble">
            Bitcoin is holding above $105K and the <strong>EMA9 just crossed above EMA21</strong> — a strong short-term continuation signal. Funding at +0.018% confirms healthy long demand without overleveraging.
          </div>
        </div>
        <div className="lp-chat-metrics">
          {metrics.map(m => (
            <div key={m.l} className="lp-chat-metric">
              <div className="lp-chat-metric-l">{m.l}</div>
              <div className="lp-chat-metric-v" style={{ color: m.c }}>{m.v}</div>
            </div>
          ))}
        </div>
        <div className="lp-chat-row lp-chat-row--user">
          <div className="lp-chat-user-bubble">Where should I place my stop loss?</div>
        </div>
        <div className="lp-chat-row lp-chat-row--ai">
          <span className="lp-chat-avatar">✦</span>
          <div className="lp-chat-bubble">
            For a long near <strong>$108,600</strong> → stop at <strong>$104,200</strong> (EMA20 + consolidation base). That's 4.0% risk. Target <strong>$115,000</strong> gives a clean 2.9R setup.
          </div>
        </div>
        <div className="lp-chat-row lp-chat-row--ai">
          <span className="lp-chat-avatar">✦</span>
          <div className="lp-chat-typing"><span /><span /><span /></div>
        </div>
      </div>
      <div className="lp-chat-footer">
        <div className="lp-chat-input-row">
          <span className="lp-chat-placeholder">Ask about any market or strategy…</span>
          <button className="lp-chat-send">↑</button>
        </div>
      </div>
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────────────

export const LandingPage: React.FC<Props> = ({ onSignIn, onSignUp, theme, onToggleTheme }) => (
  <div className="lp-root">

    {/* ── Nav ──────────────────────────────────────────────────────────── */}
    <nav className="lp-nav">
      <div className="lp-nav-logo">
        <svg width="32" height="32" viewBox="0 0 36 36" fill="none">
          <polyline points="5,9 11,27 18,13 25,27 31,9" stroke="url(#lpG)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          <line x1="25" y1="27" x2="31" y2="9" stroke="#4ade80" strokeWidth="2.6" strokeLinecap="round"/>
          <circle cx="18" cy="13" r="3" fill="#0284c7"/><circle cx="31" cy="9" r="3" fill="#4ade80"/>
          <defs><linearGradient id="lpG" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#4f46e5"/><stop offset="100%" stopColor="#0284c7"/></linearGradient></defs>
        </svg>
        <span>TradingWise<span className="lp-nav-ai">.ai</span></span>
      </div>
      <div className="lp-nav-actions">
        <button className="lp-btn-ghost" onClick={onSignIn}>Sign In</button>
        <button className="lp-btn-primary" onClick={onSignUp}>Get Started Free</button>
        <button className="lp-theme-toggle" onClick={onToggleTheme} title="Toggle theme" aria-label="Toggle theme">{theme === "dark" ? "☀" : "☽"}</button>
      </div>
    </nav>

    {/* ── Hero ─────────────────────────────────────────────────────────── */}
    <section className="lp-hero">
      <div className="lp-hero-card">
        {/* Chart lives at the bottom as the visual background */}
        <div className="lp-hero-chart-area">
          <div className="lp-hero-chart-bar">
            <span className="lp-hcb-pair">BTC/USD · 1H</span>
            <span className="lp-hcb-price">$108,642</span>
            <span className="lp-hcb-chg">+3.24% ▲</span>
            <span className="lp-hcb-signal">✦ AI Signal: ACCUMULATE</span>
          </div>
          <div className="lp-hero-chart-body"><MockChart /></div>
          <div className="lp-hero-chart-rsi"><RSIChart /></div>
        </div>

        {/* Text overlaid on top */}
        <div className="lp-hero-text">
          <div className="lp-hero-badge">✦ AI-Powered Crypto Analytics</div>
          <h1 className="lp-hero-title">Trade smarter with<br /><span className="lp-hero-gradient">AI market intelligence</span></h1>
          <p className="lp-hero-sub">Real-time Bitcoin & crypto analytics powered by GPT-4o. Liquidation maps, on-chain signals, price prediction scenarios, and Gann analysis — all in one dashboard.</p>
          <div className="lp-hero-actions">
            <button className="lp-btn-hero-primary" onClick={onSignUp}>Start for free ✦</button>
          </div>
        </div>
      </div>
    </section>

    {/* ── AI Chat Feature Highlight ─────────────────────────────────────── */}
    <section className="lp-sidekick">
      <div className="lp-sidekick-inner">
        <div className="lp-sidekick-text">
          <div className="lp-sidekick-icon-wrap">✦</div>
          <h2 className="lp-section-title lp-sidekick-title">
            Chat with our AI,<br />your trading-focused assistant
          </h2>
          <p className="lp-sidekick-desc">
            Purpose-built for crypto markets — not a generic chatbot. Ask about market structure, get stop-loss levels, decode funding rates, and receive actionable trade setups in real-time.
          </p>
          <ul className="lp-sidekick-bullets">
            <li><span className="lp-ai-check">✓</span> Instant chart &amp; structure analysis</li>
            <li><span className="lp-ai-check">✓</span> Stop loss, target &amp; R-ratio calculations</li>
            <li><span className="lp-ai-check">✓</span> Live funding rate &amp; liquidation context</li>
            <li><span className="lp-ai-check">✓</span> Bull / bear scenario breakdowns</li>
          </ul>
          <button className="lp-sidekick-cta" onClick={onSignUp}>
            Try AI Chat <span className="lp-sidekick-cta-circle">→</span>
          </button>
        </div>
        <div className="lp-sidekick-visual">
          <AIChatMock />
        </div>
      </div>
    </section>

    {/* ── Features ─────────────────────────────────────────────────────── */}
    <section className="lp-features">
      <div className="lp-section-label">What's inside</div>
      <h2 className="lp-section-title">Everything you need to trade with edge</h2>
      <div className="lp-features-grid">
        {FEATURES.map(f => (
          <div key={f.title} className="lp-feature-card" style={{"--fc": f.color} as React.CSSProperties}>
            <div className="lp-feature-icon-wrap"><span className="lp-feature-icon">{f.icon}</span></div>
            <h3 className="lp-feature-title">{f.title}</h3>
            <p className="lp-feature-desc">{f.desc}</p>
          </div>
        ))}
      </div>
    </section>

    {/* ── AI panel mock ────────────────────────────────────────────────── */}
    <section className="lp-ai-section">
      <div className="lp-ai-inner">
        <div className="lp-ai-text">
          <div className="lp-section-label">AI Engine</div>
          <h2 className="lp-section-title">GPT-4o reads the market so you don't have to</h2>
          <p className="lp-ai-desc">Our AI ingests live funding rates, liquidation levels, RSI, MACD, long/short ratios, and fear & greed data — then synthesizes it into a clear market thesis with confidence rating, scenario projections, and an actionable recommendation.</p>
          <ul className="lp-ai-bullets">
            <li><span className="lp-ai-check">✓</span> Bull / base / bear scenario arrows on chart</li>
            <li><span className="lp-ai-check">✓</span> Support & resistance levels from AI</li>
            <li><span className="lp-ai-check">✓</span> Who's buying, who's selling analysis</li>
            <li><span className="lp-ai-check">✓</span> Key risk factors that could flip the thesis</li>
          </ul>
          <button className="lp-btn-primary" onClick={onSignUp} style={{marginTop:24}}>Try it free →</button>
        </div>

        <div className="lp-ai-mock">
          <div className="lp-ai-mock-header">
            <span className="lp-ai-mock-logo">✦</span>
            <span className="lp-ai-mock-title">AI Market Intelligence</span>
            <span className="lp-ai-mock-bull">BULLISH</span>
            <span className="lp-ai-mock-conf">HIGH</span>
          </div>
          <p className="lp-ai-mock-thesis">Bitcoin is forming a continuation pattern above the $105K psychological level. Funding rates remain healthy at +0.018%, long/short ratio of 1.34 favors bulls. EMA9 crossing above EMA21 with RSI at 72 — momentum is strong.</p>
          <div className="lp-ai-scenarios">
            <div className="lp-ai-sc lp-ai-sc--bull"><div className="lp-ai-sc-dir">▲ Bull Case</div><div className="lp-ai-sc-price">$115,000</div><div className="lp-ai-sc-prob">68%</div></div>
            <div className="lp-ai-sc lp-ai-sc--base"><div className="lp-ai-sc-dir">→ Base</div><div className="lp-ai-sc-price">$108,500</div><div className="lp-ai-sc-prob">22%</div></div>
            <div className="lp-ai-sc lp-ai-sc--bear"><div className="lp-ai-sc-dir">▼ Bear Case</div><div className="lp-ai-sc-price">$98,000</div><div className="lp-ai-sc-prob">10%</div></div>
          </div>
          <div className="lp-ai-mock-cards">
            {[{l:"Sentiment",v:"BULLISH",c:"#22c55e"},{l:"L/S Ratio",v:"1.34 ▲",c:"#22c55e"},{l:"Funding",v:"+0.018%",c:"#38bdf8"},{l:"Action",v:"ACCUMULATE",c:"#a78bfa"}].map(x => (
              <div key={x.l} className="lp-ai-mock-card"><div className="lp-ai-mock-card-l">{x.l}</div><div className="lp-ai-mock-card-v" style={{color:x.c}}>{x.v}</div></div>
            ))}
          </div>
        </div>
      </div>
    </section>

    {/* ── Heatmap + Fear & Greed ────────────────────────────────────────── */}
    <section className="lp-data-section">
      <div className="lp-data-inner">
        <div className="lp-data-block">
          <div className="lp-section-label">Liquidation Heatmap</div>
          <h3 className="lp-data-title">See where the leverage is hiding</h3>
          <p className="lp-data-desc">Visualize billions in liquidation clusters. Bright zones are price magnets that the market gravitates toward.</p>
          <HeatmapPreview />
        </div>
        <div className="lp-data-block">
          <div className="lp-section-label">Market Sentiment</div>
          <h3 className="lp-data-title">Fear & Greed + On-Chain</h3>
          <p className="lp-data-desc">Real-time sentiment index combined with hash rate, miner revenue, and on-chain volume — AI interprets it all.</p>
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
      </div>
    </section>

    {/* ── Pricing ──────────────────────────────────────────────────────── */}
    <section className="lp-pricing">
      <div className="lp-section-label">Pricing</div>
      <h2 className="lp-section-title">Start free, upgrade when you're ready</h2>
      <div className="lp-plans">
        {PLANS.map(plan => (
          <div key={plan.label} className={`lp-plan${plan.primary?" lp-plan--popular":""}`} style={{"--pc":plan.color} as React.CSSProperties}>
            {plan.primary && <div className="lp-plan-popular-tag">Most Popular</div>}
            <div className="lp-plan-label" style={{color:plan.color}}>{plan.label}</div>
            <div className="lp-plan-price"><span className="lp-plan-amount">{plan.price}</span>{plan.per && <span className="lp-plan-per">{plan.per}</span>}</div>
            <ul className="lp-plan-features">{plan.features.map(f => <li key={f}><span style={{color:plan.color}}>✓</span> {f}</li>)}</ul>
            <button className={`lp-plan-cta${plan.primary?" lp-plan-cta--primary":""}`} style={plan.primary?{}:{borderColor:plan.color,color:plan.color}} onClick={onSignUp}>{plan.cta}</button>
          </div>
        ))}
      </div>
    </section>

    {/* ── CTA ──────────────────────────────────────────────────────────── */}
    <section className="lp-cta">
      <h2 className="lp-cta-title">Ready to trade with AI?</h2>
      <p className="lp-cta-sub">Join now — free forever, no credit card required.</p>
      <button className="lp-btn-hero-primary" onClick={onSignUp}>Create free account →</button>
    </section>

    <footer className="lp-footer"><span>© 2025 TradingWise.ai · Built for serious traders</span></footer>
  </div>
);
