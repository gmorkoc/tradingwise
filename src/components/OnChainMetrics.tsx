import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchOnChainData, OnChainData, fmtHashrate, fmtDifficulty } from "../services/onchain";
import { getOnChainAIAnalysis, OnChainAIResult } from "../services/openai";
import { AIQuotaWall } from "./AIQuotaWall";
import { useAIQuota } from "../hooks/useAIQuota";
import { CoinbasePremium, PremiumAIResult } from "./CoinbasePremium";
import { FearGreedGauge } from "./FearGreedGauge";
import "../styles/OnChainMetrics.css";

function fmt$(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtNum(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

interface Tile {
  icon: string;
  label: string;
  value: string;
  colorClass?: string;
  tooltip: string;
}

function buildTiles(d: OnChainData, t: (k: string) => string): Tile[] {
  return [
    {
      icon: "⚡",
      label: t("onchain.metrics.hashRate.label"),
      value: fmtHashrate(d.hashrateGHs),
      colorClass: "onchain-tile-value--blue",
      tooltip: t("onchain.metrics.hashRate.tooltip"),
    },
    {
      icon: "🔁",
      label: t("onchain.metrics.dailyTxs.label"),
      value: fmtNum(d.transactions),
      tooltip: t("onchain.metrics.dailyTxs.tooltip"),
    },
    {
      icon: "⛏",
      label: t("onchain.metrics.minerRevenue.label"),
      value: fmt$(d.minerRevenueUSD),
      colorClass: "onchain-tile-value--amber",
      tooltip: t("onchain.metrics.minerRevenue.tooltip"),
    },
    {
      icon: "🎯",
      label: t("onchain.metrics.difficulty.label"),
      value: fmtDifficulty(d.difficulty),
      colorClass: "onchain-tile-value--purple",
      tooltip: t("onchain.metrics.difficulty.tooltip"),
    },
    {
      icon: "₿",
      label: t("onchain.metrics.btcMined.label"),
      value: `${d.btcMinedToday.toFixed(2)} BTC`,
      colorClass: "onchain-tile-value--green",
      tooltip: t("onchain.metrics.btcMined.tooltip"),
    },
    {
      icon: "💸",
      label: t("onchain.metrics.transferVol.label"),
      value: fmt$(d.transferVolumeUSD),
      tooltip: t("onchain.metrics.transferVol.tooltip"),
    },
  ];
}

const HEALTH_CFG = {
  strong:   { color: "#22c55e", bg: "rgba(34,197,94,0.12)",   key: "onchain.strength.strong" },
  moderate: { color: "#f59e0b", bg: "rgba(245,158,11,0.12)",  key: "onchain.strength.moderate" },
  weak:     { color: "#fb7185", bg: "rgba(251,113,133,0.12)", key: "onchain.strength.weak" },
};

const ACTION_CFG = {
  accumulate: { color: "#22c55e", bg: "rgba(34,197,94,0.12)",   key: "onchain.action.accumulate" },
  hold:       { color: "#38bdf8", bg: "rgba(56,189,248,0.12)",  key: "onchain.action.hold" },
  caution:    { color: "#fb7185", bg: "rgba(251,113,133,0.12)", key: "onchain.action.caution" },
};

interface OnChainMetricsProps {
  onOpenAuth?: () => void;
  onOpenUpgrade?: () => void;
}

const ONCHAIN_CACHE_KEY    = "onchain_cache_v1";
const ONCHAIN_AI_CACHE_KEY = "onchain_ai_cache_v1";
const STALE_MS             = 5 * 60 * 1000;

interface CacheEntry<T> { data: T; ts: number; }

function readCache<T>(key: string): CacheEntry<T> | null {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch { return null; }
}
function writeCache<T>(key: string, data: T) {
  try { localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

export function OnChainMetrics({ onOpenAuth = () => {}, onOpenUpgrade = () => {} }: OnChainMetricsProps) {
  const { t } = useTranslation();
  const { exceeded, used, limit, consume } = useAIQuota();

  const cachedData  = readCache<OnChainData>(ONCHAIN_CACHE_KEY);
  const cachedAI    = readCache<OnChainAIResult>(ONCHAIN_AI_CACHE_KEY);
  const cacheAge    = cachedData ? Date.now() - cachedData.ts : Infinity;
  const isFresh     = cacheAge < STALE_MS;

  const [data, setData]           = useState<OnChainData | null>(cachedData?.data ?? null);
  const [loading, setLoading]     = useState(!cachedData);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(cachedData ? new Date(cachedData.ts) : null);
  const [isStale, setIsStale]     = useState(!!cachedData);
  const [ai, setAI]               = useState<OnChainAIResult | null>(cachedAI?.data ?? null);
  const [aiLoading, setAILoading] = useState(false);
  const [aiError, setAIError]     = useState(false);

  const [cbpAI, setCbpAI]               = useState<PremiumAIResult | null>(null);
  const [cbpAILoading, setCbpAILoading] = useState(false);
  const [cbpAIError, setCbpAIError]     = useState(false);

  const handleCbpAI = useCallback((result: PremiumAIResult | null, loading: boolean, error: boolean) => {
    setCbpAI(result);
    setCbpAILoading(loading);
    setCbpAIError(error);
  }, []);

  useEffect(() => {
    // Skip fetch entirely if cache is fresh
    if (isFresh) { setLoading(false); return; }

    async function load() {
      const d = await fetchOnChainData();
      if (d) {
        setData(d);
        setUpdatedAt(new Date());
        setIsStale(false);
        writeCache(ONCHAIN_CACHE_KEY, d);
        if (!exceeded && (await consume())) {
          setAILoading(true);
          setAIError(false);
          const result = await getOnChainAIAnalysis(d);
          if (result) {
            setAI(result);
            writeCache(ONCHAIN_AI_CACHE_KEY, result);
          } else setAIError(true);
          setAILoading(false);
        }
      }
      setLoading(false);
    }
    load();
    const id = setInterval(load, STALE_MS);
    return () => clearInterval(id);
  }, []);

  const tiles = data ? buildTiles(data, t) : [];

  return (
    <div className="onchain-card">
      <div className="onchain-header">
        <div>
          <h3 className="onchain-title">On-Chain Metrics</h3>
          <div className="onchain-sub">BTC Network · blockchain.info</div>
        </div>
        <span className="onchain-updated">
          {updatedAt
            ? (isStale
                ? t("onchain.cached", { time: updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
                : t("onchain.updatedAt", { time: updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }))
            : t("onchain.loading")}
        </span>
      </div>

      <FearGreedGauge />

      {loading ? (
        <div className="onchain-loading">{t("onchain.loading")}</div>
      ) : !data ? (
        <div className="onchain-loading">{t("common.noData")}</div>
      ) : (
        <div className="onchain-grid">
          {tiles.map((tile) => (
            <div className="onchain-tile" key={tile.label} title={tile.tooltip}>
              <div className="onchain-tile-icon">{tile.icon}</div>
              <div className="onchain-tile-label">{tile.label}</div>
              <div className={`onchain-tile-value ${tile.colorClass ?? ""}`}>{tile.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Coinbase Premium Chart ────────────────────────────────────────── */}
      <CoinbasePremium onAIData={handleCbpAI} />

      {/* ── Combined AI Analysis ──────────────────────────────────────────── */}
      <div className="onchain-ai">
        <div className="onchain-ai-header">
          <div className="onchain-ai-title-row">
            <span className="onchain-ai-logo">✦</span>
            <span className="onchain-ai-title">AI Analysis</span>
            <span className="pattern-insight-ai-badge">✦ AI Powered</span>
          </div>
        </div>

        {exceeded && (
          <AIQuotaWall used={used} limit={limit} onOpenUpgrade={onOpenUpgrade} onOpenAuth={onOpenAuth} />
        )}

        {!exceeded && (
          <>
            {/* Coinbase Premium Sentiment */}
            <div className="onchain-ai-subsection">
              <div className="onchain-ai-sub-title">
                Coinbase Premium
                {cbpAI && (() => {
                  const SENTIMENT_CFG = {
                    bullish: { color: "#22c55e", bg: "rgba(34,197,94,0.12)" },
                    neutral: { color: "#38bdf8", bg: "rgba(56,189,248,0.12)" },
                    bearish: { color: "#fb7185", bg: "rgba(251,113,133,0.12)" },
                  };
                  const s = SENTIMENT_CFG[cbpAI.sentiment];
                  return <span className="cbp-ai-badge" style={{ color: s.color, background: s.bg }}>{cbpAI.sentiment}</span>;
                })()}
              </div>
              {cbpAILoading && <div className="onchain-ai-loading"><span className="onchain-ai-spinner" />Analysing premium data…</div>}
              {cbpAIError && !cbpAILoading && <div className="onchain-ai-error">Unable to generate analysis</div>}
              {cbpAI && !cbpAILoading && (
                <>
                  <p className="onchain-ai-summary">{cbpAI.summary}</p>
                  <div className="onchain-ai-signals">
                    {cbpAI.signals.map(sig => (
                      <div key={sig.label} className="onchain-ai-signal">
                        <div className="onchain-ai-signal-top">
                          <span className={`onchain-ai-signal-indicator ${sig.bullish ? "onchain-ai-signal-indicator--bull" : "onchain-ai-signal-indicator--bear"}`}>{sig.bullish ? "↑" : "↓"}</span>
                          <span className="onchain-ai-signal-metric">{sig.label}</span>
                          <span className="onchain-ai-signal-value">{sig.value}</span>
                        </div>
                        <p className="onchain-ai-signal-text">{sig.interpretation}</p>
                      </div>
                    ))}
                  </div>
                  <div className="onchain-ai-outlook">
                    <span className="onchain-ai-outlook-label">Outlook</span>
                    <p className="onchain-ai-outlook-text">{cbpAI.outlook}</p>
                  </div>
                </>
              )}
            </div>

            {/* BTC Network Analysis */}
            <div className="onchain-ai-subsection">
              <div className="onchain-ai-sub-title">
                BTC Network
                {ai && (() => {
                  const h = HEALTH_CFG[ai.networkHealth];
                  const a = ACTION_CFG[ai.action];
                  return (
                    <>
                      <span className="onchain-ai-health-badge" style={{ color: h.color, background: h.bg }}>{t("onchain.networkStrength", { label: t(h.key) })}</span>
                      <span className="onchain-ai-action-badge" style={{ color: a.color, background: a.bg }}>{t(a.key)}</span>
                    </>
                  );
                })()}
              </div>
              {aiLoading && <div className="onchain-ai-loading"><span className="onchain-ai-spinner" />Analyzing network metrics…</div>}
              {aiError && !aiLoading && <div className="onchain-ai-error">Unable to generate analysis</div>}
              {ai && !aiLoading && (
                <>
                  <p className="onchain-ai-summary">{ai.summary}</p>
                  <div className="onchain-ai-signals">
                    {ai.signals.map(sig => (
                      <div key={sig.metric} className="onchain-ai-signal">
                        <div className="onchain-ai-signal-top">
                          <span className={`onchain-ai-signal-indicator ${sig.bullish ? "onchain-ai-signal-indicator--bull" : "onchain-ai-signal-indicator--bear"}`}>{sig.bullish ? "↑" : "↓"}</span>
                          <span className="onchain-ai-signal-metric">{sig.metric}</span>
                          <span className="onchain-ai-signal-value">{sig.value}</span>
                        </div>
                        <p className="onchain-ai-signal-text">{sig.interpretation}</p>
                      </div>
                    ))}
                  </div>
                  <div className="onchain-ai-outlook">
                    <span className="onchain-ai-outlook-label">Outlook</span>
                    <p className="onchain-ai-outlook-text">{ai.outlook}</p>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
