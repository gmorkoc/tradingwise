import { useEffect, useRef } from "react";

// A backgrounded/inactive browser tab left open all day was silently
// burning through a shared API quota via plain setInterval polling — this
// pauses the interval entirely while the tab is hidden and refreshes
// immediately on regaining focus, instead of polling unconditionally.
export function usePollWhileVisible(fn: () => void, intervalMs: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let id: number | null = null;

    const start = () => {
      if (id != null) return;
      id = window.setInterval(() => fnRef.current(), intervalMs);
    };
    const stop = () => {
      if (id != null) { window.clearInterval(id); id = null; }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        fnRef.current();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
}
