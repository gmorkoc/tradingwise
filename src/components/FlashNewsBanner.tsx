import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import "../styles/FlashNewsBanner.css";

interface NewsItem { title: string; url: string; source: string }

const FEEDS = [
  { url: "https://cointelegraph.com/rss",                label: "CoinTelegraph" },
  { url: "https://coindesk.com/arc/outboundfeeds/rss/",  label: "CoinDesk"      },
  { url: "https://decrypt.co/feed",                      label: "Decrypt"       },
];

async function fetchCryptoNews(): Promise<NewsItem[]> {
  const results: NewsItem[] = [];
  await Promise.allSettled(
    FEEDS.map(async ({ url, label }) => {
      try {
        const res = await fetch(
          `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`
        );
        const data = await res.json();
        if (data.status === "ok") {
          for (const item of data.items) {
            results.push({ title: item.title, url: item.link, source: label });
          }
        }
      } catch { /* silently ignore */ }
    })
  );
  const seen = new Set<string>();
  return results.filter(h => {
    if (seen.has(h.title)) return false;
    seen.add(h.title);
    return true;
  });
}

export const FlashNewsBanner: React.FC = () => {
  const { t } = useTranslation();
  const [items, setItems]       = useState<NewsItem[]>([]);
  const [index, setIndex]       = useState(0);
  const [visible, setVisible]   = useState(true);
  const [loading, setLoading]   = useState(true);
  const intervalRef             = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const news = await fetchCryptoNews();
      if (!cancelled && news.length > 0) { setItems(news); setLoading(false); }
    };
    load();
    const refresh = setInterval(load, 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(refresh); };
  }, []);

  useEffect(() => {
    if (items.length < 2) return;
    intervalRef.current = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex(i => (i + 1) % items.length);
        setVisible(true);
      }, 400);
    }, 7000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [items]);

  if (loading || items.length === 0) return null;

  const current = items[index];

  return (
    <div className="fnb-root">
      <span className="fnb-tag">
        <span className="fnb-dot" />
        {t("nav.live")}
      </span>
      <span className="fnb-source">{current.source}</span>
      <a
        href={current.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`fnb-headline${visible ? " fnb-headline--in" : " fnb-headline--out"}`}
      >
        {current.title}
      </a>
      <div className="fnb-controls">
        <button className="fnb-nav" onClick={() => { setVisible(false); setTimeout(() => { setIndex(i => (i - 1 + items.length) % items.length); setVisible(true); }, 300); }}>‹</button>
        <span className="fnb-counter">{index + 1} / {items.length}</span>
        <button className="fnb-nav" onClick={() => { setVisible(false); setTimeout(() => { setIndex(i => (i + 1) % items.length); setVisible(true); }, 300); }}>›</button>
      </div>
    </div>
  );
};
