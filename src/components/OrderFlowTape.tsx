import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface Trade {
  id: number;
  price: number;
  qty: number;
  usd: number;
  isBuy: boolean;
  time: number;
}

interface Props { coin: string; }

const MAX = 150;
const BIG_TRADE_THRESHOLD = 50_000; // USD

export function OrderFlowTape({ coin }: Props) {
  const { t } = useTranslation();
  const [trades, setTrades]   = useState<Trade[]>([]);
  const [buyVol, setBuyVol]   = useState(0);
  const [sellVol, setSellVol] = useState(0);
  const [delta, setDelta]     = useState(0);
  const [connected, setConnected] = useState(false);
  const pendingRef = useRef<Trade[]>([]);
  const rafRef     = useRef(0);
  const listRef    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTrades([]); setBuyVol(0); setSellVol(0); setDelta(0);
    setConnected(false);

    const krakenSymbol = `${coin.toUpperCase()}/USD`;
    let ws: WebSocket;
    let dead = false;
    let retryTimer = 0;
    let tradeCounter = 0;

    const connect = () => {
      if (dead) return;
      ws = new WebSocket("wss://ws.kraken.com/v2");
      ws.onopen = () => {
        ws.send(JSON.stringify({
          method: "subscribe",
          params: { channel: "trade", symbol: [krakenSymbol] },
        }));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!dead) retryTimer = window.setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.channel !== "trade") return;
        setConnected(true);
        for (const t of (msg.data ?? [])) {
          pendingRef.current.push({
            id: tradeCounter++,
            price: t.price,
            qty: t.qty,
            usd: t.price * t.qty,
            isBuy: t.side === "buy",
            time: new Date(t.timestamp).getTime(),
          });
        }
      };
    };

    connect();

    const flush = () => {
      if (pendingRef.current.length > 0) {
        const batch = pendingRef.current.splice(0);
        setTrades(prev => [...prev, ...batch].slice(-MAX));
        setBuyVol(prev => prev + batch.filter(t => t.isBuy).reduce((s, t) => s + t.usd, 0));
        setSellVol(prev => prev + batch.filter(t => !t.isBuy).reduce((s, t) => s + t.usd, 0));
        setDelta(prev => prev + batch.reduce((s, t) => s + (t.isBuy ? t.usd : -t.usd), 0));
      }
      rafRef.current = requestAnimationFrame(flush);
    };
    rafRef.current = requestAnimationFrame(flush);

    return () => {
      dead = true;
      clearTimeout(retryTimer);
      cancelAnimationFrame(rafRef.current);
      ws?.close();
    };
  }, [coin]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [trades.length]);

  const total   = buyVol + sellVol;
  const buyPct  = total > 0 ? (buyVol / total) * 100 : 50;
  const fmtUsd  = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
                              : n >= 1_000     ? `$${(n / 1_000).toFixed(1)}K`
                              : `$${n.toFixed(0)}`;
  const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="oft-root">
      <div className="oft-status">
        <span className={`oft-dot ${connected ? 'oft-dot--live' : ''}`} />
        {connected ? t("orderFlowTape.live") : t("orderFlowTape.connecting")}
      </div>

      <div className="oft-stats">
        <div className="oft-stat">
          <span className="oft-stat-lbl">{t("orderFlowTape.buyVolume")}</span>
          <span className="oft-stat-val oft-buy">{fmtUsd(buyVol)}</span>
        </div>
        <div className="oft-stat">
          <span className="oft-stat-lbl">{t("orderFlowTape.sellVolume")}</span>
          <span className="oft-stat-val oft-sell">{fmtUsd(sellVol)}</span>
        </div>
        <div className="oft-stat">
          <span className="oft-stat-lbl">{t("orderFlowTape.delta")}</span>
          <span className={`oft-stat-val ${delta >= 0 ? 'oft-buy' : 'oft-sell'}`}>
            {delta >= 0 ? '+' : ''}{fmtUsd(Math.abs(delta))}
          </span>
        </div>
      </div>

      <div className="oft-pressure-wrap">
        <div className="oft-pressure-bar">
          <div className="oft-pressure-buy" style={{ width: `${buyPct}%` }} />
        </div>
        <div className="oft-pressure-labels">
          <span className="oft-buy">{buyPct.toFixed(1)}{t("orderFlowTape.buy")}</span>
          <span className="oft-sell">{(100 - buyPct).toFixed(1)}{t("orderFlowTape.sell")}</span>
        </div>
      </div>

      <div className="oft-tape-header">
        <span>{t("orderFlowTape.colPrice")}</span><span>{t("orderFlowTape.colSize")}</span><span>{t("orderFlowTape.colSide")}</span><span>{t("orderFlowTape.colTime")}</span>
      </div>
      <div className="oft-tape" ref={listRef}>
        {[...trades].reverse().map(trade => (
          <div key={trade.id} className={`oft-row${trade.usd >= BIG_TRADE_THRESHOLD ? ' oft-row--big' : ''} ${trade.isBuy ? 'oft-row--buy' : 'oft-row--sell'}`}>
            <span className="oft-col-price">{trade.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            <span className="oft-col-size">{fmtUsd(trade.usd)}</span>
            <span className={`oft-col-side ${trade.isBuy ? 'oft-buy' : 'oft-sell'}`}>{trade.isBuy ? t("orderFlowTape.sideBuy") : t("orderFlowTape.sideSell")}</span>
            <span className="oft-col-time">{fmtTime(trade.time)}</span>
          </div>
        ))}
        {trades.length === 0 && <div className="oft-empty">{t("orderFlowTape.waiting")}</div>}
      </div>
    </div>
  );
}
