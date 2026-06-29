import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOWED_ORIGINS = ["https://www.coinhintz.io", "https://coinhintz.io", "http://localhost:5173", "http://localhost:4173"];

const TOP_COINS = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","DOT"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin ?? "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const { action, coin } = req.query;

  try {
    if (action === "history" && typeof coin === "string") {
      const r = await fetch(
        `https://www.okx.com/api/v5/public/funding-rate-history?instId=${coin.toUpperCase()}-USDT-SWAP&limit=10`
      );
      const data = await r.json();
      return res.status(200).json(data);
    }

    // Default: fetch current funding rate for all top coins in parallel
    const results = await Promise.all(
      TOP_COINS.map(sym =>
        fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${sym}-USDT-SWAP`)
          .then(r => r.json())
          .then(d => ({ sym, data: d.data?.[0] ?? null }))
          .catch(() => ({ sym, data: null }))
      )
    );

    return res.status(200).json({ results });
  } catch (e) {
    return res.status(502).json({ error: "Funding data fetch failed", detail: String(e) });
  }
}
