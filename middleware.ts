export const config = { matcher: ['/cg-api/:path*', '/cg-sdk/:path*', '/yf-api/:path*', '/bold-api/:path*', '/nasdaq-api/:path*', '/api/openai'] };

export default async function middleware(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const url = new URL(req.url);

  // ── OpenAI proxy ─────────────────────────────────────────────────────────
  if (url.pathname === '/api/openai') {
    const body = await req.text();
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.VITE_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? ''}`,
      },
      body,
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        'content-type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // ── Nasdaq API proxy ─────────────────────────────────────────────────────
  if (url.pathname.startsWith('/nasdaq-api/')) {
    const nasdaqPath = url.pathname.replace(/^\/nasdaq-api\//, '');
    const upstream = new URL(`https://api.nasdaq.com/${nasdaqPath}`);
    upstream.search = url.search;
    const response = await fetch(upstream.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.nasdaq.com',
        'Referer': 'https://www.nasdaq.com/',
      },
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // ── BOLD Report proxy ────────────────────────────────────────────────────
  if (url.pathname.startsWith('/bold-api/')) {
    const boldPath = url.pathname.replace(/^\/bold-api\//, '');
    const upstream = new URL(`https://bold.report/api/v1/${boldPath}`);
    upstream.search = url.search;
    const response = await fetch(upstream.toString(), {
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' },
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
      headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // ── Yahoo Finance proxy ──────────────────────────────────────────────────
  if (url.pathname.startsWith('/yf-api/')) {
    const yfPath = url.pathname.replace(/^\/yf-api\//, '');
    const upstream = new URL(`https://query2.finance.yahoo.com/${yfPath}`);
    upstream.search = url.search;
    const response = await fetch(upstream.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://finance.yahoo.com',
        'Referer': 'https://finance.yahoo.com/',
      },
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' },
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
    headers: {
      'content-type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
