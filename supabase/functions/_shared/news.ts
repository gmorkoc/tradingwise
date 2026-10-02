// Crypto headline pull, shared by any feature that wants recent news
// context — same direct RSS/XML parsing daily-brief-push already uses (no
// third-party caching proxy, which was serving stale snapshots), just the
// crypto-focused subset of its feeds and without the geopolitics/markets
// relevance filtering or breaking-news classification that feature adds on
// top — callers here just want the raw recent headlines.
export interface NewsItem {
  title: string;
  url: string;
  source: string;
  pubDate: number;
}

interface FeedDef {
  url: string;
  source: string;
}

const CRYPTO_FEEDS: FeedDef[] = [
  { url: "https://cointelegraph.com/rss", source: "CoinTelegraph" },
  { url: "https://coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://decrypt.co/feed", source: "Decrypt" },
];

function extractTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  const raw = cdata ? cdata[1] : m[1];
  return raw.trim()
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

async function fetchFeed(feed: FeedDef): Promise<NewsItem[]> {
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [];
    const items: NewsItem[] = [];
    for (const block of blocks) {
      const title = extractTag(block, "title");
      const link = extractTag(block, "link");
      if (!title || !link) continue;
      const pubDateRaw = extractTag(block, "pubDate");
      items.push({
        title, url: link, source: feed.source,
        pubDate: pubDateRaw ? new Date(pubDateRaw).getTime() : Date.now(),
      });
    }
    return items;
  } catch {
    return [];
  }
}

export async function fetchCryptoNews(limit = 8): Promise<NewsItem[]> {
  const results = await Promise.allSettled(CRYPTO_FEEDS.map(fetchFeed));
  const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  const seen = new Set<string>();
  const deduped = all.filter((item) => {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.sort((a, b) => b.pubDate - a.pubDate).slice(0, limit);
}
