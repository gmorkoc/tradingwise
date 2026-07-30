import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  correlation,
  CORRELATION_ASSETS,
  type CorrelationAsset,
  type CorrelationWindow,
  type CorrelationMatrix as CorrelationMatrixData,
} from "../services/correlation";
import "../styles/CorrelationMatrix.css";

const WINDOWS: { id: CorrelationWindow; label: string }[] = [
  { id: "30d", label: "30D" },
  { id: "90d", label: "90D" },
  { id: "1y", label: "1Y" },
];

const ASSET_NAMES: Record<CorrelationAsset, string> = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", XRP: "XRP", BNB: "BNB",
  GOLD: "Gold — tracked via PAXG, a token backed 1:1 by physical gold",
  DXY: "US Dollar strength — tracked via the Fed's Broad Dollar Index (close to, but not identical to, the ICE DXY futures index)",
  SPX: "S&P 500 — the 500 largest US stocks, a proxy for the overall stock market",
};

// Diverging pair validated via the dataviz skill's validator (both pass CVD
// separation + normal-vision floor at full saturation, light & dark):
// blue #2a78d6 (positive) <-> red #e34948 (negative). Applied via alpha —
// same rgba-overlay technique MonthlyReturns.tsx already uses for its
// heatmap, so weak correlations fade toward neutral rather than needing a
// separate gray step.
const POLE_POS: [number, number, number] = [42, 120, 214];
const POLE_NEG: [number, number, number] = [227, 73, 72];

function cellBg(r: number | null): string {
  if (r == null) return "transparent";
  const t = Math.min(1, Math.abs(r));
  const alpha = 0.08 + t * 0.82;
  const [red, green, blue] = r >= 0 ? POLE_POS : POLE_NEG;
  return `rgba(${red},${green},${blue},${alpha})`;
}

function cellText(r: number | null): string {
  if (r == null) return "var(--color-text-muted)";
  if (Math.abs(r) >= 0.5) return "#fff";
  return r >= 0 ? "#2a78d6" : "#e34948";
}

function fmtR(r: number | null): string {
  if (r == null) return "—";
  return (r >= 0 ? "+" : "−") + Math.abs(r).toFixed(2);
}

function describeR(r: number | null): string {
  if (r == null) return "not enough overlapping data";
  const abs = Math.abs(r);
  const strength = abs >= 0.7 ? "strongly" : abs >= 0.4 ? "moderately" : abs >= 0.15 ? "weakly" : "barely";
  const direction = r >= 0 ? "move together" : "move in opposite directions";
  return abs < 0.05 ? "little to no relationship" : `${strength} ${direction}`;
}

export function CorrelationMatrix() {
  const { t } = useTranslation();
  const [selectedWindow, setSelectedWindow] = useState<CorrelationWindow>("90d");
  const [data, setData] = useState<CorrelationMatrixData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    correlation.getMatrix(selectedWindow)
      .then(m => { if (!cancelled) { setData(m); setLoading(false); } })
      .catch(() => {
        if (cancelled) return;
        setError(t("correlationMatrix.error"));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedWindow, t]);

  const unavailableLabel = useMemo(() => {
    if (!data?.unavailable.length) return null;
    return data.unavailable.map(a => a).join(", ");
  }, [data]);

  const whyPoints = t("correlationMatrix.whyPoints", { returnObjects: true }) as string[];

  return (
    <div className="corr-wrap">
      <p className="corr-subtitle">{t("correlationMatrix.subtitle")}</p>
      <div className="corr-why">
        <div className="corr-why-title">{t("correlationMatrix.whyTitle")}</div>
        <ul className="corr-why-list">
          {whyPoints.map((point, i) => <li key={i}>{point}</li>)}
        </ul>
      </div>
      <div className="corr-header">
        <div className="corr-window-toggle">
          {WINDOWS.map(w => (
            <button
              key={w.id}
              className={`corr-window-btn${w.id === selectedWindow ? " corr-window-btn--active" : ""}`}
              onClick={() => setSelectedWindow(w.id)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="corr-loading">
          <div className="corr-spinner" />
          <span>{t("correlationMatrix.loading")}</span>
        </div>
      )}

      {!loading && error && <div className="corr-error">{error}</div>}

      {!loading && !error && data && (
        <>
          {unavailableLabel && (
            <div className="corr-unavailable">
              {t("correlationMatrix.unavailable", { assets: unavailableLabel })}
            </div>
          )}

          <div className="corr-scroll">
            <table className="corr-table">
              <thead>
                <tr>
                  <th className="corr-th corr-th--corner" />
                  {CORRELATION_ASSETS.map(a => (
                    <th key={a} className="corr-th" title={ASSET_NAMES[a]}>{a}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CORRELATION_ASSETS.map(rowAsset => (
                  <tr key={rowAsset}>
                    <th className="corr-row-label" title={ASSET_NAMES[rowAsset]}>{rowAsset}</th>
                    {CORRELATION_ASSETS.map(colAsset => {
                      const isDiag = rowAsset === colAsset;
                      const cell = data.cells[`${rowAsset}:${colAsset}`];
                      const r = cell?.r ?? null;
                      return (
                        <td key={colAsset} className="corr-cell-wrap">
                          <div
                            className={`corr-cell${isDiag ? " corr-cell--diag" : ""}`}
                            style={isDiag ? undefined : { background: cellBg(r), color: cellText(r) }}
                            title={
                              isDiag
                                ? `${ASSET_NAMES[rowAsset]}`
                                : `${rowAsset} vs ${colAsset}: r = ${fmtR(r)} — ${describeR(r)}${cell ? ` (based on ${cell.n} overlapping days)` : ""}`
                            }
                          >
                            {isDiag ? "1.00" : fmtR(r)}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="corr-legend">
            <span className="corr-legend-label">{t("correlationMatrix.legendNeg")}</span>
            <div className="corr-legend-bar" />
            <span className="corr-legend-label">{t("correlationMatrix.legendPos")}</span>
          </div>
          <p className="corr-legend-caption">{t("correlationMatrix.legendCaption")}</p>
        </>
      )}
    </div>
  );
}
