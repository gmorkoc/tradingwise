// Hyperliquid "Top Traders" scan — shared by the hl-top-traders edge
// function (Deno) and a local test script (Node), so it only uses fetch.
//
// 1. Leaderboard (stats-data.hyperliquid.xyz, ~40 MB, every trader with
//    account value + day/week/month/allTime PnL/ROI/volume) → keep the top
//    N by 30-day PnL among accounts worth at least MIN_ACCOUNT_USD.
// 2. For each, clearinghouseState (api.hyperliquid.xyz/info) → open perp
//    positions: size, entry, position value, leverage, unrealized PnL,
//    ROE, liquidation price, funding since open.
// 3. Our own labels (no paid labelling feed): Whale by account size,
//    Smart Money for top 30-day performers, Day / Swing trader by how much
//    they trade relative to their account.

const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const INFO_URL = "https://api.hyperliquid.xyz/info";

export const TOP_N = 300;
const MIN_ACCOUNT_USD = 100_000;
const CONCURRENCY = 8;

export interface TopTraderRow {
  coin: string;
  address: string;
  label: string;
  side: "long" | "short";
  size: number;
  position_value: number;
  entry_px: number;
  mark_px: number;
  liquidation_px: number | null;
  leverage: number;
  unrealized_pnl: number;
  roe: number;
  funding: number;
  account_value: number;
  month_pnl: number;
}

type Window = "day" | "week" | "month" | "allTime";
interface LbRow {
  ethAddress: string;
  accountValue: string;
  displayName: string | null;
  windowPerformances: [Window, { pnl: string; roi: string; vlm: string }][];
}

function perf(r: LbRow, w: Window) {
  const p = r.windowPerformances.find(([k]) => k === w)?.[1];
  return { pnl: Number(p?.pnl ?? 0), roi: Number(p?.roi ?? 0), vlm: Number(p?.vlm ?? 0) };
}

function labelFor(r: LbRow, rankByMonth: number): string {
  const acct = Number(r.accountValue);
  const week = perf(r, "week");
  const month = perf(r, "month");
  const parts: string[] = [];
  if (acct >= 5_000_000) parts.push("Whale");
  if (rankByMonth < 100 && month.roi >= 0.1) parts.push("Smart Money");
  // Weekly volume vs account size: very active accounts are day traders.
  const turnover = acct > 0 ? week.vlm / acct : 0;
  parts.push(turnover >= 15 ? "Day Trader" : "Swing Trader");
  return parts.join(" · ");
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

export async function scanTopTraders(): Promise<TopTraderRow[]> {
  const lbRes = await fetch(LEADERBOARD_URL);
  if (!lbRes.ok) throw new Error(`leaderboard ${lbRes.status}`);
  const lb = (await lbRes.json()) as { leaderboardRows: LbRow[] };

  const ranked = lb.leaderboardRows
    .filter((r) => Number(r.accountValue) >= MIN_ACCOUNT_USD)
    .sort((a, b) => perf(b, "month").pnl - perf(a, "month").pnl)
    .slice(0, TOP_N);

  const states = await pool(ranked, CONCURRENCY, async (r) => {
    try {
      const res = await fetch(INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "clearinghouseState", user: r.ethAddress }),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  });

  const rows: TopTraderRow[] = [];
  ranked.forEach((r, rank) => {
    const st = states[rank];
    if (!st?.assetPositions) return;
    const label = labelFor(r, rank);
    const accountValue = Number(st.marginSummary?.accountValue ?? r.accountValue);
    for (const ap of st.assetPositions) {
      const p = ap.position;
      const size = Number(p.szi);
      if (!size) continue;
      const posValue = Number(p.positionValue);
      rows.push({
        coin: String(p.coin),
        address: r.ethAddress.toLowerCase(),
        label,
        side: size > 0 ? "long" : "short",
        size: Math.abs(size),
        position_value: posValue,
        entry_px: Number(p.entryPx),
        mark_px: Math.abs(size) > 0 ? posValue / Math.abs(size) : 0,
        liquidation_px: p.liquidationPx != null ? Number(p.liquidationPx) : null,
        leverage: Number(p.leverage?.value ?? 0),
        unrealized_pnl: Number(p.unrealizedPnl),
        roe: Number(p.returnOnEquity),
        // Hyperliquid's sinceOpen is funding PAID (positive = paid out);
        // flip it so positive means the trader received funding.
        funding: -Number(p.cumFunding?.sinceOpen ?? 0),
        account_value: accountValue,
        month_pnl: perf(r, "month").pnl,
      });
    }
  });
  return rows;
}
