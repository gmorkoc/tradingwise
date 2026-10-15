import { ZoneSignal } from "./PriceChart.types";
import "../styles/SignalIndicator.css";

// Same colors as the old .zone-signal/.mch-mobile-signal pills this
// replaces (PriceChart.css) — same verdict, same color, just a different
// shape reading it out.
const SIGNAL_COLOR: Record<ZoneSignal, string> = {
  "strong-buy": "#4ade80",
  "buy": "#4ade80",
  "oversold": "#f59e0b",
  "overbought": "#f59e0b",
  "neutral": "#94a3b8",
  "sell": "#fb7185",
  "strong-sell": "#f43f5e",
};

// Which of the 3 dots lights up for each of the 7 real signal values.
// Oversold/overbought light the MIDDLE dot, not the buy/sell one — they're
// a caution/"stretched" read, not a clean buy/sell verdict, so a fully-lit
// green or red dot overstated them as equal in strength to an actual
// buy/sell signal. The middle dot still picks up SIGNAL_COLOR's amber for
// these two (below), so it reads as "caution", not the same flat gray as
// a true neutral.
const SIGNAL_BUCKET: Record<ZoneSignal, "sell" | "neutral" | "buy"> = {
  "strong-sell": "sell",
  "sell": "sell",
  "overbought": "neutral",
  "neutral": "neutral",
  "oversold": "neutral",
  "buy": "buy",
  "strong-buy": "buy",
};

export default function SignalIndicator({
  signal,
  label,
}: {
  signal: ZoneSignal;
  label: string;
}) {
  const bucket = SIGNAL_BUCKET[signal];
  // The lit dot always takes the exact signal's own color (not a shared
  // per-bucket color) so oversold/overbought's middle dot comes out amber,
  // matching the label, instead of a true neutral's gray.
  const dotColor = SIGNAL_COLOR[signal];
  return (
    <div className="signal-indicator">
      <span className="signal-indicator-dot" style={bucket === "sell" ? { background: dotColor, boxShadow: `0 0 8px ${dotColor}cc` } : undefined} />
      <span className="signal-indicator-dot" style={bucket === "neutral" ? { background: dotColor, boxShadow: `0 0 8px ${dotColor}99` } : undefined} />
      <span className="signal-indicator-dot" style={bucket === "buy" ? { background: dotColor, boxShadow: `0 0 8px ${dotColor}cc` } : undefined} />
      <span className="signal-indicator-label" style={{ color: dotColor }}>{label}</span>
    </div>
  );
}
