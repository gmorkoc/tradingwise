import { useEffect, useState } from "react";
import {
  getTakerBuySellVol, getExchangeLSData, getPriceLSHistory, getMultiCoinLSSnapshot,
  getAllExchangeTakerVol, getRecentLargeTrades,
  TakerVolData, ExchangeLSData, PriceLSPoint, CoinLSSnapshot,
  ExchangeTakerRow, LargeTradeItem, CoinSymbol, COINS,
} from "../services/coinglass";
import "../styles/PositionFlows.css";

// ── Constants ─────────────────────────────────────────────────────────────────

const INTERVALS = [
  { label: "1 hour",  short: "1H",  cg: "1h", limit: 24 },
  { label: "4 hour",  short: "4H",  cg: "4h", limit: 90 },
  { label: "12 hour", short: "12H", cg: "4h", limit: 180 },
  { label: "24 hour", short: "24H", cg: "1d", limit: 30  },
];

type Sentiment = "Very Bullish" | "Bullish" | "Neutral" | "Bearish" | "Extremely Bearish";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ratioToSentiment(ratio: number): Sentiment {
  if (ratio >= 1.3) return "Bullish";
  if (ratio >= 0.8) return "Neutral";
  if (ratio >= 0.5) return "Bearish";
  return "Extremely Bearish";
}

function smartMoneySentiment(retailRatio: number): Sentiment {
  if (retailRatio >= 1.7) return "Extremely Bearish";
  if (retailRatio >= 1.35) return "Bearish";
  if (retailRatio >= 0.85) return "Neutral";
  if (retailRatio >= 0.6)  return "Bullish";
  return "Very Bullish";
}

function fmtVol(v: number): string {
  if (!v) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${(v / 1e3).toFixed(2)}K`;
}

function fmtPrice(p: number): string {
  if (p >= 1000) return `$${(p / 1000).toFixed(1)}K`;
  if (p >= 1)    return `$${p.toFixed(2)}`;
  return `$${p.toFixed(4)}`;
}

// ── Circle ring ───────────────────────────────────────────────────────────────

function CircleRing({ pct, color, track }: { pct: number; color: string; track: string }) {
  const R = 30, CX = 38, CY = 38, CIRC = 2 * Math.PI * R;
  const dash = (pct / 100) * CIRC;
  return (
    <svg width="76" height="76" viewBox="0 0 76 76" style={{ flexShrink: 0 }}>
      <circle cx={CX} cy={CY} r={R} fill="none" stroke={track} strokeWidth="5" />
      <circle cx={CX} cy={CY} r={R} fill="none" stroke={color} strokeWidth="5"
        strokeDasharray={`${dash.toFixed(2)} ${(CIRC - dash).toFixed(2)}`}
        strokeLinecap="round" transform={`rotate(-90 ${CX} ${CY})`} />
      <text x={CX} y={CY + 4} textAnchor="middle" fill="white" fontSize="11" fontWeight="700"
        fontFamily="system-ui,sans-serif">{pct.toFixed(2)}%</text>
    </svg>
  );
}

// ── Sentiment badge ───────────────────────────────────────────────────────────

function SentimentBadge({ s }: { s: Sentiment }) {
  const cls =
    s === "Very Bullish"       ? "sen--vbull" :
    s === "Bullish"            ? "sen--bull" :
    s === "Neutral"            ? "sen--neutral" :
    s === "Bearish"            ? "sen--bear" :
    /* Extremely Bearish */      "sen--xbear";
  return (
    <span className={`sen-badge ${cls}`}>
      {s === "Extremely Bearish" && <span className="sen-flame">🔥</span>}{s}
    </span>
  );
}

// ── Exchange card ─────────────────────────────────────────────────────────────

function ExchangeCard({ data }: { data: ExchangeLSData }) {
  const smSent: Sentiment = data.retail ? smartMoneySentiment(data.retail.ratio) : "Neutral";
  type Row = { label: string; ratio: number | null; sentiment: Sentiment };
  const rows: Row[] = [
    { label: "Retail",         ratio: data.retail?.ratio       ?? null, sentiment: data.retail       ? ratioToSentiment(data.retail.ratio)       : "Neutral" },
    { label: "Whale Account",  ratio: data.whaleAccount?.ratio ?? null, sentiment: data.whaleAccount ? ratioToSentiment(data.whaleAccount.ratio) : "Neutral" },
    { label: "Whale Position", ratio: data.whalePosition?.ratio ?? null, sentiment: data.whalePosition ? ratioToSentiment(data.whalePosition.ratio) : "Neutral" },
    { label: "Smart Money Sentiment", ratio: null, sentiment: smSent },
  ];
  return (
    <div className="ls2-ex-card">
      <div className="ls2-ex-card-title">{data.exchange} Bitcoin Long/Short Ratio</div>
      <div className="ls2-ex-table">
        <div className="ls2-ex-thead">
          <span>Type</span><span>Long/Short</span><span>Sentiment</span>
        </div>
        {rows.map(({ label, ratio, sentiment }) => (
          <div key={label} className={`ls2-ex-trow${label === "Smart Money Sentiment" ? " ls2-ex-trow--smart" : ""}`}>
            <span className="ls2-trow-type">{label}</span>
            <span className={`ls2-trow-ratio${ratio !== null ? (ratio >= 1 ? " ls2-ratio-up" : " ls2-ratio-down") : ""}`}>
              {ratio !== null ? `${ratio >= 1 ? "↑" : "↓"} ${ratio.toFixed(2)}` : "—"}
            </span>
            <span className="ls2-trow-sent"><SentimentBadge s={sentiment} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Price + L/S Ratio chart ───────────────────────────────────────────────────

const PW = 900, PH = 200, ML = 70, MR = 46, MT = 16, MB = 28;
const CW = PW - ML - MR, CH = PH - MT - MB;

function PriceLSChart({ data, title }: { data: PriceLSPoint[]; title: string }) {
  if (data.length < 2) return <div className="ls2-chart-placeholder">Loading chart…</div>;

  const prices = data.map(d => d.price);
  const ratios = data.map(d => d.lsRatio);

  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const pPad = (maxP - minP) * 0.08;
  const pMin = minP - pPad, pMax = maxP + pPad;
  const pRange = pMax - pMin || 1;

  const maxR = Math.max(2.5, ...ratios.map(r => Math.ceil(r * 2) / 2));
  const minR = 0;
  const rRange = maxR - minR;

  const barW = CW / data.length;
  const bx   = (i: number) => ML + i * barW;
  const py   = (p: number) => MT + (1 - (p - pMin) / pRange) * CH;
  const ry   = (r: number) => MT + (1 - (r - minR) / rRange) * CH;
  const ry1  = ry(1.0);

  const pricePts = data.map((d, i) =>
    `${(ML + (i + 0.5) * barW).toFixed(1)},${py(d.price).toFixed(1)}`).join(" ");

  // Price axis ticks
  const priceStep = (pMax - pMin) / 4;
  const pTicks = Array.from({ length: 5 }, (_, i) => pMin + i * priceStep);

  // Ratio axis ticks
  const rTicks = Array.from({ length: Math.ceil(maxR / 0.5) + 1 }, (_, i) => i * 0.5).filter(v => v <= maxR);

  // Time axis labels (≤7 labels)
  const timeStep = Math.max(1, Math.floor(data.length / 6));
  const timePts  = data
    .map((d, i) => ({ ...d, i }))
    .filter(({ i }) => i % timeStep === 0);

  const fmtTime = (t: number) => {
    const d = new Date(t * 1000);
    return `${(d.getUTCMonth() + 1).toString().padStart(2, "0")}-${d.getUTCDate().toString().padStart(2, "0")}`;
  };
  const fmtPLabel = (p: number) => p >= 1000 ? `$${(p / 1000).toFixed(1)}K` : `$${p.toFixed(0)}`;

  return (
    <div className="ls2-chart-section">
      <div className="ls2-chart-header">
        <span className="ls2-chart-title">{title}</span>
        <span className="ls2-chart-sub">Taker Buy/Sell Volume</span>
      </div>
      <div className="ls2-chart-legend-row">
        <span className="ls2-legend-item"><span className="ls2-legend-line ls2-legend-line--price" /> Price</span>
        <span className="ls2-legend-item"><span className="ls2-legend-dot ls2-legend-dot--bull" /> Long/Short</span>
      </div>
      <div className="ls2-chart-svg-wrap">
        <svg viewBox={`0 0 ${PW} ${PH}`} className="ls2-ratio-svg" preserveAspectRatio="none">
          {/* Grid */}
          {rTicks.map(v => (
            <line key={v} x1={ML} y1={ry(v)} x2={PW - MR} y2={ry(v)}
              stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
          ))}
          <line x1={ML} y1={ry1} x2={PW - MR} y2={ry1}
            stroke="rgba(255,255,255,0.18)" strokeWidth="1" strokeDasharray="4,3" />

          {/* L/S ratio bars */}
          {data.map((d, i) => {
            const isLong = d.lsRatio >= 1;
            const top = isLong ? ry(d.lsRatio) : ry1;
            const h   = Math.max(1, Math.abs(ry(d.lsRatio) - ry1));
            return (
              <rect key={i} x={bx(i)} y={top} width={Math.max(1, barW - 0.5)} height={h}
                fill={isLong ? "#22c55e" : "#ef4444"} opacity={0.8} />
            );
          })}

          {/* Price line */}
          <polyline points={pricePts} fill="none" stroke="rgba(220,220,220,0.9)" strokeWidth="1.6"
            strokeLinejoin="round" strokeLinecap="round" />

          {/* Left Y axis labels (price) */}
          {pTicks.map(p => (
            <text key={p} x={ML - 6} y={py(p) + 4} textAnchor="end"
              fill="rgba(255,255,255,0.38)" fontSize="9.5" fontFamily="system-ui,sans-serif">
              {fmtPLabel(p)}
            </text>
          ))}

          {/* Right Y axis labels (L/S ratio) */}
          {rTicks.map(v => (
            <text key={v} x={PW - MR + 5} y={ry(v) + 4} textAnchor="start"
              fill="rgba(255,255,255,0.38)" fontSize="9.5" fontFamily="system-ui,sans-serif">
              {v.toFixed(1)}
            </text>
          ))}

          {/* X axis time labels */}
          {timePts.map(({ i, time }) => (
            <text key={i} x={(ML + (i + 0.5) * barW).toFixed(1)} y={PH - 4} textAnchor="middle"
              fill="rgba(255,255,255,0.32)" fontSize="9" fontFamily="system-ui,sans-serif">
              {fmtTime(time)}
            </text>
          ))}

          {/* Axis borders */}
          <line x1={ML} y1={MT} x2={ML} y2={MT + CH} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          <line x1={PW - MR} y1={MT} x2={PW - MR} y2={MT + CH} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          <line x1={ML} y1={MT + CH} x2={PW - MR} y2={MT + CH} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}

// ── Exchange taker volume table ───────────────────────────────────────────────

function ExchangeVolumeTable({ rows, interval }: { rows: ExchangeTakerRow[]; interval: string }) {
  if (!rows.length) return (
    <div className="ls2-ev-wrap">
      <div className="ls2-ev-header">
        <span className="ls2-chart-title">Exchanges BTC Long/Short Ratio</span>
        <span className="ls2-chart-sub">Taker Buy/Sell Volume · {interval}</span>
      </div>
      <div className="ls2-ev-empty">Loading exchange data…</div>
    </div>
  );

  const totalLong  = rows.reduce((s, r) => s + r.longVolUsd,  0);
  const totalShort = rows.reduce((s, r) => s + r.shortVolUsd, 0);
  const totalAll   = totalLong + totalShort;
  const aggLong    = totalAll > 0 ? (totalLong  / totalAll) * 100 : 50;
  const aggShort   = totalAll > 0 ? (totalShort / totalAll) * 100 : 50;

  return (
    <div className="ls2-ev-wrap">
      <div className="ls2-ev-header">
        <span className="ls2-chart-title">Exchanges BTC Long/Short Ratio</span>
        <span className="ls2-chart-sub">Taker Buy/Sell Volume · {interval}</span>
      </div>

      {/* Aggregate row */}
      <div className="ls2-ev-row ls2-ev-row--agg">
        <span className="ls2-ev-rank" />
        <span className="ls2-ev-name ls2-ev-name--agg">BTC</span>
        <div className="ls2-ev-bar-cell">
          <div className="ls2-ev-bar">
            <div className="ls2-ev-bar-long"  style={{ width: `${aggLong}%` }}>
              <span className="ls2-ev-bar-pct">{aggLong.toFixed(2)}%</span>
            </div>
            <div className="ls2-ev-bar-short" style={{ width: `${aggShort}%` }}>
              <span className="ls2-ev-bar-pct">{aggShort.toFixed(2)}%</span>
            </div>
          </div>
        </div>
        <span className="ls2-ev-label">Long</span>
        <span className="ls2-ev-vol ls2-ratio-up">{fmtVol(totalLong)}</span>
        <span className="ls2-ev-label">Short</span>
        <span className="ls2-ev-vol ls2-ratio-down">{fmtVol(totalShort)}</span>
      </div>

      {rows.map((row, i) => (
        <div key={row.exchange} className="ls2-ev-row">
          <span className="ls2-ev-rank">{i + 1}</span>
          <span className="ls2-ev-name">{row.exchange}</span>
          <div className="ls2-ev-bar-cell">
            <div className="ls2-ev-bar">
              <div className="ls2-ev-bar-long"  style={{ width: `${row.longPct}%` }}>
                <span className="ls2-ev-bar-pct">{row.longPct.toFixed(2)}%</span>
              </div>
              <div className="ls2-ev-bar-short" style={{ width: `${row.shortPct}%` }}>
                <span className="ls2-ev-bar-pct">{row.shortPct.toFixed(2)}%</span>
              </div>
            </div>
          </div>
          <span className="ls2-ev-label">Long</span>
          <span className="ls2-ev-vol ls2-ratio-up">{fmtVol(row.longVolUsd)}</span>
          <span className="ls2-ev-label">Short</span>
          <span className="ls2-ev-vol ls2-ratio-down">{fmtVol(row.shortVolUsd)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Large trades panel ────────────────────────────────────────────────────────

function fmtTradeTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getUTCHours().toString().padStart(2, "0");
  const m = d.getUTCMinutes().toString().padStart(2, "0");
  const s = d.getUTCSeconds().toString().padStart(2, "0");
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${h}:${m}:${s}\n${mo}-${day}`;
}

function LargeTradesPanel({ trades }: { trades: LargeTradeItem[] }) {
  return (
    <div className="ls2-lt-wrap">
      <div className="ls2-lt-header">
        <span className="ls2-chart-title">Large Trades (Real-Time)</span>
      </div>
      <div className="ls2-lt-thead">
        <span>Pair</span>
        <span>Price</span>
        <span>Value</span>
        <span>Time</span>
      </div>
      <div className="ls2-lt-body">
        {trades.length === 0 && (
          <div className="ls2-lt-empty">Fetching trades…</div>
        )}
        {trades.map((t, i) => (
          <div key={i} className={`ls2-lt-row${t.isBuy ? " ls2-lt-row--buy" : " ls2-lt-row--sell"}`}>
            <span className="ls2-lt-pair">
              <span className="ls2-lt-arrow">{t.isBuy ? "→" : "←"}</span>
              {t.pair}
            </span>
            <span className="ls2-lt-price">${t.price.toLocaleString()}</span>
            <span className={`ls2-lt-val ${t.isBuy ? "ls2-ratio-up" : "ls2-ratio-down"}`}>
              {fmtVol(t.valueUsd)}
            </span>
            <span className="ls2-lt-time">{fmtTradeTime(t.time)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Multi-coin futures table ──────────────────────────────────────────────────

function MultiCoinTable({ rows }: { rows: CoinLSSnapshot[] }) {
  if (!rows.length) return null;
  return (
    <div className="ls2-mc-wrap">
      <div className="ls2-chart-header" style={{ padding: "14px 16px 12px" }}>
        <span className="ls2-chart-title">Cryptocurrency Futures Longs vs Shorts</span>
      </div>
      <div className="ls2-mc-thead">
        <span>#</span>
        <span>Symbol</span>
        <span>Price</span>
        <span>24h %</span>
        <span>Long / Short</span>
        <span>L/S Ratio</span>
        <span>Sentiment</span>
      </div>
      <div className="ls2-mc-body">
        {rows.map((r, i) => {
          const change = r.change24h;
          const sent = ratioToSentiment(r.lsRatio);
          return (
            <div key={r.coin} className="ls2-mc-row">
              <span className="ls2-mc-rank">{i + 1}</span>
              <span className="ls2-mc-sym">
                <span className="ls2-mc-sym-tick">{r.coin}</span>
                <span className="ls2-mc-sym-name">{r.name}</span>
              </span>
              <span className="ls2-mc-price">{fmtPrice(r.price)}</span>
              <span className={`ls2-mc-chg ${change >= 0 ? "ls2-ratio-up" : "ls2-ratio-down"}`}>
                {change >= 0 ? "+" : ""}{change.toFixed(2)}%
              </span>
              <span className="ls2-mc-bar-cell">
                <div className="ls2-mc-bar">
                  <div className="ls2-mc-bar-long"  style={{ width: `${r.longPct}%` }} />
                  <div className="ls2-mc-bar-short" style={{ width: `${r.shortPct}%` }} />
                </div>
                <div className="ls2-mc-bar-labels">
                  <span className="ls2-ratio-up">{r.longPct.toFixed(1)}%</span>
                  <span className="ls2-ratio-down">{r.shortPct.toFixed(1)}%</span>
                </div>
              </span>
              <span className={`ls2-mc-ratio ${r.lsRatio >= 1 ? "ls2-ratio-up" : "ls2-ratio-down"}`}>
                {r.lsRatio >= 1 ? "↑" : "↓"} {r.lsRatio.toFixed(4)}
              </span>
              <span><SentimentBadge s={sent} /></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props { coin?: CoinSymbol | string; }

export function PositionFlows({ coin = "BTC" }: Props) {
  const [intervalIdx,  setIntervalIdx]  = useState(2);
  const [takerVol,     setTakerVol]     = useState<TakerVolData | null>(null);
  const [exchanges,    setExchanges]    = useState<ExchangeLSData[]>([]);
  const [chartData,    setChartData]    = useState<PriceLSPoint[]>([]);
  const [multiCoin,    setMultiCoin]    = useState<CoinLSSnapshot[]>([]);
  const [exVol,        setExVol]        = useState<ExchangeTakerRow[]>([]);
  const [largeTrades,  setLargeTrades]  = useState<LargeTradeItem[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState("");

  const iv = INTERVALS[intervalIdx];

  // Primary load: vol cards + exchange breakdown
  useEffect(() => {
    let dead = false;
    setLoading(true);
    setError("");

    Promise.all([
      getTakerBuySellVol(coin, iv.cg, 1),
      getExchangeLSData(coin),
    ])
      .then(([vol, exs]) => {
        if (dead) return;
        setTakerVol(vol);
        setExchanges(exs);
        setLoading(false);
      })
      .catch(err => {
        if (dead) return;
        setError(err?.message ?? "Failed to load");
        setLoading(false);
      });

    return () => { dead = true; };
  }, [coin, intervalIdx]);

  // Secondary load: chart + multi-coin table + exchange vol + large trades (lazy)
  useEffect(() => {
    let dead = false;
    setChartData([]);

    getPriceLSHistory(coin, iv.cg, iv.limit).then(d => {
      if (!dead) setChartData(d);
    }).catch(() => {});

    getMultiCoinLSSnapshot(COINS).then(d => {
      if (!dead) setMultiCoin(d);
    }).catch(() => {});

    getAllExchangeTakerVol(coin, iv.cg).then(d => {
      if (!dead) setExVol(d);
    }).catch(() => {});

    getRecentLargeTrades(coin).then(d => {
      if (!dead) setLargeTrades(d);
    }).catch(() => {});

    // Poll large trades every 15 s
    const poll = setInterval(() => {
      getRecentLargeTrades(coin).then(d => { if (!dead) setLargeTrades(d); }).catch(() => {});
    }, 15_000);

    return () => { dead = true; clearInterval(poll); };
  }, [coin, intervalIdx]);

  if (loading) return (
    <div className="ls2-wrap">
      <div className="ls2-state"><div className="pf-spinner" />Loading Long/Short data…</div>
    </div>
  );
  if (error) return (
    <div className="ls2-wrap">
      <div className="ls2-state ls2-state--error">{error}</div>
    </div>
  );

  const avgRetailRatio = exchanges.length
    ? exchanges.reduce((s, ex) => s + (ex.retail?.ratio ?? 1), 0) / exchanges.length : 1;
  const longPct  = takerVol ? takerVol.buyRatio  * 100 : (avgRetailRatio / (1 + avgRetailRatio)) * 100;
  const shortPct = takerVol ? takerVol.sellRatio * 100 : 100 - longPct;

  return (
    <div className="ls2-wrap">

      {/* ── Section 1: Taker Vol ── */}
      <div className="ls2-vol-wrap">
        <h2 className="ls2-title">Cryptocurrency Longs vs Shorts</h2>
        <div className="ls2-vol-controls">
          <span className="ls2-vol-ctrl-label">Taker Buy/Sell Volume</span>
          <div className="ls2-iv-tabs">
            {INTERVALS.map((iv, i) => (
              <button key={iv.label}
                className={`ls2-iv-btn${intervalIdx === i ? " active" : ""}`}
                onClick={() => setIntervalIdx(i)}>
                {iv.label}
              </button>
            ))}
          </div>
        </div>
        <div className="ls2-vol-cards">
          <div className="ls2-vc ls2-vc--long">
            <CircleRing pct={longPct}  color="#22c55e" track="rgba(34,197,94,0.2)" />
            <div className="ls2-vc-info">
              <div className="ls2-vc-label">{iv.short} Long Volume</div>
              <div className="ls2-vc-amount">
                {takerVol && takerVol.buyVolUsd > 0 ? fmtVol(takerVol.buyVolUsd) : `${longPct.toFixed(2)}%`}
              </div>
            </div>
          </div>
          <div className="ls2-vc ls2-vc--short">
            <CircleRing pct={shortPct} color="#ef4444" track="rgba(239,68,68,0.2)" />
            <div className="ls2-vc-info">
              <div className="ls2-vc-label">{iv.short} Short Volume</div>
              <div className="ls2-vc-amount">
                {takerVol && takerVol.sellVolUsd > 0 ? fmtVol(takerVol.sellVolUsd) : `${shortPct.toFixed(2)}%`}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Section 2: Exchange breakdown ── */}
      {exchanges.length > 0 && (
        <div className="ls2-ex-grid">
          {exchanges.map(ex => <ExchangeCard key={ex.exchange} data={ex} />)}
        </div>
      )}

      {/* ── Section 3: Exchange taker vol table + Large trades ── */}
      <div className="ls2-ev-lt-row">
        <ExchangeVolumeTable rows={exVol} interval={iv.label} />
        <LargeTradesPanel trades={largeTrades} />
      </div>

      {/* ── Section 4: BTC L/S Ratio Chart ── */}
      <PriceLSChart
        data={chartData}
        title={`${String(coin).toUpperCase()} Long/Short Ratio Chart`}
      />

      {/* ── Section 5: Multi-coin futures table ── */}
      {multiCoin.length > 0 && <MultiCoinTable rows={multiCoin} />}

      <p className="ls2-disclaimer">Data via coinhintz · Binance / OKX / Bybit Futures · Educational only</p>
    </div>
  );
}
