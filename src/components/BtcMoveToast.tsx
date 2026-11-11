import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import type { BtcMoveAlert } from "../hooks/useBtcMoveAlert";
import type { WhaleToastAlert } from "../hooks/useWhaleToast";
import { formatLivePrice } from "./PriceChart";
import "../styles/BtcMoveToast.css";

const DURATION = 6000;
// Whale alerts are quick glances: 2 seconds each.
const WHALE_DURATION = 2000;
const SWIPE_THRESHOLD = 48;

const fmtUsdShort = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString("en-US")}`;
const fmtBtc = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}K` : n.toFixed(1));

interface Props {
  /** A price move or a whale transfer — both use this one toast. */
  alert: BtcMoveAlert | WhaleToastAlert | null;
  onDismiss: () => void;
  /** ✕ button only (falls back to onDismiss). */
  onClose?: () => void;
  /** Whale alerts: the "Snooze 1h" button. */
  onSnooze?: () => void;
}

export function BtcMoveToast({ alert, onDismiss, onClose, onSnooze }: Props) {
  const { t } = useTranslation();
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
      const total = "kind" in alert && alert.kind === "whale" ? WHALE_DURATION : DURATION;
      const pct = Math.max(0, 100 - (elapsed / total) * 100);
      setProgress(pct);
      if (pct > 0) rafRef.current = requestAnimationFrame(tick);
      else { setVisible(false); onDismiss(); }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [alert]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!alert) return null;

  const whale = "kind" in alert && alert.kind === "whale" ? alert : null;
  const move = whale ? null : (alert as BtcMoveAlert);
  // Whale: green when coins leave exchanges (bullish), red when they go in
  // (bearish), blue when it's wallet to wallet.
  const isUp = whale ? whale.sentiment !== "bearish" : move!.direction === "up";
  const color = whale
    ? whale.sentiment === "bullish" ? "#22c55e" : whale.sentiment === "bearish" ? "#ef4444" : "#3b82f6"
    : isUp ? "#22c55e" : "#ef4444";
  // Whole-dollar rounding read fine for BTC ($84,231) but rounded a coin
  // like NEAR ($4.43) down to a bare "$4" — reuse the same adaptive-decimal
  // formatting the header price pill already uses instead of a fixed 0.
  const fmtPrice = move ? formatLivePrice(move.price).replace(/^\$/, "") : "";
  const fmtChange = move ? formatLivePrice(Math.abs(move.change)).replace(/^\$/, "") : "";

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
            {whale ? (
              <span className="btc-toast-whale" aria-hidden="true">🐋</span>
            ) : !logoError ? (
              <img
                src={`https://assets.coincap.io/assets/icons/${move!.coin.toLowerCase()}@2x.png`}
                alt=""
                onError={() => setLogoError(true)}
              />
            ) : (
              <span className="btc-toast-icon-fallback">{move!.coin[0] ?? "?"}</span>
            )}
          </div>
          {!whale && <div className="btc-toast-arrow">
            {isUp ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4l8 8H4z"/></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 20l-8-8h16z"/></svg>
            )}
          </div>}
        </div>

        {/* Center: info */}
        {whale ? (
          <div className="btc-toast-body">
            <div className="btc-toast-label">
              <span className="btc-toast-live"><span className="btc-toast-live-dot" />{t("btcMoveToast.live")}</span>
              <span className="btc-toast-tag">
                {t("btcMoveToast.whaleAlert")}{whale.sentiment !== "neutral" ? ` · ${whale.sentiment === "bullish" ? t("btcMoveToast.bullish") : t("btcMoveToast.bearish")}` : ""}
              </span>
            </div>
            <div className="btc-toast-price">
              {fmtBtc(whale.amount)} BTC{whale.usd ? <span className="btc-toast-usd"> ≈ {fmtUsdShort(whale.usd)}</span> : null}
            </div>
            <div className="btc-toast-change btc-toast-transfer">{whale.from} → {whale.to}</div>
          </div>
        ) : (
          <div className="btc-toast-body">
            <div className="btc-toast-label">
              <span className="btc-toast-live"><span className="btc-toast-live-dot" />{t("btcMoveToast.live")}</span>
              <span className="btc-toast-tag">{t("btcMoveToast.priceAlert", { coin: move!.coin })}</span>
            </div>
            <div className="btc-toast-price">${fmtPrice}</div>
            <div className="btc-toast-change">
              {isUp ? "▲" : "▼"} {t("btcMoveToast.inLastMove", { change: `${isUp ? "+" : "−"}$${fmtChange}`, pct: move!.changePct.toFixed(2) })}
            </div>
          </div>
        )}

        {/* Close (+ Snooze on whale alerts) */}
        <div className={`btc-toast-actions${whale && onSnooze ? " btc-toast-actions--snooze" : ""}`}>
          {/* Whale alerts: Snooze only, no ✕ (swipe still dismisses). */}
          {!(whale && onSnooze) && (
            <button
              className="btc-toast-close"
              onClick={(e) => {
                e.stopPropagation();
                if (onClose) { setVisible(false); onClose(); } else dismiss();
              }}
              aria-label={t("btcMoveToast.dismiss")}
            >✕</button>
          )}
          {whale && onSnooze && (
            <button
              type="button"
              className="btc-toast-snooze"
              onClick={(e) => { e.stopPropagation(); setVisible(false); onSnooze(); }}
              aria-label={t("btcMoveToast.snoozeAria", "Snooze whale alerts for 1 hour")}
            >
              {t("btcMoveToast.snooze", "Snooze 1h")}
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="btc-toast-bar" style={{ width: `${progress}%` }} />
    </div>,
    document.body
  );
}
