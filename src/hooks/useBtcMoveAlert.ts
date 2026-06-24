import { useEffect, useRef, useState } from "react";
import { coinglass } from "../services/coinglass";

export interface BtcMoveAlert {
  id: number;
  direction: "up" | "down";
  price: number;
  change: number;
}

const THRESHOLD = 10;
const POLL_MS = 10_000;

export function useBtcMoveAlert() {
  const [alert, setAlert] = useState<BtcMoveAlert | null>(null);
  const anchorRef = useRef<number | null>(null);

  useEffect(() => {
    const poll = async () => {
      const candle = await coinglass.getLiveSecondCandle("BTC");
      if (!candle) return;
      const price = candle.close;

      if (anchorRef.current === null) {
        anchorRef.current = price;
        return;
      }

      const diff = price - anchorRef.current;
      if (Math.abs(diff) >= THRESHOLD) {
        anchorRef.current = price;
        setAlert({ id: Date.now(), direction: diff > 0 ? "up" : "down", price, change: Math.abs(diff) });
      }
    };

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const dismiss = () => setAlert(null);

  return { alert, dismiss };
}
