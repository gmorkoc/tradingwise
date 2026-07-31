import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { coinglass, CoinSymbol } from "../services/coinglass";
import {
  getAstroReading,
  getAstroPriceCurve,
  invertCurveSegment,
  AstroCurvePoint,
} from "../services/astro";
import "../styles/AstroSuggestions.css";

const BIAS_LABEL: Record<string, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
};

const STEPS_PER_DAY = 48;
const DAY_MS = 86_400_000;

interface RealPoint {
  time: number;
  price: number;
}

function fmtPrice(p: number) {
  return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtHour(h: number) {
  return `${String(h).padStart(2, "0")}:00`;
}

function timeStrToMs(dayStart: number, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return dayStart + (h * 60 + (m || 0)) * 60_000;
}

function drawChart(
  ctx: CanvasRenderingContext2D,
  logW: number,
  logH: number,
  predicted: AstroCurvePoint[],
  real: RealPoint[],
  dayStart: number,
  nowMs: number | null,
  isDark: boolean,
) {
  ctx.fillStyle = isDark ? "#0b0d15" : "#f8fafc";
  ctx.fillRect(0, 0, logW, logH);

  if (!predicted.length) return;

  const PAD = { top: 14, right: 54, bottom: 20, left: 8 };
  const cW = logW - PAD.left - PAD.right;
  const cH = logH - PAD.top - PAD.bottom;
  const cB = PAD.top + cH;
  if (cW <= 0 || cH <= 0) return;

  const allPrices = predicted.map((p) => p.price).concat(real.map((p) => p.price));
  let minP = Math.min(...allPrices);
  let maxP = Math.max(...allPrices);
  const margin = (maxP - minP) * 0.12 || maxP * 0.01;
  minP -= margin;
  maxP += margin;

  const tToX = (t: number) => PAD.left + ((t - dayStart) / DAY_MS) * cW;
  const pToY = (p: number) => cB - ((p - minP) / (maxP - minP)) * cH;

  // Gridlines + price labels
  ctx.strokeStyle = isDark ? "rgba(30,41,59,0.9)" : "rgba(203,213,225,0.9)";
  ctx.fillStyle = isDark ? "#475569" : "#94a3b8";
  ctx.font = "10px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const y = PAD.top + frac * cH;
    ctx.setLineDash(frac === 0 || frac === 1 ? [] : [2, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + cW, y);
    ctx.stroke();
    const price = maxP - frac * (maxP - minP);
    ctx.fillText(fmtPrice(price), PAD.left + cW + 4, y);
  }
  ctx.setLineDash([]);

  // Hour labels every 3h
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let h = 0; h <= 24; h += 3) {
    const x = tToX(dayStart + h * 3_600_000);
    ctx.fillText(h === 24 ? "24:00" : fmtHour(h), x, cB + 4);
  }

  // Predicted curve (blue), full day
  ctx.beginPath();
  predicted.forEach((pt, i) => {
    const x = tToX(pt.time);
    const y = pToY(pt.price);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const grad = ctx.createLinearGradient(0, PAD.top, 0, cB);
  grad.addColorStop(0, isDark ? "rgba(96,165,250,0.28)" : "rgba(59,130,246,0.2)");
  grad.addColorStop(1, isDark ? "rgba(96,165,250,0.02)" : "rgba(59,130,246,0.02)");
  ctx.save();
  ctx.lineTo(tToX(predicted[predicted.length - 1].time), cB);
  ctx.lineTo(tToX(predicted[0].time), cB);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  predicted.forEach((pt, i) => {
    const x = tToX(pt.time);
    const y = pToY(pt.price);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = isDark ? "#60a5fa" : "#3b82f6";
  ctx.lineWidth = 1.75;
  ctx.stroke();

  // Real price (green), only elapsed portion
  if (real.length > 1) {
    ctx.beginPath();
    real.forEach((pt, i) => {
      const x = tToX(pt.time);
      const y = pToY(pt.price);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = isDark ? "#4ade80" : "#16a34a";
    ctx.lineWidth = 1.75;
    ctx.stroke();
  }

  // "Now" marker
  if (nowMs !== null && nowMs >= dayStart && nowMs <= dayStart + DAY_MS) {
    const x = tToX(nowMs);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = isDark ? "rgba(148,163,184,0.55)" : "rgba(100,116,139,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, cB);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

interface Props {
  coin: CoinSymbol;
  theme: "dark" | "light";
  currentPrice?: number;
  onClose: () => void;
}

export function AstroSuggestions({ coin, theme, currentPrice, onClose }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [dayOffset, setDayOffset] = useState(0); // days from today, local calendar
  const [invertEnabled, setInvertEnabled] = useState(false);
  const [invertStart, setInvertStart] = useState("00:00");
  const [invertEnd, setInvertEnd] = useState("23:59");
  const [realCandles, setRealCandles] = useState<RealPoint[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    coinglass.getCandles(coin, "1h", 24 * 8).then((candles) => {
      if (cancelled) return;
      setRealCandles(candles.map((c) => ({ time: c.time * 1000, price: c.close })));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [coin]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const selectedDay = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [dayOffset]);

  const isToday = dayOffset === 0;
  const dayStart = selectedDay.getTime();

  const anchorPrice = useMemo(() => {
    const inDay = realCandles.filter((c) => c.time >= dayStart && c.time < dayStart + DAY_MS);
    if (inDay.length) return inDay[0].price;
    if (realCandles.length) return realCandles[realCandles.length - 1].price;
    return currentPrice ?? 60000;
  }, [realCandles, dayStart, currentPrice]);

  const predicted = useMemo(() => {
    const curve = getAstroPriceCurve(selectedDay, anchorPrice, STEPS_PER_DAY);
    if (!invertEnabled) return curve;
    return invertCurveSegment(
      curve,
      timeStrToMs(dayStart, invertStart),
      timeStrToMs(dayStart, invertEnd),
    );
  }, [selectedDay, anchorPrice, invertEnabled, invertStart, invertEnd, dayStart]);

  const realToday = useMemo(
    () => realCandles.filter((c) => c.time >= dayStart && c.time <= (isToday ? Date.now() : dayStart + DAY_MS)),
    [realCandles, dayStart, isToday],
  );

  const reading = useMemo(() => getAstroReading(selectedDay), [selectedDay]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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
    drawChart(ctx, logW, logH, predicted, realToday, dayStart, isToday ? Date.now() : null, theme === "dark");
  }, [predicted, realToday, dayStart, isToday, theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    draw();
    return () => ro.disconnect();
  }, [draw]);

  const open = predicted[0]?.price ?? anchorPrice;
  const close = predicted[predicted.length - 1]?.price ?? anchorPrice;
  const low = predicted.length ? Math.min(...predicted.map((p) => p.price)) : anchorPrice;
  const high = predicted.length ? Math.max(...predicted.map((p) => p.price)) : anchorPrice;

  const dayLabel = selectedDay.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="astro-modal-backdrop" onClick={onClose}>
      <div
        className="astro-modal-panel"
        onClick={(e) => e.stopPropagation()}
      >
      <div className="astro-header">
        <span className="astro-title">
          <span className="astro-title-icon">🔮</span>
          {t("astro.title", "Astro Suggestions")}
        </span>
        <span className={`astro-bias astro-bias--${reading.bias}`}>
          {BIAS_LABEL[reading.bias]}
        </span>
        <button className="astro-modal-close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <p className="astro-disclaimer">
        {t(
          "astro.disclaimer",
          "For fun, not financial advice — the curve's shape comes from real planetary transits vs Bitcoin's genesis-block \"birth chart,\" but the price mapping is illustrative, not a real forecast.",
        )}
      </p>

      <div className="astro-nav">
        <button className="astro-nav-btn" onClick={() => setDayOffset((d) => d - 1)}>
          ← {t("astro.prevDay", "Prev Day")}
        </button>
        <span className="astro-day-label">{dayLabel}{isToday ? ` (${t("astro.today", "Today")})` : ""}</span>
        <button className="astro-nav-btn" onClick={() => setDayOffset((d) => d + 1)}>
          {t("astro.nextDay", "Next Day")} →
        </button>
      </div>

      <canvas ref={canvasRef} className="astro-canvas" />

      <div className="astro-ohlc">
        <span>{t("astro.open", "Open")} <strong>${fmtPrice(open)}</strong></span>
        <span>{t("astro.low", "Low")} <strong className="astro-neg">${fmtPrice(low)}</strong></span>
        <span>{t("astro.high", "High")} <strong className="astro-pos">${fmtPrice(high)}</strong></span>
        <span>{t("astro.close", "Close")} <strong>${fmtPrice(close)}</strong></span>
      </div>

      <div className="astro-invert-row">
        <label className="astro-invert-toggle">
          <input
            type="checkbox"
            checked={invertEnabled}
            onChange={(e) => setInvertEnabled(e.target.checked)}
          />
          {t("astro.invertSegment", "Invert segment")}
        </label>
        <input
          type="time"
          className="astro-time-input"
          value={invertStart}
          disabled={!invertEnabled}
          onChange={(e) => setInvertStart(e.target.value)}
        />
        <span className="astro-invert-sep">–</span>
        <input
          type="time"
          className="astro-time-input"
          value={invertEnd}
          disabled={!invertEnabled}
          onChange={(e) => setInvertEnd(e.target.value)}
        />
      </div>

      <button
        className="astro-expand-btn"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {expanded ? t("astro.hideFactors", "Hide factors") : t("astro.showFactors", "Show contributing transits")}
        <span className={`astro-chevron${expanded ? " astro-chevron--open" : ""}`}>▾</span>
      </button>

      {expanded && (
        <ul className="astro-factors">
          {reading.factors.map((f, i) => (
            <li key={i} className={f.valence >= 0 ? "astro-factor--pos" : "astro-factor--neg"}>
              {f.description}
            </li>
          ))}
          {reading.factors.length === 0 && (
            <li className="astro-factor--pos">
              {t("astro.noAspects", "No notable transits to BTC's genesis chart today.")}
            </li>
          )}
        </ul>
      )}
      </div>
    </div>
  );
}
