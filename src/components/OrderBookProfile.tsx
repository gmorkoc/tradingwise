import { useRef, useEffect, useCallback, useState } from "react";
import { CoinSymbol } from "../services/coinglass";
import "../styles/OrderBookProfile.css";

interface Level { price: number; size: number; }

interface Props {
  coin:    CoinSymbol;
  onClose: () => void;
}

const BINANCE_SYM: Record<string, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", XRP: "XRPUSDT", SOL: "SOLUSDT",
  DOGE: "DOGEUSDT", ADA: "ADAUSDT", SUI: "SUIUSDT", BNB: "BNBUSDT",
};

const DEPTH_LEVELS = [50, 100, 500, 1000] as const;

async function fetchDepth(coin: string, limit: number) {
  const sym = BINANCE_SYM[coin] ?? `${coin}USDT`;
  const res = await fetch(
    `/bn-api/api/v3/depth?symbol=${sym}&limit=${limit}`
  );
  if (!res.ok) throw new Error();
  const d = await res.json();
  const parse = (raw: string[][]): Level[] =>
    raw.map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }));
  return {
    bids: parse([...d.bids].sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))),
    asks: parse([...d.asks].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))),
  };
}

function fmtPrice(p: number) {
  if (p >= 10000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1000)  return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1)     return p.toFixed(3);
  return p.toFixed(5);
}

function fmtVol(s: number) {
  if (s >= 1_000_000) return (s / 1_000_000).toFixed(2) + "M";
  if (s >= 1_000)     return (s / 1_000).toFixed(1) + "K";
  return s.toFixed(1);
}

function fmtUsd(v: number) {
  if (v >= 1_000_000_000) return "$" + (v / 1_000_000_000).toFixed(2) + "B";
  if (v >= 1_000_000)     return "$" + (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000)         return "$" + (v / 1_000).toFixed(0) + "K";
  return "$" + v.toFixed(0);
}

function drawChart(
  ctx: CanvasRenderingContext2D,
  logW: number, logH: number,
  bids: Level[], asks: Level[],
  isDark: boolean,
) {
  // Background
  ctx.fillStyle = isDark ? "#060d1a" : "#f0f4f8";
  ctx.fillRect(0, 0, logW, logH);

  if (!bids.length || !asks.length) {
    ctx.fillStyle = isDark ? "#334155" : "#94a3b8";
    ctx.font = "13px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Fetching depth data…", logW / 2, logH / 2);
    return;
  }

  const PAD = { top: 36, right: 52, bottom: 50, left: 16 };
  const cW = logW - PAD.left - PAD.right;
  const cH = logH - PAD.top  - PAD.bottom;
  const cB = PAD.top + cH;

  if (cW <= 0 || cH <= 0) return;

  // Build cumulative points
  let bidCum = 0;
  const bidPts: { price: number; cum: number }[] = [];
  for (const b of bids) { bidCum += b.size; bidPts.push({ price: b.price, cum: bidCum }); }

  let askCum = 0;
  const askPts: { price: number; cum: number }[] = [];
  for (const a of asks) { askCum += a.size; askPts.push({ price: a.price, cum: askCum }); }

  const minPrice = bids[bids.length - 1].price;
  const maxPrice = asks[asks.length - 1].price;
  const maxCum   = Math.max(bidCum, askCum);
  const midPrice = (bids[0].price + asks[0].price) / 2;

  if (minPrice >= maxPrice || maxCum === 0) return;

  const pToX = (p: number) => PAD.left + ((p - minPrice) / (maxPrice - minPrice)) * cW;
  const cToY = (c: number) => cB - (c / maxCum) * cH;
  const midX  = pToX(midPrice);

  // ── Grid ────────────────────────────────────────────────────────────────
  ctx.setLineDash([2, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = isDark ? "rgba(30,41,59,0.9)" : "rgba(203,213,225,0.9)";
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const y = cB - frac * cH;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
  }
  ctx.setLineDash([]);

  // ── Clip to chart area ────────────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD.left, PAD.top, cW, cH + 1);
  ctx.clip();

  // ── Bid area ─────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(midX, cB);
  let prev = 0;
  for (const pt of bidPts) {
    ctx.lineTo(pToX(pt.price), cToY(prev));
    ctx.lineTo(pToX(pt.price), cToY(pt.cum));
    prev = pt.cum;
  }
  ctx.lineTo(pToX(bids[bids.length - 1].price), cB);
  ctx.closePath();

  const bidGrad = ctx.createLinearGradient(0, PAD.top, 0, cB);
  bidGrad.addColorStop(0, isDark ? "rgba(34,197,94,0.38)" : "rgba(34,197,94,0.28)");
  bidGrad.addColorStop(1, isDark ? "rgba(34,197,94,0.04)" : "rgba(34,197,94,0.02)");
  ctx.fillStyle = bidGrad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(midX, cB);
  prev = 0;
  for (const pt of bidPts) {
    ctx.lineTo(pToX(pt.price), cToY(prev));
    ctx.lineTo(pToX(pt.price), cToY(pt.cum));
    prev = pt.cum;
  }
  ctx.strokeStyle = isDark ? "rgba(34,197,94,0.85)" : "rgba(21,128,61,0.85)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // ── Ask area ─────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(midX, cB);
  prev = 0;
  for (const pt of askPts) {
    ctx.lineTo(pToX(pt.price), cToY(prev));
    ctx.lineTo(pToX(pt.price), cToY(pt.cum));
    prev = pt.cum;
  }
  ctx.lineTo(pToX(asks[asks.length - 1].price), cB);
  ctx.closePath();

  const askGrad = ctx.createLinearGradient(0, PAD.top, 0, cB);
  askGrad.addColorStop(0, isDark ? "rgba(239,68,68,0.38)" : "rgba(239,68,68,0.28)");
  askGrad.addColorStop(1, isDark ? "rgba(239,68,68,0.04)" : "rgba(239,68,68,0.02)");
  ctx.fillStyle = askGrad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(midX, cB);
  prev = 0;
  for (const pt of askPts) {
    ctx.lineTo(pToX(pt.price), cToY(prev));
    ctx.lineTo(pToX(pt.price), cToY(pt.cum));
    prev = pt.cum;
  }
  ctx.strokeStyle = isDark ? "rgba(239,68,68,0.85)" : "rgba(185,28,28,0.85)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore(); // remove clip

  // ── Mid-price vertical dashed line ────────────────────────────────────
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = isDark ? "rgba(148,163,184,0.45)" : "rgba(100,116,139,0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(midX, PAD.top); ctx.lineTo(midX, cB); ctx.stroke();
  ctx.setLineDash([]);

  // ── Mid-price label (top) ─────────────────────────────────────────────
  const midTxt = fmtPrice(midPrice);
  const mw = ctx.measureText(midTxt).width + 12;
  const mx = Math.min(Math.max(midX - mw / 2, PAD.left), PAD.left + cW - mw);
  ctx.fillStyle = isDark ? "rgba(15,23,42,0.88)" : "rgba(241,245,249,0.92)";
  ctx.beginPath();
  ctx.roundRect(mx, 4, mw, 24, 4);
  ctx.fill();
  ctx.fillStyle = isDark ? "#e2e8f0" : "#1e293b";
  ctx.font = "bold 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(midTxt, midX, 16);

  // ── X-axis price labels ───────────────────────────────────────────────
  ctx.fillStyle = isDark ? "#475569" : "#94a3b8";
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const TICKS = 6;
  for (let i = 0; i <= TICKS; i++) {
    const p = minPrice + (i / TICKS) * (maxPrice - minPrice);
    const x = pToX(p);
    ctx.fillText(fmtPrice(p), x, cB + 7);
    ctx.strokeStyle = isDark ? "rgba(30,41,59,0.8)" : "rgba(203,213,225,0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, cB); ctx.lineTo(x, cB + 4); ctx.stroke();
  }

  // ── Y-axis volume labels (right side) ─────────────────────────────────
  ctx.fillStyle = isDark ? "#475569" : "#94a3b8";
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const y = cB - frac * cH;
    ctx.fillText(fmtVol(frac * maxCum), PAD.left + cW + 4, y);
  }

  // ── Axis baseline ─────────────────────────────────────────────────────
  ctx.strokeStyle = isDark ? "#1e293b" : "#e2e8f0";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.left, cB);
  ctx.lineTo(PAD.left + cW, cB);
  ctx.stroke();
}

export function OrderBookProfileModal({ coin, onClose }: Props) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const bidsRef    = useRef<Level[]>([]);
  const asksRef    = useRef<Level[]>([]);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  const [stats, setStats] = useState<{
    bidUsd: number; askUsd: number; spread: number; spreadPct: number;
  } | null>(null);
  const [depthLimit, setDepthLimit] = useState<number>(100);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr  = window.devicePixelRatio || 1;
    const logW = canvas.offsetWidth;
    const logH = canvas.offsetHeight;
    if (!logW || !logH) return;
    if (canvas.width  !== Math.round(logW * dpr) ||
        canvas.height !== Math.round(logH * dpr)) {
      canvas.width  = Math.round(logW * dpr);
      canvas.height = Math.round(logH * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const isDark = document.documentElement.dataset.theme !== "light";
    drawChart(ctx, logW, logH, bidsRef.current, asksRef.current, isDark);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    const id = setInterval(draw, 100);
    return () => clearInterval(id);
  }, [draw]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const book = await fetchDepth(coin, depthLimit);
        if (cancelled) return;
        bidsRef.current = book.bids;
        asksRef.current = book.asks;
        const bidUsd = book.bids.reduce((s, l) => s + l.price * l.size, 0);
        const askUsd = book.asks.reduce((s, l) => s + l.price * l.size, 0);
        const spread = (book.asks[0]?.price ?? 0) - (book.bids[0]?.price ?? 0);
        const mid    = ((book.asks[0]?.price ?? 0) + (book.bids[0]?.price ?? 0)) / 2;
        setStats({ bidUsd, askUsd, spread, spreadPct: mid ? (spread / mid) * 100 : 0 });
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [coin, depthLimit]);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      window.removeEventListener("keydown", onKeyDown);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  const bidRatio = stats ? (stats.bidUsd / (stats.bidUsd + stats.askUsd)) * 100 : 50;

  return (
    <div className="obp-backdrop" onClick={onClose}>
      <div className="obp-panel" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="obp-header">
          <div className="obp-header-left">
            <span className="obp-title">Order Depth Chart</span>
            <span className="obp-coin">{coin}/USDT</span>
          </div>
          <div className="obp-levels" title="Number of bid/ask price levels pulled from the order book per side — higher values show a wider price range">
            <span className="obp-levels-label">Levels</span>
            {DEPTH_LEVELS.map(lvl => (
              <button
                key={lvl}
                className={`obp-level-btn${lvl === depthLimit ? " obp-level-btn--active" : ""}`}
                onClick={() => setDepthLimit(lvl)}
              >
                {lvl}
              </button>
            ))}
          </div>
          <button className="obp-exit" onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3"/>
            </svg>
            <span className="obp-exit-label">Exit</span>
          </button>
        </div>

        {/* Stats strip */}
        {stats && (
          <div className="obp-stats">
            <div className="obp-stat">
              <span className="obp-stat-label">Bid Depth</span>
              <span className="obp-stat-value obp-stat-value--bid">{fmtUsd(stats.bidUsd)}</span>
            </div>
            <div className="obp-stat">
              <span className="obp-stat-label">Ask Depth</span>
              <span className="obp-stat-value obp-stat-value--ask">{fmtUsd(stats.askUsd)}</span>
            </div>
            <div className="obp-stat">
              <span className="obp-stat-label">Spread</span>
              <span className="obp-stat-value">{fmtPrice(stats.spread)} <em>({stats.spreadPct.toFixed(3)}%)</em></span>
            </div>
            <div className="obp-stat obp-stat--ratio">
              <span className="obp-stat-label">Bid / Ask</span>
              <div className="obp-ratio-bar">
                <div className="obp-ratio-bid" style={{ width: `${bidRatio}%` }} />
                <div className="obp-ratio-ask" style={{ width: `${100 - bidRatio}%` }} />
              </div>
              <span className="obp-ratio-pct obp-stat-value--bid">{bidRatio.toFixed(0)}%</span>
              <span className="obp-ratio-sep">/</span>
              <span className="obp-ratio-pct obp-stat-value--ask">{(100 - bidRatio).toFixed(0)}%</span>
            </div>
          </div>
        )}

        {/* Depth canvas */}
        <canvas ref={canvasRef} className="obp-canvas" />

        {/* Legend */}
        <div className="obp-footer">
          <span className="obp-legend-bid">■ Bids (cumulative)</span>
          <span className="obp-legend-ask">■ Asks (cumulative)</span>
          <span className="obp-legend-src">Binance · live</span>
        </div>
      </div>
    </div>
  );
}
