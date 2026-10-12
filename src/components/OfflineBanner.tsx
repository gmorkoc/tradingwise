import { useEffect, useState } from "react";
import "../styles/OfflineBanner.css";

// Plain browser online/offline events — these fire correctly in a
// Capacitor WKWebView too (standard Web API, no native plugin needed).
// Mounted once, unconditionally, at the top of App.tsx so it's visible
// above literally everything else (modals, sheets, the chart) regardless
// of what page/state the rest of the app is in.
export function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);
  // Keeps the banner up for a moment after reconnecting ("Back online")
  // instead of just silently vanishing — confirms the connection actually
  // came back rather than leaving the user to guess.
  const [justReconnected, setJustReconnected] = useState(false);

  useEffect(() => {
    let reconnectTimer: number | undefined;
    const goOnline = () => {
      setOnline(true);
      setJustReconnected(true);
      reconnectTimer = window.setTimeout(() => setJustReconnected(false), 2500);
    };
    const goOffline = () => {
      window.clearTimeout(reconnectTimer);
      setJustReconnected(false);
      setOnline(false);
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.clearTimeout(reconnectTimer);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online && !justReconnected) return null;

  return (
    <div className={`offline-banner${online ? " offline-banner--back" : ""}`} role="status">
      {online ? "Back online" : "No internet connection"}
    </div>
  );
}
