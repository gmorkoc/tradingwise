import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { deribit, type OptionCurrency, type OptionLeg } from "../services/deribit";
import "../styles/OptionsAnalytics.css";

const CURRENCIES: OptionCurrency[] = ["BTC", "ETH"];

interface StrikeRow { strike: number; callOI: number; putOI: number; }

function fmtStrike(p: number): string {
  return p >= 1000
    ? p.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : p.toFixed(1);
}

function fmtOI(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + "K";
  return v.toFixed(1);
}

function fmtPct(v: number): string {
  return v.toFixed(1) + "%";
}

function groupByStrike(legs: OptionLeg[]): StrikeRow[] {
  const map = new Map<number, StrikeRow>();
  for (const leg of legs) {
    const row = map.get(leg.strike) ?? { strike: leg.strike, callOI: 0, putOI: 0 };
    if (leg.type === "call") row.callOI += leg.openInterest;
    else row.putOI += leg.openInterest;
    map.set(leg.strike, row);
  }
  return Array.from(map.values()).sort((a, b) => a.strike - b.strike);
}

function drawChart(
  ctx: CanvasRenderingContext2D,
  logW: number, logH: number,
  rows: StrikeRow[], maxPain: number, spot: number,
  isDark: boolean,
) {
  ctx.fillStyle = isDark ? "#060d1a" : "#f0f4f8";
  ctx.fillRect(0, 0, logW, logH);

  if (!rows.length) {
    ctx.fillStyle = isDark ? "#334155" : "#94a3b8";
    ctx.font = "13px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Fetching options data…", logW / 2, logH / 2);
    return;
  }

  const PAD = { top: 40, right: 52, bottom: 46, left: 16 };
  const cW = logW - PAD.left - PAD.right;
  const cH = logH - PAD.top - PAD.bottom;
  const cB = PAD.top + cH;
  if (cW <= 0 || cH <= 0) return;

  const maxOI = Math.max(...rows.map(r => Math.max(r.callOI, r.putOI)), 1);
  const slot = cW / rows.length;
  const barW = Math.max(1, slot * 0.38);

  const xForIndex = (i: number) => PAD.left + (i + 0.5) * slot;
  const yForOI = (oi: number) => cB - (oi / maxOI) * cH;

  // ── Grid ──────────────────────────────────────────────────────────────
  ctx.setLineDash([2, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = isDark ? "rgba(30,41,59,0.9)" : "rgba(203,213,225,0.9)";
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const y = cB - frac * cH;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
  }
  ctx.setLineDash([]);

  // ── Bars: calls (green) + puts (red) per strike ─────────────────────
  rows.forEach((row, i) => {
    const cx = xForIndex(i);
    if (row.callOI > 0) {
      const y = yForOI(row.callOI);
      ctx.fillStyle = isDark ? "rgba(34,197,94,0.78)" : "rgba(21,128,61,0.78)";
      ctx.fillRect(cx - barW - 1, y, barW, cB - y);
    }
    if (row.putOI > 0) {
      const y = yForOI(row.putOI);
      ctx.fillStyle = isDark ? "rgba(239,68,68,0.78)" : "rgba(185,28,28,0.78)";
      ctx.fillRect(cx + 1, y, barW, cB - y);
    }
  });

  // ── Marker lines (max pain dashed, spot solid) ──────────────────────
  const strikeToX = (strike: number) => {
    // Interpolate between the two nearest strikes so spot rarely sits
    // exactly on a listed strike.
    if (strike <= rows[0].strike) return xForIndex(0);
    if (strike >= rows[rows.length - 1].strike) return xForIndex(rows.length - 1);
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i], b = rows[i + 1];
      if (strike >= a.strike && strike <= b.strike) {
        const frac = (strike - a.strike) / (b.strike - a.strike || 1);
        return xForIndex(i) + frac * slot;
      }
    }
    return xForIndex(0);
  };

  const drawMarker = (x: number, color: string, dashed: boolean, label: string, badgeY: number) => {
    ctx.save();
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, cB); ctx.stroke();
    ctx.restore();

    ctx.font = "bold 10px Inter, system-ui, sans-serif";
    const tw = ctx.measureText(label).width + 12;
    const bx = Math.min(Math.max(x - tw / 2, PAD.left), PAD.left + cW - tw);
    ctx.fillStyle = isDark ? "rgba(15,23,42,0.92)" : "rgba(241,245,249,0.95)";
    ctx.beginPath();
    ctx.roundRect(bx, badgeY, tw, 20, 4);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, badgeY + 10);
  };

  const maxPainColor = isDark ? "#f59e0b" : "#b45309";
  const spotColor    = isDark ? "#38bdf8" : "#0369a1";
  drawMarker(strikeToX(maxPain), maxPainColor, true, `Max Pain ${fmtStrike(maxPain)}`, 4);
  drawMarker(strikeToX(spot), spotColor, false, `Spot ${fmtStrike(spot)}`, 26);

  // ── X-axis strike labels (sparse, based on measured width) ──────────
  ctx.fillStyle = isDark ? "#475569" : "#94a3b8";
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const labelW = ctx.measureText(fmtStrike(rows[rows.length - 1].strike)).width + 10;
  const step = Math.max(1, Math.ceil(labelW / slot));
  for (let i = 0; i < rows.length; i += step) {
    const x = xForIndex(i);
    ctx.fillText(fmtStrike(rows[i].strike), x, cB + 7);
    ctx.strokeStyle = isDark ? "rgba(30,41,59,0.8)" : "rgba(203,213,225,0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, cB); ctx.lineTo(x, cB + 4); ctx.stroke();
  }

  // ── Y-axis OI labels ──────────────────────────────────────────────────
  ctx.fillStyle = isDark ? "#475569" : "#94a3b8";
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const y = cB - frac * cH;
    ctx.fillText(fmtOI(frac * maxOI), PAD.left + cW + 4, y);
  }

  // ── Axis baseline ─────────────────────────────────────────────────────
  ctx.strokeStyle = isDark ? "#1e293b" : "#e2e8f0";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.left, cB);
  ctx.lineTo(PAD.left + cW, cB);
  ctx.stroke();
}

export function OptionsAnalytics() {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [currency, setCurrency] = useState<OptionCurrency>("BTC");
  const [spot, setSpot] = useState(0);
  const [expiries, setExpiries] = useState<{ expiryMs: number; label: string; legs: OptionLeg[]; totalOI: number }[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    deribit.getOptionsSnapshot(currency)
      .then(snap => {
        if (cancelled) return;
        setSpot(snap.spot);
        setExpiries(snap.expiries);
        setUpdatedAt(snap.fetchedAt);
        setSelectedExpiry(prev => {
          if (prev != null && snap.expiries.some(e => e.expiryMs === prev)) return prev;
          return deribit.pickDefaultExpiry(snap.expiries)?.expiryMs ?? null;
        });
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t("optionsAnalytics.error"));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [currency, t]);

  const selectedGroup = useMemo(
    () => expiries.find(e => e.expiryMs === selectedExpiry) ?? null,
    [expiries, selectedExpiry],
  );

  const stats = useMemo(
    () => selectedGroup ? deribit.computeExpiryStats(selectedGroup.legs, spot) : null,
    [selectedGroup, spot],
  );

  const rows = useMemo(
    () => selectedGroup ? groupByStrike(selectedGroup.legs) : [],
    [selectedGroup],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stats) return;
    const dpr = window.devicePixelRatio || 1;
    const logW = canvas.offsetWidth;
    const logH = canvas.offsetHeight;
    if (!logW || !logH) return;
    if (canvas.width !== Math.round(logW * dpr) || canvas.height !== Math.round(logH * dpr)) {
      canvas.width = Math.round(logW * dpr);
      canvas.height = Math.round(logH * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const isDark = document.documentElement.dataset.theme !== "light";
    drawChart(ctx, logW, logH, rows, stats.maxPain, spot, isDark);
  }, [rows, stats, spot]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => { draw(); }, [draw]);

  const whyPoints = t("optionsAnalytics.whyPoints", { returnObjects: true }) as string[];

  return (
    <div className="oa-wrap">
      <p className="oa-subtitle">{t("optionsAnalytics.subtitle")}</p>
      <div className="oa-why">
        <div className="oa-why-title">{t("optionsAnalytics.whyTitle")}</div>
        <ul className="oa-why-list">
          {whyPoints.map((point, i) => <li key={i}>{point}</li>)}
        </ul>
      </div>
      <div className="oa-header">
        <div className="oa-currency-toggle">
          {CURRENCIES.map(c => (
            <button
              key={c}
              className={`oa-currency-btn${c === currency ? " oa-currency-btn--active" : ""}`}
              onClick={() => setCurrency(c)}
            >
              {c}
            </button>
          ))}
        </div>
        {expiries.length > 0 && (
          <div className="oa-expiry-row">
            {expiries.map(e => (
              <button
                key={e.expiryMs}
                className={`oa-expiry-btn${e.expiryMs === selectedExpiry ? " oa-expiry-btn--active" : ""}`}
                onClick={() => setSelectedExpiry(e.expiryMs)}
                title={`Total OI: ${fmtOI(e.totalOI)}`}
              >
                {e.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && (
        <div className="oa-loading">
          <div className="oa-spinner" />
          <span>{t("optionsAnalytics.loading")}</span>
        </div>
      )}

      {!loading && error && <div className="oa-error">{error}</div>}

      {!loading && !error && stats && (
        <>
          <div className="oa-stats">
            <div className="oa-stat" title={t("optionsAnalytics.maxPainDesc")}>
              <span className="oa-stat-label">{t("optionsAnalytics.maxPain")} <span className="oa-info-dot">?</span></span>
              <span className="oa-stat-value">{fmtStrike(stats.maxPain)}</span>
            </div>
            <div className="oa-stat" title={t("optionsAnalytics.putCallRatioDesc")}>
              <span className="oa-stat-label">{t("optionsAnalytics.putCallRatio")} <span className="oa-info-dot">?</span></span>
              <span className="oa-stat-value">{stats.putCallRatio.toFixed(2)}</span>
            </div>
            <div className="oa-stat" title={t("optionsAnalytics.atmIvDesc")}>
              <span className="oa-stat-label">{t("optionsAnalytics.atmIv")} <span className="oa-info-dot">?</span></span>
              <span className="oa-stat-value">{stats.atmIv != null ? fmtPct(stats.atmIv) : "—"}</span>
            </div>
            <div className="oa-stat" title={t("optionsAnalytics.totalOIDesc")}>
              <span className="oa-stat-label">{t("optionsAnalytics.totalOI")} <span className="oa-info-dot">?</span></span>
              <span className="oa-stat-value">{fmtOI(stats.totalOI)}</span>
            </div>
          </div>

          <canvas ref={canvasRef} className="oa-canvas" />
          <p className="oa-chart-caption">{t("optionsAnalytics.chartCaption")}</p>

          <div className="oa-footer">
            <span className="oa-legend-call">■ {t("optionsAnalytics.calls")}</span>
            <span className="oa-legend-put">■ {t("optionsAnalytics.puts")}</span>
            <span className="oa-legend-src">
              Deribit · {updatedAt ? `${Math.max(0, Math.round((Date.now() - updatedAt) / 60000))}m ago` : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
