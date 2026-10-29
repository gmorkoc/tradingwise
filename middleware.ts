export const config = { matcher: ['/cg-api/:path*', '/cg-sdk/:path*', '/coinalyze-api/:path*', '/bn-api/:path*', '/gecko-api/:path*', '/ff-cal'] };

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
    const response = await fetch(upstream.toString(), {
      headers: { accept: 'application/json', 'api_key': process.env.VITE_COINALYZE_API_KEY ?? '' },
    });
    const text = await response.text();
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
  if (url.pathname.startsWith('/gecko-api/')) {
    const gkPath = url.pathname.replace(/^\/gecko-api\//, '');
    const upstream = new URL(`https://api.coingecko.com/${gkPath}`);
    upstream.search = url.search;
    const response = await fetch(upstream.toString(), {
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
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
