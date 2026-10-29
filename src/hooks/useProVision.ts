import { useCallback, useEffect, useState } from "react";

// Pro Vision on/off — one app-wide switch (top-bar toggle ↔ Trade chart),
// remembered across reloads. A window event keeps every user of the hook in
// sync without a context provider.
const KEY = "proVision:v1";
const EVT = "provision-change";

function read(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function useProVision(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(read);
  useEffect(() => {
    const sync = () => setOn(read());
    window.addEventListener(EVT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    try { localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* ignore */ }
    setOn(next);
    window.dispatchEvent(new Event(EVT));
  }, []);
  return [on, set];
}
