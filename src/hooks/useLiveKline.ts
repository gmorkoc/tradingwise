import { useEffect, useRef } from "react";

// Live forming candle for any timeframe, straight from Binance's public
// market-data stream (data-stream.binance.vision — the same no-trading,
// US-accessible family as data-api.binance.vision the charts already load
// history from). Binance pushes the current candle several times a second,
// so the last bar grows in real time instead of waiting for a refresh.
//
// One WebSocket per mounted chart; reconnects with backoff, pauses while
// the tab/app is hidden, and closes on unmount or coin/interval change.

export interface LiveCandle {
  time: number; // candle open time, seconds (same as the charts' candles)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume: number;
}

const WS_BASE = "wss://data-stream.binance.vision/ws";

/** App interval → Binance kline interval (null = no live stream). */
export function binanceKlineInterval(iv: string): string | null {
  switch (iv) {
    case "1sec": return "1s";
    case "1min": return "1m";
    case "5min": return "5m";
    case "15min": return "15m";
    case "1h": return "1h";
    case "4h": return "4h";
    case "6h": return "6h";
    case "1day": return "1d";
    case "1week": return "1w";
    case "1month": return "1M";
    default: return null;
  }
}

/**
 * Calls `onCandle` with the live forming candle (throttled to ~6×/s).
 * `binanceInterval` = e.g. "5m"; pass null to switch the stream off.
 */
export function useLiveKline(coin: string | null, binanceInterval: string | null, onCandle: (c: LiveCandle) => void) {
  const cbRef = useRef(onCandle);
  cbRef.current = onCandle;

  useEffect(() => {
    if (!coin || !binanceInterval) return;
    const stream = `${coin.toLowerCase()}usdt@kline_${binanceInterval}`;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let retryTimer: number | undefined;
    let lastEmit = 0;
    let pending: LiveCandle | null = null;
    let flushTimer: number | undefined;

    const emit = (c: LiveCandle) => {
      const now = Date.now();
      if (now - lastEmit >= 160) {
        lastEmit = now;
        cbRef.current(c);
      } else {
        // Keep only the newest tick; flush it shortly so the last move shows.
        pending = c;
        if (flushTimer === undefined) {
          flushTimer = window.setTimeout(() => {
            flushTimer = undefined;
            if (pending) { lastEmit = Date.now(); cbRef.current(pending); pending = null; }
          }, 160);
        }
      }
    };

    const connect = () => {
      if (closed || document.visibilityState === "hidden") return;
      try {
        ws = new WebSocket(`${WS_BASE}/${stream}`);
      } catch {
        scheduleRetry();
        return;
      }
      ws.onopen = () => { retry = 0; };
      ws.onmessage = (ev) => {
        try {
          const k = JSON.parse(ev.data as string)?.k;
          if (!k) return;
          emit({
            time: Math.floor(Number(k.t) / 1000),
            open: Number(k.o),
            high: Number(k.h),
            low: Number(k.l),
            close: Number(k.c),
            volume: Number(k.v),
            takerBuyVolume: Number(k.V),
          });
        } catch { /* ignore malformed frame */ }
      };
      ws.onclose = () => { ws = null; if (!closed) scheduleRetry(); };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
    };

    const scheduleRetry = () => {
      if (closed) return;
      // 1s, 2s, 4s … capped at 30s. Unknown symbols just keep failing quietly.
      const wait = Math.min(30_000, 1000 * 2 ** retry++);
      retryTimer = window.setTimeout(connect, wait);
    };

    // Don't hold a socket open in the background; reconnect when visible.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        try { ws?.close(); } catch { /* ignore */ }
      } else if (!ws) {
        window.clearTimeout(retryTimer);
        retry = 0;
        connect();
      }
    };

    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearTimeout(retryTimer);
      window.clearTimeout(flushTimer);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [coin, binanceInterval]);
}
