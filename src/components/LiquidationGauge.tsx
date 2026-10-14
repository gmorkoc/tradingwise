import "../styles/LiquidationGauge.css";

interface Props {
  side: "long" | "short";
  entryPrice: number;
  liquidationPrice: number | null;
  takeProfitPrice: number | null;
  currentPrice: number;
}

// Live horizontal gauge for a leveraged position: liquidation always sits
// at the 0% (danger) end, take-profit at the 100% (safe/profit) end,
// regardless of long/short — the actual numeric ordering of those two
// prices flips between the two sides, but mirroring the entry-to-
// liquidation distance onto the other side of entry (2*entry -
// liquidationPrice) when there's no real take-profit set gives a single
// formula that works for both without branching on `side` at all. The
// live marker's position (and color/pulse once it's close to liquidation)
// updates every time `currentPrice` changes — same live-ticker price the
// position's own P&L figure already uses.
export function LiquidationGauge({ side, entryPrice, liquidationPrice, takeProfitPrice, currentPrice }: Props) {
  if (liquidationPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  const farEnd = takeProfitPrice ?? (2 * entryPrice - liquidationPrice);
  const clampPct = (v: number) => Math.max(0, Math.min(100, v));
  const pct = clampPct(((currentPrice - liquidationPrice) / (farEnd - liquidationPrice)) * 100);
  const entryPct = clampPct(((entryPrice - liquidationPrice) / (farEnd - liquidationPrice)) * 100);
  const danger = pct <= 20;

  return (
    <div
      className={`liq-gauge${danger ? " liq-gauge--danger" : ""}`}
      role="img"
      aria-label={`${side === "long" ? "Long" : "Short"} position, ${pct.toFixed(0)}% of the way from liquidation to ${takeProfitPrice != null ? "take profit" : "a safe distance"}`}
    >
      <div className="liq-gauge-track">
        <span className="liq-gauge-entry-tick" style={{ left: `${entryPct}%` }} title={`Entry $${entryPrice.toLocaleString()}`} />
        <span className="liq-gauge-marker" style={{ left: `${pct}%` }} />
      </div>
      <div className="liq-gauge-labels">
        <span className="liq-gauge-label liq-gauge-label--danger">Liq ${liquidationPrice.toLocaleString()}</span>
        {takeProfitPrice != null && (
          <span className="liq-gauge-label liq-gauge-label--profit">TP ${takeProfitPrice.toLocaleString()}</span>
        )}
      </div>
    </div>
  );
}
