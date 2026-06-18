import React from "react";
import { useTranslation } from "react-i18next";
import "../styles/SectionBanner.css";

const ICONS: Partial<Record<string, string>> = {
  ai:         "✦",
  heatmap:    "◈",
  feargreed:  "◉",
  onchain:    "⬡",
  alerts:     "◎",
  etf:        "▣",
  positions:  "⇅",
  htf:        "▲",
  orderflow:  "∿",
  signals:    "★",
  fundingbot: "%",
  gann:       "✕",
  candleai:   "🕯",
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
