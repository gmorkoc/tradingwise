// Finance news for the Stocks homepage news grid — same RSS2JSON pattern as
// FlashNewsBanner.tsx/NewsTicker.tsx (anonymous, no API key), against
// finance-specific feeds instead of crypto ones. Feed URLs below were
// live-tested against api.rss2json.com; Investing.com's feed returns 403
// and is deliberately excluded.

export type NewsCategory = "top" | "markets" | "tech";

export interface FinanceNewsItem {
  title: string;
  url: string;
  source: string;
  category: NewsCategory;
  image: string | null;
}

const FEEDS: { url: string; source: string; category: NewsCategory }[] = [
  { url: "https://finance.yahoo.com/news/rssindex", source: "Yahoo Finance", category: "top" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", source: "MarketWatch", category: "markets" },
  { url: "https://www.cnbc.com/id/19854910/device/rss/rss.html", source: "CNBC Tech", category: "tech" },
];

interface RSS2JsonItem {
  title: string;
  link: string;
  thumbnail?: string;
  enclosure?: { link?: string };
  description?: string;
}

function extractImage(item: RSS2JsonItem): string | null {
  if (item.enclosure?.link) return item.enclosure.link;
  if (item.thumbnail) return item.thumbnail;
  const match = item.description?.match(/<img[^>]+src="([^"]+)"/i);
  return match ? match[1] : null;
}

export async function fetchFinanceNews(): Promise<FinanceNewsItem[]> {
  const results: FinanceNewsItem[] = [];
  await Promise.allSettled(
    FEEDS.map(async ({ url, source, category }) => {
      try {
        const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`);
        const data = await res.json();
        if (data.status === "ok") {
          for (const item of data.items as RSS2JsonItem[]) {
            results.push({
              title: item.title,
              url: item.link,
              source,
              category,
              image: extractImage(item),
            });
          }
        }
      } catch { /* silently ignore — Promise.allSettled isolates per-feed failures */ }
    }),
  );
  const seen = new Set<string>();
  return results.filter(n => {
    if (seen.has(n.title)) return false;
    seen.add(n.title);
    return true;
  });
}
