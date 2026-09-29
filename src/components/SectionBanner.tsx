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
  marketheatmap: "▦",
  altanalysis: "◆",
  options:     "Ω",
  correlation: "⋈",
  strategyalerts: "⚑",
  // A single candle body — the bar-chart-lines mark it replaced didn't
  // read as distinct from other sections; this one at least ties back to
  // what the section is actually named after.
  candleai:    "▮",
};

interface Props { section: string }

export const SectionBanner: React.FC<Props> = ({ section }) => {
  const { t } = useTranslation();

  const icon = ICONS[section];
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
