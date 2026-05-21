import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { openai, PredictionResponse } from "../services/openai";
import { BTCData, coinglass, CoinSymbol } from "../services/coinglass";
import { fetchFearGreed } from "../services/feargreed";
import { PredictionChart, PredictionChartHandle } from "./PredictionChart";
import { AIQuotaWall } from "./AIQuotaWall";
import { useAIQuota } from "../hooks/useAIQuota";
import "../styles/AIPredictionPanel.css";

interface AIPredictionPanelProps {
  btcData: Partial<BTCData> | null;
  coin?: CoinSymbol;
  theme?: "dark" | "light";
  onOpenAuth?: () => void;
  onOpenUpgrade?: () => void;
}

const fmt = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const fmtK = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(0)}K` : fmt(n);

const TF_LABELS = ["8h", "12h", "16h", "24h"] as const;

const SENTIMENT_COLORS = {
  bullish: { text: "#22c55e", bg: "rgba(34,197,94,0.15)", border: "rgba(34,197,94,0.4)" },
  bearish: { text: "#fb7185", bg: "rgba(251,113,133,0.15)", border: "rgba(251,113,133,0.4)" },
  neutral: { text: "#e2e8f0", bg: "rgba(226,232,240,0.12)", border: "rgba(226,232,240,0.3)" },
};

const CONF_COLORS = { high: "#22c55e", medium: "#f59e0b", low: "#94a3b8" };

const SentimentGauge: React.FC<{ sentiment: "bullish" | "bearish" | "neutral" }> = ({ sentiment }) => {
  const pos = sentiment === "bullish" ? 0.80 : sentiment === "bearish" ? 0.20 : 0.50;
  const angle = pos * Math.PI;
  const cx = 50, cy = 44, r = 34;
  const nx = +(cx - r * Math.cos(angle)).toFixed(2);
  const ny = +(cy - r * Math.sin(angle)).toFixed(2);
  return (
    <svg viewBox="0 0 100 54" className="aip-gauge" aria-hidden="true">
      <defs>
        <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"   stopColor="#fb7185" />
          <stop offset="48%"  stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#22c55e" />
        </linearGradient>
      </defs>
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        stroke="rgba(255,255,255,0.12)" strokeWidth="7" fill="none" strokeLinecap="round" />
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        stroke="url(#gaugeGrad)" strokeWidth="7" fill="none" strokeLinecap="round" opacity="0.75" />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="4" fill="white" />
    </svg>
  );
};

const CACHE_KEY = (coin: string) => `aip_cache_${coin}`;

interface CacheEntry { data: PredictionResponse; timestamp: number; }

function readCache(coin: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY(coin));
    return raw ? (JSON.parse(raw) as CacheEntry) : null;
  } catch { return null; }
}

function writeCache(coin: string, data: PredictionResponse) {
  try {
    localStorage.setItem(CACHE_KEY(coin), JSON.stringify({ data, timestamp: Date.now() }));
  } catch {}
}

export const AIPredictionPanel: React.FC<AIPredictionPanelProps> = ({ btcData, coin = "BTC", theme = "dark", onOpenAuth = () => {}, onOpenUpgrade = () => {} }) => {
  const { t } = useTranslation();
  const { exceeded, used, limit, consume } = useAIQuota();

  const cached = readCache(coin);
  const [data, setData] = useState<PredictionResponse | null>(cached?.data ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(
    cached?.timestamp ? new Date(cached.timestamp) : null
  );
  const [isStale, setIsStale] = useState(!!cached);
  const fetchedForCoin = useRef<string | null>(null);
  const chartRef       = useRef<PredictionChartHandle>(null);

  // When coin switches, immediately hydrate from that coin's cache
  useEffect(() => {
    const entry = readCache(coin);
    if (entry) {
      setData(entry.data);
      setLastUpdated(new Date(entry.timestamp));
      setIsStale(true);
    } else {
      setData(null);
      setLastUpdated(null);
      setIsStale(false);
    }
    fetchedForCoin.current = null;
  }, [coin]);

  const fetchPrediction = async () => {
    if (exceeded) return;
    if (!consume()) return;
    setLoading(true);
    setError("");
    const [latest, fearGreed] = await Promise.all([
      coinglass.getAllBTCData(coin).catch(() => null),
      fetchFearGreed().catch(() => null),
    ]);
    const src = latest || btcData;
    if (!src?.price) {
      setError(t("aiPanel.unableToFetch"));
      setLoading(false);
      return;
    }
    const res = await openai.getPricePrediction(src, fearGreed ?? undefined);
    if (res.success) {
      setData(res);
      setLastUpdated(new Date());
      setIsStale(false);
      writeCache(coin, res);
    } else {
      setError(res.error || "Failed to get prediction");
    }
    setLoading(false);
  };

  useEffect(() => {
    if (btcData?.price && fetchedForCoin.current !== coin && !exceeded) {
      fetchedForCoin.current = coin;
      fetchPrediction();
    }
  }, [btcData, coin]);

  const sentiment = data?.sentiment ?? "neutral";
  const sc = SENTIMENT_COLORS[sentiment];
  const currentPrice = btcData?.price ?? 0;

  if (exceeded) {
    return (
      <div className="aip-root">
        <AIQuotaWall used={used} limit={limit} onOpenUpgrade={onOpenUpgrade} onOpenAuth={onOpenAuth} />
      </div>
    );
  }

  return (
    <div className="aip-root">

      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="aip-header">
        <div className="aip-header-row">
          <div className="aip-header-left">
            <span className="aip-logo">✦</span>
            <div>
              <div className="aip-title">
                AI Market Intelligence
                <span className="aip-coin-tag">{coin}</span>
                <span className="aip-ai-powered-badge">✦ AI Powered</span>
              </div>
              {lastUpdated && (
                <div className="aip-updated">
                  {isStale ? "Cached · " : "Updated "}{lastUpdated.toLocaleTimeString()}
                  {isStale && loading && <span className="aip-refreshing"> · Refreshing…</span>}
                </div>
              )}
            </div>
          </div>

          {data && (
            <div className="aip-header-gauge">
              <SentimentGauge sentiment={data.sentiment ?? "neutral"} />
              <span className="aip-gauge-label" style={{ color: sc.text }}>{sentiment.toUpperCase()}</span>
            </div>
          )}

          <div className="aip-header-right">
            {data?.confidence && (
              <span className="aip-conf-badge" style={{ color: CONF_COLORS[data.confidence] }}>
                {data.confidence} conf.
              </span>
            )}
            {data && (
              <span className="aip-sentiment-badge" style={{ color: sc.text, background: sc.bg, borderColor: sc.border }}>
                {sentiment.toUpperCase()}
              </span>
            )}
            <button className="aip-refresh-btn" onClick={fetchPrediction} disabled={loading} title="Refresh">
              ↺
            </button>
          </div>
        </div>

        {data?.message && (
          <div className="aip-header-thesis" style={{ borderLeftColor: sc.border }}>
            <span className="aip-header-thesis-label">Market Thesis</span>
            <p className="aip-header-thesis-text">{data.message}</p>
          </div>
        )}
      </div>

      {/* ── Loading / Error ───────────────────────────────────────────── */}
      {loading && !data && (
        <div className="aip-loading">
          <div className="aip-spinner" />
          <span>Analyzing market conditions…</span>
        </div>
      )}
      {error && !loading && <div className="aip-error">{error}</div>}

      {data && (
        <>
          {/* ── Prediction Chart ──────────────────────────────────────── */}
          <PredictionChart
            ref={chartRef}
            coin={coin}
            currentPrice={currentPrice}
            prediction={data}
            theme={theme}
          />

          {/* ── Our Take — full width ─────────────────────────────────── */}
          {data.ourTake && (
            <div
              className={`aip-our-take aip-our-take--${data.ourTakeAction ?? "watch"}`}
              data-action={data.ourTakeAction ?? "watch"}
            >
              <div className="aip-our-take-header">
                <span className="aip-our-take-eyebrow">✦ Our Take</span>
                {data.ourTakeAction && (
                  <span className={`aip-our-take-action aip-our-take-action--${data.ourTakeAction}`}>
                    {data.ourTakeAction.toUpperCase()}
                  </span>
                )}
              </div>
              <p className="aip-our-take-text">{data.ourTake}</p>
            </div>
          )}

          {/* ── Bottom: range chart + cards ───────────────────────────── */}
          <div className="aip-body-grid">
            {/* ── Range chart ─────────────────────────────────────────── */}
            {data.timeframes && (() => {
              const tfs = TF_LABELS.map(tf => ({ tf, r: data.timeframes![tf] }));
              return (
                <div className="aip-range-chart">
                  <div className="aip-section-label">Price Range Forecast</div>
                  <div className="aip-range-rows">
                    {tfs.map(({ tf, r }) => {
                      const span = r.high - r.low;
                      // top%: 0% = high (top), 100% = low (bottom) — inverted axis
                      const cpTop = currentPrice > 0 && span > 0
                        ? Math.max(1, Math.min(99, ((r.high - currentPrice) / span) * 100))
                        : null;
                      const outOfRange = currentPrice > 0 && (currentPrice < r.low || currentPrice > r.high);
                      return (
                        <div key={tf} className="aip-range-row">
                          <span className="aip-range-tf">{tf.toUpperCase()}</span>
                          <div className="aip-range-track">
                            <div className="aip-range-fill" />
                            {cpTop !== null && (
                              <div
                                className={`aip-range-needle${outOfRange ? " aip-range-needle--out" : ""}`}
                                style={{ top: `${cpTop}%` }}
                                title={`Current: ${fmt(currentPrice)}`}
                              />
                            )}
                          </div>
                          <div className="aip-range-vals">
                            <span className="aip-range-hi">{fmtK(r.high)}</span>
                            <span className="aip-range-lo">{fmtK(r.low)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {currentPrice > 0 && (
                    <p className="aip-range-footer">
                      <span className="aip-range-dot" /> Current: <strong>{fmt(currentPrice)}</strong>
                    </p>
                  )}
                </div>
              );
            })()}

            <div className="aip-col-right">
              {/* ── Intelligence cards 2×2 ──────────────────────────────── */}
              <div className="aip-cards-grid">
              {data.priceDrivers && (
                <div className="aip-card">
                  <div className="aip-card-icon aip-card-icon--drivers">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                    </svg>
                  </div>
                  <div className="aip-card-label">Price Drivers</div>
                  <p className="aip-card-text">{data.priceDrivers}</p>
                </div>
              )}
              {data.whoIsBuying && (
                <div className="aip-card">
                  <div className="aip-card-icon aip-card-icon--buying">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
                      <polyline points="17 6 23 6 23 12"/>
                    </svg>
                  </div>
                  <div className="aip-card-label">Who's Buying</div>
                  <p className="aip-card-text">{data.whoIsBuying}</p>
                </div>
              )}
              {data.whoIsSelling && (
                <div className="aip-card">
                  <div className="aip-card-icon aip-card-icon--selling">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/>
                      <polyline points="17 18 23 18 23 12"/>
                    </svg>
                  </div>
                  <div className="aip-card-label">Who's Selling</div>
                  <p className="aip-card-text">{data.whoIsSelling}</p>
                </div>
              )}
              {data.marketContext && (
                <div className="aip-card">
                  <div className="aip-card-icon aip-card-icon--macro">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <circle cx="12" cy="12" r="10"/>
                      <line x1="2" y1="12" x2="22" y2="12"/>
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                    </svg>
                  </div>
                  <div className="aip-card-label">Macro & News</div>
                  <p className="aip-card-text">{data.marketContext}</p>
                </div>
              )}
              {data.keyRisks && (
                <div className="aip-card aip-card--risk">
                  <div className="aip-card-icon aip-card-icon--risk">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                      <line x1="12" y1="9" x2="12" y2="13"/>
                      <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                  </div>
                  <div className="aip-card-label">Key Risks</div>
                  <p className="aip-card-text">{data.keyRisks}</p>
                </div>
              )}
            </div>
          </div> {/* aip-col-right */}
          </div> {/* aip-body-grid */}
        </>
      )}

      {!data && !loading && !error && (
        <div className="aip-loading"><span>Fetching market data…</span></div>
      )}

    </div>
  );
};
