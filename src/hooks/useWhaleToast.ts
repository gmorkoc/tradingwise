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
// ✕ on a whale alert: no more whale alerts for an hour (this device).
const SNOOZE_KEY = "whale-snoozed-until";
const SNOOZE_MS = 60 * 60 * 1000;
const snoozedNow = () => {
  try { return Date.now() < Number(localStorage.getItem(SNOOZE_KEY) ?? 0); } catch { return false; }
};

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
    if (!enabledRef.current || snoozedNow()) return;
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

  // Local dev only: fake whale alerts for checking the banner.
  //   open  http://localhost:5173/?fakewhale   (10 whales, one every 4s)
  //   open  http://localhost:5173/?fakealerts  (in-app notification banners
  //         alternating with whales, every 8s)
  //   or in the console: fakeWhale(count, gapMs)
  // A phone test build made with VITE_FAKE_NOTIFS=1 runs them on launch,
  // alternating with fake price-alert banners. Skips the sign-in / switch /
  // snooze checks; never in normal production builds.
  useEffect(() => {
    const fakeBuild = import.meta.env.VITE_FAKE_NOTIFS === "1";
    if (!import.meta.env.DEV && !fakeBuild) return;
    const FROM = ["Binance", "Coinbase", "Unknown", "Kraken", "OKX", "Bitfinex"];
    const TO = ["Unknown", "Binance", "Cold wallet", "Coinbase", "Kraken"];
    const SENT: WhaleTx["sentiment"][] = ["bullish", "bearish", "neutral"];
    const timers: number[] = [];
    const push = (i: number) => {
      const amount = Math.round((50 + Math.random() * 950) * 10) / 10;
      const next: WhaleToastAlert = {
        kind: "whale",
        id: Date.now() + Math.random(),
        amount,
        usd: amount * 74000,
        from: FROM[i % FROM.length],
        to: TO[(i * 3) % TO.length],
        sentiment: SENT[i % SENT.length],
        hash: `fake-${i}`,
      };
      if (showingRef.current) { queueRef.current = [...queueRef.current, next].slice(-MAX_QUEUE); return; }
      showingRef.current = true;
      setAlert(next);
    };
    const run = (count = 10, gapMs = 4000) => {
      for (let i = 0; i < count; i++) timers.push(window.setTimeout(() => push(i), i * gapMs));
      return `queued ${count} fake whales, one every ${gapMs}ms`;
    };
    (window as unknown as { fakeWhale?: typeof run }).fakeWhale = run;
    if (new URLSearchParams(window.location.search).has("fakewhale")) run();
    // Local dev: http://localhost:5173/?fakealerts — the same mix as the
    // phone test build (in-app notification banners alternating with whales).
    if (fakeBuild || new URLSearchParams(window.location.search).has("fakealerts")) {
      // Phone test build: price alerts and whales, alternating every 8s.
      const PRICE = [
        ["BTC price alert", "Bitcoin reached $75,000 — up 1.2% in the last hour"],
        ["ETH price alert", "Ethereum dropped below $2,000"],
        ["SOL price alert", "Solana is up 6.2% in the last hour"],
        ["Strategy alert", "Your RSI < 30 rule fired on BTC 1H — tap to see the chart"],
        ["Daily brief", "Your market brief for today is ready"],
      ];
      for (let i = 0; i < 10; i++) {
        timers.push(window.setTimeout(() => {
          if (i % 2 === 0) {
            const [title, body] = PRICE[(i / 2) % PRICE.length];
            window.dispatchEvent(new CustomEvent("push-toast", { detail: { title, body, data: { type: "test" } } }));
          } else push(i);
        }, 4000 + i * 8000));
      }
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  const dismiss = useCallback(() => {
    const next = queueRef.current.shift() ?? null;
    showingRef.current = !!next;
    setAlert(next);
  }, []);

  /** ✕ pressed: hide it, drop the queue and snooze whale alerts for 1 hour. */
  const snooze = useCallback(() => {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* ignore */ }
    queueRef.current = [];
    showingRef.current = false;
    setAlert(null);
  }, []);

  return { alert, dismiss, snooze };
}
