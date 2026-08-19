import { createPortal } from "react-dom";
import { CandleDataPoint } from "../services/coinglass";
import { ZoneAnalysisResult } from "../services/openai";
import "../styles/ZoneAnalysisModal.css";

interface Props {
  coin: string;
  interval: string;
  candles: CandleDataPoint[];
  loading: boolean;
  error?: string;
  result?: ZoneAnalysisResult;
  theme?: "dark" | "light";
  onClose: () => void;
}

function fmtDate(t: number): string {
  return new Date(t * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function ZoneAnalysisModal({ coin, interval, candles, loading, error, result, theme = "dark", onClose }: Props) {
  const first = candles[0];
  const last = candles[candles.length - 1];
  const verdict = result?.verdict ?? "neutral";

  return createPortal(
    <div className="zam-backdrop" onClick={onClose}>
      <div
        className={`zam-modal zam-modal--${verdict}`}
        data-theme={theme}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="zam-header">
          <div className="zam-header-text">
            <span className="zam-title">
              {loading ? "Scanning zone…" : result?.title ?? "Zone Analysis"}
            </span>
            <span className="zam-subtitle">
              {coin} · {interval} · {candles.length} candle{candles.length === 1 ? "" : "s"}
              {first && last ? ` · ${fmtDate(first.time as number)} – ${fmtDate(last.time as number)}` : ""}
            </span>
          </div>
          <button className="zam-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="zam-body">
          {loading && (
            <div className="zam-loading">
              <span className="zam-spinner" />
              <span>Reading {candles.length} candles in the marked zone…</span>
            </div>
          )}

          {!loading && error && (
            <div className="zam-error">⚠️ {error}</div>
          )}

          {!loading && !error && result && (
            <>
              <div className={`zam-verdict-badge zam-verdict-badge--${verdict}`}>
                {verdict === "bullish" ? "▲ Bullish" : verdict === "bearish" ? "▼ Bearish" : "● Neutral"}
              </div>
              <p className="zam-summary">{result.summary}</p>
              <div className="zam-section">
                <span className="zam-section-label">What happened</span>
                <p className="zam-section-body">{result.narrative}</p>
              </div>
              {result.liquidityGrabs && (
                <div className="zam-section zam-section--liquidity">
                  <span className="zam-section-label">🎣 Liquidity &amp; market maker intent</span>
                  <p className="zam-section-body">{result.liquidityGrabs}</p>
                </div>
              )}
              <div className="zam-section">
                <span className="zam-section-label">Key levels</span>
                <p className="zam-section-body">{result.keyLevels}</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
