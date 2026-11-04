// Builds public/sitemap.xml (and robots.txt) from the app's own lists, so
// it never goes stale: one /chart/<coin-name> page per coin in COINS
// (src/services/coinglass.ts) plus every page in NAV_ITEMS (src/App.tsx).
// Runs before every `npm run build`. Slugs match App.tsx's coinSlug().
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SITE = "https://www.coinhintz.io";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// Coins: the `export const COINS = [ ... ];` block.
const coinsSrc = read("src/services/coinglass.ts");
const coinsBlock = coinsSrc.slice(coinsSrc.indexOf("export const COINS"));
const coinsBody = coinsBlock.slice(0, coinsBlock.indexOf("\n]"));
const coins = [...coinsBody.matchAll(/symbol:\s*['"]([^'"]+)['"]\s*,\s*name:\s*['"]([^'"]+)['"]/g)].map((m) => ({ symbol: m[1], name: m[2] }));
if (coins.length < 10) throw new Error(`sitemap: only found ${coins.length} coins — COINS format changed?`);
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Pages: ids inside `const NAV_ITEMS ... = [ ... ];` (Markets is "/", the
// chart page is per coin, so both are handled separately).
const appSrc = read("src/App.tsx");
const navBlock = appSrc.slice(appSrc.indexOf("const NAV_ITEMS"));
const navBody = navBlock.slice(0, navBlock.indexOf("\n];"));
const pages = [...new Set([...navBody.matchAll(/id:\s*"([a-z-]+)"/g)].map((m) => m[1]))]
  .filter((id) => id !== "chart" && id !== "markets");

const today = new Date().toISOString().slice(0, 10);
const seen = new Set();
const urls = [];
const add = (path, priority, freq) => {
  if (seen.has(path)) return;
  seen.add(path);
  urls.push(`  <url><loc>${SITE}${path}</loc><lastmod>${today}</lastmod><changefreq>${freq}</changefreq><priority>${priority}</priority></url>`);
};
add("/", "1.0", "hourly");
coins.forEach((c, i) => add(`/chart/${slug(c.name)}`, i < 20 ? "0.9" : "0.7", "hourly"));
pages.forEach((p) => add(`/${p}`, "0.6", "daily"));

writeFileSync(
  join(root, "public/sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
);
writeFileSync(join(root, "public/robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
console.log(`sitemap: ${urls.length} URLs (${coins.length} coins, ${pages.length} pages)`);
