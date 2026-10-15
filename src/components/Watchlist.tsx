import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
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
import { COINS } from "../services/coinglass";

const DEFAULT_IDS = ["bitcoin", "ethereum", "solana", "ripple"];

// Only coins the price chart actually supports (a subset of the full watchlist catalog)
const CHARTABLE_SYMBOLS = new Set<string>(COINS.map(c => c.symbol));

/* ── Sparkline ──────────────────────────────────────────────────────────── */
// Exported — TopMoversCarousel's own list view reuses this exact
// implementation instead of a second copy.
export function Sparkline({ prices, positive, width, height, className }: {
  prices: number[]; positive: boolean; width?: number; height?: number; className?: string;
}) {
  if (prices.length < 2) return null;
  const W = width ?? 44, H = height ?? 18;
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
    <svg className={className ?? "wl-chip-spark"} width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
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

/* ── Row ────────────────────────────────────────────────────────────────── */
// Its own component (not inlined in the .map() below) because useSortable
// is a hook — needs a real component to call it from, same reason the old
// desktop chip strip had its own WatchlistChip.
interface RowProps {
  id: string;
  meta?: CatalogEntry;
  entry?: PriceEntry;
  spark: number[];
  imgError: boolean;
  onImgError: (symbol: string) => void;
  onRemove: (id: string) => void;
  onSelect?: (symbol: string) => void;
  chartable: boolean;
  manageMode: boolean;
  removeTitle: string;
  dragTitle: string;
}

function WatchlistRow({
  id, meta, entry, spark, imgError, onImgError, onRemove, onSelect,
  chartable, manageMode, removeTitle, dragTitle,
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
    <div ref={setNodeRef} style={style} className="wl-list-row">
      {/* Desktop (>=641px): .wl-list-row-main is display:contents, so
          these children lay out as direct items of .wl-list-row's own
          grid columns (name/price/sparkline/%). Mobile: .wl-list-row-main
          is a real flex row instead (see Watchlist.css's own @media
          split) — same markup, same original mobile look either way,
          .wl-list-figures just un-wraps on desktop to let price/% sit in
          their own separate grid columns there. */}
      <button
        type="button"
        className="wl-list-row-main"
        onClick={() => chartable && onSelect!(symbol)}
        disabled={!chartable}
      >
        <span className="wl-list-identity">
          <span className="wl-list-icon">
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
          </span>
          <span className="wl-list-names">
            <span className="wl-list-name">{meta?.name ?? symbol}</span>
            <span className="wl-list-sym">{symbol}</span>
          </span>
        </span>
        <span className="wl-list-col-price">{entry ? `$${fmtPrice(entry.price)}` : "—"}</span>
        {spark.length > 1 ? (
          <Sparkline prices={spark} positive={up} width={64} height={28} className="wl-list-spark" />
        ) : (
          <span className="wl-list-spark" />
        )}
        <span className={`wl-list-col-pct${entry ? (up ? " up" : " down") : ""}`}>
          {entry && `${up ? "↗" : "↘"} ${Math.abs(pct).toFixed(2)}%`}
        </span>
      </button>
      {/* Desktop-only (star/handle both display:none on mobile) —
          decorative star for now (no separate "favorite" concept yet
          beyond being in the watchlist at all), real drag-to-reorder
          handle via dnd-kit. */}
      <span className="wl-list-star" aria-hidden="true">★</span>
      <button
        type="button"
        className="wl-list-handle"
        title={dragTitle}
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      {manageMode && (
        <button
          type="button"
          className="wl-list-remove"
          onClick={() => onRemove(id)}
          aria-label={removeTitle}
        >
          ×
        </button>
      )}
    </div>
  );
}

/* ── Component ──────────────────────────────────────────────────────────── */
interface WatchlistProps {
  onSelectCoin?: (symbol: string) => void;
}

// Same vertical icon/name/sparkline/price/% row list on every width now —
// used to be a separate horizontal chip-strip on desktop, dropped in favor
// of reusing this one everywhere (desktop was asked to just match what
// mobile already does here instead of keeping its own separate layout).
export function Watchlist({ onSelectCoin }: WatchlistProps) {
  const { t } = useTranslation();
  // Still matters for the search/manage dropdown below (full-screen sheet
  // vs a small floating popover) even though the row list itself no
  // longer branches on this.
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
  // "Manage" toggle — reveals a remove (×) per row plus the "Add More +"
  // button that opens the search/manage dropdown below.
  const [manageMode, setManageMode] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  // The search/manage dropdown portals to document.body + position:fixed
  // on anything wider than the mobile breakpoint (small floating popover
  // there vs a full-screen sheet on real mobile) — same approach
  // AccountMenu.css/.tsx already uses for its own dropdown, so it can't be
  // clipped or lose a z-index fight against other in-page content.
  // addBtnRef/dropPos anchor the portaled panel under the real trigger
  // button; dropdownRef lets the outside-click handler below still
  // recognize clicks inside it even though it's no longer a DOM
  // descendant of searchRef once portaled.
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    localStorage.setItem("watchlistCoins_v1", JSON.stringify(watchedIds));
  }, [watchedIds]);

  // PushToast's "+ Watchlist" button (buy/sell signal toasts) writes
  // localStorage directly so it works even when this component isn't
  // mounted — this picks the change up live when it is, instead of only on
  // next mount.
  useEffect(() => {
    const onAdd = (e: Event) => {
      const coin = (e as CustomEvent<{ coin?: string }>).detail?.coin;
      if (!coin) return;
      setWatchedIds((prev) => prev.includes(coin) ? prev : [...prev, coin]);
    };
    window.addEventListener("watchlist-add", onAdd);
    return () => window.removeEventListener("watchlist-add", onAdd);
  }, []);

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
      const t = e.target as Node;
      if (!searchRef.current?.contains(t) && !dropdownRef.current?.contains(t)) {
        setSearchOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [searchOpen]);

  // iOS: capacitor.config.ts sets Keyboard resize:'none', so nothing
  // shrinks the WebView for the keyboard on its own. .wl-dropdown is
  // full-screen on mobile now (flex column, .wl-dropdown-list is the
  // flex:1 scrollable part) — padding its bottom by the keyboard height
  // is all that's needed to keep the keyboard from covering the last few
  // results, same fix CoinChat/TradingAgent's own fixed panels already
  // use for the same underlying problem.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !searchOpen) return;
    const showSub = Keyboard.addListener("keyboardWillShow", (info) => {
      const list = searchRef.current?.querySelector(".wl-dropdown-list") as HTMLElement | null;
      if (list) list.style.paddingBottom = `${info.keyboardHeight}px`;
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      const list = searchRef.current?.querySelector(".wl-dropdown-list") as HTMLElement | null;
      if (list) list.style.paddingBottom = "";
    });
    return () => { showSub.then(s => s.remove()); hideSub.then(s => s.remove()); };
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

  // Computes where the portaled dropdown lands (see searchDropdown below)
  // from the real button's position — irrelevant on real mobile widths,
  // where the full-screen sheet CSS ignores dropPos entirely, so this is
  // always safe to call regardless of width.
  const openManage = () => {
    if (!searchOpen && addBtnRef.current) {
      const r = addBtnRef.current.getBoundingClientRect();
      const DROPDOWN_W = 300;
      const DROPDOWN_H = 420;
      let left = r.right - DROPDOWN_W;
      let top = r.bottom + 6;
      if (left < 8) left = 8;
      if (top + DROPDOWN_H > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - DROPDOWN_H - 8);
      }
      setDropPos({ top, left });
    }
    setSearchOpen(v => !v);
  };

  const filteredCatalog = CATALOG.filter(c =>
    !watchedIds.includes(c.id) &&
    (c.name.toLowerCase().includes(search.toLowerCase()) ||
     c.symbol.toLowerCase().includes(search.toLowerCase()))
  );

  const dropdownContent = (
    <>
      {/* Full-screen on mobile (see .wl-dropdown's own @media override) —
          tap-outside-to-close doesn't apply there, so this is the only
          way out in that mode. Harmless extra control on desktop too. */}
      <div className="wl-dropdown-header">
        <span className="wl-dropdown-title">{t("watchlist.manage", "Manage")}</span>
        <button type="button" className="wl-dropdown-close" onClick={() => { setSearchOpen(false); setSearch(""); }}>✕</button>
      </div>

      {/* Currently-watched coins — remove (×) only, re-adding happens via
          the search list below. */}
      {watchedIds.length > 0 && (
        <div className="wl-dropdown-watched">
          {watchedIds.map(id => {
            const meta = CATALOG.find(c => c.id === id);
            return (
              <div key={id} className="wl-dropdown-item wl-dropdown-item--watched">
                <span className="wl-dropdown-icon">
                  {!imgErrors.has((meta?.symbol ?? "").toUpperCase()) ? (
                    <img
                      className="wl-coin-img"
                      src={`https://assets.coincap.io/assets/icons/${(meta?.symbol ?? "").toLowerCase()}@2x.png`}
                      alt=""
                      loading="lazy"
                      onError={() => setImgErrors(prev => new Set([...prev, (meta?.symbol ?? "").toUpperCase()]))}
                    />
                  ) : (
                    <div className="wl-coin-placeholder">{meta?.symbol?.[0] ?? "?"}</div>
                  )}
                </span>
                <span className="wl-dropdown-sym">{(meta?.symbol ?? "").toUpperCase()}</span>
                <span className="wl-dropdown-name">{meta?.name}</span>
                <button
                  type="button"
                  className="wl-dropdown-remove"
                  onClick={() => removeCoin(id)}
                  aria-label={t("watchlist.removeTitle")}
                  title={t("watchlist.removeTitle")}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

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
            <span className="wl-dropdown-icon">
              {!imgErrors.has(c.symbol.toUpperCase()) ? (
                <img
                  className="wl-coin-img"
                  src={`https://assets.coincap.io/assets/icons/${c.symbol.toLowerCase()}@2x.png`}
                  alt=""
                  loading="lazy"
                  onError={() => setImgErrors(prev => new Set([...prev, c.symbol.toUpperCase()]))}
                />
              ) : (
                <div className="wl-coin-placeholder">{c.symbol[0] ?? "?"}</div>
              )}
            </span>
            <span className="wl-dropdown-sym">{c.symbol}</span>
            <span className="wl-dropdown-name">{c.name}</span>
          </button>
        ))}
        {filteredCatalog.length === 0 && (
          <div className="wl-dropdown-empty">{t("watchlist.noResults")}</div>
        )}
      </div>
    </>
  );

  const searchDropdown = searchOpen && (
    isMobile
      ? <div className="wl-dropdown">{dropdownContent}</div>
      : createPortal(
          <div
            className="wl-dropdown wl-dropdown--portal"
            ref={dropdownRef}
            style={{ top: dropPos.top, left: dropPos.left }}
          >
            {dropdownContent}
          </div>,
          document.body,
        )
  );

  return (
    <div className="wl-list">
      <div className="wl-list-head">
        <span className="wl-list-title">{t("watchlist.title")}</span>
        <div className="wl-search-wrap" ref={searchRef}>
          {manageMode && (
            <button type="button" className="wl-list-arrow" ref={addBtnRef} onClick={openManage}>
              {t("watchlist.addMore", "Add More")} +
            </button>
          )}
          {searchDropdown}
        </div>
      </div>

      {loading && watchedIds.length > 0 && (
        <div className="wl-loading">{t("watchlist.loading")}</div>
      )}
      {!loading && watchedIds.length === 0 && (
        <div className="wl-empty">{t("watchlist.emptyText")}</div>
      )}

      {!loading && watchedIds.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={watchedIds} strategy={verticalListSortingStrategy}>
            <div className="wl-list-rows">
              {watchedIds.map(id => {
                const meta = CATALOG.find(c => c.id === id);
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
                    onSelect={onSelectCoin}
                    chartable={!!onSelectCoin && CHARTABLE_SYMBOLS.has(symbol)}
                    manageMode={manageMode}
                    removeTitle={t("watchlist.removeTitle")}
                    dragTitle={t("watchlist.dragTitle")}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <button type="button" className="wl-list-manage" onClick={() => setManageMode(v => !v)}>
        {manageMode ? t("watchlist.done", "Done") : t("watchlist.manage", "Manage")}
      </button>
    </div>
  );
}
