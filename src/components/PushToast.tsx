import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { Browser } from "@capacitor/browser";
import "../styles/PushToast.css";

interface PushToastDetail {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

const DURATION = 6000;

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

  const handleTap = () => {
    const data = toast.data as { type?: string; url?: string } | undefined;
    if (data?.type === "daily_brief" && data.url) {
      Browser.open({ url: data.url });
    } else if (data?.type === "upgrade_reminder") {
      window.dispatchEvent(new CustomEvent("open-upgrade-modal"));
    }
    setToast(null);
  };

  return ReactDOM.createPortal(
    <div className="push-toast" onClick={handleTap} role="alert">
      <div className="push-toast-icon">🔔</div>
      <div className="push-toast-body">
        <strong>{toast.title}</strong>
        <span>{toast.body}</span>
      </div>
      <button className="push-toast-close" onClick={(e) => { e.stopPropagation(); setToast(null); }}>✕</button>
    </div>,
    document.body
  );
}
