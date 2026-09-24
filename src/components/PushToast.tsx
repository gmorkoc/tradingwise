import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { Browser } from "@capacitor/browser";
import { Avatar } from "./Avatar";
import "../styles/PushToast.css";

interface SignalHit { id: string; label: string; value?: number }

interface PushToastData {
  type?: string;
  url?: string;
  coin?: string;
  commentId?: string;
  avatarUrl?: string;
  username?: string;
  strategyId?: string;
  // Real structured data (not the FCM-style string-only payload the native
  // push path is stuck with) — only ever set by the web Realtime path
  // (useBuySignalRealtime.ts), which has the full row to work with. Native
  // buy-signal pushes fall back to the plain title/body layout below since
  // the OS notification payload never carried this.
  price?: number;
  signals?: SignalHit[];
}

interface PushToastDetail {
  title: string;
  body: string;
  data?: PushToastData;
}

// 3 minutes instead of the old 6s — this now covers a genuinely
// action-worth-noticing alert (a buy signal), not just an FYI, so it stays
// up long enough to actually notice without demanding an instant reaction.
// The close button (already there) covers "I saw it, dismiss it now."
const DURATION = 180_000;

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

// Rendered once at the app root. pushNotifications.ts dispatches
// "push-toast" for any push received while the app is in the foreground
// (the OS banner is suppressed for those — see capacitor.config.ts) so the
// user still sees something, just in-app instead of a system banner.
export function PushToast() {
  const [toast, setToast] = useState<PushToastDetail | null>(null);
  const [logoError, setLogoError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onPush = (e: Event) => {
      const detail = (e as CustomEvent<PushToastDetail>).detail;
      setToast(detail);
      setLogoError(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setToast(null), DURATION);
    };
    window.addEventListener("push-toast", onPush);
    return () => window.removeEventListener("push-toast", onPush);
  }, []);

  if (!toast) return null;

  const data = toast.data;

  const handleTap = () => {
    if ((data?.type === "daily_brief" || data?.type === "breaking_news") && data.url) {
      Browser.open({ url: data.url });
    } else if (data?.type === "upgrade_reminder") {
      window.dispatchEvent(new CustomEvent("open-upgrade-modal"));
    } else if (data?.type === "coin_mention" && data.coin && data.commentId) {
      window.dispatchEvent(new CustomEvent("open-coin-mention", {
        detail: { coin: data.coin, commentId: parseInt(data.commentId, 10) },
      }));
    } else if (data?.type === "strategy_alert" && data.strategyId) {
      window.dispatchEvent(new CustomEvent("open-strategy-alert", {
        detail: { strategyId: data.strategyId, coin: data.coin },
      }));
    } else if (data?.type === "buy_signal") {
      window.dispatchEvent(new CustomEvent("open-buy-signals"));
    }
    setToast(null);
  };

  const isBuySignal = data?.type === "buy_signal";
  // Only the web Realtime path sends the full breakdown — a native push
  // (title/body only) still gets the plain layout further down.
  const hasBuySignalDetail = isBuySignal && data?.coin && data?.signals && data.signals.length > 0;

  if (hasBuySignalDetail) {
    const coin = data!.coin!;
    return ReactDOM.createPortal(
      <div className="push-toast push-toast--buy-signal push-toast--rich" onClick={handleTap} role="alert">
        <button className="push-toast-close push-toast-close--rich" onClick={(e) => { e.stopPropagation(); setToast(null); }}>✕</button>
        <div className="push-toast-rich-head">
          <div className="push-toast-coin-logo">
            {!logoError ? (
              <img
                src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
                alt=""
                onError={() => setLogoError(true)}
              />
            ) : (
              <span className="push-toast-coin-logo-fallback">{coin[0] ?? "?"}</span>
            )}
          </div>
          <div className="push-toast-rich-name">
            <span className="push-toast-eyebrow">Buy Signal</span>
            <span className="push-toast-coin-pair">{coin} / USD</span>
          </div>
          {data?.price != null && (
            <span className="push-toast-coin-price">
              ${data.price.toLocaleString(undefined, { maximumFractionDigits: data.price < 1 ? 6 : 2 })}
            </span>
          )}
        </div>
        <div className="push-toast-signals">
          {data!.signals!.map((s) => (
            <div key={s.id} className="push-toast-signal-row">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      </div>,
      document.body
    );
  }

  return ReactDOM.createPortal(
    <div className={`push-toast${isBuySignal ? " push-toast--buy-signal" : ""}`} onClick={handleTap} role="alert">
      {data?.type === "coin_mention" ? (
        <Avatar url={data.avatarUrl} fallback={initials(data.username ?? "?")} className="push-toast-avatar" />
      ) : isBuySignal ? (
        <div className="push-toast-icon push-toast-icon--buy-signal">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 17l6-6 4 4 8-8" />
            <path d="M15 7h6v6" />
          </svg>
        </div>
      ) : (
        <div className="push-toast-icon">🔔</div>
      )}
      <div className="push-toast-body">
        {isBuySignal && <span className="push-toast-eyebrow">Buy Signal</span>}
        <strong>{toast.title}</strong>
        <span>{toast.body}</span>
      </div>
      <button className="push-toast-close" onClick={(e) => { e.stopPropagation(); setToast(null); }}>✕</button>
    </div>,
    document.body
  );
}
