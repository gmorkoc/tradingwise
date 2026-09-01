import { useEffect, useState } from "react";
import ReactDOM from "react-dom";
import { completePushPriming, dismissPushPriming } from "../services/pushNotifications";
import "../styles/PushPrimingModal.css";

// Explains what notifications are for BEFORE the real OS permission prompt
// appears, instead of that prompt just showing up out of nowhere right
// after sign-in — see pushNotifications.ts's initPushNotifications for why.
export function PushPrimingModal() {
  const [userId, setUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onNeeded = (e: Event) => {
      const detail = (e as CustomEvent<{ userId: string }>).detail;
      setUserId(detail.userId);
    };
    window.addEventListener("push-priming-needed", onNeeded);
    return () => window.removeEventListener("push-priming-needed", onNeeded);
  }, []);

  if (!userId) return null;

  const handleEnable = async () => {
    setBusy(true);
    await completePushPriming(userId);
    setUserId(null);
  };

  const handleSkip = () => {
    dismissPushPriming();
    setUserId(null);
  };

  return ReactDOM.createPortal(
    <div className="push-priming-backdrop" onClick={(e) => { if (e.target === e.currentTarget) handleSkip(); }}>
      <div className="push-priming-card">
        <div className="push-priming-icon">🔔</div>
        <h2 className="push-priming-title">Stay on top of the market</h2>
        <p className="push-priming-body">
          Get notified about your price alerts, breaking crypto news, and big BTC moves — even when the app is closed. You can turn this off anytime.
        </p>
        <button className="push-priming-enable" onClick={handleEnable} disabled={busy}>
          {busy ? "…" : "Enable Notifications"}
        </button>
        <button className="push-priming-skip" onClick={handleSkip} disabled={busy}>
          Not now
        </button>
      </div>
    </div>,
    document.body
  );
}
