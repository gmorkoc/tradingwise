import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getLongShortBundle, getMultiCoinLSSnapshot, getRecentLargeTrades, getBinanceCandles,
  LongShortBundle, ExchangeLSData, PriceLSPoint, CoinLSSnapshot,
  ExchangeTakerRow, LargeTradeItem, CoinSymbol, COINS,
} from "../services/coinglass";
import { useAuth } from "../contexts/AuthContext";
import { LockCard } from "./MembershipGate";
import "../styles/PositionFlows.css";

// ── Constants ─────────────────────────────────────────────────────────────────

// hours = taker-volume window; period/limit = ratio-chart buckets.
const INTERVALS = [
  { label: "1 hour",  labelKey: "h1",  short: "1H",  hours: 1,  period: "1h",  limit: 72 },
  { label: "4 hour",  labelKey: "h4",  short: "4H",  hours: 4,  period: "4h",  limit: 90 },
  { label: "12 hour", labelKey: "h12", short: "12H", hours: 12, period: "12h", limit: 60 },
  { label: "24 hour", labelKey: "h24", short: "24H", hours: 24, period: "1d",  limit: 30 },
] as const;
const CARD_EXCHANGES = ["Binance", "OKX", "Bybit", "Bitget", "Gate"] as const;

type Sentiment = "Very Bullish" | "Bullish" | "Neutral" | "Bearish" | "Extremely Bearish";

// Sentiment (internal value) → translation key, resolved at render time.
const SENTIMENT_KEY: Record<Sentiment, string> = {
  "Very Bullish":      "veryBullish",
  "Bullish":           "bullish",
  "Neutral":           "neutral",
  "Bearish":           "bearish",
  "Extremely Bearish": "extremelyBearish",
};

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
  const { t } = useTranslation();
  const cls =
    s === "Very Bullish"       ? "sen--vbull" :
    s === "Bullish"            ? "sen--bull" :
    s === "Neutral"            ? "sen--neutral" :
    s === "Bearish"            ? "sen--bear" :
    /* Extremely Bearish */      "sen--xbear";
  return (
    <span className={`sen-badge ${cls}`}>
      {s === "Extremely Bearish" && <span className="sen-flame">🔥</span>}{t(`positionFlows.sentiment.${SENTIMENT_KEY[s]}`)}
    </span>
  );
}

// ── Exchange card ─────────────────────────────────────────────────────────────

function ExchangeCard({ data, coin, locked, onUnlock }: { data: ExchangeLSData; coin: string; locked: boolean; onUnlock: () => void }) {
  // Smart money reads the crowd contrarian: lots of retail longs → bearish.
  const { t } = useTranslation();
  const smSent: Sentiment | null = data.retail ? smartMoneySentiment(data.retail.ratio) : null;
  type RowId = "retail" | "whaleAccount" | "whalePosition" | "smartMoney";
  type Row = { id: RowId; ratio: number | null; sentiment: Sentiment | null };
  const rows: Row[] = [
    { id: "retail",        ratio: data.retail?.ratio       ?? null, sentiment: data.retail       ? ratioToSentiment(data.retail.ratio)       : null },
    { id: "whaleAccount",  ratio: data.whaleAccount?.ratio ?? null, sentiment: data.whaleAccount ? ratioToSentiment(data.whaleAccount.ratio) : null },
    { id: "whalePosition", ratio: data.whalePosition?.ratio ?? null, sentiment: data.whalePosition ? ratioToSentiment(data.whalePosition.ratio) : null },
    { id: "smartMoney",    ratio: null, sentiment: smSent },
  ];
  return (
    <div className="ls2-ex-card">
      <div className="ls2-ex-card-title">{t("positionFlows.exchangeCardTitle", { exchange: data.exchange, coin })}</div>
      <div className="ls2-ex-table">
        <div className="ls2-ex-thead">
          <span>{t("positionFlows.colType")}</span><span>{t("positionFlows.colLongShort")}</span><span>{t("positionFlows.colSentiment")}</span>
        </div>
        {rows.map(({ id, ratio, sentiment }) => (id !== "retail" && locked) ? (
          // Whale + smart-money rows need a free account.
          <div key={id} className={`ls2-ex-trow ls2-ex-trow--locked${id === "smartMoney" ? " ls2-ex-trow--smart" : ""}`}>
            <span className="ls2-trow-type">{t(`positionFlows.rows.${id}`)}</span>
            <button type="button" className="ls2-row-lock" onClick={onUnlock}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
              </svg>
              {t("positionFlows.signInToSee")}
            </button>
          </div>
        ) : (
          <div key={id} className={`ls2-ex-trow${id === "smartMoney" ? " ls2-ex-trow--smart" : ""}`}>
            <span className="ls2-trow-type">{t(`positionFlows.rows.${id}`)}</span>
            <span className={`ls2-trow-ratio${ratio !== null ? (ratio >= 1 ? " ls2-ratio-up" : " ls2-ratio-down") : ""}`}>
              {ratio !== null ? `${ratio >= 1 ? "↑" : "↓"} ${ratio.toFixed(2)}` : id === "smartMoney" ? "" : "—"}
            </span>
            <span className="ls2-trow-sent">
              {sentiment ? <SentimentBadge s={sentiment} /> : <span className="ls2-nodata">{t("positionFlows.notPublished")}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Price + L/S Ratio chart ───────────────────────────────────────────────────

const PW = 900, PH = 200, ML = 70, MR = 46, MT = 16, MB = 28;
const CW = PW - ML - MR, CH = PH - MT - MB;

function PriceLSChart({ data, title, sub, state }: { data: PriceLSPoint[]; title: string; sub: string; state: "loading" | "ready" | "empty" }) {
  const { t } = useTranslation();
  if (data.length < 2) return (
    <div className="ls2-chart-placeholder">
      {state === "empty" ? t("positionFlows.chartEmpty") : t("positionFlows.chartLoading")}
    </div>
  );

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
        <span className="ls2-chart-sub">{sub}</span>
      </div>
      <div className="ls2-chart-legend-row">
        <span className="ls2-legend-item"><span className="ls2-legend-line ls2-legend-line--price" /> {t("positionFlows.legendPrice")}</span>
        <span className="ls2-legend-item"><span className="ls2-legend-dot ls2-legend-dot--bull" /> {t("positionFlows.legendLongShort")}</span>
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

function ExchangeVolumeTable({ rows, interval, coin }: { rows: ExchangeTakerRow[]; interval: string; coin: string }) {
  const { t } = useTranslation();
  if (!rows.length) return (
    <div className="ls2-ev-wrap">
      <div className="ls2-ev-header">
        <span className="ls2-chart-title">{t("positionFlows.evTitle", { coin })}</span>
        <span className="ls2-chart-sub">{t("positionFlows.evSub", { interval })}</span>
      </div>
      <div className="ls2-ev-empty">{t("positionFlows.evEmpty")}</div>
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
        <span className="ls2-chart-title">{t("positionFlows.evTitle", { coin })}</span>
        <span className="ls2-chart-sub">{t("positionFlows.evSub", { interval })}</span>
      </div>

      {/* Aggregate row */}
      <div className="ls2-ev-row ls2-ev-row--agg">
        <span className="ls2-ev-rank" />
        <span className="ls2-ev-name ls2-ev-name--agg">{t("positionFlows.evAll")}</span>
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
        <span className="ls2-ev-label">{t("positionFlows.long")}</span>
        <span className="ls2-ev-vol ls2-ratio-up">{fmtVol(totalLong)}</span>
        <span className="ls2-ev-label">{t("positionFlows.short")}</span>
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
          <span className="ls2-ev-label">{t("positionFlows.long")}</span>
          <span className="ls2-ev-vol ls2-ratio-up">{fmtVol(row.longVolUsd)}</span>
          <span className="ls2-ev-label">{t("positionFlows.short")}</span>
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
  const { t } = useTranslation();
  return (
    <div className="ls2-lt-wrap">
      <div className="ls2-lt-header">
        <span className="ls2-chart-title">{t("positionFlows.ltTitle")}</span>
      </div>
      <div className="ls2-lt-thead">
        <span>{t("positionFlows.ltPair")}</span>
        <span>{t("positionFlows.ltPrice")}</span>
        <span>{t("positionFlows.ltValue")}</span>
        <span>{t("positionFlows.ltTime")}</span>
      </div>
      <div className="ls2-lt-body">
        {trades.length === 0 && (
          <div className="ls2-lt-empty">{t("positionFlows.ltFetching")}</div>
        )}
        {trades.map((tr, i) => (
          <div key={i} className={`ls2-lt-row${tr.isBuy ? " ls2-lt-row--buy" : " ls2-lt-row--sell"}`}>
            <span className="ls2-lt-pair">
              <span className="ls2-lt-arrow">{tr.isBuy ? "→" : "←"}</span>
              {tr.pair}
            </span>
            <span className="ls2-lt-price">${tr.price.toLocaleString()}</span>
            <span className={`ls2-lt-val ${tr.isBuy ? "ls2-ratio-up" : "ls2-ratio-down"}`}>
              {fmtVol(tr.valueUsd)}
            </span>
            <span className="ls2-lt-time">{fmtTradeTime(tr.time)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Multi-coin futures table ──────────────────────────────────────────────────

function MultiCoinTable({ rows }: { rows: CoinLSSnapshot[] }) {
  const { t } = useTranslation();
  if (!rows.length) return null;
  return (
    <div className="ls2-mc-wrap">
      <div className="ls2-chart-header" style={{ padding: "14px 16px 12px" }}>
        <span className="ls2-chart-title">{t("positionFlows.mcTitle")}</span>
      </div>
      <div className="ls2-mc-thead">
        <span>#</span>
        <span>{t("positionFlows.mcSymbol")}</span>
        <span>{t("positionFlows.mcPrice")}</span>
        <span>{t("positionFlows.mc24h")}</span>
        <span>{t("positionFlows.mcLongShort")}</span>
        <span>{t("positionFlows.mcRatio")}</span>
        <span>{t("positionFlows.colSentiment")}</span>
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

interface Props { coin?: CoinSymbol | string; onOpenAuth?: (view?: "login" | "signup") => void; }

export function PositionFlows({ coin = "BTC", onOpenAuth = () => {} }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [intervalIdx,  setIntervalIdx]  = useState(2);
  const [bundle,       setBundle]       = useState<LongShortBundle | null>(null);
  const [chartData,    setChartData]    = useState<PriceLSPoint[]>([]);
  const [chartState,   setChartState]   = useState<"loading" | "ready" | "empty">("loading");
  const [multiCoin,    setMultiCoin]    = useState<CoinLSSnapshot[]>([]);
  const [largeTrades,  setLargeTrades]  = useState<LargeTradeItem[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState("");

  const iv = INTERVALS[intervalIdx];
  const coinU = String(coin).toUpperCase();

  // One call to our long-short function: ratios, taker volume, history and
  // the multi-coin table — all from the exchanges' own APIs.
  useEffect(() => {
    let dead = false;
    setLoading(true); setError(""); setChartData([]); setChartState("loading");

    const load = () => getLongShortBundle(coinU, iv.hours, iv.period, iv.limit, COINS.map(c => c.symbol));
    load().then(async b => {
      if (dead) return;
      setBundle(b);
      setLoading(false);
      // Stores a translation key; translated at render time.
      if (!b) { setError("positionFlows.errorUnreachable"); return; }

      // Chart: exchange L/S history matched to price candles (nearest time).
      if (!b.history.length) { setChartState("empty"); }
      else {
        const candles = await getBinanceCandles(coinU, iv.period, iv.limit + 5).catch(() => []);
        if (dead) return;
        if (!candles.length) { setChartState("empty"); return; }
        const pts: PriceLSPoint[] = [];
        for (const h of b.history) {
          let best = candles[0];
          for (const c of candles) if (Math.abs(c.time - h.time) < Math.abs(best.time - h.time)) best = c;
          pts.push({ time: h.time, price: best.close, lsRatio: h.ratio });
        }
        setChartData(pts);
        setChartState(pts.length >= 2 ? "ready" : "empty");
      }
      if (b.multi) getMultiCoinLSSnapshot(COINS, b.multi).then(d => { if (!dead) setMultiCoin(d); }).catch(() => {});
    });

    // Refresh every 60 s (the function caches 30 s).
    const poll = setInterval(() => { load().then(b => { if (!dead && b) setBundle(b); }); }, 60_000);
    return () => { dead = true; clearInterval(poll); };
  }, [coinU, intervalIdx]);

  // Large trades: poll every 15 s.
  useEffect(() => {
    let dead = false;
    const get = () => getRecentLargeTrades(coinU).then(d => { if (!dead) setLargeTrades(d); }).catch(() => {});
    get();
    const poll = setInterval(get, 15_000);
    return () => { dead = true; clearInterval(poll); };
  }, [coinU]);

  // ── Derived views ───────────────────────────────────────────────────────
  const exchanges: ExchangeLSData[] = bundle
    ? CARD_EXCHANGES.flatMap(ex => {
        const r = bundle.ratios[ex];
        return r && (r.retail || r.whaleAccount || r.whalePosition) ? [{ exchange: ex, ...r }] : [];
      })
    : [];
  const exVol: ExchangeTakerRow[] = (bundle?.taker ?? [])
    .map(t => {
      const tot = t.buyUsd + t.sellUsd;
      return { exchange: t.exchange, longPct: (t.buyUsd / tot) * 100, shortPct: (t.sellUsd / tot) * 100, longVolUsd: t.buyUsd, shortVolUsd: t.sellUsd };
    })
    .sort((a, b) => (b.longVolUsd + b.shortVolUsd) - (a.longVolUsd + a.shortVolUsd));
  const buyVolUsd  = exVol.reduce((s, r) => s + r.longVolUsd, 0);
  const sellVolUsd = exVol.reduce((s, r) => s + r.shortVolUsd, 0);
  const takerVol = buyVolUsd + sellVolUsd > 0
    ? { buyVolUsd, sellVolUsd, buyRatio: buyVolUsd / (buyVolUsd + sellVolUsd), sellRatio: sellVolUsd / (buyVolUsd + sellVolUsd) }
    : null;

  if (loading) return (
    <div className="ls2-wrap">
      <div className="ls2-state"><div className="pf-spinner" />{t("positionFlows.loadingData")}</div>
    </div>
  );
  if (error) return (
    <div className="ls2-wrap">
      <div className="ls2-state ls2-state--error">{t(error)}</div>
    </div>
  );

  // No fake 50/50: without taker data the cards say so.
  const longPct  = takerVol ? takerVol.buyRatio  * 100 : 0;
  const shortPct = takerVol ? takerVol.sellRatio * 100 : 0;
  const takerSources = exVol.map(r => r.exchange).join(", ");

  return (
    <div className="ls2-wrap">

      {/* ── Section 1: Taker Vol ── */}
      <div className="ls2-vol-wrap">
        <h2 className="ls2-title">{t("positionFlows.pageTitle")}</h2>
        <div className="ls2-vol-controls">
          <span className="ls2-vol-ctrl-label">{t("positionFlows.takerVolumeLabel")}</span>
          <div className="ls2-iv-tabs">
            {INTERVALS.map((iv, i) => (
              <button key={iv.label}
                className={`ls2-iv-btn${intervalIdx === i ? " active" : ""}`}
                onClick={() => setIntervalIdx(i)}>
                {t(`positionFlows.intervals.${iv.labelKey}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="ls2-vol-cards">
          <div className="ls2-vc ls2-vc--long">
            <CircleRing pct={longPct}  color="#22c55e" track="rgba(34,197,94,0.2)" />
            <div className="ls2-vc-info">
              <div className="ls2-vc-label">{t("positionFlows.takerBuyVolume", { interval: iv.short })}</div>
              <div className="ls2-vc-amount">{takerVol ? fmtVol(takerVol.buyVolUsd) : t("positionFlows.noData")}</div>
              {takerSources && <div className="ls2-vc-src">{takerSources}</div>}
            </div>
          </div>
          <div className="ls2-vc ls2-vc--short">
            <CircleRing pct={shortPct} color="#ef4444" track="rgba(239,68,68,0.2)" />
            <div className="ls2-vc-info">
              <div className="ls2-vc-label">{t("positionFlows.takerSellVolume", { interval: iv.short })}</div>
              <div className="ls2-vc-amount">{takerVol ? fmtVol(takerVol.sellVolUsd) : t("positionFlows.noData")}</div>
              {takerSources && <div className="ls2-vc-src">{takerSources}</div>}
            </div>
          </div>
        </div>
      </div>

      {/* ── Section 2: Exchange breakdown ── */}
      {exchanges.length > 0 && (
        <div className="ls2-ex-grid">
          {exchanges.map(ex => <ExchangeCard key={ex.exchange} data={ex} coin={coinU} locked={!user} onUnlock={() => onOpenAuth()} />)}
        </div>
      )}

      {/* ── Section 3: Exchange taker vol table + Large trades ── */}
      <div className="ls2-ev-lt-row">
        <ExchangeVolumeTable rows={exVol} interval={t(`positionFlows.intervals.${iv.labelKey}`)} coin={coinU} />
        {user ? <LargeTradesPanel trades={largeTrades} /> : (
          <div className="ls2-lt-wrap ls2-lock-wrap">
            <LockCard variant="panel" plan="free" featureName={t("positionFlows.lockLargeTradesName")}
              description={t("positionFlows.lockLargeTradesDesc")} onOpenAuth={onOpenAuth} />
          </div>
        )}
      </div>

      {/* ── Section 4: BTC L/S Ratio Chart ── */}
      <PriceLSChart
        data={chartData}
        title={t("positionFlows.chartTitle", { coin: coinU })}
        sub={t("positionFlows.chartSub", { source: bundle?.historySource ?? "—", interval: t(`positionFlows.intervals.${iv.labelKey}`) })}
        state={chartState}
      />

      {/* ── Section 5: Multi-coin futures table ── */}
      {multiCoin.length > 0 && (user ? <MultiCoinTable rows={multiCoin} /> : (
        <LockCard plan="free" featureName={t("positionFlows.lockMultiCoinName")} onOpenAuth={onOpenAuth} />
      ))}

      <p className="ls2-disclaimer">{t("positionFlows.disclaimer")}</p>
    </div>
  );
}
