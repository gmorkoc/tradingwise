import { useCallback, useEffect, useState } from "react";

const KEY = "notificationsEnabled";
const EVENT = "notifications-enabled-change";

export function getNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

function setStoredNotificationsEnabled(enabled: boolean) {
  try {
    localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    /* quota */
  }
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: enabled }));
}

// Shared across every notification source (whale alerts, price alerts, big
// BTC move toasts) so one switch in the header can silence all of them,
// even though each lives in its own component tree.
export function useNotificationsEnabled(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(getNotificationsEnabled);

  useEffect(() => {
    const onChange = (e: Event) => setEnabled((e as CustomEvent<boolean>).detail);
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);

  const update = useCallback((next: boolean) => {
    setStoredNotificationsEnabled(next);
    setEnabled(next);
  }, []);

  return [enabled, update];
}
