import { useState, useEffect } from "react";
import "../styles/ResolutionBanner.css";

const STORAGE_KEY = "resolution_banner_dismissed";

export function ResolutionBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    // Skip on touch devices (phones, tablets) — only relevant for desktop browsers
    if (window.matchMedia("(pointer: coarse)").matches) return;
    if (window.innerWidth < 1280 || window.innerHeight < 800) {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  }

  return (
    <div className="rb-banner">
      <span className="rb-icon">💡</span>
      <span className="rb-text">
        For the best experience, use a screen resolution of at least{" "}
        <strong>1280 × 800</strong>.
      </span>
      <button className="rb-close" onClick={dismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}
