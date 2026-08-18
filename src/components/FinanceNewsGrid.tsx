import { useEffect, useState } from "react";
import { fetchFinanceNews, type FinanceNewsItem, type NewsCategory } from "../services/financeNews";
import "../styles/FinanceNewsGrid.css";

const COLUMNS: { key: NewsCategory; label: string }[] = [
  { key: "top", label: "Top Stories" },
  { key: "markets", label: "Markets" },
  { key: "tech", label: "Tech" },
];

const ITEMS_PER_COLUMN = 5;

export function FinanceNewsGrid() {
  const [items, setItems] = useState<FinanceNewsItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const news = await fetchFinanceNews();
      if (!cancelled) { setItems(news); setLoading(false); }
    };
    load();
    const id = window.setInterval(load, 10 * 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  if (loading) {
    return <div className="fng-loading">Loading news…</div>;
  }
  if (items.length === 0) return null;

  return (
    <div className="fng-grid">
      {COLUMNS.map(col => {
        const colItems = items.filter(i => i.category === col.key).slice(0, ITEMS_PER_COLUMN);
        if (colItems.length === 0) return null;
        const [hero, ...rest] = colItems;
        return (
          <div key={col.key} className="fng-column">
            <div className="fng-column-title">{col.label}</div>
            <a href={hero.url} target="_blank" rel="noopener noreferrer" className="fng-hero">
              {hero.image ? (
                <img src={hero.image} alt="" className="fng-hero-img" loading="lazy" onError={e => { e.currentTarget.style.display = "none"; }} />
              ) : (
                <div className="fng-hero-img fng-hero-img--placeholder" />
              )}
              <div className="fng-hero-title">{hero.title}</div>
              <div className="fng-hero-source">{hero.source}</div>
            </a>
            <ul className="fng-list">
              {rest.map(item => (
                <li key={item.title} className="fng-list-item">
                  <a href={item.url} target="_blank" rel="noopener noreferrer" className="fng-list-link">
                    {item.title}
                  </a>
                  <span className="fng-list-source">{item.source}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
