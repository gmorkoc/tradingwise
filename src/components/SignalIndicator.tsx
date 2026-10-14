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

// Which of the 3 dots lights up for each of the 7 real signal values —
// overbought (price stretched up, pullback risk) buckets with the sell
// dot, oversold (stretched down, bounce potential) buckets with the buy
// dot, matching the "caution, not a clean verdict" lean those two get
// everywhere else in the app. The exact word (not just the bucket) still
// shows in the label beside it, in its own precise color.
const SIGNAL_BUCKET: Record<ZoneSignal, "sell" | "neutral" | "buy"> = {
  "strong-sell": "sell",
  "sell": "sell",
  "overbought": "sell",
  "neutral": "neutral",
  "oversold": "buy",
  "buy": "buy",
  "strong-buy": "buy",
};

const BUCKET_COLOR: Record<"sell" | "neutral" | "buy", string> = {
  sell: "#fb7185",
  neutral: "#94a3b8",
  buy: "#4ade80",
};

export default function SignalIndicator({
  signal,
  label,
}: {
  signal: ZoneSignal;
  label: string;
}) {
  const bucket = SIGNAL_BUCKET[signal];
  const labelColor = SIGNAL_COLOR[signal];
  return (
    <div className="signal-indicator">
      <span className="signal-indicator-dot" style={bucket === "sell" ? { background: BUCKET_COLOR.sell, boxShadow: `0 0 8px ${BUCKET_COLOR.sell}cc` } : undefined} />
      <span className="signal-indicator-dot" style={bucket === "neutral" ? { background: BUCKET_COLOR.neutral, boxShadow: `0 0 8px ${BUCKET_COLOR.neutral}99` } : undefined} />
      <span className="signal-indicator-dot" style={bucket === "buy" ? { background: BUCKET_COLOR.buy, boxShadow: `0 0 8px ${BUCKET_COLOR.buy}cc` } : undefined} />
      <span className="signal-indicator-label" style={{ color: labelColor }}>{label}</span>
    </div>
  );
}
