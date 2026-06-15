import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FearGreedData } from "../services/feargreed";
import "../styles/FearGreedGauge.css";

/* ── Gauge geometry ─────────────────────────────────────────────────────── */
const CX = 120, CY = 118, R = 100, NEEDLE_R = 88;

function toRad(deg: number) { return (deg * Math.PI) / 180; }
function valToAngle(v: number) { return 180 - v * 1.8; }

function arcPath(fromDeg: number, toDeg: number, r = R): string {
  const x1 = CX + r * Math.cos(toRad(fromDeg));
  const y1 = CY - r * Math.sin(toRad(fromDeg));
  const x2 = CX + r * Math.cos(toRad(toDeg));
  const y2 = CY - r * Math.sin(toRad(toDeg));
  const large = fromDeg - toDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const ZONES = [
  { from: 180,   to: 136.8, color: "#ef4444" },
  { from: 136.8, to: 100.8, color: "#f97316" },
  { from: 100.8, to: 81,    color: "#eab308" },
  { from: 81,    to: 46.8,  color: "#22c55e" },
  { from: 46.8,  to: 0,     color: "#15803d" },
];

// Zone labels fetched via t() inside component

function zoneColor(value: number): string {
  if (value <= 24) return "#ef4444";
  if (value <= 44) return "#f97316";
  if (value <= 55) return "#eab308";
  if (value <= 74) return "#22c55e";
  return "#15803d";
}

/* ── History mini-bars (last 7 values) ─────────────────────────────────── */
interface HistoryEntry { value: number; classification: string }

interface FearGreedExtended extends FearGreedData {
  history?: HistoryEntry[];
}

/* ── Component ──────────────────────────────────────────────────────────── */
export function FearGreedGauge() {
  const { t } = useTranslation();
  const ZONE_LABELS = [
    t("feargreed.zones.extremeFear"),
    t("feargreed.zones.fear"),
    t("feargreed.zones.neutral"),
    t("feargreed.zones.greed"),
    t("feargreed.zones.extremeGreed"),
  ];
  const [data, setData] = useState<FearGreedExtended | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("https://api.alternative.me/fng/?limit=8&format=json");
        const json = await res.json();
        const arr = json?.data;
        if (!Array.isArray(arr) || arr.length < 2) return;
        const parse = (d: { value: string; value_classification: string; timestamp: string }) => ({
          value: parseInt(d.value, 10),
          classification: d.value_classification,
          timestamp: parseInt(d.timestamp, 10),
        });
        setData({
          current:   parse(arr[0]),
          yesterday: parse(arr[1]),
          lastWeek:  parse(arr[Math.min(7, arr.length - 1)]),
          history:   arr.slice(0, 7).map((d: { value: string; value_classification: string }) => ({
            value: parseInt(d.value, 10),
            classification: d.value_classification,
          })).reverse(),
        });
      } catch {
        /* silently fail */
      } finally {
        setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (loading) return (
    <div className="fng-card">
      <div className="fng-header">
        <h3 className="fng-title">{t("feargreed.title")}</h3>
      </div>
      <div className="fng-loading">{t("feargreed.loading")}</div>
    </div>
  );

  if (!data) return null;

  const val = data.current.value;
  const color = zoneColor(val);
  const needleAngle = valToAngle(val);
  const nx = CX + NEEDLE_R * Math.cos(toRad(needleAngle));
  const ny = CY - NEEDLE_R * Math.sin(toRad(needleAngle));

  return (
    <div className="fng-card">
      <div className="fng-header">
        <h3 className="fng-title">{t("feargreed.title")}</h3>
        <span className="fng-source">alternative.me</span>
      </div>

      <div className="fng-body">
        {/* SVG gauge */}
        <div className="fng-gauge-wrap">
          <svg viewBox="0 0 240 128" className="fng-svg">
            {/* Zone background arcs */}
            {ZONES.map((z, i) => (
              <path key={i} d={arcPath(z.from, z.to)} stroke={z.color}
                strokeWidth={16} fill="none" opacity={0.22} strokeLinecap="butt" />
            ))}

            {/* Active fill arc */}
            {val > 0 && (
              <path d={arcPath(180, needleAngle)} stroke={color}
                strokeWidth={16} fill="none" strokeLinecap="round" />
            )}

            {/* Zone tick marks */}
            {[0, 24, 44, 55, 74, 100].map(v => {
              const a = toRad(valToAngle(v));
              const ix = CX + (R - 8) * Math.cos(a);
              const iy = CY - (R - 8) * Math.sin(a);
              const ox = CX + (R + 8) * Math.cos(a);
              const oy = CY - (R + 8) * Math.sin(a);
              return <line key={v} x1={ix.toFixed(2)} y1={iy.toFixed(2)}
                x2={ox.toFixed(2)} y2={oy.toFixed(2)}
                stroke="var(--color-border)" strokeWidth={1.5} />;
            })}

            {/* Zone labels */}
            {ZONE_LABELS.map((label, i) => {
              const midAngle = (ZONES[i].from + ZONES[i].to) / 2;
              const lx = CX + (R + 20) * Math.cos(toRad(midAngle));
              const ly = CY - (R + 20) * Math.sin(toRad(midAngle));
              return (
                <text key={i} x={lx.toFixed(2)} y={ly.toFixed(2)}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize="7" fontWeight="700" fill={ZONES[i].color} opacity={0.7}>
                  {label.split("\n").map((line, li) => (
                    <tspan key={li} x={lx.toFixed(2)} dy={li === 0 ? 0 : 9}>{line}</tspan>
                  ))}
                </text>
              );
            })}

            {/* Needle */}
            <line x1={CX} y1={CY} x2={nx.toFixed(2)} y2={ny.toFixed(2)}
              stroke={color} strokeWidth={2.5} strokeLinecap="round" />
            <circle cx={CX} cy={CY} r={6} fill={color} />
            <circle cx={CX} cy={CY} r={3} fill="var(--color-card-bg)" />
          </svg>

          {/* Center value */}
          <div className="fng-value-row">
            <div className="fng-number" style={{ color }}>{val}</div>
            <div className="fng-classification" style={{ color }}>{data.current.classification}</div>
          </div>
        </div>

        {/* Yesterday / Last week */}
        <div className="fng-compare">
          <div className="fng-compare-item">
            <div className="fng-compare-label">{t("feargreed.history.yesterday")}</div>
            <div className="fng-compare-val" style={{ color: zoneColor(data.yesterday.value) }}>
              {data.yesterday.value}
              <span className="fng-compare-class">{data.yesterday.classification}</span>
            </div>
          </div>
          <div className="fng-compare-item">
            <div className="fng-compare-label">{t("feargreed.history.lastWeek")}</div>
            <div className="fng-compare-val" style={{ color: zoneColor(data.lastWeek.value) }}>
              {data.lastWeek.value}
              <span className="fng-compare-class">{data.lastWeek.classification}</span>
            </div>
          </div>
        </div>

        {/* 7-day mini bar chart */}
        {data.history && data.history.length > 0 && (
          <div className="fng-history" title="7-day history (oldest → newest)">
            {data.history.map((h, i) => (
              <div key={i} className="fng-bar"
                style={{
                  height: `${(h.value / 100) * 100}%`,
                  background: zoneColor(h.value),
                  opacity: 0.5 + (i / data.history!.length) * 0.5,
                }}
                title={`${h.value} — ${h.classification}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
