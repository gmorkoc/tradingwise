import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import type { BtcMoveAlert } from "../hooks/useBtcMoveAlert";
import { formatLivePrice } from "./PriceChart";
import "../styles/BtcMoveToast.css";

const DURATION = 6000;
const SWIPE_THRESHOLD = 48;

interface Props {
  alert: BtcMoveAlert | null;
  onDismiss: () => void;
}

export function BtcMoveToast({ alert, onDismiss }: Props) {
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(100);
  const [dragY, setDragY] = useState(0);
  const [logoError, setLogoError] = useState(false);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const touchStartYRef = useRef<number | null>(null);

  useEffect(() => {
    if (!alert) { setVisible(false); return; }

    setVisible(true);
    setProgress(100);
    setDragY(0);
    setLogoError(false);
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
  // Whole-dollar rounding read fine for BTC ($84,231) but rounded a coin
  // like NEAR ($4.43) down to a bare "$4" — reuse the same adaptive-decimal
  // formatting the header price pill already uses instead of a fixed 0.
  const fmtPrice = formatLivePrice(alert.price).replace(/^\$/, "");
  const fmtChange = formatLivePrice(Math.abs(alert.change)).replace(/^\$/, "");

  const dismiss = () => { setVisible(false); onDismiss(); };

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0].clientY;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (touchStartYRef.current === null) return;
    const dy = e.touches[0].clientY - touchStartYRef.current;
    if (dy < 0) setDragY(dy); // only allow upward drag
  };

  const onTouchEnd = () => {
    if (dragY < -SWIPE_THRESHOLD) {
      dismiss();
    } else {
      setDragY(0);
    }
    touchStartYRef.current = null;
  };

  const dragging = dragY !== 0;
  const extraStyle: React.CSSProperties = {
    "--btc-color": color,
    ...(dragging ? {
      transform: `translateX(-50%) translateY(${dragY}px)`,
      transition: "none",
      opacity: Math.max(0, 1 + dragY / 120),
    } : {}),
  } as React.CSSProperties;

  return ReactDOM.createPortal(
    <div
      className={`btc-toast${visible ? " btc-toast--visible" : ""} ${isUp ? "btc-toast--up" : "btc-toast--down"}`}
      onClick={() => { if (!dragging) dismiss(); }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      role="alert"
      style={extraStyle}
    >
      {/* glow blob */}
      <div className="btc-toast-glow" />

      <div className="btc-toast-inner">
        {/* Left: coin icon + direction */}
        <div className="btc-toast-left">
          <div className="btc-toast-btc-icon">
            {!logoError ? (
              <img
                src={`https://assets.coincap.io/assets/icons/${alert.coin.toLowerCase()}@2x.png`}
                alt=""
                onError={() => setLogoError(true)}
              />
            ) : (
              <span className="btc-toast-icon-fallback">{alert.coin[0] ?? "?"}</span>
            )}
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
            <span className="btc-toast-tag">{alert.coin} PRICE ALERT</span>
          </div>
          <div className="btc-toast-price">${fmtPrice}</div>
          <div className="btc-toast-change">
            {isUp ? "▲" : "▼"} {isUp ? "+" : "−"}${fmtChange} ({alert.changePct.toFixed(2)}%) in last move
          </div>
        </div>

        {/* Close */}
        <button
          className="btc-toast-close"
          onClick={(e) => { e.stopPropagation(); dismiss(); }}
          aria-label="Dismiss"
        >✕</button>
      </div>

      {/* Progress bar */}
      <div className="btc-toast-bar" style={{ width: `${progress}%` }} />
    </div>,
    document.body
  );
}
