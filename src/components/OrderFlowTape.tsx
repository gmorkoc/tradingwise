import { useEffect, useRef, useState } from "react";

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

    const symbol = `${coin.toLowerCase()}usdt`;
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@aggTrade`);

    ws.onopen  = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      const price = parseFloat(d.p);
      const qty   = parseFloat(d.q);
      pendingRef.current.push({
        id: d.a, price, qty, usd: price * qty,
        isBuy: !d.m, time: d.T,
      });
    };

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

    return () => { cancelAnimationFrame(rafRef.current); ws.close(); };
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
        {connected ? 'LIVE' : 'Connecting...'}
      </div>

      <div className="oft-stats">
        <div className="oft-stat">
          <span className="oft-stat-lbl">Buy Volume</span>
          <span className="oft-stat-val oft-buy">{fmtUsd(buyVol)}</span>
        </div>
        <div className="oft-stat">
          <span className="oft-stat-lbl">Sell Volume</span>
          <span className="oft-stat-val oft-sell">{fmtUsd(sellVol)}</span>
        </div>
        <div className="oft-stat">
          <span className="oft-stat-lbl">Cumulative Delta</span>
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
          <span className="oft-buy">{buyPct.toFixed(1)}% Buy</span>
          <span className="oft-sell">{(100 - buyPct).toFixed(1)}% Sell</span>
        </div>
      </div>

      <div className="oft-tape-header">
        <span>Price</span><span>Size (USD)</span><span>Side</span><span>Time</span>
      </div>
      <div className="oft-tape" ref={listRef}>
        {[...trades].reverse().map(t => (
          <div key={t.id} className={`oft-row${t.usd >= BIG_TRADE_THRESHOLD ? ' oft-row--big' : ''} ${t.isBuy ? 'oft-row--buy' : 'oft-row--sell'}`}>
            <span className="oft-col-price">{t.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            <span className="oft-col-size">{fmtUsd(t.usd)}</span>
            <span className={`oft-col-side ${t.isBuy ? 'oft-buy' : 'oft-sell'}`}>{t.isBuy ? '▲ BUY' : '▼ SELL'}</span>
            <span className="oft-col-time">{fmtTime(t.time)}</span>
          </div>
        ))}
        {trades.length === 0 && <div className="oft-empty">Waiting for trades...</div>}
      </div>
    </div>
  );
}
