import { useState, useEffect } from "react";
import "../styles/LearnSection.css";

interface MiniCandle { o: number; c: number; h: number; l: number; }

interface Pattern {
  name: string;
  description: string;
  candles: MiniCandle[];
}

function MiniChart({ candles, type }: { candles: MiniCandle[]; type: "bullish" | "bearish" }) {
  const SLOT = 28;
  const PAD  = 4;
  const W    = candles.length * SLOT + PAD * 2;
  const H    = 72;
  const toY  = (v: number) => (1 - v / 100) * H;
  const bull = "#22c55e";
  const bear = "#ef4444";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="learn-mini-chart">
      <line x1={0} y1={H / 2} x2={W} y2={H / 2}
        stroke={type === "bullish" ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)"}
        strokeWidth={1} strokeDasharray="3 3" />
      {candles.map((c, i) => {
        const cx    = PAD + i * SLOT + SLOT / 2;
        const isBull = c.c >= c.o;
        const color  = isBull ? bull : bear;
        const bTop   = toY(Math.max(c.o, c.c));
        const bBot   = toY(Math.min(c.o, c.c));
        const bH     = Math.max(bBot - bTop, 2);
        return (
          <g key={i}>
            <line x1={cx} y1={toY(c.h)} x2={cx} y2={toY(c.l)}
              stroke={color} strokeWidth={1.5} strokeLinecap="round" />
            <rect x={cx - 8} y={bTop} width={16} height={bH} fill={color} rx={1.5} />
          </g>
        );
      })}
    </svg>
  );
}

const BULLISH: Pattern[] = [
  {
    name: "Hammer",
    description: "Small body near the top with a long lower wick (2× body or more). After a downtrend, buyers pushed price back up — strong potential reversal signal.",
    candles: [{ o: 80, c: 85, h: 88, l: 20 }],
  },
  {
    name: "Inverted Hammer",
    description: "Small body near the bottom with a long upper wick. Buyers attempted a rally; sellers couldn't sustain the pressure — watch for follow-through confirmation.",
    candles: [{ o: 28, c: 32, h: 88, l: 23 }],
  },
  {
    name: "Bullish Engulfing",
    description: "A large green candle completely engulfs the prior red candle's body. Strong reversal signal — buyers have taken decisive control from sellers.",
    candles: [
      { o: 72, c: 52, h: 76, l: 48 },
      { o: 42, c: 82, h: 86, l: 38 },
    ],
  },
  {
    name: "Piercing Line",
    description: "Green candle opens below the prior red candle's low but closes above its midpoint. Shows buyers stepping in aggressively after a flush lower.",
    candles: [
      { o: 80, c: 52, h: 83, l: 49 },
      { o: 42, c: 68, h: 71, l: 38 },
    ],
  },
  {
    name: "Morning Star",
    description: "Three-candle reversal: large red, small indecisive candle, then large green. Classic bottom-reversal pattern showing increasing buyer conviction.",
    candles: [
      { o: 82, c: 58, h: 85, l: 55 },
      { o: 48, c: 52, h: 58, l: 44 },
      { o: 56, c: 80, h: 84, l: 53 },
    ],
  },
  {
    name: "Three White Soldiers",
    description: "Three consecutive green candles, each opening near the prior close and closing higher. Signals a powerful, sustained shift to buying pressure.",
    candles: [
      { o: 30, c: 50, h: 53, l: 27 },
      { o: 48, c: 68, h: 71, l: 45 },
      { o: 66, c: 88, h: 91, l: 63 },
    ],
  },
  {
    name: "Bullish Harami",
    description: "A small green candle entirely within the prior large red candle's body. The downtrend is losing momentum — a reversal may be near.",
    candles: [
      { o: 82, c: 40, h: 85, l: 37 },
      { o: 52, c: 62, h: 65, l: 50 },
    ],
  },
  {
    name: "Dragonfly Doji",
    description: "Open, high, and close near the top with a very long lower wick. Sellers drove price down hard but buyers fully reclaimed — strong demand signal.",
    candles: [{ o: 82, c: 84, h: 86, l: 8 }],
  },
];

const BEARISH: Pattern[] = [
  {
    name: "Shooting Star",
    description: "Small body near the low with a long upper wick (2× body or more). At market tops, buyers rallied but sellers crushed them back — potential reversal.",
    candles: [{ o: 68, c: 63, h: 92, l: 59 }],
  },
  {
    name: "Hanging Man",
    description: "Looks like a hammer but forms at the top of an uptrend. The long lower wick reveals growing selling pressure even though bulls recovered for now.",
    candles: [{ o: 78, c: 73, h: 81, l: 12 }],
  },
  {
    name: "Bearish Engulfing",
    description: "A large red candle completely engulfs the prior green candle's body. Strong reversal signal — sellers have taken decisive control from buyers.",
    candles: [
      { o: 40, c: 60, h: 63, l: 37 },
      { o: 70, c: 28, h: 73, l: 25 },
    ],
  },
  {
    name: "Dark Cloud Cover",
    description: "Red candle opens above the prior green candle's high but closes below its midpoint. Shows sellers aggressively stepping in at elevated prices.",
    candles: [
      { o: 40, c: 76, h: 79, l: 37 },
      { o: 84, c: 52, h: 87, l: 49 },
    ],
  },
  {
    name: "Evening Star",
    description: "Three-candle reversal: large green, small indecisive candle, then large red. Classic top-reversal showing buyers exhausted and sellers taking over.",
    candles: [
      { o: 28, c: 54, h: 57, l: 25 },
      { o: 62, c: 58, h: 70, l: 55 },
      { o: 52, c: 27, h: 55, l: 24 },
    ],
  },
  {
    name: "Three Black Crows",
    description: "Three consecutive red candles, each opening near the prior close and closing lower. Signals a powerful, sustained shift to heavy selling pressure.",
    candles: [
      { o: 82, c: 62, h: 85, l: 59 },
      { o: 64, c: 44, h: 67, l: 41 },
      { o: 46, c: 22, h: 49, l: 19 },
    ],
  },
  {
    name: "Bearish Harami",
    description: "A small red candle entirely within the prior large green candle's body. The uptrend is losing steam — watch for a breakdown below support.",
    candles: [
      { o: 28, c: 76, h: 79, l: 25 },
      { o: 62, c: 50, h: 65, l: 48 },
    ],
  },
  {
    name: "Gravestone Doji",
    description: "Open, low, and close near the bottom with a very long upper wick. Buyers pushed hard but sellers fully reclaimed — strong supply rejection signal.",
    candles: [{ o: 18, c: 20, h: 92, l: 14 }],
  },
];

function PatternCard({ pattern, type }: { pattern: Pattern; type: "bullish" | "bearish" }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`learn-card learn-card--${type}`} onClick={() => setOpen(o => !o)}>
      <div className="learn-card-top">
        <div className="learn-card-chart">
          <MiniChart candles={pattern.candles} type={type} />
        </div>
        <div className="learn-card-info">
          <span className="learn-card-name">{pattern.name}</span>
          <span className="learn-card-chevron">{open ? "▲" : "▼"}</span>
        </div>
      </div>
      {open && <p className="learn-card-desc">{pattern.description}</p>}
    </div>
  );
}

interface LearnSectionProps {
  isOpen: boolean;
  onClose: () => void;
}

export const LearnSection: React.FC<LearnSectionProps> = ({ isOpen, onClose }) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="learn-overlay" onClick={onClose}>
      <div className="learn-modal" onClick={e => e.stopPropagation()}>
        <div className="learn-modal-header">
          <span className="learn-modal-title">📚 Candlestick Patterns</span>
          <button className="learn-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="learn-modal-body">
          <div className="learn-panels">
            <div className="learn-panel">
              <div className="learn-panel-header learn-panel-header--bullish">
                <span className="learn-panel-dot" /> Bullish Patterns
              </div>
              <div className="learn-pattern-list">
                {BULLISH.map(p => <PatternCard key={p.name} pattern={p} type="bullish" />)}
              </div>
            </div>

            <div className="learn-panel">
              <div className="learn-panel-header learn-panel-header--bearish">
                <span className="learn-panel-dot" /> Bearish Patterns
              </div>
              <div className="learn-pattern-list">
                {BEARISH.map(p => <PatternCard key={p.name} pattern={p} type="bearish" />)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
