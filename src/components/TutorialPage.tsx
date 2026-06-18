import { useState } from "react";
import "../styles/TutorialPage.css";

interface Props { onClose: () => void; }

/* ─── SVG ILLUSTRATIONS ─────────────────────────────────────── */

const BullFlagSVG = () => (
  <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="210" fill="#0d1520" rx="10"/>
    {[55,105,155].map(y => <line key={y} x1="0" y1={y} x2="460" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>)}
    {/* Flagpole */}
    <polyline points="10,170 40,145 60,155 90,120 110,130 140,90 165,100 185,65" stroke="#4ade80" strokeWidth="2.5" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    <polygon points="175,50 175,0 460,0 460,50" fill="rgba(74,222,128,0.03)"/>
    {/* Flag channel */}
    <polyline points="185,65 205,85 220,78 240,98 255,90 270,108" stroke="#94a3b8" strokeWidth="1.8" fill="none" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="0"/>
    <line x1="185" y1="65" x2="275" y2="108" stroke="rgba(148,163,184,0.3)" strokeWidth="1" strokeDasharray="4,3"/>
    <line x1="190" y1="90" x2="280" y2="130" stroke="rgba(148,163,184,0.3)" strokeWidth="1" strokeDasharray="4,3"/>
    {/* Breakout */}
    <polyline points="270,108 295,85 320,70 360,45 420,20" stroke="#4ade80" strokeWidth="2.5" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    <polygon points="270,108 295,85 320,70 360,45 420,20 460,20 460,210 270,210" fill="rgba(74,222,128,0.05)"/>
    {/* Entry */}
    <circle cx="270" cy="108" r="5" fill="#4ade80"/>
    <text x="278" y="105" fill="#4ade80" fontSize="9" fontFamily="sans-serif" fontWeight="700">ENTRY</text>
    {/* Stop */}
    <line x1="200" y1="132" x2="310" y2="132" stroke="#f87171" strokeWidth="1" strokeDasharray="4,3"/>
    <text x="315" y="135" fill="#f87171" fontSize="9" fontFamily="sans-serif">Stop</text>
    {/* Target arrow */}
    <line x1="380" y1="108" x2="380" y2="35" stroke="#4ade80" strokeWidth="1.5" strokeDasharray="3,3"/>
    <polygon points="375,37 385,37 380,27" fill="#4ade80"/>
    <text x="386" y="72" fill="#4ade80" fontSize="9" fontFamily="sans-serif">Target</text>
    {/* Labels */}
    <text x="80" y="185" fill="#94a3b8" fontSize="9" fontFamily="sans-serif">① Flagpole</text>
    <text x="205" y="185" fill="#94a3b8" fontSize="9" fontFamily="sans-serif">② Flag</text>
    <text x="310" y="185" fill="#4ade80" fontSize="9" fontFamily="sans-serif">③ Breakout</text>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">BULL FLAG PATTERN</text>
  </svg>
);

const SupportBounceSVG = () => (
  <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="210" fill="#0d1520" rx="10"/>
    {[55,105,155].map(y => <line key={y} x1="0" y1={y} x2="460" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>)}
    {/* Support zone band */}
    <rect x="0" y="148" width="460" height="20" fill="rgba(74,222,128,0.07)"/>
    <line x1="0" y1="148" x2="460" y2="148" stroke="#4ade80" strokeWidth="1" strokeDasharray="5,4"/>
    <line x1="0" y1="168" x2="460" y2="168" stroke="#4ade80" strokeWidth="0.5" strokeDasharray="3,4" opacity="0.4"/>
    <text x="8" y="143" fill="#4ade80" fontSize="9" fontFamily="sans-serif" fontWeight="600">SUPPORT ZONE</text>
    {/* Price touches support 3 times */}
    <polyline points="10,80 40,100 60,85 90,120 110,105 140,150 155,145 175,160 190,152 210,130 230,110 250,155 265,148 285,162 300,150 320,115 350,80 390,50 440,25" stroke="#60a5fa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Touch circles */}
    <circle cx="155" cy="145" r="6" fill="none" stroke="#4ade80" strokeWidth="1.5"/>
    <circle cx="265" cy="148" r="6" fill="none" stroke="#4ade80" strokeWidth="1.5"/>
    <circle cx="300" cy="150" r="6" fill="none" stroke="#4ade80" strokeWidth="1.5"/>
    <text x="145" y="195" fill="#4ade80" fontSize="8" fontFamily="sans-serif">Touch 1</text>
    <text x="255" y="195" fill="#4ade80" fontSize="8" fontFamily="sans-serif">Touch 2</text>
    <text x="290" y="195" fill="#4ade80" fontSize="8" fontFamily="sans-serif">Touch 3 = Entry</text>
    {/* Entry arrow */}
    <polygon points="295,120 305,120 300,108" fill="#4ade80"/>
    <line x1="300" y1="150" x2="300" y2="122" stroke="#4ade80" strokeWidth="1.5" strokeDasharray="3,3"/>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">SUPPORT BOUNCE — 3 TOUCHES = STRONGER LEVEL</text>
  </svg>
);

const FibRetracementSVG = () => (
  <svg viewBox="0 0 460 220" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="220" fill="#0d1520" rx="10"/>
    {/* Fib levels */}
    {[
      { y: 20,  label: "0%   $48,000", color: "#4ade80" },
      { y: 65,  label: "23.6%  $44,200", color: "#a78bfa" },
      { y: 95,  label: "38.2%  $41,500", color: "#a78bfa" },
      { y: 118, label: "50%   $39,000", color: "#fbbf24" },
      { y: 145, label: "61.8%  $36,500", color: "#f87171" },
      { y: 190, label: "100%  $30,000", color: "#4ade80" },
    ].map((f, i) => (
      <g key={i}>
        <line x1="90" y1={f.y} x2="460" y2={f.y} stroke={f.color} strokeWidth={f.color === "#fbbf24" || f.color === "#f87171" ? 1.2 : 0.8} strokeDasharray="5,4" opacity="0.6"/>
        <text x="2" y={f.y + 4} fill={f.color} fontSize="8" fontFamily="monospace" opacity="0.8">{f.label}</text>
      </g>
    ))}
    {/* Price action: uptrend then retrace to 61.8%, then bounce */}
    <polyline points="90,190 130,170 155,175 185,145 210,155 240,105 265,115 300,65 330,75 350,20" stroke="#60a5fa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    <polyline points="350,20 370,40 390,32 410,55 430,45 445,70" stroke="#94a3b8" strokeWidth="1.8" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Bounce zone highlight */}
    <rect x="350" y="138" width="110" height="28" fill="rgba(248,113,113,0.08)" rx="4"/>
    <polyline points="445,70 450,80" stroke="#94a3b8" strokeWidth="1.8" fill="none"/>
    {/* Entry at 61.8% */}
    <circle cx="445" cy="145" r="5" fill="#4ade80"/>
    <text x="350" y="133" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">Golden Zone 61.8%</text>
    <text x="390" y="160" fill="#4ade80" fontSize="9" fontFamily="sans-serif" fontWeight="700">ENTRY ↑</text>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">FIBONACCI RETRACEMENT — ADVANCED LONG</text>
  </svg>
);

const DoubleTopSVG = () => (
  <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="210" fill="#0d1520" rx="10"/>
    {[55,105,155].map(y => <line key={y} x1="0" y1={y} x2="460" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>)}
    {/* Resistance line */}
    <line x1="0" y1="35" x2="460" y2="35" stroke="#f87171" strokeWidth="1" strokeDasharray="5,4" opacity="0.7"/>
    <text x="8" y="30" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="600">RESISTANCE</text>
    {/* Neckline */}
    <line x1="0" y1="125" x2="460" y2="125" stroke="#fbbf24" strokeWidth="1" strokeDasharray="5,4" opacity="0.7"/>
    <text x="8" y="120" fill="#fbbf24" fontSize="9" fontFamily="sans-serif" fontWeight="600">NECKLINE</text>
    {/* Double top price action */}
    <polyline points="10,170 40,150 70,110 100,60 120,40 140,55 155,80 175,105 195,110 215,85 230,45 250,38 270,55 290,80 310,110 330,125 355,128 375,150 400,170 440,185" stroke="#f87171" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Top 1 and 2 labels */}
    <text x="112" y="32" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">Top 1</text>
    <text x="242" y="32" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">Top 2</text>
    {/* Entry at neckline break */}
    <circle cx="355" cy="128" r="5" fill="#f87171"/>
    <polygon points="349,158 361,158 355,170" fill="#f87171"/>
    <line x1="355" y1="128" x2="355" y2="156" stroke="#f87171" strokeWidth="1.5" strokeDasharray="3,3"/>
    <text x="362" y="126" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">ENTRY ↓</text>
    {/* Measured move */}
    <line x1="420" y1="35" x2="420" y2="125" stroke="#a78bfa" strokeWidth="1" strokeDasharray="3,3"/>
    <line x1="415" y1="35" x2="425" y2="35" stroke="#a78bfa" strokeWidth="1"/>
    <line x1="415" y1="125" x2="425" y2="125" stroke="#a78bfa" strokeWidth="1"/>
    <text x="426" y="82" fill="#a78bfa" fontSize="8" fontFamily="sans-serif">Height</text>
    <line x1="420" y1="125" x2="420" y2="185" stroke="#f87171" strokeWidth="1" strokeDasharray="3,3" opacity="0.6"/>
    <text x="426" y="160" fill="#f87171" fontSize="8" fontFamily="sans-serif">Target</text>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">DOUBLE TOP — TARGET = PATTERN HEIGHT</text>
  </svg>
);

const LiquiditySweepSVG = () => (
  <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="210" fill="#0d1520" rx="10"/>
    {/* Liquidity cluster zones */}
    <rect x="0" y="148" width="460" height="18" fill="rgba(248,113,113,0.12)"/>
    <line x1="0" y1="148" x2="460" y2="148" stroke="#f87171" strokeWidth="1.5" strokeDasharray="5,4"/>
    <text x="8" y="143" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="600">🔴 LIQUIDITY CLUSTER — Stop hunted here</text>
    {/* Price action */}
    <polyline points="10,80 40,85 70,78 100,88 130,82 160,90 190,85" stroke="#60a5fa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Spike down (sweep) */}
    <polyline points="190,85 210,100 225,130 235,160 240,172" stroke="#f87171" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Wick */}
    <line x1="240" y1="148" x2="240" y2="175" stroke="#f87171" strokeWidth="2.5" strokeLinecap="round"/>
    <line x1="235" y1="155" x2="245" y2="155" stroke="rgba(248,113,113,0.4)" strokeWidth="8" strokeLinecap="round"/>
    {/* Sharp reversal up */}
    <polyline points="240,172 248,155 260,130 275,100 295,75 325,55 365,35 410,22" stroke="#4ade80" strokeWidth="2.5" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    <polygon points="295,0 295,210 460,210 460,0" fill="rgba(74,222,128,0.04)"/>
    {/* Labels */}
    <text x="195" y="195" fill="#f87171" fontSize="9" fontFamily="sans-serif">① Sweep below stops</text>
    <text x="310" y="195" fill="#4ade80" fontSize="9" fontFamily="sans-serif">② Real move up</text>
    <circle cx="240" cy="172" r="5" fill="#4ade80"/>
    <text x="248" y="190" fill="#4ade80" fontSize="9" fontFamily="sans-serif" fontWeight="700">ENTRY</text>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">LIQUIDITY SWEEP → REVERSAL PATTERN</text>
  </svg>
);

const HeatmapClusterSVG = () => {
  const rows = [
    { y: 22,  price: "$72,400", w: 360, col: "rgba(248,113,113,0.9)",  liq: "Extreme" },
    { y: 48,  price: "$70,800", w: 220, col: "rgba(251,146,60,0.75)",  liq: "Very High" },
    { y: 74,  price: "$69,200", w: 160, col: "rgba(251,191,36,0.6)",   liq: "High" },
    { y: 100, price: "$67,800", w: 80,  col: "rgba(74,222,128,0.3)",   liq: "Medium" },
    { y: 126, price: "$66,500", w: 40,  col: "rgba(74,222,128,0.15)",  liq: "Low" },
    { y: 152, price: "$65,200", w: 200, col: "rgba(251,191,36,0.55)",  liq: "High" },
    { y: 178, price: "$63,800", w: 340, col: "rgba(248,113,113,0.85)", liq: "Extreme" },
  ];
  return (
    <svg viewBox="0 0 460 215" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
      <rect width="460" height="215" fill="#0d1520" rx="10"/>
      <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">LIQUIDATION HEATMAP — MULTI-LEVEL ANALYSIS</text>
      {rows.map((r, i) => (
        <g key={i}>
          <text x="2" y={r.y + 15} fill="rgba(255,255,255,0.55)" fontSize="8.5" fontFamily="monospace">{r.price}</text>
          <rect x="78" y={r.y + 2} width={r.w} height="18" fill={r.col} rx="3"/>
          <text x={78 + r.w + 6} y={r.y + 14} fill="rgba(255,255,255,0.45)" fontSize="8" fontFamily="sans-serif">{r.liq}</text>
        </g>
      ))}
      {/* Current price marker */}
      <line x1="78" y1="115" x2="440" y2="115" stroke="#60a5fa" strokeWidth="2" strokeDasharray="5,3"/>
      <rect x="390" y="106" width="60" height="16" fill="#1e3a5f" rx="4"/>
      <text x="420" y="117" fill="#60a5fa" fontSize="9" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">PRICE</text>
      {/* Arrows showing magnets */}
      <polygon points="54,28 62,28 58,20" fill="#f87171" opacity="0.7"/>
      <line x1="58" y1="115" x2="58" y2="30" stroke="#f87171" strokeWidth="1" strokeDasharray="3,3" opacity="0.5"/>
      <polygon points="54,185 62,185 58,193" fill="#f87171" opacity="0.7"/>
      <line x1="58" y1="115" x2="58" y2="183" stroke="#f87171" strokeWidth="1" strokeDasharray="3,3" opacity="0.5"/>
    </svg>
  );
};

const RSIDivergenceSVG = () => (
  <svg viewBox="0 0 460 230" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="230" fill="#0d1520" rx="10"/>
    {/* Price chart top half */}
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">RSI DIVERGENCE — PRICE VS MOMENTUM</text>
    <text x="8" y="28" fill="rgba(255,255,255,0.4)" fontSize="9" fontFamily="sans-serif">Price</text>
    {/* Price: higher highs */}
    <polyline points="20,95 55,80 75,88 110,60 135,68 165,40 190,50 220,100 250,88" stroke="#60a5fa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Price peaks */}
    <circle cx="110" cy="60" r="4" fill="#60a5fa"/>
    <circle cx="165" cy="40" r="4" fill="#60a5fa"/>
    {/* Arrow showing higher high */}
    <line x1="110" y1="55" x2="165" y2="35" stroke="#60a5fa" strokeWidth="1" strokeDasharray="3,2" opacity="0.6"/>
    <polygon points="162,32 169,38 167,30" fill="#60a5fa" opacity="0.6"/>
    <text x="125" y="35" fill="#60a5fa" fontSize="8" fontFamily="sans-serif">Higher High</text>
    {/* Divider */}
    <line x1="0" y1="115" x2="460" y2="115" stroke="rgba(255,255,255,0.08)" strokeWidth="1"/>
    {/* RSI bottom half */}
    <text x="8" y="130" fill="rgba(255,255,255,0.4)" fontSize="9" fontFamily="sans-serif">RSI</text>
    <line x1="8" y1="140" x2="452" y2="140" stroke="rgba(248,113,113,0.3)" strokeWidth="1" strokeDasharray="3,3"/>
    <text x="436" y="138" fill="#f87171" fontSize="8" fontFamily="sans-serif">70</text>
    {/* RSI: lower highs (divergence) */}
    <polyline points="20,190 55,165 75,175 110,148 135,158 165,162 190,172 220,190 250,178" stroke="#a78bfa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* RSI peaks */}
    <circle cx="110" cy="148" r="4" fill="#a78bfa"/>
    <circle cx="165" cy="162" r="4" fill="#a78bfa"/>
    {/* Arrow showing lower high */}
    <line x1="110" y1="148" x2="165" y2="162" stroke="#f87171" strokeWidth="1.5" strokeDasharray="3,2"/>
    <polygon points="162,162 169,158 166,166" fill="#f87171"/>
    <text x="115" y="162" fill="#f87171" fontSize="8" fontFamily="sans-serif">Lower High</text>
    {/* Warning label */}
    <rect x="290" y="122" width="162" height="28" fill="rgba(248,113,113,0.1)" rx="6"/>
    <text x="302" y="134" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">⚠ BEARISH DIVERGENCE</text>
    <text x="302" y="145" fill="#f87171" fontSize="8" fontFamily="sans-serif">Reversal likely incoming</text>
  </svg>
);

const AdvancedIndicatorsSVG = () => (
  <svg viewBox="0 0 460 240" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="240" fill="#0d1520" rx="10"/>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">CONFLUENCE: RSI + MACD + PRICE ACTION</text>
    {/* Price */}
    <text x="8" y="28" fill="rgba(255,255,255,0.35)" fontSize="8" fontFamily="sans-serif">PRICE</text>
    <polyline points="10,85 40,75 65,80 95,55 120,62 150,45 175,52 200,80 225,72 250,58 275,62 300,45 325,35 365,20 415,15" stroke="#60a5fa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Support level */}
    <line x1="150" y1="95" x2="310" y2="95" stroke="#4ade80" strokeWidth="1" strokeDasharray="4,3"/>
    <text x="315" y="98" fill="#4ade80" fontSize="8" fontFamily="sans-serif">Support</text>
    {/* RSI section */}
    <line x1="0" y1="108" x2="460" y2="108" stroke="rgba(255,255,255,0.06)" strokeWidth="1"/>
    <text x="8" y="120" fill="rgba(255,255,255,0.35)" fontSize="8" fontFamily="sans-serif">RSI</text>
    <line x1="8" y1="127" x2="452" y2="127" stroke="rgba(74,222,128,0.3)" strokeWidth="1" strokeDasharray="3,3"/>
    <text x="435" y="125" fill="#4ade80" fontSize="8" fontFamily="sans-serif">30</text>
    <polyline points="10,155 40,148 65,150 95,145 120,148 150,155 175,152 200,130 225,122 250,127 275,125 300,128 325,118 365,110 415,108" stroke="#a78bfa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* MACD section */}
    <line x1="0" y1="174" x2="460" y2="174" stroke="rgba(255,255,255,0.06)" strokeWidth="1"/>
    <text x="8" y="186" fill="rgba(255,255,255,0.35)" fontSize="8" fontFamily="sans-serif">MACD</text>
    <line x1="8" y1="210" x2="452" y2="210" stroke="rgba(255,255,255,0.08)" strokeWidth="1"/>
    {[
      {x:20,h:8,pos:false},{x:42,h:6,pos:false},{x:64,h:3,pos:false},
      {x:86,h:2,pos:true},{x:108,h:5,pos:true},{x:130,h:8,pos:true},
      {x:152,h:11,pos:true},{x:174,h:14,pos:true},{x:196,h:12,pos:true},
      {x:218,h:9,pos:true},{x:240,h:6,pos:true},{x:262,h:3,pos:true},
      {x:284,h:2,pos:false},{x:306,h:5,pos:false},{x:328,h:4,pos:true},
      {x:350,h:8,pos:true},{x:372,h:11,pos:true},{x:394,h:14,pos:true},
      {x:416,h:16,pos:true},{x:438,h:18,pos:true},
    ].map((b,i)=>(
      <rect key={i} x={b.x} y={b.pos ? 210-b.h : 210} width="16" height={b.h}
        fill={b.pos ? "rgba(74,222,128,0.7)" : "rgba(248,113,113,0.7)"} rx="1"/>
    ))}
    <polyline points="20,214 62,213 104,206 146,198 188,195 230,200 272,208 314,206 356,200 438,192" stroke="#fbbf24" strokeWidth="1.5" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Convergence zone */}
    <rect x="195" y="108" width="30" height="132" fill="rgba(74,222,128,0.06)" rx="2"/>
    <text x="192" y="105" fill="#4ade80" fontSize="9" fontFamily="sans-serif" fontWeight="700">All 3 align ↓</text>
  </svg>
);

const EXCHANGES = [
  {
    name: "Binance",
    tagline: "Largest volume worldwide",
    url: "https://www.binance.com/en/register",
    color: "#f59e0b",
    glow: "rgba(245,158,11,0.18)",
    border: "rgba(245,158,11,0.32)",
    bg: "linear-gradient(160deg, rgba(245,158,11,0.12) 0%, rgba(245,158,11,0.04) 100%)",
    stars: 5,
    badge: "Best for Pro",
    pros: ["350+ coins available", "Low trading fees 0.1%", "Full futures & margin"],
    cons: ["Not available in the US"],
  },
  {
    name: "Coinbase",
    tagline: "Most beginner-friendly",
    url: "https://www.coinbase.com/signup",
    color: "#3b82f6",
    glow: "rgba(59,130,246,0.18)",
    border: "rgba(59,130,246,0.32)",
    bg: "linear-gradient(160deg, rgba(59,130,246,0.12) 0%, rgba(59,130,246,0.04) 100%)",
    stars: 5,
    badge: "Best for Beginners",
    pros: ["US licensed & regulated", "Very simple interface", "200+ coins"],
    cons: ["Higher fees ~1.5%"],
  },
  {
    name: "Kraken",
    tagline: "Most trusted globally",
    url: "https://www.kraken.com/sign-up",
    color: "#8b5cf6",
    glow: "rgba(139,92,246,0.18)",
    border: "rgba(139,92,246,0.32)",
    bg: "linear-gradient(160deg, rgba(139,92,246,0.12) 0%, rgba(139,92,246,0.04) 100%)",
    stars: 4,
    badge: "Best for Safety",
    pros: ["US & EU fully licensed", "Industry-leading security", "Low fees 0.16%"],
    cons: ["Fewer altcoins"],
  },
] as const;

const ExchangeSelectionCards = () => (
  <div style={{
    display: "flex", gap: "10px", padding: "14px 12px", background: "#0b1220",
    borderRadius: "12px", width: "100%", boxSizing: "border-box", minHeight: "210px",
  }}>
    {EXCHANGES.map((ex) => (
      <div key={ex.name} style={{
        flex: 1, background: ex.bg, border: `1px solid ${ex.border}`,
        borderRadius: "12px", padding: "14px 12px 12px",
        display: "flex", flexDirection: "column", gap: "6px",
        position: "relative", overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", top: "-24px", left: "50%", transform: "translateX(-50%)",
          width: "90px", height: "90px", background: ex.glow,
          filter: "blur(28px)", borderRadius: "50%", pointerEvents: "none",
        }}/>
        <div style={{ fontSize: "1.05rem", fontWeight: 800, color: ex.color, textAlign: "center", letterSpacing: "-0.02em" }}>
          {ex.name}
        </div>
        <div style={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.38)", textAlign: "center" }}>
          {ex.tagline}
        </div>
        <div style={{ textAlign: "center", fontSize: "0.78rem", color: ex.color, letterSpacing: "1px" }}>
          {"★".repeat(ex.stars)}{"☆".repeat(5 - ex.stars)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "5px", flex: 1, marginTop: "4px" }}>
          {ex.pros.map((p) => (
            <div key={p} style={{ display: "flex", gap: "6px", fontSize: "0.73rem", color: "#4ade80", alignItems: "flex-start" }}>
              <span style={{ flexShrink: 0, marginTop: "1px" }}>✓</span><span>{p}</span>
            </div>
          ))}
          {ex.cons.map((c) => (
            <div key={c} style={{ display: "flex", gap: "6px", fontSize: "0.73rem", color: "#f87171", alignItems: "flex-start" }}>
              <span style={{ flexShrink: 0, marginTop: "1px" }}>✗</span><span>{c}</span>
            </div>
          ))}
        </div>
        <a
          href={ex.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            display: "block", textAlign: "center", padding: "8px 10px", marginTop: "6px",
            background: `${ex.color}1a`, border: `1px solid ${ex.border}`,
            borderRadius: "8px", color: ex.color, fontSize: "0.76rem",
            fontWeight: 700, textDecoration: "none", letterSpacing: "0.01em",
            transition: "background 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = `${ex.color}30`; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = `${ex.color}1a`; }}
        >
          {ex.badge} →
        </a>
      </div>
    ))}
  </div>
);

const AccountSetupSVG = () => (
  <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="210" fill="#0d1520" rx="10"/>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">ACCOUNT SETUP — 6 STEPS TO YOUR FIRST TRADE</text>
    {([
      { x: 10,  icon: "📧", label: "Sign Up",  sub1: "Email +",    sub2: "Password",    color: "#60a5fa" },
      { x: 84,  icon: "✉️", label: "Verify",   sub1: "Check your", sub2: "email inbox", color: "#4ade80" },
      { x: 158, icon: "🪪", label: "KYC",      sub1: "ID + selfie", sub2: "~5 min",     color: "#fbbf24" },
      { x: 232, icon: "🔐", label: "2FA",      sub1: "Auth app",   sub2: "not SMS",     color: "#a78bfa" },
      { x: 306, icon: "💳", label: "Deposit",  sub1: "Bank/card",  sub2: "or crypto",   color: "#f97316" },
      { x: 380, icon: "🚀", label: "Trade",    sub1: "Spot only",  sub2: "to start!",   color: "#4ade80" },
    ] as const).map((s, i) => (
      <g key={i}>
        <rect x={s.x} y="28" width="68" height="158" fill={`${s.color}0d`} stroke={`${s.color}44`} strokeWidth="1.2" rx="7"/>
        <text x={s.x + 34} y="56" fontSize="17" fontFamily="sans-serif" textAnchor="middle">{s.icon}</text>
        <rect x={s.x + 24} y="62" width="20" height="13" fill={`${s.color}22`} rx="6"/>
        <text x={s.x + 34} y="72" fill={s.color} fontSize="8" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">{`0${i + 1}`}</text>
        <text x={s.x + 34} y="91" fill={s.color} fontSize="9.5" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">{s.label}</text>
        <text x={s.x + 34} y="108" fill="rgba(255,255,255,0.45)" fontSize="7.5" fontFamily="sans-serif" textAnchor="middle">{s.sub1}</text>
        <text x={s.x + 34} y="120" fill="rgba(255,255,255,0.45)" fontSize="7.5" fontFamily="sans-serif" textAnchor="middle">{s.sub2}</text>
        {i < 5 && <polygon points={`${s.x + 70},107 ${s.x + 77},103 ${s.x + 77},111`} fill="rgba(255,255,255,0.18)"/>}
      </g>
    ))}
    <text x="230" y="202" fill="rgba(255,255,255,0.25)" fontSize="8" fontFamily="sans-serif" textAnchor="middle">Total time: ~15 minutes • Available 24/7</text>
  </svg>
);

const CexDexCards = () => (
  <div style={{
    display: "flex", gap: "10px", padding: "14px 12px", background: "#0b1220",
    borderRadius: "12px", width: "100%", boxSizing: "border-box", minHeight: "210px",
    alignItems: "stretch", position: "relative",
  }}>
    {([
      {
        key: "cex", label: "CEX", sublabel: "Centralized Exchange",
        examples: "Binance · Coinbase · Kraken",
        color: "#3b82f6", glow: "rgba(59,130,246,0.18)", border: "rgba(59,130,246,0.32)",
        bg: "linear-gradient(160deg, rgba(59,130,246,0.12) 0%, rgba(59,130,246,0.04) 100%)",
        pros: ["Beginner-friendly UI", "Fiat deposit (bank/card)", "KYC adds accountability", "24/7 customer support"],
        cons: ["They hold your keys", "Can be hacked/frozen", "Account can be banned"],
      },
      {
        key: "dex", label: "DEX", sublabel: "Decentralized Exchange",
        examples: "Uniswap · dYdX · Jupiter",
        color: "#f59e0b", glow: "rgba(245,158,11,0.18)", border: "rgba(245,158,11,0.32)",
        bg: "linear-gradient(160deg, rgba(245,158,11,0.12) 0%, rgba(245,158,11,0.04) 100%)",
        pros: ["You own your keys", "No KYC needed", "Cannot be frozen", "Access to DeFi tokens"],
        cons: ["Complex for beginners", "No fiat on-ramp", "No support if error"],
      },
    ] as const).map((side, idx) => (
      <div key={side.key} style={{
        flex: 1, background: side.bg, border: `1px solid ${side.border}`,
        borderRadius: "12px", padding: "14px 14px 14px",
        display: "flex", flexDirection: "column", gap: "5px",
        position: "relative", overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", top: "-20px", left: "50%", transform: "translateX(-50%)",
          width: "100px", height: "100px", background: side.glow,
          filter: "blur(30px)", borderRadius: "50%", pointerEvents: "none",
        }}/>
        <div style={{ fontSize: "1.35rem", fontWeight: 800, color: side.color, textAlign: "center", letterSpacing: "-0.02em" }}>
          {side.label}
        </div>
        <div style={{ fontSize: "0.72rem", color: "rgba(255,255,255,0.38)", textAlign: "center" }}>{side.sublabel}</div>
        <div style={{ fontSize: "0.65rem", color: "rgba(255,255,255,0.2)", textAlign: "center", marginBottom: "6px" }}>{side.examples}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "7px", flex: 1 }}>
          {side.pros.map((p) => (
            <div key={p} style={{ display: "flex", gap: "7px", fontSize: "0.78rem", color: "#4ade80", alignItems: "flex-start" }}>
              <span style={{ flexShrink: 0, fontWeight: 700 }}>✓</span><span>{p}</span>
            </div>
          ))}
          <div style={{ height: "1px", background: "rgba(255,255,255,0.06)", margin: "2px 0" }}/>
          {side.cons.map((c) => (
            <div key={c} style={{ display: "flex", gap: "7px", fontSize: "0.78rem", color: "#f87171", alignItems: "flex-start" }}>
              <span style={{ flexShrink: 0, fontWeight: 700 }}>✗</span><span>{c}</span>
            </div>
          ))}
        </div>
        {idx === 0 && (
          <div style={{
            position: "absolute", right: "-18px", top: "50%", transform: "translateY(-50%)",
            fontSize: "0.72rem", fontWeight: 800, color: "rgba(255,255,255,0.2)",
            background: "#0b1220", padding: "4px 6px", borderRadius: "20px",
            border: "1px solid rgba(255,255,255,0.08)", zIndex: 2, letterSpacing: "0.05em",
          }}>vs</div>
        )}
      </div>
    ))}
  </div>
);

const SecuritySetupSVG = () => (
  <svg viewBox="0 0 460 218" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="218" fill="#0d1520" rx="10"/>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">SECURITY LAYERS — PROTECTING YOUR CRYPTO</text>
    <path d="M230 22 L262 36 L262 65 Q262 90 230 102 Q198 90 198 65 L198 36 Z" fill="rgba(74,222,128,0.09)" stroke="#4ade80" strokeWidth="1.5"/>
    <text x="230" y="70" fontSize="20" fontFamily="sans-serif" textAnchor="middle">🛡</text>
    <text x="230" y="88" fill="#4ade80" fontSize="8" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">Your Crypto</text>
    <rect x="10" y="110" width="440" height="30" fill="rgba(96,165,250,0.07)" stroke="rgba(96,165,250,0.22)" strokeWidth="1" rx="6"/>
    <text x="20" y="129" fill="#60a5fa" fontSize="8.5" fontFamily="sans-serif" fontWeight="700">LAYER 1 — Strong Password (16+ chars, unique, use a password manager)</text>
    <rect x="398" y="115" width="44" height="20" fill="rgba(96,165,250,0.14)" rx="4"/>
    <text x="420" y="128" fill="#60a5fa" fontSize="8" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">Basic</text>
    <rect x="10" y="146" width="440" height="30" fill="rgba(167,139,250,0.07)" stroke="rgba(167,139,250,0.22)" strokeWidth="1" rx="6"/>
    <text x="20" y="165" fill="#a78bfa" fontSize="8.5" fontFamily="sans-serif" fontWeight="700">LAYER 2 — 2FA via Authenticator App (not SMS — SIM-swap risk!)</text>
    <rect x="398" y="151" width="44" height="20" fill="rgba(167,139,250,0.14)" rx="4"/>
    <text x="420" y="164" fill="#a78bfa" fontSize="8" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">Must</text>
    <rect x="10" y="182" width="440" height="30" fill="rgba(251,191,36,0.07)" stroke="rgba(251,191,36,0.22)" strokeWidth="1" rx="6"/>
    <text x="20" y="201" fill="#fbbf24" fontSize="8.5" fontFamily="sans-serif" fontWeight="700">LAYER 3 — Hardware Wallet (Ledger / Trezor) for long-term holdings</text>
    <rect x="398" y="187" width="44" height="20" fill="rgba(251,191,36,0.14)" rx="4"/>
    <text x="420" y="200" fill="#fbbf24" fontSize="8" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">Pro</text>
  </svg>
);

/* ─── TUTORIAL DATA ─────────────────────────────────────────── */

const TUTORIALS = [
  {
    icon: "📈", title: "Spotting a Long",
    beginner: {
      illustrations: [
        { title: "Bull Flag Pattern", svg: <BullFlagSVG /> },
        { title: "Support Bounce — 3 Touch Rule", svg: <SupportBounceSVG /> },
      ],
      steps: [
        { emoji: "1️⃣", text: "Identify an uptrend — price making higher highs and higher lows. Never long into a confirmed downtrend." },
        { emoji: "2️⃣", text: "Wait for a pullback to a key support level. Look for a horizontal zone where price has reversed before." },
        { emoji: "3️⃣", text: "Look for a bullish reversal candle at support: hammer, bullish engulfing, or pin bar with long lower wick." },
        { emoji: "4️⃣", text: "Confirm with RSI above 40 and turning upward. If RSI is below 30, even better — oversold bounce incoming." },
        { emoji: "5️⃣", text: "Enter when price closes above the prior candle's high — this confirms the reversal and avoids fakeouts." },
        { emoji: "6️⃣", text: "Set stop-loss just below the support zone. Position size so the stop-loss represents max 1–2% of your account." },
        { emoji: "7️⃣", text: "Target the next resistance level or a minimum 2:1 reward-to-risk ratio before entering." },
      ],
      mistakes: [
        "Buying before the reversal candle confirms — you're guessing, not trading",
        "Entering at resistance thinking it will break — wait for the actual breakout",
        "Ignoring the higher timeframe trend — longs work best in uptrends",
        "Setting stops too tight — minor wicks will stop you out before the move",
      ],
      tips: ["Volume spike on breakout = high conviction", "More touches on support = stronger level", "Check the 4H before trading the 1H"],
    },
    advanced: {
      illustrations: [
        { title: "Fibonacci Retracement — Golden Zone", svg: <FibRetracementSVG /> },
        { title: "Confluence: RSI + MACD + Price Action", svg: <AdvancedIndicatorsSVG /> },
      ],
      steps: [
        { emoji: "1️⃣", text: "Draw Fibonacci retracement from the last major swing low to swing high. The 61.8% level is the 'Golden Zone' — highest probability long." },
        { emoji: "2️⃣", text: "Look for confluence: Fib 61.8% aligning with a horizontal support zone. Two reasons to enter = much higher confidence." },
        { emoji: "3️⃣", text: "Add RSI — if RSI is near 40 or below 30 at the Fib level, that's a triple confluence. Very high probability setup." },
        { emoji: "4️⃣", text: "Check MACD — a bullish crossover at the Fib level confirms momentum is turning. Histogram flipping from red to green is the signal." },
        { emoji: "5️⃣", text: "Check the liquidation heatmap — large liquidity clusters below your entry often get swept first. Wait for the sweep, then enter." },
        { emoji: "6️⃣", text: "Scale in: put 50% of position at 61.8% Fib, add the remaining 50% on confirmation candle close." },
        { emoji: "7️⃣", text: "Use the 0% Fib level (prior high) as TP1 and set a trailing stop once TP1 is hit to let winners run." },
      ],
      mistakes: [
        "Trading every Fib level — only the 50% and 61.8% have meaningful edge",
        "Not waiting for MACD/RSI confluence — Fib alone is weak without confirmation",
        "Ignoring the macro trend — Fib longs only work in macro uptrends",
        "Moving stop-loss to breakeven too early — gets you stopped on normal consolidation",
      ],
      tips: ["Fib + support + oversold RSI = triple confluence, highest probability", "BTC Fib levels on weekly chart have held remarkably well historically", "Scale out at 38.2% and 23.6% on the way back up to lock profits"],
    },
  },
  {
    icon: "📉", title: "Spotting a Short",
    beginner: {
      illustrations: [
        { title: "Bear Flag — Short Continuation", svg: (
          <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
            <rect width="460" height="210" fill="#0d1520" rx="10"/>
            {[55,105,155].map(y=><line key={y} x1="0" y1={y} x2="460" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>)}
            <polyline points="10,30 45,55 65,45 95,80 115,70 145,110 165,100 190,140" stroke="#f87171" strokeWidth="2.5" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
            <polyline points="190,140 210,120 225,128 245,108 260,118 275,100" stroke="#94a3b8" strokeWidth="1.8" fill="none" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="0"/>
            <line x1="190" y1="140" x2="280" y2="98" stroke="rgba(148,163,184,0.3)" strokeWidth="1" strokeDasharray="4,3"/>
            <line x1="196" y1="162" x2="286" y2="120" stroke="rgba(148,163,184,0.3)" strokeWidth="1" strokeDasharray="4,3"/>
            <polyline points="275,100 295,125 320,150 360,170 410,190 450,200" stroke="#f87171" strokeWidth="2.5" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
            <polygon points="275,100 295,125 320,150 360,170 410,190 450,200 450,0 275,0" fill="rgba(248,113,113,0.05)"/>
            <circle cx="275" cy="100" r="5" fill="#f87171"/>
            <text x="282" y="98" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">ENTRY ↓</text>
            <line x1="200" y1="78" x2="310" y2="78" stroke="#f87171" strokeWidth="1" strokeDasharray="4,3"/>
            <text x="315" y="81" fill="#f87171" fontSize="9" fontFamily="sans-serif">Stop</text>
            <text x="80" y="200" fill="#94a3b8" fontSize="9" fontFamily="sans-serif">① Flagpole down</text>
            <text x="205" y="200" fill="#94a3b8" fontSize="9" fontFamily="sans-serif">② Flag</text>
            <text x="310" y="200" fill="#f87171" fontSize="9" fontFamily="sans-serif">③ Breakdown</text>
            <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">BEAR FLAG PATTERN</text>
          </svg>
        )},
        { title: "Resistance Rejection", svg: (
          <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
            <rect width="460" height="210" fill="#0d1520" rx="10"/>
            {[55,105,155].map(y=><line key={y} x1="0" y1={y} x2="460" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>)}
            <rect x="0" y="42" width="460" height="20" fill="rgba(248,113,113,0.07)"/>
            <line x1="0" y1="42" x2="460" y2="42" stroke="#f87171" strokeWidth="1" strokeDasharray="5,4"/>
            <line x1="0" y1="62" x2="460" y2="62" stroke="#f87171" strokeWidth="0.5" strokeDasharray="3,4" opacity="0.4"/>
            <text x="8" y="38" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="600">RESISTANCE ZONE — 3 Rejections</text>
            <polyline points="10,140 40,120 60,130 90,80 110,95 140,55 155,62 175,75 190,68 210,95 230,75 250,60 265,68 285,82 300,68 320,100 350,135 390,158 440,175" stroke="#60a5fa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
            <circle cx="155" cy="62" r="6" fill="none" stroke="#f87171" strokeWidth="1.5"/>
            <circle cx="265" cy="68" r="6" fill="none" stroke="#f87171" strokeWidth="1.5"/>
            <circle cx="300" cy="68" r="6" fill="none" stroke="#f87171" strokeWidth="1.5"/>
            <text x="140" y="30" fill="#f87171" fontSize="8" fontFamily="sans-serif">Reject 1</text>
            <text x="250" y="30" fill="#f87171" fontSize="8" fontFamily="sans-serif">Reject 2</text>
            <text x="283" y="30" fill="#f87171" fontSize="8" fontFamily="sans-serif">Reject 3=Entry</text>
            <polygon points="295,100 305,100 300,112" fill="#f87171"/>
            <line x1="300" y1="68" x2="300" y2="98" stroke="#f87171" strokeWidth="1.5" strokeDasharray="3,3"/>
            <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">RESISTANCE ZONE — MORE REJECTIONS = STRONGER SIGNAL</text>
          </svg>
        )},
      ],
      steps: [
        { emoji: "1️⃣", text: "Identify a downtrend or a weakening uptrend — price making lower highs. Never short at random in a bull market." },
        { emoji: "2️⃣", text: "Wait for price to bounce up to a key resistance level. The longer price has respected that level, the better." },
        { emoji: "3️⃣", text: "Look for a bearish reversal candle: shooting star, bearish engulfing, or doji with upper wick." },
        { emoji: "4️⃣", text: "Check RSI is below 60 and turning down. RSI above 70 is even better — overbought momentum reversal." },
        { emoji: "5️⃣", text: "Enter when the current candle closes below the prior candle's low — confirms rejection, not just a wick." },
        { emoji: "6️⃣", text: "Set stop-loss just above the resistance zone or the candle's high. Keep it tight." },
        { emoji: "7️⃣", text: "Target the next major support level, previous swing low, or 2:1 R:R." },
      ],
      mistakes: [
        "Shorting in a strong bull trend — 'it's too high' is not a setup",
        "Not checking funding rate — high positive funding favors shorts, negative funding is dangerous",
        "Overleveraging shorts — in crypto, shorts get squeezed violently",
        "Shorting without confirmation candle — wicks can fool you",
      ],
      tips: ["Check funding rate — above 0.1% = crowded longs, great short environment", "Volume should decrease during the bounce to resistance", "Crypto shorts need tighter stops than longs — squeezes are brutal"],
    },
    advanced: {
      illustrations: [
        { title: "Double Top — Classic Reversal Pattern", svg: <DoubleTopSVG /> },
        { title: "RSI Bearish Divergence", svg: <RSIDivergenceSVG /> },
      ],
      steps: [
        { emoji: "1️⃣", text: "Double top: price makes two peaks at roughly the same level with a trough between them. Second peak failing to break higher is a warning." },
        { emoji: "2️⃣", text: "The 'neckline' is the trough between the two tops. Breaking below the neckline is the short entry trigger." },
        { emoji: "3️⃣", text: "Measured move target: the distance from the neckline to the tops, projected downward from the neckline break." },
        { emoji: "4️⃣", text: "Confirm with RSI bearish divergence — if price makes equal/higher high but RSI makes a lower high, momentum is fading. Very powerful signal." },
        { emoji: "5️⃣", text: "MACD histogram should be shrinking at the second top — confirms momentum exhaustion before price even breaks down." },
        { emoji: "6️⃣", text: "Check the liquidation heatmap for clusters below the neckline — those become your targets." },
        { emoji: "7️⃣", text: "Stop-loss above the second top. If price makes a new high above both tops, the pattern is invalidated — get out." },
      ],
      mistakes: [
        "Shorting at the second top before neckline breaks — pattern isn't confirmed yet",
        "Ignoring RSI divergence — the most powerful short signal is divergence, not just price at resistance",
        "Setting stops too wide — double top pattern is invalidated at new highs, use that as your stop",
        "Not accounting for support levels below — know where the nearest support is before entering",
      ],
      tips: ["Double top on higher timeframes (Daily/Weekly) = institutional-level setup", "Bearish divergence on RSI is one of the highest win-rate signals in crypto", "Volume typically drops at the second top — confirms distribution"],
    },
  },
  {
    icon: "🔥", title: "Liquidation Heatmap",
    beginner: {
      illustrations: [
        { title: "Reading Liquidity Levels", svg: <HeatmapClusterSVG /> },
        { title: "Liquidity Sweep → Reversal", svg: <LiquiditySweepSVG /> },
      ],
      steps: [
        { emoji: "1️⃣", text: "Open the Liquidation Heatmap in coinhintz. Brighter = more liquidity (stop-losses and liquidation orders) sitting at that price." },
        { emoji: "2️⃣", text: "Red/orange zones are 'Extreme' liquidity — market makers know these levels and will push price there to collect orders." },
        { emoji: "3️⃣", text: "Large cluster ABOVE current price = bullish magnet. Price will likely be pulled upward to clear those stops." },
        { emoji: "4️⃣", text: "Large cluster BELOW current price = bearish magnet. Price may be pushed down to sweep those stops before reversing." },
        { emoji: "5️⃣", text: "The sweep pattern: price dips INTO the liquidity zone with a wick, triggers all the stops, then reverses sharply — this is the real trade." },
        { emoji: "6️⃣", text: "Wait for the wick INTO the zone to close back ABOVE/BELOW the zone — that's your confirmation the sweep happened." },
        { emoji: "7️⃣", text: "Combine with support/resistance: a heatmap cluster sitting exactly ON a support level = extremely high probability zone." },
      ],
      mistakes: [
        "Assuming every liquidity cluster will cause a reversal — it won't if trend is strong",
        "Fading (trading against) a move into liquidity before the wick closes — you're guessing",
        "Ignoring the overall trend — liquidity sweeps in a strong trend just continue the trend",
        "Trading into thin liquidity zones — only high-liquidity clusters matter",
      ],
      tips: ["The sweep candle often closes as a pin bar — use it as your entry signal", "Larger timeframe heatmaps show more institutional-level liquidity zones", "After a sweep, price moves fast — be ready to enter"],
    },
    advanced: {
      illustrations: [
        { title: "Multi-Level Heatmap Analysis", svg: <HeatmapClusterSVG /> },
        { title: "Sweep → Reversal Pattern", svg: <LiquiditySweepSVG /> },
      ],
      steps: [
        { emoji: "1️⃣", text: "Layer your analysis: identify all extreme liquidity clusters above and below price. These become your price targets AND potential reversal zones." },
        { emoji: "2️⃣", text: "'Liquidity cascade': when a sweep triggers one cluster, it can cause a chain reaction into the next cluster below — this is how 10-20% moves start." },
        { emoji: "3️⃣", text: "Compare heatmap with Open Interest (OI): rising OI + large cluster below = very likely sweep incoming. Someone is building a position to run stops." },
        { emoji: "4️⃣", text: "Funding rate analysis: if funding is extremely positive + heatmap shows massive cluster below = short-squeeze setup after the downward sweep." },
        { emoji: "5️⃣", text: "Mark the zones BEFORE price reaches them. Never chase — set limit orders IN the sweep zone so you get filled on the wick." },
        { emoji: "6️⃣", text: "Risk: not all sweeps reverse. Use confluence — heatmap cluster + Fibonacci level + RSI oversold = very high probability reversal." },
        { emoji: "7️⃣", text: "Once the sweep zone is hit, set a tight stop below the wick's low. If price continues through without reversing, exit immediately." },
      ],
      mistakes: [
        "Setting market orders at liquidity zones — use limit orders to get filled on the wick",
        "Expecting every sweep to be a perfect reversal — sometimes they cascade into the next zone",
        "Not checking Open Interest alongside the heatmap — OI context is critical",
        "Missing the entry because you waited for 'more confirmation' after the sweep",
      ],
      tips: ["Set alerts at key heatmap levels so you don't miss the sweep", "The bigger the cluster, the sharper the reversal after the sweep", "Historical heatmap levels that held become support/resistance going forward"],
    },
  },
  {
    icon: "🏦", title: "Open an Account",
    beginner: {
      illustrations: [
        { title: "Choosing Your Exchange", svg: <ExchangeSelectionCards /> },
        { title: "Account Setup — 6 Steps", svg: <AccountSetupSVG /> },
      ],
      steps: [
        { emoji: "1️⃣", text: "Choose a reputable exchange. Coinbase is best for US beginners. Binance has the most coins. Kraken is trusted globally. Never use unknown exchanges — your funds can disappear overnight." },
        { emoji: "2️⃣", text: "Go to the official exchange website and click Sign Up. Use your real email and create a unique, strong password (16+ characters). Never reuse passwords from other sites." },
        { emoji: "3️⃣", text: "Verify your email. The exchange sends a confirmation link within minutes. Check spam if it doesn't arrive. Click the link to activate your account." },
        { emoji: "4️⃣", text: "Complete KYC (Know Your Customer). Upload a government ID (passport or driver's license) and take a selfie. This takes 2–10 minutes and is required by law." },
        { emoji: "5️⃣", text: "Enable 2FA immediately. Download Google Authenticator or Authy, scan the QR code in your exchange security settings. Never skip this — it protects you if your password is leaked." },
        { emoji: "6️⃣", text: "Make your first deposit. Bank transfer is cheapest (0–0.1% fee). Card deposit is fastest but costs 1.5–3%. Start small — $50–$100 is enough to learn." },
        { emoji: "7️⃣", text: "Buy your first crypto. Start with Bitcoin (BTC) or Ethereum (ETH). Use the 'Buy' button and choose Spot trading (not Futures or Leverage) for your very first purchase." },
      ],
      mistakes: [
        "Downloading fake exchange apps — always visit the official website first, then the official app store link",
        "Skipping 2FA setup — without it, a leaked password means your entire account is gone",
        "Depositing your life savings immediately — start with an amount you're comfortable losing",
        "Using SMS for 2FA — SIM-swap attacks can bypass SMS; use an authenticator app instead",
      ],
      tips: [
        "Write your 2FA backup codes on paper and store safely — you'll need them if you lose your phone",
        "Bookmark the official exchange URL to avoid phishing sites that look identical",
        "US residents: Coinbase or Kraken. Rest of world: Binance or OKX",
      ],
    },
    advanced: {
      illustrations: [
        { title: "CEX vs DEX — Which to Use?", svg: <CexDexCards /> },
        { title: "Security Layers — Protecting Your Crypto", svg: <SecuritySetupSVG /> },
      ],
      steps: [
        { emoji: "1️⃣", text: "Understand custodial risk: on a CEX, the exchange holds your private keys. 'Not your keys, not your coins.' FTX held $8B in customer funds and collapsed in 72 hours. Hardware wallets are your solution." },
        { emoji: "2️⃣", text: "Use a DEX for DeFi and privacy. MetaMask + Uniswap (Ethereum) or Phantom + Jupiter (Solana). You buy on a CEX first, then transfer to a self-custody wallet before swapping on a DEX." },
        { emoji: "3️⃣", text: "Secure your seed phrase: 12 or 24 words that are the master key to your wallet. Write it on metal (not paper — fire risk). Store copies in two separate physical locations. Never type it online." },
        { emoji: "4️⃣", text: "Enable exchange withdrawal whitelists — only pre-approved wallet addresses can receive your funds. Even if a hacker gains account access, they cannot withdraw to an unknown address." },
        { emoji: "5️⃣", text: "Use a dedicated device for crypto if possible. A cheap Chromebook reset to factory settings and used only for trading is far safer than a phone with 50 apps installed." },
        { emoji: "6️⃣", text: "Spread holdings across exchanges — never keep everything on one platform. Exchange insolvency and hacks do happen. Crypto is not FDIC-insured." },
        { emoji: "7️⃣", text: "Track taxes from day one. Most countries treat crypto as property — every trade, sale, or swap is a taxable event. Tools like Koinly or CoinTracking automate this if you connect your wallets early." },
      ],
      mistakes: [
        "Storing seed phrases digitally (photos, cloud notes, email) — one data breach loses everything permanently",
        "Trusting 'guaranteed yield' platforms — anything above 15% APY is almost always unsustainable or a Ponzi",
        "Sending to wrong network — ETH sent on BSC to an ETH-only address is permanent loss; always verify the chain",
        "Keeping large holdings on an exchange long-term — exchanges are for trading, hardware wallets are for holding",
      ],
      tips: [
        "Ledger Nano X (~$150) protects against exchange hacks, phishing, and malware — worth it above $2,000",
        "Create a separate email address exclusively for crypto — never share it, never use it for anything else",
        "Cold-storage rule: anything you wouldn't lose sleep over can stay on exchange; the rest goes to hardware",
      ],
    },
  },
  {
    icon: "📊", title: "RSI & MACD",
    beginner: {
      illustrations: [
        { title: "RSI Overbought & Oversold", svg: <RSIDivergenceSVG /> },
        { title: "MACD Crossover Signals", svg: <AdvancedIndicatorsSVG /> },
      ],
      steps: [
        { emoji: "1️⃣", text: "RSI (Relative Strength Index) measures momentum on a 0–100 scale. Above 70 = overbought. Below 30 = oversold." },
        { emoji: "2️⃣", text: "Overbought (RSI >70): market may be exhausted. Consider taking profits on longs or looking for short entries." },
        { emoji: "3️⃣", text: "Oversold (RSI <30): market may be bottoming. Look for long setups — but wait for a reversal candle first." },
        { emoji: "4️⃣", text: "RSI 50 is the neutral zone. RSI consistently above 50 = bullish momentum. Below 50 = bearish momentum." },
        { emoji: "5️⃣", text: "MACD shows the difference between 12 and 26 period EMAs. When MACD line crosses above the signal line → bullish." },
        { emoji: "6️⃣", text: "When MACD crosses below signal line → bearish momentum. The histogram bars show the strength — bigger = stronger." },
        { emoji: "7️⃣", text: "Never use RSI or MACD alone. They are confirmation tools — always combine with price action and key levels." },
      ],
      mistakes: [
        "Buying just because RSI is oversold — it can stay oversold for a long time in a downtrend",
        "Using RSI on low timeframes (1m, 5m) — too much noise, stick to 1H and above",
        "Ignoring price action and only using indicators — indicators lag, price leads",
        "Missing the MACD histogram — a shrinking histogram warns of a crossover before it happens",
      ],
      tips: ["RSI 50 cross is a trend signal — when RSI crosses above 50, bullish trend is likely confirmed", "4H and Daily RSI signals are far more reliable than lower timeframes", "RSI above 70 in a strong bull market can stay high for weeks — don't short just because it's overbought"],
    },
    advanced: {
      illustrations: [
        { title: "RSI Bearish & Bullish Divergence", svg: <RSIDivergenceSVG /> },
        { title: "Triple Confluence Setup", svg: <AdvancedIndicatorsSVG /> },
      ],
      steps: [
        { emoji: "1️⃣", text: "RSI Bearish Divergence: price makes a HIGHER high but RSI makes a LOWER high. Momentum is fading — reversal incoming. One of the most reliable signals in crypto." },
        { emoji: "2️⃣", text: "RSI Bullish Divergence: price makes a LOWER low but RSI makes a HIGHER low. Selling pressure is exhausting — reversal up likely." },
        { emoji: "3️⃣", text: "Hidden divergence: price makes higher low (uptrend), RSI makes lower low = trend continuation signal for longs. More reliable than regular divergence." },
        { emoji: "4️⃣", text: "MACD zero line cross: MACD line crossing from below to above zero = strong bullish signal. This is a momentum regime change, not just a crossover." },
        { emoji: "5️⃣", text: "Triple confluence: RSI divergence + MACD crossover + price at key support/resistance = highest probability setup available." },
        { emoji: "6️⃣", text: "RSI on multiple timeframes: RSI oversold on 4H + RSI turning up on 1H = entry timing on the 1H while having 4H confidence." },
        { emoji: "7️⃣", text: "MACD histogram peak/trough: histogram that peaks and starts shrinking before the actual crossover = early warning to prepare your position." },
      ],
      mistakes: [
        "Calling divergence with only one or two candles — you need clearly defined peaks/troughs",
        "Trading divergence on very low timeframes — divergence signals are only reliable on 1H and above",
        "Entering on RSI divergence without a price action trigger — wait for the reversal candle too",
        "Ignoring the MACD zero line — a crossover in negative territory is weaker than one in positive territory",
      ],
      tips: ["RSI divergence on the Weekly chart has preceded every major BTC top and bottom historically", "MACD zero line cross on the Daily = high conviction trend change, not just a bounce", "The best trades have RSI divergence + MACD setup + heatmap confluence all aligned"],
    },
  },
];

/* ─── COMPONENT ─────────────────────────────────────────────── */

export const TutorialPage: React.FC<Props> = ({ onClose }) => {
  const [activeTab, setActiveTab]   = useState(0);
  const [level, setLevel]           = useState<"beginner" | "advanced">("beginner");
  const [slideIndex, setSlideIndex] = useState(0);

  const tut     = TUTORIALS[activeTab];
  const content = tut[level];

  const handleTab = (i: number) => { setActiveTab(i); setSlideIndex(0); };
  const handleLevel = (l: "beginner" | "advanced") => { setLevel(l); setSlideIndex(0); };

  return (
    <div className="tutorial-overlay" onClick={onClose}>
      <div className="tutorial-page" onClick={(e) => e.stopPropagation()}>

        <div className="tutorial-header">
          <h2 className="tutorial-title">Trading Tutorials</h2>
          <button className="tutorial-close" onClick={onClose}>✕</button>
        </div>

        {/* Topic tabs */}
        <div className="tutorial-tabs">
          {TUTORIALS.map((t, i) => (
            <button key={i} className={`tutorial-tab${activeTab === i ? " active" : ""}`} onClick={() => handleTab(i)}>
              <span className="tutorial-tab-icon">{t.icon}</span>
              <span className="tutorial-tab-label">{t.title}</span>
            </button>
          ))}
        </div>

        {/* Level toggle */}
        <div className="tutorial-level-bar">
          <button className={`tutorial-level-btn${level === "beginner" ? " active" : ""}`} onClick={() => handleLevel("beginner")}>Beginner</button>
          <button className={`tutorial-level-btn${level === "advanced" ? " active" : ""}`} onClick={() => handleLevel("advanced")}>Advanced</button>
        </div>

        <div className="tutorial-body">

          {/* Illustration carousel — full width */}
          <div className="tutorial-carousel">
            <div className="tutorial-carousel-header">
              <span className="tutorial-carousel-title">{content.illustrations[slideIndex].title}</span>
              <span className="tutorial-carousel-count">{slideIndex + 1} / {content.illustrations.length}</span>
            </div>
            <div className="tutorial-illustration">{content.illustrations[slideIndex].svg}</div>
            {content.illustrations.length > 1 && (
              <div className="tutorial-carousel-nav">
                <button className="carousel-btn" onClick={() => setSlideIndex(Math.max(0, slideIndex - 1))} disabled={slideIndex === 0}>‹</button>
                <div className="carousel-dots">
                  {content.illustrations.map((_, i) => (
                    <button key={i} className={`carousel-dot${slideIndex === i ? " active" : ""}`} onClick={() => setSlideIndex(i)} />
                  ))}
                </div>
                <button className="carousel-btn" onClick={() => setSlideIndex(Math.min(content.illustrations.length - 1, slideIndex + 1))} disabled={slideIndex === content.illustrations.length - 1}>›</button>
              </div>
            )}
          </div>

          {/* Steps — full width, 2-col sub-grid */}
          <div>
            <div className="tutorial-section-title" style={{ marginBottom: 8 }}>Step-by-Step</div>
            <div className="tutorial-steps">
              {content.steps.map((s, i) => (
                <div key={i} className="tutorial-step">
                  <span className="tutorial-step-emoji">{s.emoji}</span>
                  <span className="tutorial-step-text">{s.text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Mistakes — full width, 2-col sub-grid */}
          <div>
            <div className="tutorial-section-title" style={{ marginBottom: 8 }}>Common Mistakes</div>
            <div className="tutorial-mistakes">
              {content.mistakes.map((m, i) => (
                <div key={i} className="tutorial-mistake">
                  <span className="tutorial-mistake-icon">✗</span>
                  <span className="tutorial-mistake-text">{m}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Pro tips — full width */}
          <div className="tutorial-tips">
            <h4>Pro Tips</h4>
            <ul>{content.tips.map((tip, i) => <li key={i}>{tip}</li>)}</ul>
          </div>

          <p className="tutorial-disclaimer">⚠️ Educational only. Not financial advice.</p>

        </div>
      </div>
    </div>
  );
};
