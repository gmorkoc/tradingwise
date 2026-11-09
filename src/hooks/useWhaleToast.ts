// Whale transfers shown in the price toast (one at a time, queued).
import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeWhaleAlerts, type WhaleTx } from "../services/whaleAlerts";
import { coinglass } from "../services/coinglass";

export interface WhaleToastAlert {
  kind: "whale";
  id: number;
  amount: number; // BTC
  usd: number | null;
  from: string;
  to: string;
  sentiment: WhaleTx["sentiment"];
  hash: string;
}

const MAX_QUEUE = 5;

/** `enabled` = global alerts on AND the Whale Activity switch on. */
export function useWhaleToast(enabled: boolean) {
  const [alert, setAlert] = useState<WhaleToastAlert | null>(null);
  const queueRef = useRef<WhaleToastAlert[]>([]);
  const showingRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Switched off: drop what's showing and anything waiting.
  useEffect(() => {
    if (!enabled) { queueRef.current = []; showingRef.current = false; setAlert(null); }
  }, [enabled]);

  useEffect(() => subscribeWhaleAlerts(async (tx) => {
    if (!enabledRef.current) return;
    // USD value at BTC's live price (the page's own coin may not be BTC).
    const p = (await coinglass.getLiveSecondCandle("BTC").catch(() => null))?.close;
    if (!enabledRef.current) return;
    const next: WhaleToastAlert = {
      kind: "whale",
      id: Date.now() + Math.random(),
      amount: tx.amount,
      usd: p && p > 0 ? tx.amount * p : null,
      from: tx.from,
      to: tx.to,
      sentiment: tx.sentiment,
      hash: tx.hash,
    };
    if (showingRef.current) {
      queueRef.current = [...queueRef.current, next].slice(-MAX_QUEUE);
      return;
    }
    showingRef.current = true;
    setAlert(next);
  }), []);

  const dismiss = useCallback(() => {
    const next = queueRef.current.shift() ?? null;
    showingRef.current = !!next;
    setAlert(next);
  }, []);

  return { alert, dismiss };
}
