import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, verticalListSortingStrategy,
  sortableKeyboardCoordinates, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import "../styles/Watchlist.css";
import { CATALOG, type CatalogEntry } from "../services/coinCatalog";
import { fetchBinancePrices, fetchSparklines, type PriceEntry } from "../services/binancePrices";

const DEFAULT_IDS = ["bitcoin", "ethereum", "solana", "ripple"];

/* ── Sparkline ──────────────────────────────────────────────────────────── */
function Sparkline({ prices, positive }: { prices: number[]; positive: boolean }) {
  if (prices.length < 2) return null;
  const W = 60, H = 26;
  // Only downsample large series (e.g. CoinGecko 168-pt); Binance gives 7 pts already
  const sample = prices.length > 20 ? prices.filter((_, i) => i % 4 === 0) : prices;
  const min = Math.min(...sample);
  const max = Math.max(...sample);
  const range = max - min || 1;
  const pts = sample.map((p, i) => {
    const x = (i / (sample.length - 1)) * W;
    const y = H - ((p - min) / range) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = positive ? "#22c55e" : "#ef4444";
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <polyline points={pts} fill="none" stroke={color}
        strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ── Helpers ────────────────────────────────────────────────────────────── */
function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  return `${v.toFixed(0)}`;
}

/* ── Row ────────────────────────────────────────────────────────────────── */
interface RowProps {
  id: string;
  meta?: CatalogEntry;
  entry?: PriceEntry;
  spark: number[];
  imgError: boolean;
  onImgError: (symbol: string) => void;
  onRemove: (id: string) => void;
  dragTitle: string;
  removeTitle: string;
  volLabel: string;
}

function WatchlistRow({
  id, meta, entry, spark, imgError, onImgError, onRemove, dragTitle, removeTitle, volLabel,
}: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const symbol = (meta?.symbol ?? "").toUpperCase();
  const pct = entry?.pct ?? 0;
  const up = pct >= 0;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="wl-row">
      <button className="wl-row-handle" title={dragTitle} {...attributes} {...listeners}>
        ⋮⋮
      </button>

      <div className="wl-row-icon">
        {!imgError ? (
          <img
            className="wl-coin-img"
            src={`https://assets.coincap.io/assets/icons/${symbol.toLowerCase()}@2x.png`}
            alt={symbol}
            loading="lazy"
            onError={() => onImgError(symbol)}
          />
        ) : (
          <div className="wl-coin-placeholder">{symbol[0] ?? "?"}</div>
        )}
      </div>

      <div className="wl-row-info">
        <span className="wl-row-symbol">{symbol}-USD</span>
        <span className="wl-row-vol">{volLabel} {entry ? fmtVol(entry.vol) : "—"}</span>
      </div>

      {spark.length > 1 && (
        <div className="wl-row-spark">
          <Sparkline prices={spark} positive={up} />
        </div>
      )}

      <div className="wl-row-right">
        <span className="wl-row-price">${entry ? fmtPrice(entry.price) : "—"}</span>
        <span className={`wl-row-pct${up ? " up" : " down"}`}>
          {up ? "↗" : "↘"} {Math.abs(pct).toFixed(2)}%
        </span>
      </div>

      <button className="wl-row-star" onClick={() => onRemove(id)} title={removeTitle}>
        ★
      </button>
    </div>
  );
}

/* ── Component ──────────────────────────────────────────────────────────── */
export function Watchlist() {
  const { t } = useTranslation();
  const [watchedIds, setWatchedIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("watchlistCoins_v1") ?? "null");
      return Array.isArray(saved) && saved.length > 0 ? saved : DEFAULT_IDS;
    } catch { return DEFAULT_IDS; }
  });
  const [priceData,  setPriceData]  = useState<Map<string, PriceEntry>>(new Map());
  const [sparklines, setSparklines] = useState<Map<string, number[]>>(new Map());
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [imgErrors,  setImgErrors]  = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem("watchlistCoins_v1", JSON.stringify(watchedIds));
  }, [watchedIds]);

  // Price refresh every 30s
  useEffect(() => {
    if (watchedIds.length === 0) { setLoading(false); return; }
    const symbols = watchedIds.map(id => CATALOG.find(c => c.id === id)?.symbol ?? "").filter(Boolean);

    async function refresh() {
      const data = await fetchBinancePrices(symbols);
      setPriceData(data);
      setLoading(false);
    }

    refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [watchedIds]);

  // Sparklines refresh every 10 min (daily candles, no need to hammer)
  useEffect(() => {
    if (watchedIds.length === 0) return;
    const symbols = watchedIds.map(id => CATALOG.find(c => c.id === id)?.symbol ?? "").filter(Boolean);

    fetchSparklines(symbols).then(setSparklines);
    const id = setInterval(() => fetchSparklines(symbols).then(setSparklines), 10 * 60_000);
    return () => clearInterval(id);
  }, [watchedIds]);

  useEffect(() => {
    if (!searchOpen) return;
    const handle = (e: MouseEvent) => {
      if (!searchRef.current?.contains(e.target as Node)) {
        setSearchOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [searchOpen]);

  const addCoin = (id: string) => {
    if (!watchedIds.includes(id)) setWatchedIds(prev => [...prev, id]);
    setSearchOpen(false);
    setSearch("");
  };

  const removeCoin = (id: string) => setWatchedIds(prev => prev.filter(x => x !== id));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setWatchedIds(prev => {
      const oldIndex = prev.indexOf(String(active.id));
      const newIndex = prev.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const filteredCatalog = CATALOG.filter(c =>
    !watchedIds.includes(c.id) &&
    (c.name.toLowerCase().includes(search.toLowerCase()) ||
     c.symbol.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="wl-card">
      <div className="wl-header">
        <h3 className="wl-title">{t("watchlist.title")}</h3>
        <span className="wl-subtitle">
          {t("watchlist.updated")} ·{" "}
          <span className="wl-source-badge">Binance</span>
        </span>
        <div className="wl-search-wrap" ref={searchRef}>
          <button className="wl-add-btn" onClick={() => setSearchOpen(v => !v)}>
            {t("watchlist.addCoin")}
          </button>
          {searchOpen && (
            <div className="wl-dropdown">
              <input
                className="wl-search-input"
                placeholder={t("watchlist.searchPlaceholder")}
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
              />
              <div className="wl-dropdown-list">
                {filteredCatalog.slice(0, 20).map(c => (
                  <button key={c.id} className="wl-dropdown-item" onClick={() => addCoin(c.id)}>
                    <span className="wl-dropdown-sym">{c.symbol}</span>
                    <span className="wl-dropdown-name">{c.name}</span>
                  </button>
                ))}
                {filteredCatalog.length === 0 && (
                  <div className="wl-dropdown-empty">{t("watchlist.noResults")}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {loading && watchedIds.length > 0 && (
        <div className="wl-loading">{t("watchlist.loading")}</div>
      )}

      {!loading && watchedIds.length === 0 && (
        <div className="wl-empty">
          <div className="wl-empty-icon">☆</div>
          <div className="wl-empty-text">{t("watchlist.emptyText")}</div>
          <div className="wl-empty-hint">{t("watchlist.emptyHint")}</div>
        </div>
      )}

      {!loading && watchedIds.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={watchedIds} strategy={verticalListSortingStrategy}>
            <div className="wl-list">
              {watchedIds.map(id => {
                const meta   = CATALOG.find(c => c.id === id);
                const symbol = (meta?.symbol ?? "").toUpperCase();
                return (
                  <WatchlistRow
                    key={id}
                    id={id}
                    meta={meta}
                    entry={priceData.get(symbol)}
                    spark={sparklines.get(symbol) ?? []}
                    imgError={imgErrors.has(symbol)}
                    onImgError={sym => setImgErrors(prev => new Set([...prev, sym]))}
                    onRemove={removeCoin}
                    dragTitle={t("watchlist.dragTitle")}
                    removeTitle={t("watchlist.removeTitle")}
                    volLabel={t("watchlist.vol")}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
