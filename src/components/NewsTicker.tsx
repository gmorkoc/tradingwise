import { useState, useEffect } from "react";
import "../styles/NewsTicker.css";

interface NewsItem {
  title: string;
  url: string;
}

const FEEDS = [
  "https://cointelegraph.com/rss",
  "https://coindesk.com/arc/outboundfeeds/rss/",
];

async function fetchHeadlines(): Promise<NewsItem[]> {
  const results: NewsItem[] = [];

  await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const res = await fetch(
        `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed)}`,
      );
      const data = await res.json();
      if (data.status === "ok") {
        for (const item of data.items) {
          results.push({ title: item.title, url: item.link });
        }
      }
    }),
  );

  // Deduplicate by title
  const seen = new Set<string>();
  return results.filter((h) => {
    if (seen.has(h.title)) return false;
    seen.add(h.title);
    return true;
  });
}

export const NewsTicker: React.FC = () => {
  const [headlines, setHeadlines] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const items = await fetchHeadlines();
      if (!cancelled) {
        if (items.length > 0) setHeadlines(items);
        setLoading(false);
      }
    };

    load();
    const interval = window.setInterval(load, 15 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="news-ticker">
        <span className="news-ticker-loading">Loading latest crypto news…</span>
      </div>
    );
  }

  if (headlines.length === 0) return null;

  // Duration scales with number of items so scroll speed stays consistent
  const duration = headlines.length * 8;

  return (
    <div
      className="news-ticker"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="news-ticker-track">
        <div
          className="news-ticker-content"
          style={{
            animationDuration: `${duration}s`,
            animationPlayState: paused ? "paused" : "running",
          }}
        >
          {/* Render twice for seamless loop */}
          {[...headlines, ...headlines].map((h, i) => (
            <span key={i} className="news-ticker-item">
              <a
                href={h.url}
                target="_blank"
                rel="noopener noreferrer"
                className="news-ticker-link"
                tabIndex={-1}
              >
                {h.title}
              </a>
              <span className="news-ticker-sep" aria-hidden>
                ◆
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
