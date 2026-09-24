import React from "react";
import { useTranslation } from "react-i18next";
import "../styles/SectionBanner.css";

const ICONS: Partial<Record<string, string>> = {
  ai:          "✦",
  heatmap:     "◈",
  onchain:     "⬡",
  alerts:      "◎",
  positions:   "⇅",
  htf:         "▲",
  orderflow:   "∿",
  signals:     "★",
  fundingbot:  "%",
  riskcalc:    "⛨",
  gann:        "✕",
  markets:     "⊕",
  altanalysis: "◆",
  options:     "Ω",
  correlation: "⋈",
  strategyalerts: "⚑",
};

// The candle emoji rendered in its own fixed color (not the blue accent
// every other section icon takes via currentColor), and didn't read as a
// deliberate glyph next to the rest of this set — a simple bar-chart
// stroke icon (same mark used for the portfolio icon elsewhere) matches
// both the accent color and the rest of ICONS' plain-symbol style.
const CandleaiIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="20" x2="18" y2="10" />
    <line x1="12" y1="20" x2="12" y2="4" />
    <line x1="6" y1="20" x2="6" y2="14" />
  </svg>
);

interface Props { section: string }

export const SectionBanner: React.FC<Props> = ({ section }) => {
  const { t } = useTranslation();

  const icon = section === "candleai" ? <CandleaiIcon /> : ICONS[section];
  if (!icon) return null;

  const b = {
    icon,
    title:       t(`sectionBanner.${section}.title`),
    description: t(`sectionBanner.${section}.desc`),
    tags:        t(`sectionBanner.${section}.tags`, { returnObjects: true }) as string[],
  };

  return (
    <div className="sec-banner">
      <div className="sec-banner-icon">{b.icon}</div>
      <div className="sec-banner-body">
        <div className="sec-banner-title">{b.title}</div>
        <div className="sec-banner-desc">{b.description}</div>
        <div className="sec-banner-tags">
          {b.tags.map(tag => <span key={tag} className="sec-banner-tag">{tag}</span>)}
        </div>
      </div>
    </div>
  );
};
