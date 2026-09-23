import { useEffect, useRef, useState } from "react";
import { coinglass, CoinSymbol } from "../services/coinglass";

export interface BtcMoveAlert {
  id: number;
  coin: CoinSymbol;
  direction: "up" | "down";
  price: number;
  change: number;
  changePct: number;
}

// Percentage move, not a fixed dollar amount — a flat $50 threshold meant
// this fired on ~0.06% wiggles at BTC's price level and would've been even
// noisier on lower-priced coins. 1% keeps it to moves actually worth a toast.
const PCT_THRESHOLD = 1;
const POLL_MS = 10_000;

export function useBtcMoveAlert(coin: CoinSymbol) {
  const [alert, setAlert] = useState<BtcMoveAlert | null>(null);
  const anchorRef = useRef<number | null>(null);

  useEffect(() => {
    // Re-anchor on every coin switch so a stale price from the previous
    // coin never gets diffed against the new one's price.
    anchorRef.current = null;
    setAlert(null);

    const poll = async () => {
      const candle = await coinglass.getLiveSecondCandle(coin);
      if (!candle) return;
      const price = candle.close;

      if (anchorRef.current === null) {
        anchorRef.current = price;
        return;
      }

      const diff = price - anchorRef.current;
      const pct = (Math.abs(diff) / anchorRef.current) * 100;
      if (pct >= PCT_THRESHOLD) {
        anchorRef.current = price;
        setAlert({ id: Date.now(), coin, direction: diff > 0 ? "up" : "down", price, change: Math.abs(diff), changePct: pct });
      }
    };

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [coin]);

  const dismiss = () => setAlert(null);

  return { alert, dismiss };
}
