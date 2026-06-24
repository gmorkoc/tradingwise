import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import type { BtcMoveAlert } from "../hooks/useBtcMoveAlert";
import "../styles/BtcMoveToast.css";

const DURATION = 6000;

interface Props {
  alert: BtcMoveAlert | null;
  onDismiss: () => void;
}

export function BtcMoveToast({ alert, onDismiss }: Props) {
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(100);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (!alert) { setVisible(false); return; }

    setVisible(true);
    setProgress(100);
    startRef.current = performance.now();

    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const tick = () => {
      const elapsed = performance.now() - startRef.current;
      const pct = Math.max(0, 100 - (elapsed / DURATION) * 100);
      setProgress(pct);
      if (pct > 0) rafRef.current = requestAnimationFrame(tick);
      else { setVisible(false); onDismiss(); }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [alert]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!alert) return null;

  const isUp = alert.direction === "up";
  const color = isUp ? "#22c55e" : "#ef4444";
  const fmtPrice = alert.price.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtChange = Math.round(alert.change).toLocaleString("en-US");

  return ReactDOM.createPortal(
    <div
      className={`btc-toast${visible ? " btc-toast--visible" : ""} ${isUp ? "btc-toast--up" : "btc-toast--down"}`}
      onClick={() => { setVisible(false); onDismiss(); }}
      role="alert"
      style={{ "--btc-color": color } as React.CSSProperties}
    >
      {/* glow blob */}
      <div className="btc-toast-glow" />

      <div className="btc-toast-inner">
        {/* Left: BTC icon + direction */}
        <div className="btc-toast-left">
          <div className="btc-toast-btc-icon">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M9 8h4.5a2 2 0 0 1 0 4H9v4h5a2 2 0 0 0 0-4"/>
              <line x1="9" y1="8" x2="9" y2="16"/>
              <line x1="10.5" y1="6" x2="10.5" y2="8"/>
              <line x1="13.5" y1="6" x2="13.5" y2="8"/>
              <line x1="10.5" y1="16" x2="10.5" y2="18"/>
              <line x1="13.5" y1="16" x2="13.5" y2="18"/>
            </svg>
          </div>
          <div className="btc-toast-arrow">
            {isUp ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4l8 8H4z"/></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 20l-8-8h16z"/></svg>
            )}
          </div>
        </div>

        {/* Center: info */}
        <div className="btc-toast-body">
          <div className="btc-toast-label">
            <span className="btc-toast-live"><span className="btc-toast-live-dot" />LIVE</span>
            <span className="btc-toast-tag">BTC PRICE ALERT</span>
          </div>
          <div className="btc-toast-price">${fmtPrice}</div>
          <div className="btc-toast-change">
            {isUp ? "▲" : "▼"} {isUp ? "+" : "−"}${fmtChange} in last move
          </div>
        </div>

        {/* Close */}
        <button
          className="btc-toast-close"
          onClick={(e) => { e.stopPropagation(); setVisible(false); onDismiss(); }}
          aria-label="Dismiss"
        >✕</button>
      </div>

      {/* Progress bar */}
      <div className="btc-toast-bar" style={{ width: `${progress}%` }} />
    </div>,
    document.body
  );
}
