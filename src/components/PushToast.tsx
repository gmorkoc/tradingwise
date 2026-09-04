import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { Browser } from "@capacitor/browser";
import { Avatar } from "./Avatar";
import "../styles/PushToast.css";

interface PushToastData {
  type?: string;
  url?: string;
  coin?: string;
  commentId?: string;
  avatarUrl?: string;
  username?: string;
  strategyId?: string;
}

interface PushToastDetail {
  title: string;
  body: string;
  data?: PushToastData;
}

const DURATION = 6000;

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

// Rendered once at the app root. pushNotifications.ts dispatches
// "push-toast" for any push received while the app is in the foreground
// (the OS banner is suppressed for those — see capacitor.config.ts) so the
// user still sees something, just in-app instead of a system banner.
export function PushToast() {
  const [toast, setToast] = useState<PushToastDetail | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onPush = (e: Event) => {
      const detail = (e as CustomEvent<PushToastDetail>).detail;
      setToast(detail);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setToast(null), DURATION);
    };
    window.addEventListener("push-toast", onPush);
    return () => window.removeEventListener("push-toast", onPush);
  }, []);

  if (!toast) return null;

  const data = toast.data;

  const handleTap = () => {
    if (data?.type === "daily_brief" && data.url) {
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
    }
    setToast(null);
  };

  return ReactDOM.createPortal(
    <div className="push-toast" onClick={handleTap} role="alert">
      {data?.type === "coin_mention" ? (
        <Avatar url={data.avatarUrl} fallback={initials(data.username ?? "?")} className="push-toast-avatar" />
      ) : (
        <div className="push-toast-icon">🔔</div>
      )}
      <div className="push-toast-body">
        <strong>{toast.title}</strong>
        <span>{toast.body}</span>
      </div>
      <button className="push-toast-close" onClick={(e) => { e.stopPropagation(); setToast(null); }}>✕</button>
    </div>,
    document.body
  );
}
