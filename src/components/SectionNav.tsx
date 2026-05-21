import { useEffect, useRef, useState } from "react";
import "../styles/SectionNav.css";

interface NavItem {
  id: string;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "ai",        label: "AI Prediction",  icon: "✦" },
  { id: "feargreed", label: "Fear & Greed",   icon: "◉" },
  { id: "market",    label: "Market Data",    icon: "◈" },
  { id: "onchain",   label: "On-Chain",       icon: "⛓" },
  { id: "chart",     label: "Price Chart",    icon: "↗" },
  { id: "heatmap",   label: "Liquidations",   icon: "⬡" },
  { id: "alerts",    label: "Alerts",         icon: "⚡" },
  { id: "watchlist", label: "Watchlist",       icon: "★" },
  { id: "gann",      label: "Gann Analysis",  icon: "⊿" },
];

interface SectionNavProps {
  sectionOrder: string[];
}

export const SectionNav: React.FC<SectionNavProps> = ({ sectionOrder }) => {
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
          title={item.label}
        >
          <span className="section-nav-dot" />
          <span className="section-nav-label">{item.label}</span>
          <span className="section-nav-icon">{item.icon}</span>
        </button>
      ))}
    </nav>
  );
};
