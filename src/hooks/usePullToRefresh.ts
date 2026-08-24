import { useEffect, useRef, useState } from "react";

const PULL_THRESHOLD = 70; // px pulled before a release triggers refresh
const MAX_PULL = 100;      // visual cap on how far the indicator can be dragged
const RESISTANCE = 0.5;    // finger moves 1px, indicator moves RESISTANCE px

interface Options {
  /** Set false to skip attaching listeners entirely (e.g. non-native platforms). */
  enabled?: boolean;
}

export function usePullToRefresh(
  containerRef: React.RefObject<HTMLElement | null>,
  onRefresh: () => Promise<unknown> | void,
  { enabled = true }: Options = {},
) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [dragging, setDragging] = useState(false);

  const pullDistanceRef = useRef(0);
  const startYRef = useRef<number | null>(null);
  const pullingRef = useRef(false);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const setPull = (v: number) => {
    pullDistanceRef.current = v;
    setPullDistance(v);
  };

  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (refreshingRef.current) return;
      if (el.scrollTop > 0) {
        pullingRef.current = false;
        return;
      }
      startYRef.current = e.touches[0].clientY;
      pullingRef.current = true;
      setDragging(true);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pullingRef.current || startYRef.current === null) return;
      const delta = e.touches[0].clientY - startYRef.current;
      if (delta <= 0 || el.scrollTop > 0) {
        pullingRef.current = false;
        setDragging(false);
        setPull(0);
        return;
      }
      e.preventDefault();
      setPull(Math.min(delta * RESISTANCE, MAX_PULL));
    };

    const onTouchEnd = () => {
      if (!pullingRef.current) return;
      pullingRef.current = false;
      startYRef.current = null;
      setDragging(false);
      if (pullDistanceRef.current >= PULL_THRESHOLD) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPull(PULL_THRESHOLD);
        Promise.resolve(onRefreshRef.current()).finally(() => {
          refreshingRef.current = false;
          setRefreshing(false);
          setPull(0);
        });
      } else {
        setPull(0);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [containerRef, enabled]);

  return {
    pullDistance,
    progress: Math.min(pullDistance / PULL_THRESHOLD, 1),
    refreshing,
    dragging,
  };
}
