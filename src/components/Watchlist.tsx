import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, horizontalListSortingStrategy,
  sortableKeyboardCoordinates, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import "../styles/Watchlist.css";
import { CATALOG, type CatalogEntry } from "../services/coinCatalog";
import { fetchBinancePrices, fetchSparklines, type PriceEntry } from "../services/binancePrices";
import { COINS } from "../services/coinglass";

const DEFAULT_IDS = ["bitcoin", "ethereum", "solana", "ripple"];

// Only coins the price chart actually supports (a subset of the full watchlist catalog)
const CHARTABLE_SYMBOLS = new Set<string>(COINS.map(c => c.symbol));

/* ── Sparkline ──────────────────────────────────────────────────────────── */
function Sparkline({ prices, positive }: { prices: number[]; positive: boolean }) {
  if (prices.length < 2) return null;
  const W = 44, H = 18;
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
  const color = positive ? "#4ade80" : "#fb7185";
  return (
    <svg className="wl-chip-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <polyline points={pts} fill="none" stroke={color}
        strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ── Helpers ────────────────────────────────────────────────────────────── */
function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}

/* ── Chip ───────────────────────────────────────────────────────────────── */
interface ChipProps {
  id: string;
  meta?: CatalogEntry;
  entry?: PriceEntry;
  spark: number[];
  imgError: boolean;
  onImgError: (symbol: string) => void;
  onRemove: (id: string) => void;
  onSelect?: (symbol: string) => void;
  dragTitle: string;
  removeTitle: string;
  chartTitle: string;
}

function WatchlistChip({
  id, meta, entry, spark, imgError, onImgError, onRemove, onSelect,
  dragTitle, removeTitle, chartTitle,
}: ChipProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const symbol = (meta?.symbol ?? "").toUpperCase();
  const pct = entry?.pct ?? 0;
  const up = pct >= 0;
  const chartable = onSelect && CHARTABLE_SYMBOLS.has(symbol);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const chipContent = (
    <>
      <div className="wl-chip-icon">
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

      <div className="wl-chip-text">
        <span className="wl-chip-sym">{symbol}</span>
        <div className="wl-chip-row">
          <span className="wl-chip-price">{entry ? `$${fmtPrice(entry.price)}` : "—"}</span>
          {entry && (
            <span className={`wl-chip-pct${up ? " up" : " down"}`}>
              {up ? "+" : ""}{pct.toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      {spark.length > 1 && <Sparkline prices={spark} positive={up} />}
    </>
  );

  return (
    <div ref={setNodeRef} style={style} className="wl-chip">
      <button className="wl-chip-handle" title={dragTitle} {...attributes} {...listeners}>⋮⋮</button>

      {chartable ? (
        <button className="wl-chip-main" onClick={() => onSelect!(symbol)} title={chartTitle}>
          {chipContent}
        </button>
      ) : (
        <div className="wl-chip-main wl-chip-main--static">{chipContent}</div>
      )}

      <button className="wl-chip-remove" onClick={() => onRemove(id)} title={removeTitle}>×</button>
    </div>
  );
}

/* ── Component ──────────────────────────────────────────────────────────── */
interface WatchlistProps {
  onSelectCoin?: (symbol: string) => void;
}

export function Watchlist({ onSelectCoin }: WatchlistProps) {
  const { t } = useTranslation();
  // Matches Watchlist.css's own mobile breakpoint — the full "+ Add to
  // Watchlist" label is too wide there and crowds out the coin chips, so a
  // shorter "+ Add" is used instead to leave more room for the content.
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 640px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
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
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const scrollBy = (dir: 1 | -1) => scrollRef.current?.scrollBy({ left: dir * 240, behavior: "smooth" });

  return (
    <div className="wl-strip">
      <div className="wl-strip-label">
        <span className="wl-strip-dot" />
        {t("watchlist.title")}
      </div>

      {loading && watchedIds.length > 0 && (
        <div className="wl-loading">{t("watchlist.loading")}</div>
      )}

      {!loading && watchedIds.length === 0 && (
        <div className="wl-empty">{t("watchlist.emptyText")}</div>
      )}

      {!loading && watchedIds.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={watchedIds} strategy={horizontalListSortingStrategy}>
            <div className="wl-scroll" ref={scrollRef}>
              {watchedIds.map(id => {
                const meta   = CATALOG.find(c => c.id === id);
                const symbol = (meta?.symbol ?? "").toUpperCase();
                return (
                  <WatchlistChip
                    key={id}
                    id={id}
                    meta={meta}
                    entry={priceData.get(symbol)}
                    spark={sparklines.get(symbol) ?? []}
                    imgError={imgErrors.has(symbol)}
                    onImgError={sym => setImgErrors(prev => new Set([...prev, sym]))}
                    onRemove={removeCoin}
                    onSelect={onSelectCoin}
                    dragTitle={t("watchlist.dragTitle")}
                    removeTitle={t("watchlist.removeTitle")}
                    chartTitle={t("watchlist.viewChart")}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <div className="wl-strip-actions">
        <button className="wl-nav-btn" onClick={() => scrollBy(-1)} aria-label="Scroll left">‹</button>
        <button className="wl-nav-btn" onClick={() => scrollBy(1)} aria-label="Scroll right">›</button>
        <div className="wl-search-wrap" ref={searchRef}>
          <button className="wl-add-btn" onClick={() => setSearchOpen(v => !v)}>
            {t(isMobile ? "watchlist.addCoinShort" : "watchlist.addCoin")}
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
    </div>
  );
}
