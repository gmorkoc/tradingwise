import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/AgentIntroShowcase.css";

const SPARKLE_COUNT = 12;
const RING_COUNT = 4;

// One-time full-screen "Agent Ready" reveal — App.tsx mounts this
// alongside (and slightly before the end of) TradingAgent/FloatingNavBar's
// own smaller trigger-anchored glow (showIntroShowcase/showAgentShowcase),
// giving the first-ever chart-page visit a proper big moment before
// settling into "here's where it lives" on the actual trigger. Self-
// contained: no prop needed to end it, just unmounts itself after ~3.8s
// (or instantly on tap-to-skip).
export function AgentIntroShowcase() {
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    const id = window.setTimeout(() => setMounted(false), 3800);
    return () => window.clearTimeout(id);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div className="ais-overlay" onClick={() => setMounted(false)}>
      <div className="ais-backdrop" />
      <div className="ais-beams" />
      <div className="ais-shockwave" />
      <div className="ais-flash" />
      <div className="ais-content">
        <div className="ais-orb-wrap">
          {Array.from({ length: RING_COUNT }).map((_, i) => (
            <span key={i} className={`ais-ring ais-ring--${i + 1}`} aria-hidden="true" />
          ))}
          {Array.from({ length: SPARKLE_COUNT }).map((_, i) => (
            <span key={i} className={`ais-sparkle ais-sparkle--${i + 1}`} aria-hidden="true" />
          ))}
          <span className="ais-orb" aria-hidden="true" />
        </div>
        <div className="ais-title">Agent Ready</div>
        <div className="ais-subtitle">Your AI trading copilot is here</div>
      </div>
    </div>,
    document.body,
  );
}
