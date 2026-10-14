import { useRef } from "react";
import "../styles/CookingLoader.css";

// Playful "preparing your request" loading treatment, shared by any modal/
// panel that has a visible gap between opening and real data landing
// (AgentChartModal, OrderBookProfileModal) — replaces what used to be a
// plain static "Loading…"/"Fetching depth data…" string with no animation
// at all. One random phrase per mount, not a rotating cycle — this is
// usually a sub-second wait, so cycling through several phrases would just
// flash past unread; picking one and holding it is enough personality
// without needing an extra timer.
const COOKING_PHRASES = [
  "Cooking up your chart…",
  "Plating this up for you…",
  "Crunching the numbers…",
  "Warming up the data…",
  "Stirring up the details…",
];

export function CookingLoader({ label }: { label?: string }) {
  const phraseRef = useRef(label ?? COOKING_PHRASES[Math.floor(Math.random() * COOKING_PHRASES.length)]);
  return (
    <div className="cooking-loader">
      <span className="cooking-loader-orb" />
      <span className="cooking-loader-label">{phraseRef.current}</span>
    </div>
  );
}
