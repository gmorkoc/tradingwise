import { supabaseAdmin, getAccessToken, sendPush, getSoundsByUser } from "../_shared/fcm.ts";

// Server-side twin of DailyBrief.tsx's fetchBrief() — same feeds and
// relevance filtering, run on a cron schedule (see the matching migration)
// so a genuinely new story pushes a notification even with the app closed,
// instead of only surfacing next time someone happens to open the sheet.
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

type Category = "crypto" | "markets" | "geopolitics";

interface BriefItem {
  title: string;
  url: string;
  source: string;
  category: Category;
  pubDate: number;
}

interface FeedDef {
  url: string;
  source: string;
  category: Category;
}

const FEEDS: FeedDef[] = [
  { url: "https://cointelegraph.com/rss", source: "CoinTelegraph", category: "crypto" },
  { url: "https://coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk", category: "crypto" },
  { url: "https://decrypt.co/feed", source: "Decrypt", category: "crypto" },
  { url: "https://www.cnbc.com/id/20910258/device/rss/rss.html", source: "CNBC Markets", category: "markets" },
  { url: "https://feeds.marketwatch.com/marketwatch/topstories/", source: "MarketWatch", category: "markets" },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", source: "BBC World", category: "geopolitics" },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", source: "Al Jazeera", category: "geopolitics" },
];

const RELEVANCE_KEYWORDS = [
  "bitcoin", "crypto", "btc", "eth", "ethereum", "blockchain", "stablecoin", "defi",
  "sec ", "cftc", "etf", "coinbase", "binance", "regulation", "regulator",
  "federal reserve", "the fed", "fed rate", "interest rate", "rate cut", "rate hike",
  "inflation", "cpi", "tariff", "sanction", "war", "ukraine", "russia", "israel",
  "gaza", "iran", "china", "taiwan", "geopolitic", "treasury", "dollar", "recession",
  "stock market", "s&p 500", "nasdaq", "dow jones", "oil price", "shutdown",
  "election", "trump", "debt ceiling", "gold price", "sell-off", "selloff",
  "rally", "volatility", "wall street", "central bank", "jerome powell", "imf",
];

function isRelevant(title: string): boolean {
  const t = title.toLowerCase();
  return RELEVANCE_KEYWORDS.some((kw) => t.includes(kw));
}

function extractTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  const raw = cdata ? cdata[1] : m[1];
  return raw.trim()
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// rss2json (a third-party caching proxy we used to fetch through) turned out
// to serve stale snapshots — sometimes over an hour old — which defeats the
// entire point of polling for "new since last check". Parsing each feed's
// RSS/XML directly instead: no proxy, no caching layer we don't control.
async function fetchFeed(feed: FeedDef): Promise<BriefItem[]> {
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [];
    const items: BriefItem[] = [];
    for (const block of blocks) {
      const title = extractTag(block, "title");
      const link = extractTag(block, "link");
      if (!title || !link) continue;
      const pubDateRaw = extractTag(block, "pubDate");
      items.push({
        title,
        url: link,
        source: feed.source,
        category: feed.category,
        pubDate: pubDateRaw ? new Date(pubDateRaw).getTime() : Date.now(),
      });
    }
    return feed.category === "crypto" ? items : items.filter((i) => isRelevant(i.title));
  } catch {
    return [];
  }
}

async function fetchBrief(): Promise<BriefItem[]> {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  const seen = new Set<string>();
  const deduped = all.filter((item) => {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.sort((a, b) => b.pubDate - a.pubDate);
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const items = await fetchBrief();
  if (items.length === 0) return new Response(JSON.stringify({ fetched: 0 }), { headers: { "Content-Type": "application/json" } });

  const { data: state } = await supabaseAdmin
    .from("daily_brief_alert_state")
    .select("last_seen_pubdate")
    .eq("id", 1)
    .single();

  const lastSeen = state?.last_seen_pubdate;
  const maxPubDate = items[0].pubDate; // items is sorted newest-first

  // First run ever — just establish the baseline, nothing to push yet
  // (otherwise every existing headline would count as "new").
  if (lastSeen == null) {
    await supabaseAdmin.from("daily_brief_alert_state").update({ last_seen_pubdate: maxPubDate, updated_at: new Date().toISOString() }).eq("id", 1);
    return new Response(JSON.stringify({ fetched: items.length, reason: "baseline initialized" }), { headers: { "Content-Type": "application/json" } });
  }

  const freshItems = items.filter((i) => i.pubDate > lastSeen);
  await supabaseAdmin.from("daily_brief_alert_state").update({ last_seen_pubdate: maxPubDate, updated_at: new Date().toISOString() }).eq("id", 1);

  if (freshItems.length === 0) {
    return new Response(JSON.stringify({ fetched: items.length, fresh: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  const { data: eligible } = await supabaseAdmin.from("profiles").select("id").eq("notify_daily_brief", true);
  if (!eligible || eligible.length === 0) {
    return new Response(JSON.stringify({ fetched: items.length, fresh: freshItems.length, sent: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  const { data: tokens } = await supabaseAdmin
    .from("device_push_tokens")
    .select("token, user_id")
    .in("user_id", eligible.map(u => u.id));
  if (!tokens || tokens.length === 0) {
    return new Response(JSON.stringify({ fetched: items.length, fresh: freshItems.length, sent: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  const headline = freshItems[0];
  const title = `📰 ${headline.source}`;
  const body = freshItems.length > 1
    ? `${headline.title} (+${freshItems.length - 1} more)`
    : headline.title;

  const soundByUser = await getSoundsByUser(tokens.map(t => t.user_id));
  const accessToken = await getAccessToken();
  const results = await Promise.all(tokens.map(({ token, user_id }) =>
    sendPush(accessToken, token, title, body, soundByUser.get(user_id) ?? "bell", { type: "daily_brief", url: headline.url })
  ));

  return new Response(
    JSON.stringify({ fetched: items.length, fresh: freshItems.length, sent: results.filter(Boolean).length, total: tokens.length }),
    { headers: { "Content-Type": "application/json" } }
  );
});
