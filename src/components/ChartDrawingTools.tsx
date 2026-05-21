import { useState, useRef, useCallback, useEffect } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { CandleDataPoint } from '../services/coinglass';
import '../styles/ChartDrawingTools.css';

export type DrawingTool =
  | 'cursor' | 'brush' | 'trendline' | 'hline' | 'vline'
  | 'rect' | 'fib' | 'text' | 'eraser';

interface ChartPt { price: number; time: number }
interface ScreenPt { x: number; y: number }

interface Drawing {
  id: string;
  type: DrawingTool;
  pts: ChartPt[];
  // brush strokes also cache screen coords (rebuilt on zoom/pan)
  screenCache?: ScreenPt[];
  text?: string;
  color: string;
}

interface Props {
  chartRef: React.RefObject<IChartApi | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seriesRef: React.RefObject<any>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  candlesRef: React.RefObject<CandleDataPoint[]>;
  visible: boolean;
}

const TOOL_CLICKS: Record<DrawingTool, number> = {
  cursor: 0, brush: 0, trendline: 2, hline: 1, vline: 1,
  rect: 2, fib: 2, text: 1, eraser: 0,
};

const MIN_BRUSH_PX = 4; // skip points closer than this — keeps stroke counts sane

const FIB_LEVELS = [
  { r: 0,     l: '0',     c: 'rgba(251,191,36,0.9)'  },
  { r: 0.236, l: '0.236', c: 'rgba(167,139,250,0.9)' },
  { r: 0.382, l: '0.382', c: 'rgba(52,211,153,0.9)'  },
  { r: 0.5,   l: '0.5',   c: 'rgba(251,113,133,0.9)' },
  { r: 0.618, l: '0.618', c: 'rgba(56,189,248,0.9)'  },
  { r: 0.786, l: '0.786', c: 'rgba(249,115,22,0.9)'  },
  { r: 1,     l: '1',     c: 'rgba(251,191,36,0.9)'  },
];

// ── Icons ────────────────────────────────────────────────────────────────────

function Icon({ d, stroke = false }: { d: string; stroke?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16"
      fill={stroke ? 'none' : 'currentColor'}
      stroke={stroke ? 'currentColor' : 'none'}
      strokeWidth={stroke ? 2 : 0}
      strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', color: 'inherit' }}
    >
      <path d={d} />
    </svg>
  );
}
function IconMulti({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16"
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', color: 'inherit' }}
    >
      {children}
    </svg>
  );
}

const TOOL_LIST: { id: DrawingTool; label: string; icon: JSX.Element }[] = [
  { id: 'cursor',    label: 'Cursor',       icon: <Icon d="M4 2l16 10-7.5 2L9 22z" /> },
  { id: 'brush',     label: 'Free Brush',
    icon: <IconMulti>
      <path d="M12 19c0 1.1-.9 2-2 2s-2-.9-2-2 2-4 2-4 2 2.9 2 4z" fill="currentColor" stroke="none"/>
      <path d="M9.5 12.5L3 6l3-3 13 7-9.5 2.5z"/>
    </IconMulti>,
  },
  { id: 'trendline', label: 'Trend Line',
    icon: <IconMulti>
      <line x1="4" y1="20" x2="20" y2="4"/>
      <circle cx="4" cy="20" r="2" fill="currentColor" stroke="none"/>
      <circle cx="20" cy="4" r="2" fill="currentColor" stroke="none"/>
    </IconMulti>,
  },
  { id: 'hline',  label: 'Horizontal Line',
    icon: <IconMulti><line x1="2" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></IconMulti>,
  },
  { id: 'vline',  label: 'Vertical Line',
    icon: <IconMulti><line x1="12" y1="2" x2="12" y2="22"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></IconMulti>,
  },
  { id: 'rect',   label: 'Rectangle',   icon: <IconMulti><rect x="3" y="6" width="18" height="12" rx="1"/></IconMulti> },
  { id: 'fib',    label: 'Fibonacci',
    icon: <IconMulti>
      <line x1="2" y1="4"  x2="22" y2="4"/>
      <line x1="2" y1="9"  x2="22" y2="9"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <line x1="2" y1="15" x2="22" y2="15"/>
      <line x1="2" y1="20" x2="22" y2="20"/>
    </IconMulti>,
  },
  { id: 'text',   label: 'Text',    icon: <Icon d="M5 4v3h5.5v12h3V7H19V4z" /> },
  { id: 'eraser', label: 'Eraser',
    icon: <IconMulti><path d="M20 20H7L3 16l11-11 7 7-1 8z"/><line x1="6" y1="14" x2="14" y2="6"/></IconMulti>,
  },
];

const MAGNET_ICON = <IconMulti>
  <path d="M6 2v8a6 6 0 0012 0V2"/><line x1="3" y1="2" x2="9" y2="2"/><line x1="15" y1="2" x2="21" y2="2"/>
</IconMulti>;
const TRASH_ICON = <IconMulti>
  <polyline points="3 6 5 6 21 6"/>
  <path d="M19 6l-1 14H6L5 6"/>
  <line x1="10" y1="11" x2="10" y2="17"/>
  <line x1="14" y1="11" x2="14" y2="17"/>
  <path d="M9 6V4h6v2"/>
</IconMulti>;

// ── Component ────────────────────────────────────────────────────────────────

export function ChartDrawingTools({ chartRef, seriesRef, containerRef, candlesRef, visible }: Props) {
  const [tool, setTool]         = useState<DrawingTool>('cursor');
  const [magnet, setMagnet]     = useState(false);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [pendingPts, setPendingPts] = useState<ChartPt[]>([]);
  const [chartRect, setChartRect]   = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const drawingsRef      = useRef<Drawing[]>([]);
  const pendingRef       = useRef<ChartPt[]>([]);
  const mousePosRef      = useRef<ScreenPt | null>(null);
  const toolRef          = useRef<DrawingTool>('cursor');
  const magnetRef        = useRef(false);
  const rafRef           = useRef<number>(0);
  const chartRectRef     = useRef<typeof chartRect>(null);
  const rectRafRef       = useRef<number>(0);
  // Brush: accumulate raw screen pixels during drag — no chart API calls per frame
  const brushActiveRef   = useRef(false);
  const brushScreenRef   = useRef<ScreenPt[]>([]); // screen-space live buffer
  const handlePointRef   = useRef<((sx: number, sy: number) => void) | null>(null);

  useEffect(() => { drawingsRef.current = drawings;  }, [drawings]);
  useEffect(() => { pendingRef.current  = pendingPts; }, [pendingPts]);
  useEffect(() => { toolRef.current     = tool;       }, [tool]);
  useEffect(() => { magnetRef.current   = magnet;     }, [magnet]);

  // ── Track chart rect (RAF-throttled) ─────────────────────────────────────

  const updateRect = useCallback(() => {
    const el = containerRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const next = { top: r.top, left: r.left, width: r.width, height: r.height };
    chartRectRef.current = next;
    setChartRect(next);
  }, [containerRef]);

  const scheduleRectUpdate = useCallback(() => {
    cancelAnimationFrame(rectRafRef.current);
    rectRafRef.current = requestAnimationFrame(updateRect);
  }, [updateRect]);

  useEffect(() => {
    if (!visible) return;
    updateRect();
    const ro = new ResizeObserver(scheduleRectUpdate);
    const el = containerRef.current;
    if (el) ro.observe(el);
    window.addEventListener('scroll', scheduleRectUpdate, true);
    window.addEventListener('resize', scheduleRectUpdate);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', scheduleRectUpdate, true);
      window.removeEventListener('resize', scheduleRectUpdate);
      cancelAnimationFrame(rectRafRef.current);
    };
  }, [containerRef, updateRect, scheduleRectUpdate, visible]);

  // ── Coordinate helpers ────────────────────────────────────────────────────

  const toScreen = useCallback((pt: ChartPt): ScreenPt | null => {
    const chart = chartRef.current; const series = seriesRef.current;
    if (!chart || !series) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const x = chart.timeScale().timeToCoordinate(pt.time as any);
    const y = series.priceToCoordinate(pt.price);
    if (x === null || y === null) return null;
    return { x, y };
  }, [chartRef, seriesRef]);

  const toChart = useCallback((sx: number, sy: number): ChartPt | null => {
    const chart = chartRef.current; const series = seriesRef.current;
    if (!chart || !series) return null;
    const time  = chart.timeScale().coordinateToTime(sx);
    const price = series.coordinateToPrice(sy);
    if (time === null || price === null) return null;
    return { price, time: time as number };
  }, [chartRef, seriesRef]);

  const magnetSnap = useCallback((pt: ChartPt): ChartPt => {
    if (!magnetRef.current) return pt;
    const candles = candlesRef.current;
    if (!candles?.length) return pt;
    let nearest = candles[0];
    let minD = Math.abs((candles[0].time as number) - pt.time);
    for (const c of candles) {
      const d = Math.abs((c.time as number) - pt.time);
      if (d < minD) { minD = d; nearest = c; }
    }
    const ohlc = [nearest.open, nearest.high, nearest.low, nearest.close];
    let snap = ohlc[0]; let minPD = Math.abs(ohlc[0] - pt.price);
    for (const p of ohlc) { const d = Math.abs(p - pt.price); if (d < minPD) { minPD = d; snap = p; } }
    return { price: snap, time: nearest.time as number };
  }, [candlesRef]);

  // ── Commit brush: convert throttled screen pts → chart coords once ───────

  const commitBrush = useCallback(() => {
    brushActiveRef.current = false;
    const raw = brushScreenRef.current;
    brushScreenRef.current = [];
    if (raw.length < 2) return;

    // Distance-throttle: keep only points ≥ MIN_BRUSH_PX apart
    const kept: ScreenPt[] = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
      const prev = kept[kept.length - 1];
      if (Math.hypot(raw[i].x - prev.x, raw[i].y - prev.y) >= MIN_BRUSH_PX) kept.push(raw[i]);
    }
    if (kept.length < 2) return;

    // Single bulk conversion from screen → chart coords
    const chartPts = kept.map(p => toChart(p.x, p.y)).filter(Boolean) as ChartPt[];
    if (chartPts.length >= 2) {
      setDrawings(prev => [...prev, { id: Date.now().toString(), type: 'brush', pts: chartPts, color: '#38bdf8' }]);
    }
  }, [toChart]);

  // ── Canvas render ────────────────────────────────────────────────────────

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const rect   = chartRectRef.current;
    if (!canvas || !rect) return;

    const dpr = window.devicePixelRatio || 1;
    const w = rect.width, h = rect.height;

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width  = w + 'px';
      canvas.style.height = h + 'px';
    }

    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    const drawShape = (d: Drawing, preview = false) => {
      ctx.globalAlpha = preview ? 0.55 : 1;
      switch (d.type) {
        case 'brush': {
          if (d.pts.length < 2) break;
          ctx.strokeStyle = d.color; ctx.lineWidth = 2;
          ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
          ctx.beginPath();
          const f = toScreen(d.pts[0]); if (!f) break;
          ctx.moveTo(f.x, f.y);
          for (let i = 1; i < d.pts.length; i++) {
            const s = toScreen(d.pts[i]); if (s) ctx.lineTo(s.x, s.y);
          }
          ctx.stroke(); break;
        }
        case 'trendline': {
          if (d.pts.length < 2) break;
          const s1 = toScreen(d.pts[0]); const s2 = toScreen(d.pts[1]);
          if (!s1 || !s2) break;
          ctx.strokeStyle = d.color; ctx.lineWidth = 1.5; ctx.setLineDash([]);
          if (s2.x !== s1.x) {
            const m = (s2.y - s1.y) / (s2.x - s1.x);
            ctx.beginPath(); ctx.moveTo(0, s1.y - m * s1.x); ctx.lineTo(w, s1.y + m * (w - s1.x)); ctx.stroke();
          } else { ctx.beginPath(); ctx.moveTo(s1.x, 0); ctx.lineTo(s1.x, h); ctx.stroke(); }
          ctx.fillStyle = d.color;
          ctx.beginPath(); ctx.arc(s1.x, s1.y, 3, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(s2.x, s2.y, 3, 0, Math.PI * 2); ctx.fill(); break;
        }
        case 'hline': {
          if (!d.pts.length) break;
          const s = toScreen(d.pts[0]); if (!s) break;
          ctx.strokeStyle = d.color; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(w, s.y); ctx.stroke();
          ctx.setLineDash([]); ctx.fillStyle = d.color; ctx.font = '10px Inter,sans-serif';
          ctx.fillText(d.pts[0].price.toFixed(2), w - 90, s.y - 4); break;
        }
        case 'vline': {
          if (!d.pts.length) break;
          const s = toScreen(d.pts[0]); if (!s) break;
          ctx.strokeStyle = d.color; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, h); ctx.stroke();
          ctx.setLineDash([]); break;
        }
        case 'rect': {
          if (d.pts.length < 2) break;
          const s1 = toScreen(d.pts[0]); const s2 = toScreen(d.pts[1]); if (!s1 || !s2) break;
          const [rx, ry, rw, rh2] = [Math.min(s1.x, s2.x), Math.min(s1.y, s2.y), Math.abs(s2.x - s1.x), Math.abs(s2.y - s1.y)];
          ctx.strokeStyle = d.color; ctx.lineWidth = 1.5; ctx.setLineDash([]);
          ctx.fillStyle = d.color.replace(/[\d.]+\)$/, '0.08)');
          ctx.fillRect(rx, ry, rw, rh2); ctx.strokeRect(rx, ry, rw, rh2); break;
        }
        case 'fib': {
          if (d.pts.length < 2) break;
          const ph = Math.max(d.pts[0].price, d.pts[1].price);
          const range = ph - Math.min(d.pts[0].price, d.pts[1].price);
          for (const fib of FIB_LEVELS) {
            const price = ph - fib.r * range;
            const s = toScreen({ price, time: d.pts[0].time }); if (!s) continue;
            ctx.strokeStyle = fib.c; ctx.lineWidth = 1.2; ctx.setLineDash([]);
            ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(w, s.y); ctx.stroke();
            ctx.fillStyle = fib.c; ctx.font = '10px Inter,sans-serif';
            ctx.fillText(`${fib.l} · ${price.toFixed(2)}`, 4, s.y - 3);
          } break;
        }
        case 'text': {
          if (!d.pts.length || !d.text) break;
          const s = toScreen(d.pts[0]); if (!s) break;
          ctx.font = 'bold 13px Inter,sans-serif'; ctx.fillStyle = d.color;
          ctx.fillText(d.text, s.x, s.y); break;
        }
      }
      ctx.globalAlpha = 1;
    };

    for (const d of drawingsRef.current) drawShape(d);

    // Live brush: draw from raw screen coords — zero chart API calls
    if (brushActiveRef.current && brushScreenRef.current.length > 1) {
      const pts = brushScreenRef.current;
      ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
      ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // Preview for click-based tools
    const pending = pendingRef.current;
    const mouse   = mousePosRef.current;
    const curTool = toolRef.current;
    if (pending.length > 0 && mouse && curTool !== 'brush') {
      const mp = toChart(mouse.x, mouse.y);
      if (mp) drawShape({ id: '__prev', type: curTool, pts: [...pending, mp], color: '#38bdf8' }, true);
    }
    if (pending.length === 1) {
      const s = toScreen(pending[0]);
      if (s) { ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.stroke(); }
    }

    ctx.restore();
  }, [toScreen, toChart]);

  const scheduleRender = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(render);
  }, [render]);

  useEffect(() => { scheduleRender(); });

  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const h = () => scheduleRender();
    chart.timeScale().subscribeVisibleLogicalRangeChange(h);
    return () => { chart.timeScale().unsubscribeVisibleLogicalRangeChange(h); cancelAnimationFrame(rafRef.current); };
  }, [chartRef, scheduleRender]);

  // ── Shared tap/click handler ──────────────────────────────────────────────

  handlePointRef.current = (sx: number, sy: number) => {
    const curTool = toolRef.current;
    if (curTool === 'cursor' || curTool === 'brush') return;

    if (curTool === 'eraser') {
      let closest: string | null = null; let minDist = 20;
      for (const d of drawingsRef.current) {
        for (const pt of d.pts) {
          const s = toScreen(pt); if (!s) continue;
          const dist = Math.hypot(s.x - sx, s.y - sy);
          if (dist < minDist) { minDist = dist; closest = d.id; }
        }
        if (d.type === 'hline' && d.pts.length) { const s = toScreen(d.pts[0]); if (s && Math.abs(s.y - sy) < 10) closest = d.id; }
        if (d.type === 'vline' && d.pts.length) { const s = toScreen(d.pts[0]); if (s && Math.abs(s.x - sx) < 10) closest = d.id; }
      }
      if (closest) setDrawings(prev => prev.filter(d => d.id !== closest));
      return;
    }

    const chartPt = toChart(sx, sy); if (!chartPt) return;
    const snapped = magnetSnap(chartPt);
    const newPending = [...pendingRef.current, snapped];
    const needed = TOOL_CLICKS[curTool];

    if (newPending.length >= needed) {
      if (curTool === 'text') {
        const text = window.prompt('Label text:');
        if (!text) { setPendingPts([]); return; }
        setDrawings(prev => [...prev, { id: Date.now().toString(), type: curTool, pts: newPending.slice(0, needed), color: '#38bdf8', text }]);
      } else {
        setDrawings(prev => [...prev, { id: Date.now().toString(), type: curTool, pts: newPending.slice(0, needed), color: '#38bdf8' }]);
      }
      setPendingPts([]);
    } else {
      setPendingPts(newPending);
    }
  };

  // ── Touch event listeners (passive:false → preventDefault works on iOS) ──

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visible || !chartRect) return;

    const getPos = (e: TouchEvent): ScreenPt => {
      const t = e.touches[0] || e.changedTouches[0];
      const r = canvas.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };

    const addBrushPt = (pos: ScreenPt) => {
      const buf = brushScreenRef.current;
      if (!buf.length) { buf.push(pos); return; }
      const last = buf[buf.length - 1];
      if (Math.hypot(pos.x - last.x, pos.y - last.y) >= MIN_BRUSH_PX) buf.push(pos);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (toolRef.current === 'cursor') return;
      e.preventDefault(); e.stopPropagation();
      const pos = getPos(e);
      mousePosRef.current = pos;
      if (toolRef.current === 'brush') {
        brushActiveRef.current = true;
        brushScreenRef.current = [pos];
      }
      scheduleRender();
    };

    const onTouchMove = (e: TouchEvent) => {
      if (toolRef.current === 'cursor') return;
      e.preventDefault(); e.stopPropagation();
      const pos = getPos(e);
      mousePosRef.current = pos;
      if (brushActiveRef.current && toolRef.current === 'brush') addBrushPt(pos);
      scheduleRender();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (toolRef.current === 'cursor') return;
      e.preventDefault(); e.stopPropagation();
      mousePosRef.current = null;
      if (toolRef.current === 'brush') {
        commitBrush(); scheduleRender(); return;
      }
      const t = e.changedTouches[0];
      const r = canvas.getBoundingClientRect();
      handlePointRef.current?.(t.clientX - r.left, t.clientY - r.top);
      scheduleRender();
    };

    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
    canvas.addEventListener('touchend',   onTouchEnd,   { passive: false });
    return () => {
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove',  onTouchMove);
      canvas.removeEventListener('touchend',   onTouchEnd);
    };
  }, [visible, chartRect, commitBrush, scheduleRender]);

  // ── Mouse handlers (desktop) ─────────────────────────────────────────────

  const canvasCoords = (e: React.MouseEvent<HTMLCanvasElement>): ScreenPt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (toolRef.current !== 'brush') return;
    const pos = canvasCoords(e);
    brushActiveRef.current = true;
    brushScreenRef.current = [pos];
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = canvasCoords(e);
    mousePosRef.current = pos;
    if (brushActiveRef.current && toolRef.current === 'brush') {
      const buf = brushScreenRef.current;
      const last = buf[buf.length - 1];
      if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) >= MIN_BRUSH_PX) buf.push(pos);
    }
    scheduleRender();
  }, [scheduleRender]);

  const handleMouseUp    = useCallback(() => { if (brushActiveRef.current) commitBrush(); }, [commitBrush]);
  const handleMouseLeave = useCallback(() => {
    mousePosRef.current = null;
    if (brushActiveRef.current) commitBrush();
    scheduleRender();
  }, [commitBrush, scheduleRender]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = canvasCoords(e);
    handlePointRef.current?.(x, y);
  }, []);

  if (!visible || !chartRect) return null;

  return (
    <>
      <div className="cdt-toolbar" style={{ top: chartRect.top + 8, left: chartRect.left + 8 }}>
        {TOOL_LIST.map(t => (
          <button
            key={t.id}
            className={`cdt-btn${tool === t.id ? ' cdt-btn--active' : ''}`}
            onClick={() => { setTool(t.id); setPendingPts([]); brushActiveRef.current = false; }}
            title={t.label}
          >
            {t.icon}
          </button>
        ))}
        <div className="cdt-separator" />
        <button
          className={`cdt-btn cdt-btn--magnet${magnet ? ' cdt-btn--active' : ''}`}
          onClick={() => setMagnet(m => !m)}
          title={magnet ? 'Magnet On' : 'Magnet Off'}
        >
          {MAGNET_ICON}
        </button>
        <div className="cdt-separator" />
        <button
          className="cdt-btn cdt-btn--danger"
          onClick={() => { setDrawings([]); setPendingPts([]); brushActiveRef.current = false; }}
          title="Clear All"
        >
          {TRASH_ICON}
        </button>
      </div>

      {magnet && (
        <div className="cdt-magnet-badge" style={{ top: chartRect.top + 8, left: chartRect.left + 50 }}>
          ⊕ Magnet On
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="cdt-canvas"
        style={{
          top:          chartRect.top,
          left:         chartRect.left,
          width:        chartRect.width,
          height:       chartRect.height,
          cursor:       tool === 'cursor' ? 'default' : 'crosshair',
          pointerEvents: tool === 'cursor' ? 'none' : 'all',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      />
    </>
  );
}
