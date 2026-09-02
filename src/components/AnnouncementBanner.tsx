import { useState } from "react";
import "../styles/AnnouncementBanner.css";

interface Props {
  storageKey: string;
  icon?: string;
  message: string;
}

// A one-time, locally-dismissible announcement — never sent, never
// auto-triggers a push notification. Shows once per device until closed.
export function AnnouncementBanner({ storageKey, icon = "✨", message }: Props) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(storageKey) === "true");
  if (dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(storageKey, "true");
    setDismissed(true);
  };

  return (
    <div className="announce-banner">
      <span className="announce-banner-icon">{icon}</span>
      <span className="announce-banner-text">{message}</span>
      <button type="button" className="announce-banner-close" onClick={dismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}
