export const config = { matcher: ['/cg-api/:path*', '/cg-sdk/:path*', '/coinalyze-api/:path*', '/bn-api/:path*', '/gecko-api/:path*', '/ff-cal', '/etf-api/:path*', '/okx-api/:path*'] };

// Reflects whatever Origin actually sent the request, instead of checking
// it against a fixed web-origin allowlist — that allowlist never included
// the native iOS/Android app's real origin (a capacitor:// scheme, not a
// coinhintz.io URL), so every proxied request made FROM the app itself got
// a mismatched Access-Control-Allow-Origin back and was silently blocked
// by WebKit before the response ever reached the calling JS. That surfaced
// as a permanently "stuck loading" UI (GlobalMarkets.tsx's Open Interest
// tiles, in particular) rather than a visible error, since a blocked CORS
// response rejects the fetch promise with no HTTP status to inspect, and
// several callers' .catch() swallow that silently. Safe to do broadly
// here: every route this proxies is a plain public-market-data GET with no
// cookies/credentials involved, so there's no session to leak by not
// pinning to a fixed origin list.
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// Last good Coinalyze answers (see the /coinalyze-api route below).
const coinalyzeCache = new Map<string, { at: number; body: string }>();
// Last good CoinGecko answers (see the /gecko-api route below).
const geckoCache = new Map<string, { at: number; body: string }>();

export default async function middleware(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const url = new URL(req.url);

  // ── Economic calendar (Pro Vision event warnings) ─────────────────────────
  // This week's scheduled macro events (FOMC, CPI, jobs, GDP…). The upstream
  // JSON sends no CORS header, so browsers need it proxied; CDN-cached for
  // 30 min since it only changes when the week's schedule does.
  if (url.pathname === '/ff-cal') {
    const response = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, s-maxage=1800, stale-while-revalidate=3600',
        ...corsHeaders(req),
      },
    });
  }

  // ── Spot ETF flows (CoinMarketCap public data API) ───────────────────────
  // Our CoinGlass plan doesn't include ETF endpoints ("Upgrade plan"), and
  // CMC's data API sends no CORS header, so it's proxied here (web + app).
  // Daily data — CDN-cached for 15 min.
  if (url.pathname.startsWith('/etf-api/')) {
    const etfPath = url.pathname.replace(/^\/etf-api\//, '');
    if (!/^[a-z0-9/_-]+$/i.test(etfPath)) {
      return new Response('bad path', { status: 400, headers: corsHeaders(req) });
    }
    const upstream = new URL(`https://api.coinmarketcap.com/data-api/v3/etf/${etfPath}`);
    upstream.search = url.search;
    const response = await fetch(upstream.toString(), {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; coinhintz)' },
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, s-maxage=900, stale-while-revalidate=3600',
        ...corsHeaders(req),
      },
    });
  }

  // ── OKX proxy ─────────────────────────────────────────────────────────────
  // OKX's rubik (stats) endpoints send no CORS header at all, so the iOS app
  // (capacitor://localhost) can't call them directly. Was a vercel.json
  // rewrite, which passes OKX's missing CORS headers through unchanged.
  if (url.pathname.startsWith('/okx-api/')) {
    const okxPath = url.pathname.replace(/^\/okx-api\//, '');
    const upstream = new URL(`https://www.okx.com/${okxPath}`);
    upstream.search = url.search;
    try {
      const response = await fetch(upstream.toString(), { headers: { accept: 'application/json' } });
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, s-maxage=30, stale-while-revalidate=60',
          vary: 'Origin',
          ...corsHeaders(req),
        },
      });
    } catch {
      return new Response('{"code":"502","data":[]}', { status: 502, headers: { 'content-type': 'application/json', ...corsHeaders(req) } });
    }
  }

  // ── CoinGlass SDK proxy (preserves /api/ prefix for SDK-generated paths) ─
  if (url.pathname.startsWith('/cg-sdk/')) {
    const cgPath = url.pathname.replace(/^\/cg-sdk\//, '');
    const upstream = new URL(`https://open-api-v4.coinglass.com/${cgPath}`);
    upstream.search = url.search;
    const response = await fetch(upstream.toString(), {
      headers: { accept: 'application/json', 'CG-API-KEY': process.env.VITE_COINGLASS_API_KEY ?? '' },
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { 'content-type': 'application/json', ...corsHeaders(req) },
    });
  }

  // ── Coinalyze proxy (funding-rate fallback; free tier, no CORS support) ──
  if (url.pathname.startsWith('/coinalyze-api/')) {
    const caPath = url.pathname.replace(/^\/coinalyze-api\//, '');
    const upstream = new URL(`https://api.coinalyze.net/${caPath}`);
    upstream.search = url.search;
    // One shared key for every visitor hit Coinalyze's rate limit (429), so
    // successful answers are reused for 60s — per instance in memory, and by
    // the CDN/browser via cache-control — instead of fetched per visitor.
    // History routes carry from/to in seconds — round them to 5 min so
    // repeat calls share one cache entry instead of each being unique.
    for (const p of ['from', 'to']) {
      const v = Number(upstream.searchParams.get(p));
      if (v > 0) upstream.searchParams.set(p, String(Math.floor(v / 300) * 300));
    }
    const key = upstream.toString();
    const hit = coinalyzeCache.get(key);
    const cacheHeaders = { 'content-type': 'application/json', 'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120', vary: 'Origin', ...corsHeaders(req) };
    if (hit && Date.now() - hit.at < 60_000) {
      return new Response(hit.body, { status: 200, headers: cacheHeaders });
    }
    // On failure, an answer up to 10 min old beats none — older is stale.
    const fallback = hit && Date.now() - hit.at < 600_000 ? hit : null;
    let response: Response;
    try {
      response = await fetch(key, {
        headers: { accept: 'application/json', 'api_key': process.env.VITE_COINALYZE_API_KEY ?? '' },
      });
    } catch {
      if (fallback) return new Response(fallback.body, { status: 200, headers: { ...cacheHeaders, 'x-stale': '1' } });
      return new Response('[]', { status: 502, headers: { 'content-type': 'application/json', ...corsHeaders(req) } });
    }
    const text = await response.text();
    if (response.ok) {
      coinalyzeCache.set(key, { at: Date.now(), body: text });
      if (coinalyzeCache.size > 300) coinalyzeCache.delete(coinalyzeCache.keys().next().value as string);
      return new Response(text, { status: 200, headers: cacheHeaders });
    }
    // Rate-limited: serve the last good answer if it's recent enough.
    if (fallback) return new Response(fallback.body, { status: 200, headers: { ...cacheHeaders, 'x-stale': '1' } });
    return new Response(text, {
      status: response.status,
      headers: { 'content-type': 'application/json', ...corsHeaders(req) },
    });
  }

  // ── CoinGecko proxy ────────────────────────────────────────────────────────
  // Free tier, no key/auth needed — this was missing from `matcher` above
  // entirely, so every /gecko-api/* call (GlobalMarkets.tsx's historical
  // chart series, MarketHeatmap.tsx, coinMeta.ts) silently 404'd on the
  // production domain (and therefore in the native iOS app, which points
  // at it) while working fine in dev only because vite.config.ts's own dev
  // proxy has a matching rule — same class of bug as the api/ serverless-
  // functions-unreachable-in-prod issue, just for middleware's matcher
  // instead. The other CoinGecko calls in this app (global/coins/markets/
  // trending/sentiment) go straight to api.coingecko.com directly instead
  // of through this proxy — those never hit this gap.
  // The key lives here, not in the app: COINGECKO_API_KEY (falls back to
  // VITE_COINGECKO_API_KEY), and COINGECKO_PLAN=pro switches to the paid
  // host + header. Changing plan/key = Vercel env + redeploy, no app update.
  // Answers are reused for 60s (in memory + CDN) so every visitor shares
  // one upstream call; on a 429/error a recent (≤10 min) answer is served.
  if (url.pathname.startsWith('/gecko-api/')) {
    const gkPath = url.pathname.replace(/^\/gecko-api\//, '');
    const pro = process.env.COINGECKO_PLAN === 'pro';
    const key = process.env.COINGECKO_API_KEY || process.env.VITE_COINGECKO_API_KEY || '';
    const upstream = new URL(`https://${pro ? 'pro-api' : 'api'}.coingecko.com/${gkPath}`);
    upstream.search = url.search;
    const cacheKey = upstream.toString();
    const hit = geckoCache.get(cacheKey);
    const okHeaders = { 'content-type': 'application/json', 'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300', vary: 'Origin', ...corsHeaders(req) };
    if (hit && Date.now() - hit.at < 60_000) return new Response(hit.body, { status: 200, headers: okHeaders });
    const fallback = hit && Date.now() - hit.at < 600_000 ? hit : null;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (key) headers[pro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = key;
    let response: Response;
    try {
      response = await fetch(cacheKey, { headers });
    } catch {
      if (fallback) return new Response(fallback.body, { status: 200, headers: { ...okHeaders, 'x-stale': '1' } });
      return new Response('{}', { status: 502, headers: { 'content-type': 'application/json', ...corsHeaders(req) } });
    }
    const text = await response.text();
    if (response.ok) {
      geckoCache.set(cacheKey, { at: Date.now(), body: text });
      if (geckoCache.size > 300) geckoCache.delete(geckoCache.keys().next().value as string);
      return new Response(text, { status: 200, headers: okHeaders });
    }
    if (fallback) return new Response(fallback.body, { status: 200, headers: { ...okHeaders, 'x-stale': '1' } });
    return new Response(text, {
      status: response.status,
      headers: { 'content-type': 'application/json', ...corsHeaders(req) },
    });
  }

  // ── Binance klines proxy ──────────────────────────────────────────────────
  // Binance's public data-api.binance.vision has open CORS, so the client
  // used to call it directly — but that means every visitor's own IP eats
  // Binance's per-IP rate limit, and one busy IP (or a shared NAT) gets a
  // hard 418 ban that fails charts/prices for every symbol at once. Proxying
  // through here moves the outbound call to Vercel's edge IPs and, more
  // importantly, lets Vercel's CDN cache identical requests (same symbol +
  // interval + limit) for a few seconds — collapsing many concurrent
  // viewers of the same chart into a single upstream Binance call instead of
  // one per visitor.
  if (url.pathname.startsWith('/bn-api/')) {
    const bnPath = url.pathname.replace(/^\/bn-api\//, '');
    const upstream = new URL(`https://data-api.binance.vision/${bnPath}`);
    upstream.search = url.search;
    const response = await fetch(upstream.toString(), {
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, s-maxage=3, stale-while-revalidate=15',
        ...corsHeaders(req),
      },
    });
  }

  // ── CoinGlass proxy ───────────────────────────────────────────────────────
  const apiPath = url.pathname.replace(/^\/cg-api\//, '');
  const upstream = new URL(`https://open-api-v4.coinglass.com/api/${apiPath}`);
  upstream.search = url.search;

  const response = await fetch(upstream.toString(), {
    headers: {
      accept: 'application/json',
      'CG-API-KEY': process.env.VITE_COINGLASS_API_KEY ?? '',
    },
  });

  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: { 'content-type': 'application/json', ...corsHeaders(req) },
  });
}
