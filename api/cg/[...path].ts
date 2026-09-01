import type { VercelRequest, VercelResponse } from "@vercel/node";

// capacitor://localhost is the native iOS app's real Origin header — see
// api/deleteAccount.ts for why this has to be here.
const ALLOWED_ORIGINS = ["https://www.coinhintz.io", "https://coinhintz.io", "capacitor://localhost", "http://localhost:5173", "http://localhost:4173"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin ?? "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const pathParts = req.query.path;
  const apiPath = Array.isArray(pathParts) ? pathParts.join("/") : (pathParts ?? "");

  const url = new URL(`https://open-api-v4.coinglass.com/api/${apiPath}`);

  const { path: _path, ...rest } = req.query;
  for (const [k, v] of Object.entries(rest)) {
    if (typeof v === "string") url.searchParams.set(k, v);
    else if (Array.isArray(v)) v.forEach((val) => url.searchParams.append(k, val));
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: {
        accept: "application/json",
        "CG-API-KEY": process.env.VITE_COINGLASS_API_KEY ?? "",
      },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch {
    res.status(502).json({ error: "upstream request failed" });
  }
}
