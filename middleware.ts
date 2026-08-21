export const config = { matcher: ['/cg-api/:path*', '/cg-sdk/:path*', '/coinalyze-api/:path*', '/bn-api/:path*'] };

const ALLOWED_ORIGINS = ['https://www.coinhintz.io', 'https://coinhintz.io', 'http://localhost:5173', 'http://localhost:4173'];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export default async function middleware(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const url = new URL(req.url);

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
