import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../styles/SectionNav.css";

interface NavItem {
  id: string;
  tKey: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "ai",        tKey: "nav.ai",        icon: "✦" },
  { id: "feargreed", tKey: "nav.feargreed", icon: "◉" },
  { id: "market",    tKey: "nav.market",    icon: "◈" },
  { id: "onchain",   tKey: "nav.onchain",   icon: "⛓" },
  { id: "chart",     tKey: "nav.chart",     icon: "↗" },
  { id: "heatmap",   tKey: "nav.heatmap",   icon: "⬡" },
  { id: "alerts",    tKey: "nav.alerts",    icon: "⚡" },
  { id: "watchlist", tKey: "nav.watchlist", icon: "★" },
  { id: "gann",      tKey: "nav.gann",      icon: "⊿" },
];

interface SectionNavProps {
  sectionOrder: string[];
}

export const SectionNav: React.FC<SectionNavProps> = ({ sectionOrder }) => {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string>("");
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const onIntersect: IntersectionObserverCallback = (entries) => {
      // Pick the entry closest to the top of the viewport among visible ones
      const visible = entries
        .filter(e => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length > 0) {
        const id = (visible[0].target as HTMLElement).dataset.section;
        if (id) setActiveId(id);
      }
    };

    observerRef.current = new IntersectionObserver(onIntersect, {
      root: null,
      rootMargin: "-20% 0px -60% 0px",
      threshold: 0,
    });

    const sections = document.querySelectorAll<HTMLElement>("[data-section]");
    sections.forEach(el => observerRef.current!.observe(el));

    return () => observerRef.current?.disconnect();
  }, [sectionOrder]);

  const scrollTo = (id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Show nav items in current section order
  const ordered = sectionOrder
    .map(id => NAV_ITEMS.find(n => n.id === id))
    .filter(Boolean) as NavItem[];

  return (
    <nav className="section-nav" aria-label="Section navigation">
      {ordered.map((item) => (
        <button
          key={item.id}
          className={`section-nav-item${activeId === item.id ? " section-nav-item--active" : ""}`}
          onClick={() => scrollTo(item.id)}
          title={t(item.tKey)}
        >
          <span className="section-nav-dot" />
          <span className="section-nav-label">{t(item.tKey)}</span>
          <span className="section-nav-icon">{item.icon}</span>
        </button>
      ))}
    </nav>
  );
};
