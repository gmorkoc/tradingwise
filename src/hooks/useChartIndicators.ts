// Draws the shared indicator catalog (services/indicatorLibrary.ts) on any
// lightweight-charts chart. Overlays go on the price pane; each "pane"
// indicator gets its own panel under the price (LWC v5 panes).
//
//   const [enabled, toggle] = useIndicatorSelection("pc");
//   useChartIndicators({ chart: chartRef.current, mainSeries, getCandles, enabled, isDark });
//
// Pass the live chart/series (from refs) — the hook rebuilds only when the
// chart object itself changes (theme switch etc.), not on every redraw.
//
// It follows the chart on its own: whenever the main series' data changes
// (setData or a live update) it recomputes from getCandles().
import { useCallback, useEffect, useRef, useState } from "react";
import {
  HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type ISeriesApi, type SeriesType, type UTCTimestamp,
} from "lightweight-charts";
import { toCols, type IndCandle, type IndLine } from "../services/indicatorLibrary";
import { getIndicatorDef, onCustomIndicatorsChange, startCustomIndicatorSync } from "../services/customIndicators";

// ── Selection (persisted per chart family, synced across instances) ──────
const SEL_EVENT = "chart-indicators-changed";
const selKey = (scope: string) => `chartIndicatorsV1:${scope}`;

function readSel(scope: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(selKey(scope)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id) => typeof id === "string" && getIndicatorDef(id)) : [];
  } catch {
    return [];
  }
}

export function useIndicatorSelection(scope: string): [string[], (id: string) => void, () => void] {
  const [enabled, setEnabled] = useState<string[]>(() => readSel(scope));
  useEffect(() => {
    const onChange = (e: Event) => {
      if ((e as CustomEvent).detail === scope) setEnabled(readSel(scope));
    };
    window.addEventListener(SEL_EVENT, onChange);
    return () => window.removeEventListener(SEL_EVENT, onChange);
  }, [scope]);
  const toggle = useCallback((id: string) => {
    const cur = readSel(scope);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    try { localStorage.setItem(selKey(scope), JSON.stringify(next)); } catch { /* ignore */ }
    setEnabled(next);
    window.dispatchEvent(new CustomEvent(SEL_EVENT, { detail: scope }));
  }, [scope]);
  // Turn every catalog indicator off for this chart family.
  const clear = useCallback(() => {
    try { localStorage.setItem(selKey(scope), "[]"); } catch { /* ignore */ }
    setEnabled([]);
    window.dispatchEvent(new CustomEvent(SEL_EVENT, { detail: scope }));
  }, [scope]);
  return [enabled, toggle, clear];
}

// ── Rendering ────────────────────────────────────────────────────────────
interface Drawn {
  id: string;
  lines: { line: IndLine; series: ISeriesApi<SeriesType> }[];
}

interface Opts {
  chart: IChartApi | null;
  /** The chart's main candle series — its data changes trigger a recompute. */
  mainSeries: ISeriesApi<SeriesType> | null;
  getCandles: () => IndCandle[];
  enabled: string[];
  isDark: boolean;
  /** Height of each indicator panel under the price, px. */
  paneHeight?: number;
}

const toTime = (t: number) => t as UTCTimestamp;

// Synthetic candles, only used to learn how many lines each indicator draws.
const SAMPLE: IndCandle[] = Array.from({ length: 150 }, (_, i) => {
  const c = 100 + Math.sin(i / 6) * 5 + i * 0.05;
  return { time: i * 60, open: c - 0.3, high: c + 1, low: c - 1, close: c, volume: 1000 + (i % 7) * 50 };
});
const SAMPLE_COLS = toCols(SAMPLE);

export function useChartIndicators({ chart, mainSeries, getCandles, enabled, isDark, paneHeight = 90 }: Opts) {
  const drawnRef = useRef<{ chart: IChartApi | null; items: Drawn[] }>({ chart: null, items: [] });
  const getCandlesRef = useRef(getCandles);
  getCandlesRef.current = getCandles;
  const lastFillRef = useRef(0);
  const pendingRef = useRef<number | null>(null);

  const fill = useCallback(() => {
    const { items } = drawnRef.current;
    if (!items.length) return;
    const candles = getCandlesRef.current();
    if (candles.length < 3) return;
    const cols = toCols(candles);
    const times = candles.map((c) => c.time);
    const step = times.length > 1 ? times[times.length - 1] - times[times.length - 2] : 60;
    for (const item of items) {
      const def = getIndicatorDef(item.id);
      if (!def) continue;
      let lines: IndLine[];
      try { lines = def.compute(cols); } catch { continue; }
      item.lines.forEach(({ series }, i) => {
        const line = lines[i];
        if (!line) return;
        const data: { time: UTCTimestamp; value: number; color?: string }[] = [];
        for (let k = def.warmup; k < line.values.length; k++) {
          const v = line.values[k];
          if (!Number.isFinite(v)) continue;
          const t = k < times.length ? times[k] : times[times.length - 1] + step * (k - times.length + 1);
          const point: { time: UTCTimestamp; value: number; color?: string } = { time: toTime(t), value: v };
          if (line.colors?.[k]) point.color = line.colors[k];
          else if (line.style === "histogram") point.color = v >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)";
          data.push(point);
        }
        try { series.setData(data as never); } catch { /* chart gone */ }
      });
    }
    lastFillRef.current = Date.now();
  }, []);

  // Live ticks can fire many times a second — recompute at most ~1/s.
  const scheduleFill = useCallback(() => {
    if (pendingRef.current != null) return;
    const wait = Math.max(0, 1000 - (Date.now() - lastFillRef.current));
    pendingRef.current = window.setTimeout(() => {
      pendingRef.current = null;
      fill();
    }, wait);
  }, [fill]);

  const enabledKey = enabled.join(",");
  // A saved AI indicator was added/refined/deleted (here or synced from the
  // account) — rebuild with the new recipes.
  const [customVersion, setCustomVersion] = useState(0);
  useEffect(() => {
    startCustomIndicatorSync();
    return onCustomIndicatorsChange(() => setCustomVersion((v) => v + 1));
  }, []);

  // (Re)build series whenever the selection or the chart instance changes.
  useEffect(() => {
    const prev = drawnRef.current;
    if (prev.chart && prev.chart === chart) {
      for (const item of prev.items) for (const { series } of item.lines) {
        try { prev.chart.removeSeries(series); } catch { /* ignore */ }
      }
      // Drop now-empty indicator panels (pane 0 is the price).
      try {
        const panes = prev.chart.panes();
        for (let i = panes.length - 1; i >= 1; i--) {
          if (panes[i].getSeries().length === 0) prev.chart.removePane(i);
        }
      } catch { /* ignore */ }
    }
    drawnRef.current = { chart, items: [] };
    if (!chart) return;

    const items: Drawn[] = [];
    for (const id of enabled) {
      const def = getIndicatorDef(id);
      if (!def) continue;
      let pane = 0;
      if (def.kind === "pane") {
        try { pane = chart.panes().length; } catch { pane = 1; }
      }
      let sample: IndLine[] = [];
      try { sample = def.compute(SAMPLE_COLS); } catch { sample = []; }
      const lines: Drawn["lines"] = [];
      sample.forEach((line, i) => {
        const common = {
          priceLineVisible: false,
          lastValueVisible: def.kind === "pane" && i === sample.length - 1,
        };
        const series = line.style === "histogram"
          ? chart.addSeries(HistogramSeries, { ...common, color: line.color, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } }, pane)
          : chart.addSeries(LineSeries, {
              ...common,
              color: line.color,
              lineWidth: def.kind === "overlay" ? 1 : 2,
              lineStyle: line.style === "dashed" ? LineStyle.Dashed : LineStyle.Solid,
              lineVisible: line.style !== "dots",
              pointMarkersVisible: line.style === "dots",
              pointMarkersRadius: 1,
              crosshairMarkerVisible: false,
            }, pane);
        lines.push({ line, series });
      });
      if (def.kind === "pane" && lines[0]) {
        for (const lvl of def.levels ?? []) {
          lines[0].series.createPriceLine({
            price: lvl,
            color: isDark ? "rgba(148,163,184,0.35)" : "rgba(100,116,139,0.35)",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
          });
        }
        try { chart.panes()[pane]?.setHeight(paneHeight); } catch { /* ignore */ }
      }
      items.push({ id, lines });
    }
    drawnRef.current = { chart, items };
    fill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, enabledKey, isDark, customVersion]);

  // Recompute when the main series' data changes.
  useEffect(() => {
    if (!mainSeries) return;
    const handler = () => scheduleFill();
    mainSeries.subscribeDataChanged(handler);
    return () => {
      try { mainSeries.unsubscribeDataChanged(handler); } catch { /* ignore */ }
    };
  }, [mainSeries, scheduleFill]);

  useEffect(() => () => { if (pendingRef.current != null) window.clearTimeout(pendingRef.current); }, []);
}
