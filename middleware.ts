export const config = { matcher: ['/cg-api/:path*', '/cg-sdk/:path*'] };

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
