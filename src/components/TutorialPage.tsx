import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { BottomSheet } from "./BottomSheet";
import "../styles/TutorialPage.css";

interface Props { onClose: () => void; }

/* ─── SVG ILLUSTRATIONS ─────────────────────────────────────── */

const BullFlagSVG = () => { const { t } = useTranslation(); return (
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
    <text x="278" y="105" fill="#4ade80" fontSize="9" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.entry")}</text>
    {/* Stop */}
    <line x1="200" y1="132" x2="310" y2="132" stroke="#f87171" strokeWidth="1" strokeDasharray="4,3"/>
    <text x="315" y="135" fill="#f87171" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.stop")}</text>
    {/* Target arrow */}
    <line x1="380" y1="108" x2="380" y2="35" stroke="#4ade80" strokeWidth="1.5" strokeDasharray="3,3"/>
    <polygon points="375,37 385,37 380,27" fill="#4ade80"/>
    <text x="386" y="72" fill="#4ade80" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.target")}</text>
    {/* Labels */}
    <text x="80" y="185" fill="#94a3b8" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.flagpole")}</text>
    <text x="205" y="185" fill="#94a3b8" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.flag")}</text>
    <text x="310" y="185" fill="#4ade80" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.breakout")}</text>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.bullFlagHeader")}</text>
  </svg>
); };

const SupportBounceSVG = () => { const { t } = useTranslation(); return (
  <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="210" fill="#0d1520" rx="10"/>
    {[55,105,155].map(y => <line key={y} x1="0" y1={y} x2="460" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>)}
    {/* Support zone band */}
    <rect x="0" y="148" width="460" height="20" fill="rgba(74,222,128,0.07)"/>
    <line x1="0" y1="148" x2="460" y2="148" stroke="#4ade80" strokeWidth="1" strokeDasharray="5,4"/>
    <line x1="0" y1="168" x2="460" y2="168" stroke="#4ade80" strokeWidth="0.5" strokeDasharray="3,4" opacity="0.4"/>
    <text x="8" y="143" fill="#4ade80" fontSize="9" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.supportZone")}</text>
    {/* Price touches support 3 times */}
    <polyline points="10,80 40,100 60,85 90,120 110,105 140,150 155,145 175,160 190,152 210,130 230,110 250,155 265,148 285,162 300,150 320,115 350,80 390,50 440,25" stroke="#60a5fa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Touch circles */}
    <circle cx="155" cy="145" r="6" fill="none" stroke="#4ade80" strokeWidth="1.5"/>
    <circle cx="265" cy="148" r="6" fill="none" stroke="#4ade80" strokeWidth="1.5"/>
    <circle cx="300" cy="150" r="6" fill="none" stroke="#4ade80" strokeWidth="1.5"/>
    <text x="145" y="195" fill="#4ade80" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.touch1")}</text>
    <text x="255" y="195" fill="#4ade80" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.touch2")}</text>
    <text x="290" y="195" fill="#4ade80" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.touch3Entry")}</text>
    {/* Entry arrow */}
    <polygon points="295,120 305,120 300,108" fill="#4ade80"/>
    <line x1="300" y1="150" x2="300" y2="122" stroke="#4ade80" strokeWidth="1.5" strokeDasharray="3,3"/>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.supportBounceHeader")}</text>
  </svg>
); };

const FibRetracementSVG = () => { const { t } = useTranslation(); return (
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
    <text x="350" y="133" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.goldenZone")}</text>
    <text x="390" y="160" fill="#4ade80" fontSize="9" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.entryUp")}</text>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.fibHeader")}</text>
  </svg>
); };

const DoubleTopSVG = () => { const { t } = useTranslation(); return (
  <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="210" fill="#0d1520" rx="10"/>
    {[55,105,155].map(y => <line key={y} x1="0" y1={y} x2="460" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>)}
    {/* Resistance line */}
    <line x1="0" y1="35" x2="460" y2="35" stroke="#f87171" strokeWidth="1" strokeDasharray="5,4" opacity="0.7"/>
    <text x="8" y="30" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.resistance")}</text>
    {/* Neckline */}
    <line x1="0" y1="125" x2="460" y2="125" stroke="#fbbf24" strokeWidth="1" strokeDasharray="5,4" opacity="0.7"/>
    <text x="8" y="120" fill="#fbbf24" fontSize="9" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.neckline")}</text>
    {/* Double top price action */}
    <polyline points="10,170 40,150 70,110 100,60 120,40 140,55 155,80 175,105 195,110 215,85 230,45 250,38 270,55 290,80 310,110 330,125 355,128 375,150 400,170 440,185" stroke="#f87171" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Top 1 and 2 labels */}
    <text x="112" y="32" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.top1")}</text>
    <text x="242" y="32" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.top2")}</text>
    {/* Entry at neckline break */}
    <circle cx="355" cy="128" r="5" fill="#f87171"/>
    <polygon points="349,158 361,158 355,170" fill="#f87171"/>
    <line x1="355" y1="128" x2="355" y2="156" stroke="#f87171" strokeWidth="1.5" strokeDasharray="3,3"/>
    <text x="362" y="126" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.entryDown")}</text>
    {/* Measured move */}
    <line x1="420" y1="35" x2="420" y2="125" stroke="#a78bfa" strokeWidth="1" strokeDasharray="3,3"/>
    <line x1="415" y1="35" x2="425" y2="35" stroke="#a78bfa" strokeWidth="1"/>
    <line x1="415" y1="125" x2="425" y2="125" stroke="#a78bfa" strokeWidth="1"/>
    <text x="426" y="82" fill="#a78bfa" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.height")}</text>
    <line x1="420" y1="125" x2="420" y2="185" stroke="#f87171" strokeWidth="1" strokeDasharray="3,3" opacity="0.6"/>
    <text x="426" y="160" fill="#f87171" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.target")}</text>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.doubleTopHeader")}</text>
  </svg>
); };

const LiquiditySweepSVG = () => { const { t } = useTranslation(); return (
  <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="210" fill="#0d1520" rx="10"/>
    {/* Liquidity cluster zones */}
    <rect x="0" y="148" width="460" height="18" fill="rgba(248,113,113,0.12)"/>
    <line x1="0" y1="148" x2="460" y2="148" stroke="#f87171" strokeWidth="1.5" strokeDasharray="5,4"/>
    <text x="8" y="143" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.liqCluster")}</text>
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
    <text x="195" y="195" fill="#f87171" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.sweepBelow")}</text>
    <text x="310" y="195" fill="#4ade80" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.realMoveUp")}</text>
    <circle cx="240" cy="172" r="5" fill="#4ade80"/>
    <text x="248" y="190" fill="#4ade80" fontSize="9" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.entry")}</text>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.sweepHeader")}</text>
  </svg>
); };

const HeatmapClusterSVG = () => {
  const { t } = useTranslation();
  const rows = [
    { y: 22,  price: "$72,400", w: 360, col: "rgba(248,113,113,0.9)",  liq: "extreme" },
    { y: 48,  price: "$70,800", w: 220, col: "rgba(251,146,60,0.75)",  liq: "veryHigh" },
    { y: 74,  price: "$69,200", w: 160, col: "rgba(251,191,36,0.6)",   liq: "high" },
    { y: 100, price: "$67,800", w: 80,  col: "rgba(74,222,128,0.3)",   liq: "medium" },
    { y: 126, price: "$66,500", w: 40,  col: "rgba(74,222,128,0.15)",  liq: "low" },
    { y: 152, price: "$65,200", w: 200, col: "rgba(251,191,36,0.55)",  liq: "high" },
    { y: 178, price: "$63,800", w: 340, col: "rgba(248,113,113,0.85)", liq: "extreme" },
  ];
  return (
    <svg viewBox="0 0 460 215" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
      <rect width="460" height="215" fill="#0d1520" rx="10"/>
      <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.heatmapHeader")}</text>
      {rows.map((r, i) => (
        <g key={i}>
          <text x="2" y={r.y + 15} fill="rgba(255,255,255,0.55)" fontSize="8.5" fontFamily="monospace">{r.price}</text>
          <rect x="78" y={r.y + 2} width={r.w} height="18" fill={r.col} rx="3"/>
          <text x={78 + r.w + 6} y={r.y + 14} fill="rgba(255,255,255,0.45)" fontSize="8" fontFamily="sans-serif">{t(`tutorials.svg.levels.${r.liq}`)}</text>
        </g>
      ))}
      {/* Current price marker */}
      <line x1="78" y1="115" x2="440" y2="115" stroke="#60a5fa" strokeWidth="2" strokeDasharray="5,3"/>
      <rect x="390" y="106" width="60" height="16" fill="#1e3a5f" rx="4"/>
      <text x="420" y="117" fill="#60a5fa" fontSize="9" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">{t("tutorials.svg.priceUpper")}</text>
      {/* Arrows showing magnets */}
      <polygon points="54,28 62,28 58,20" fill="#f87171" opacity="0.7"/>
      <line x1="58" y1="115" x2="58" y2="30" stroke="#f87171" strokeWidth="1" strokeDasharray="3,3" opacity="0.5"/>
      <polygon points="54,185 62,185 58,193" fill="#f87171" opacity="0.7"/>
      <line x1="58" y1="115" x2="58" y2="183" stroke="#f87171" strokeWidth="1" strokeDasharray="3,3" opacity="0.5"/>
    </svg>
  );
};

const RSIDivergenceSVG = () => { const { t } = useTranslation(); return (
  <svg viewBox="0 0 460 230" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="230" fill="#0d1520" rx="10"/>
    {/* Price chart top half */}
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.rsiDivHeader")}</text>
    <text x="8" y="28" fill="rgba(255,255,255,0.4)" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.price")}</text>
    {/* Price: higher highs */}
    <polyline points="20,95 55,80 75,88 110,60 135,68 165,40 190,50 220,100 250,88" stroke="#60a5fa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Price peaks */}
    <circle cx="110" cy="60" r="4" fill="#60a5fa"/>
    <circle cx="165" cy="40" r="4" fill="#60a5fa"/>
    {/* Arrow showing higher high */}
    <line x1="110" y1="55" x2="165" y2="35" stroke="#60a5fa" strokeWidth="1" strokeDasharray="3,2" opacity="0.6"/>
    <polygon points="162,32 169,38 167,30" fill="#60a5fa" opacity="0.6"/>
    <text x="125" y="35" fill="#60a5fa" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.higherHigh")}</text>
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
    <text x="115" y="162" fill="#f87171" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.lowerHigh")}</text>
    {/* Warning label */}
    <rect x="290" y="122" width="162" height="28" fill="rgba(248,113,113,0.1)" rx="6"/>
    <text x="302" y="134" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.bearishDiv")}</text>
    <text x="302" y="145" fill="#f87171" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.reversalLikely")}</text>
  </svg>
); };

const AdvancedIndicatorsSVG = () => { const { t } = useTranslation(); return (
  <svg viewBox="0 0 460 240" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="240" fill="#0d1520" rx="10"/>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.confluenceHeader")}</text>
    {/* Price */}
    <text x="8" y="28" fill="rgba(255,255,255,0.35)" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.priceUpper")}</text>
    <polyline points="10,85 40,75 65,80 95,55 120,62 150,45 175,52 200,80 225,72 250,58 275,62 300,45 325,35 365,20 415,15" stroke="#60a5fa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
    {/* Support level */}
    <line x1="150" y1="95" x2="310" y2="95" stroke="#4ade80" strokeWidth="1" strokeDasharray="4,3"/>
    <text x="315" y="98" fill="#4ade80" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.support")}</text>
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
    <text x="192" y="105" fill="#4ade80" fontSize="9" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.allAlign")}</text>
  </svg>
); };

const EXCHANGES = [
  {
    name: "Binance",
    id: "binance",
    url: "https://www.binance.com/en/register",
    color: "#f59e0b",
    glow: "rgba(245,158,11,0.18)",
    border: "rgba(245,158,11,0.32)",
    bg: "linear-gradient(160deg, rgba(245,158,11,0.12) 0%, rgba(245,158,11,0.04) 100%)",
    stars: 5,
  },
  {
    name: "Coinbase",
    id: "coinbase",
    url: "https://www.coinbase.com/signup",
    color: "#3b82f6",
    glow: "rgba(59,130,246,0.18)",
    border: "rgba(59,130,246,0.32)",
    bg: "linear-gradient(160deg, rgba(59,130,246,0.12) 0%, rgba(59,130,246,0.04) 100%)",
    stars: 5,
  },
  {
    name: "Kraken",
    id: "kraken",
    url: "https://www.kraken.com/sign-up",
    color: "#8b5cf6",
    glow: "rgba(139,92,246,0.18)",
    border: "rgba(139,92,246,0.32)",
    bg: "linear-gradient(160deg, rgba(139,92,246,0.12) 0%, rgba(139,92,246,0.04) 100%)",
    stars: 4,
  },
] as const;

/** Reads a translated string array (pros/cons/steps/…); [] if the key is missing. */
const tList = (t: TFunction, key: string): string[] => {
  const v: unknown = t(key, { returnObjects: true });
  return Array.isArray(v) ? (v as string[]) : [];
};

const ExchangeSelectionCards = () => { const { t } = useTranslation(); return (
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
          {t(`tutorials.exchanges.${ex.id}.tagline`)}
        </div>
        <div style={{ textAlign: "center", fontSize: "0.78rem", color: ex.color, letterSpacing: "1px" }}>
          {"★".repeat(ex.stars)}{"☆".repeat(5 - ex.stars)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "5px", flex: 1, marginTop: "4px" }}>
          {tList(t, `tutorials.exchanges.${ex.id}.pros`).map((p) => (
            <div key={p} style={{ display: "flex", gap: "6px", fontSize: "0.73rem", color: "#4ade80", alignItems: "flex-start" }}>
              <span style={{ flexShrink: 0, marginTop: "1px" }}>✓</span><span>{p}</span>
            </div>
          ))}
          {tList(t, `tutorials.exchanges.${ex.id}.cons`).map((c) => (
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
          {t(`tutorials.exchanges.${ex.id}.badge`)} →
        </a>
      </div>
    ))}
  </div>
); };

const AccountSetupSVG = () => { const { t } = useTranslation(); return (
  <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="210" fill="#0d1520" rx="10"/>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.accountHeader")}</text>
    {([
      { x: 10,  icon: "📧", id: "signUp",  color: "#60a5fa" },
      { x: 84,  icon: "✉️", id: "verify",  color: "#4ade80" },
      { x: 158, icon: "🪪", id: "kyc",     color: "#fbbf24" },
      { x: 232, icon: "🔐", id: "twoFa",   color: "#a78bfa" },
      { x: 306, icon: "💳", id: "deposit", color: "#f97316" },
      { x: 380, icon: "🚀", id: "trade",   color: "#4ade80" },
    ] as const).map((st) => ({
      ...st,
      label: t(`tutorials.svg.accountSteps.${st.id}.label`),
      sub1: t(`tutorials.svg.accountSteps.${st.id}.sub1`),
      sub2: t(`tutorials.svg.accountSteps.${st.id}.sub2`),
    })).map((s, i) => (
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
    <text x="230" y="202" fill="rgba(255,255,255,0.25)" fontSize="8" fontFamily="sans-serif" textAnchor="middle">{t("tutorials.svg.totalTime")}</text>
  </svg>
); };

const CexDexCards = () => { const { t } = useTranslation(); return (
  <div style={{
    display: "flex", gap: "10px", padding: "14px 12px", background: "#0b1220",
    borderRadius: "12px", width: "100%", boxSizing: "border-box", minHeight: "210px",
    alignItems: "stretch", position: "relative",
  }}>
    {([
      {
        key: "cex", label: "CEX",
        examples: "Binance · Coinbase · Kraken",
        color: "#3b82f6", glow: "rgba(59,130,246,0.18)", border: "rgba(59,130,246,0.32)",
        bg: "linear-gradient(160deg, rgba(59,130,246,0.12) 0%, rgba(59,130,246,0.04) 100%)",
      },
      {
        key: "dex", label: "DEX",
        examples: "Uniswap · dYdX · Jupiter",
        color: "#f59e0b", glow: "rgba(245,158,11,0.18)", border: "rgba(245,158,11,0.32)",
        bg: "linear-gradient(160deg, rgba(245,158,11,0.12) 0%, rgba(245,158,11,0.04) 100%)",
      },
    ] as const).map((sd) => ({
      ...sd,
      sublabel: t(`tutorials.cexDex.${sd.key}.sublabel`),
      pros: tList(t, `tutorials.cexDex.${sd.key}.pros`),
      cons: tList(t, `tutorials.cexDex.${sd.key}.cons`),
    })).map((side, idx) => (
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
          }}>{t("tutorials.cexDex.vs")}</div>
        )}
      </div>
    ))}
  </div>
); };

const SecuritySetupSVG = () => { const { t } = useTranslation(); return (
  <svg viewBox="0 0 460 218" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
    <rect width="460" height="218" fill="#0d1520" rx="10"/>
    <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.securityHeader")}</text>
    <path d="M230 22 L262 36 L262 65 Q262 90 230 102 Q198 90 198 65 L198 36 Z" fill="rgba(74,222,128,0.09)" stroke="#4ade80" strokeWidth="1.5"/>
    <text x="230" y="70" fontSize="20" fontFamily="sans-serif" textAnchor="middle">🛡</text>
    <text x="230" y="88" fill="#4ade80" fontSize="8" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">{t("tutorials.svg.yourCrypto")}</text>
    <rect x="10" y="110" width="440" height="30" fill="rgba(96,165,250,0.07)" stroke="rgba(96,165,250,0.22)" strokeWidth="1" rx="6"/>
    <text x="20" y="129" fill="#60a5fa" fontSize="8.5" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.layer1")}</text>
    <rect x="398" y="115" width="44" height="20" fill="rgba(96,165,250,0.14)" rx="4"/>
    <text x="420" y="128" fill="#60a5fa" fontSize="8" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">{t("tutorials.svg.basic")}</text>
    <rect x="10" y="146" width="440" height="30" fill="rgba(167,139,250,0.07)" stroke="rgba(167,139,250,0.22)" strokeWidth="1" rx="6"/>
    <text x="20" y="165" fill="#a78bfa" fontSize="8.5" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.layer2")}</text>
    <rect x="398" y="151" width="44" height="20" fill="rgba(167,139,250,0.14)" rx="4"/>
    <text x="420" y="164" fill="#a78bfa" fontSize="8" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">{t("tutorials.svg.must")}</text>
    <rect x="10" y="182" width="440" height="30" fill="rgba(251,191,36,0.07)" stroke="rgba(251,191,36,0.22)" strokeWidth="1" rx="6"/>
    <text x="20" y="201" fill="#fbbf24" fontSize="8.5" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.layer3")}</text>
    <rect x="398" y="187" width="44" height="20" fill="rgba(251,191,36,0.14)" rx="4"/>
    <text x="420" y="200" fill="#fbbf24" fontSize="8" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">Pro</text>
  </svg>
); };

/* ─── TUTORIAL DATA ─────────────────────────────────────────── */

const BearFlagSVG = () => { const { t } = useTranslation(); return (
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
            <text x="282" y="98" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="700">{t("tutorials.svg.entryDown")}</text>
            <line x1="200" y1="78" x2="310" y2="78" stroke="#f87171" strokeWidth="1" strokeDasharray="4,3"/>
            <text x="315" y="81" fill="#f87171" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.stop")}</text>
            <text x="80" y="200" fill="#94a3b8" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.flagpoleDown")}</text>
            <text x="205" y="200" fill="#94a3b8" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.flag")}</text>
            <text x="310" y="200" fill="#f87171" fontSize="9" fontFamily="sans-serif">{t("tutorials.svg.breakdown")}</text>
            <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.bearFlagHeader")}</text>
          </svg>
); };

const ResistanceRejectionSVG = () => { const { t } = useTranslation(); return (
          <svg viewBox="0 0 460 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="tutorial-svg">
            <rect width="460" height="210" fill="#0d1520" rx="10"/>
            {[55,105,155].map(y=><line key={y} x1="0" y1={y} x2="460" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>)}
            <rect x="0" y="42" width="460" height="20" fill="rgba(248,113,113,0.07)"/>
            <line x1="0" y1="42" x2="460" y2="42" stroke="#f87171" strokeWidth="1" strokeDasharray="5,4"/>
            <line x1="0" y1="62" x2="460" y2="62" stroke="#f87171" strokeWidth="0.5" strokeDasharray="3,4" opacity="0.4"/>
            <text x="8" y="38" fill="#f87171" fontSize="9" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.resistanceZone3")}</text>
            <polyline points="10,140 40,120 60,130 90,80 110,95 140,55 155,62 175,75 190,68 210,95 230,75 250,60 265,68 285,82 300,68 320,100 350,135 390,158 440,175" stroke="#60a5fa" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
            <circle cx="155" cy="62" r="6" fill="none" stroke="#f87171" strokeWidth="1.5"/>
            <circle cx="265" cy="68" r="6" fill="none" stroke="#f87171" strokeWidth="1.5"/>
            <circle cx="300" cy="68" r="6" fill="none" stroke="#f87171" strokeWidth="1.5"/>
            <text x="140" y="30" fill="#f87171" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.reject1")}</text>
            <text x="250" y="30" fill="#f87171" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.reject2")}</text>
            <text x="283" y="30" fill="#f87171" fontSize="8" fontFamily="sans-serif">{t("tutorials.svg.reject3Entry")}</text>
            <polygon points="295,100 305,100 300,112" fill="#f87171"/>
            <line x1="300" y1="68" x2="300" y2="98" stroke="#f87171" strokeWidth="1.5" strokeDasharray="3,3"/>
            <text x="8" y="14" fill="rgba(255,255,255,0.4)" fontSize="10" fontFamily="sans-serif" fontWeight="600">{t("tutorials.svg.resistanceHeader")}</text>
          </svg>
); };

// All text (titles, illustration captions, steps, mistakes, tips) lives in
// src/locales/extra/<lang>/tutorials.json under tutorials.topics.<id>.
const TUTORIALS = [
  {
    id: "long", icon: "📈",
    beginner: { illustrations: [<BullFlagSVG />, <SupportBounceSVG />] },
    advanced: { illustrations: [<FibRetracementSVG />, <AdvancedIndicatorsSVG />] },
  },
  {
    id: "short", icon: "📉",
    beginner: { illustrations: [<BearFlagSVG />, <ResistanceRejectionSVG />] },
    advanced: { illustrations: [<DoubleTopSVG />, <RSIDivergenceSVG />] },
  },
  {
    id: "heatmap", icon: "🔥",
    beginner: { illustrations: [<HeatmapClusterSVG />, <LiquiditySweepSVG />] },
    advanced: { illustrations: [<HeatmapClusterSVG />, <LiquiditySweepSVG />] },
  },
  {
    id: "account", icon: "🏦",
    beginner: { illustrations: [<ExchangeSelectionCards />, <AccountSetupSVG />] },
    advanced: { illustrations: [<CexDexCards />, <SecuritySetupSVG />] },
  },
  {
    id: "indicators", icon: "📊",
    beginner: { illustrations: [<RSIDivergenceSVG />, <AdvancedIndicatorsSVG />] },
    advanced: { illustrations: [<RSIDivergenceSVG />, <AdvancedIndicatorsSVG />] },
  },
];

const STEP_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

/* ─── COMPONENT ─────────────────────────────────────────────── */

export const TutorialPage: React.FC<Props> = ({ onClose }) => {
  const [activeTab, setActiveTab]   = useState(0);
  const [level, setLevel]           = useState<"beginner" | "advanced">("beginner");
  const [slideIndex, setSlideIndex] = useState(0);
  const { t } = useTranslation();

  const tut     = TUTORIALS[activeTab];
  const base    = `tutorials.topics.${tut.id}.${level}`;
  const captions = tList(t, `${base}.illustrations`);
  const content = {
    illustrations: tut[level].illustrations.map((svg, i) => ({ title: captions[i] ?? "", svg })),
    steps: tList(t, `${base}.steps`).map((text, i) => ({ emoji: STEP_EMOJI[i] ?? `${i + 1}.`, text })),
    mistakes: tList(t, `${base}.mistakes`),
    tips: tList(t, `${base}.tips`),
  };

  const handleTab = (i: number) => { setActiveTab(i); setSlideIndex(0); };
  const handleLevel = (l: "beginner" | "advanced") => { setLevel(l); setSlideIndex(0); };

  // Shared bottom sheet: full height on phones, centred popup on desktop.
  return (
    <BottomSheet
      open
      onClose={onClose}
      title={t("tutorials.title")}
      className="tutorial-sheet"
      bodyClassName="bs-body--pad"
      desktopModal
      startFull
    >
      <div className="tutorial-page tutorial-page--sheet">

        {/* Topic tabs */}
        <div className="tutorial-tabs">
          {TUTORIALS.map((tp, i) => (
            <button key={i} className={`tutorial-tab${activeTab === i ? " active" : ""}`} onClick={() => handleTab(i)}>
              <span className="tutorial-tab-icon">{tp.icon}</span>
              <span className="tutorial-tab-label">{t(`tutorials.topics.${tp.id}.title`)}</span>
            </button>
          ))}
        </div>

        {/* Level toggle */}
        <div className="tutorial-level-bar">
          <button className={`tutorial-level-btn${level === "beginner" ? " active" : ""}`} onClick={() => handleLevel("beginner")}>{t("tutorials.beginner")}</button>
          <button className={`tutorial-level-btn${level === "advanced" ? " active" : ""}`} onClick={() => handleLevel("advanced")}>{t("tutorials.advanced")}</button>
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
                <button className="carousel-btn" aria-label={t("tutorials.prevSlide")} onClick={() => setSlideIndex(Math.max(0, slideIndex - 1))} disabled={slideIndex === 0}>‹</button>
                <div className="carousel-dots">
                  {content.illustrations.map((_, i) => (
                    <button key={i} className={`carousel-dot${slideIndex === i ? " active" : ""}`} aria-label={t("tutorials.goToSlide", { n: i + 1 })} onClick={() => setSlideIndex(i)} />
                  ))}
                </div>
                <button className="carousel-btn" aria-label={t("tutorials.nextSlide")} onClick={() => setSlideIndex(Math.min(content.illustrations.length - 1, slideIndex + 1))} disabled={slideIndex === content.illustrations.length - 1}>›</button>
              </div>
            )}
          </div>

          {/* Steps — full width, 2-col sub-grid */}
          <div>
            <div className="tutorial-section-title" style={{ marginBottom: 8 }}>{t("tutorials.stepByStep")}</div>
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
            <div className="tutorial-section-title" style={{ marginBottom: 8 }}>{t("tutorials.commonMistakes")}</div>
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
            <h4>{t("tutorials.proTips")}</h4>
            <ul>{content.tips.map((tip, i) => <li key={i}>{tip}</li>)}</ul>
          </div>

          <p className="tutorial-disclaimer">{t("tutorials.disclaimer")}</p>

        </div>
      </div>
    </BottomSheet>
  );
};
