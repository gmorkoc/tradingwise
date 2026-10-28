import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactDOM from "react-dom";
import { BottomSheet } from "./BottomSheet";
import { INDICATORS, IND_CATEGORIES, type IndCategory } from "../services/indicatorLibrary";
import {
  listCustomIndicators, onCustomIndicatorsChange, deleteCustomIndicator, type CustomIndicator,
} from "../services/customIndicators";
import { AIIndicatorBuilder } from "./AIIndicatorBuilder";
import "../styles/IndicatorPicker.css";

// The app's one indicator picker (TradingView-style): search, then
// categories → list with on/off switches. Shows the shared catalog
// (indicatorLibrary.ts) plus whatever the host chart already draws itself
// (its "builtIn" items — e.g. PriceChart's EMA/MA/Bollinger/RSI/MACD).

export interface PickerItem {
  id: string;
  name: string;
  category: IndCategory;
  description?: string;
  checked: boolean;
  onToggle: () => void;
  pro?: boolean;
  color?: string;
  /** Draws over the price, or in its own panel under it. Default overlay. */
  kind?: "overlay" | "pane";
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Shared-catalog ids that are on. */
  enabled: string[];
  onToggle: (id: string) => void;
  /** The host chart's own indicators/layers. */
  builtIn?: PickerItem[];
  /** Catalog ids this chart already covers with a built-in (hidden). */
  hideIds?: string[];
  isPaid?: boolean;
  /** Opens the upgrade flow (AI indicators are Pro). */
  onUpgrade?: () => void;
}

const CATEGORY_ICONS: Record<IndCategory, ReactNode> = {
  "Moving Averages": <path d="M3 17c3-6 6-8 9-6s6 0 9-6" />,
  Trend: <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
  Momentum: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  Oscillators: <path d="M2 12c2.5-6 5-6 7.5 0s5 6 7.5 0 4-6 5 0" />,
  Volatility: <><path d="M3 12h3l3-8 4 16 3-8h5" /></>,
  Volume: <><rect x="4" y="12" width="3" height="8" /><rect x="10.5" y="7" width="3" height="13" /><rect x="17" y="4" width="3" height="16" /></>,
  "Levels & Zones": <><line x1="3" y1="7" x2="21" y2="7" /><line x1="3" y1="12" x2="21" y2="12" strokeDasharray="3 3" /><line x1="3" y1="17" x2="21" y2="17" /></>,
  "Smart Money": <><rect x="4" y="5" width="16" height="5" rx="1" /><rect x="4" y="14" width="10" height="5" rx="1" /></>,
  "My indicators": <><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" /><path d="M19 15l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" /></>,
};

// Tap a row to add it to the chart; tap again to remove. On = a check.
function Check({ on }: { on: boolean }) {
  return (
    <span className={`ip-check${on ? " ip-check--on" : ""}`} aria-hidden="true">
      {on && <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
    </span>
  );
}

export function IndicatorPicker({ open, onClose, enabled, onToggle, builtIn = [], hideIds = [], isPaid = true, onUpgrade }: Props) {
  // "__build" = the Build with AI screen (phone).
  const [cat, setCat] = useState<IndCategory | "__build" | null>(null);
  // The user's saved AI indicators.
  const [customs, setCustoms] = useState<CustomIndicator[]>(() => listCustomIndicators());
  useEffect(() => onCustomIndicatorsChange(() => setCustoms(listCustomIndicators())), []);
  // Which saved indicator the builder is refining (undefined = new one).
  const [refining, setRefining] = useState<CustomIndicator | undefined>(undefined);
  const [builderKey, setBuilderKey] = useState(0);
  const openBuilder = (ci?: CustomIndicator) => { setRefining(ci); setBuilderKey((k) => k + 1); };
  const [q, setQ] = useState("");
  // Desktop (TradingView-style): sidebar selection, type filter, favorites.
  const [side, setSide] = useState<"all" | "fav" | "on" | "build" | IndCategory>("all");
  const [kindFilter, setKindFilter] = useState<"all" | "overlay" | "pane">("all");
  const [favs, setFavs] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem("ipFavoritesV1") ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const toggleFav = (id: string) => {
    const next = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
    setFavs(next);
    try { localStorage.setItem("ipFavoritesV1", JSON.stringify(next)); } catch { /* ignore */ }
  };
  // Desktop: a mega menu (every category at once, in columns) instead of
  // the phone's bottom sheet.
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 901px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 901px)");
    const on = () => setDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (!open || !desktop) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setQ(""); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, desktop, onClose]);

  const items: PickerItem[] = useMemo(() => [
    ...builtIn,
    ...INDICATORS.filter((d) => !hideIds.includes(d.id)).map((d) => ({
      id: d.id,
      name: d.name,
      category: d.category,
      description: d.description,
      checked: enabled.includes(d.id),
      onToggle: () => onToggle(d.id),
      kind: d.kind,
    })),
    ...customs.map((ci): PickerItem => ({
      id: ci.id,
      name: ci.recipe.name,
      category: "My indicators",
      description: ci.recipe.description,
      checked: enabled.includes(ci.id),
      onToggle: () => onToggle(ci.id),
      kind: ci.recipe.placement === "pane" ? "pane" : "overlay",
    })),
  ], [builtIn, hideIds, enabled, onToggle, customs]);
  const byId = (id: string) => customs.find((c) => c.id === id);
  const removeCustom = (id: string) => {
    if (enabled.includes(id)) onToggle(id);
    deleteCustomIndicator(id);
  };
  const MINE_ABOUT = {
    title: "What are My indicators?",
    about: "Indicators you built by describing them to the AI. They work on every chart like the built-in ones. Use Edit to change one in plain words, or delete it.",
  };
  // Edit / delete for saved AI indicators (shown on their rows).
  const aiActions = (id: string) => {
    const ci = byId(id);
    if (!ci) return null;
    return (
      <span className="ip-ai-actions">
        <button
          type="button"
          className="ip-ai-act"
          onClick={(e) => { e.stopPropagation(); openBuilder(ci); if (desktop) setSide("build"); else setCat("__build"); }}
          title="Edit with AI"
        >
          ✦ Edit
        </button>
        <button
          type="button"
          className="ip-ai-act ip-ai-act--del"
          onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete “${ci.recipe.name}”?`)) removeCustom(ci.id); }}
          aria-label="Delete"
          title="Delete"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
        </button>
      </span>
    );
  };
  const builder = (onDone: () => void) => (
    <AIIndicatorBuilder
      key={builderKey}
      existing={refining}
      isPaid={isPaid}
      onUpgrade={onUpgrade}
      onAdded={(id) => { if (!enabled.includes(id)) onToggle(id); }}
      onDone={onDone}
    />
  );

  const close = () => { setCat(null); setQ(""); onClose(); };
  const query = q.trim().toLowerCase();
  const results = query
    ? items.filter((i) => i.name.toLowerCase().includes(query) || i.category.toLowerCase().includes(query) || (i.description ?? "").toLowerCase().includes(query))
    : [];
  const active = items.filter((i) => i.checked);
  // Turn off everything currently on the chart (catalog + host's own).
  const clearAll = () => { for (const i of items) if (i.checked) i.onToggle(); };
  const cats = IND_CATEGORIES.filter((c) => items.some((i) => i.category === c.key));

  const row = (i: PickerItem) => (
    <button key={i.id} type="button" className={`ip-row${i.checked ? " ip-row--on" : ""}`} aria-pressed={i.checked} onClick={i.onToggle}>
      <span className="ip-row-text">
        <span className="ip-row-name">
          {i.color && <span className="ip-dot" style={{ background: i.color }} />}
          {i.name}
          {i.pro && !isPaid && <span className="interval-sheet-item-pro">PRO</span>}
        </span>
        {i.description && <span className="ip-row-sub">{i.description}</span>}
      </span>
      {aiActions(i.id)}
      <Check on={i.checked} />
    </button>
  );

  if (desktop) {
    if (!open) return null;
    const matches = (i: PickerItem) => !query || i.name.toLowerCase().includes(query) || i.category.toLowerCase().includes(query) || (i.description ?? "").toLowerCase().includes(query);
    // Search covers everything; otherwise the sidebar picks the list.
    const listed = items
      .filter((i) => (query ? matches(i) : side === "all" ? true : side === "fav" ? favs.includes(i.id) : side === "on" ? i.checked : i.category === side))
      .filter((i) => kindFilter === "all" || (i.kind ?? "overlay") === kindFilter);
    const sideBtn = (key: typeof side, label: string, icon: ReactNode, count?: number) => (
      <button type="button" className={`ip-tv-side-item${!query && side === key ? " active" : ""}`} onClick={() => { setSide(key); setQ(""); }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
        <span>{label}</span>
        {count ? <em>{count}</em> : null}
      </button>
    );
    const heading = query ? `Results for “${q.trim()}”` : side === "all" ? "All indicators" : side === "fav" ? "Favorites" : side === "on" ? "On chart" : side;
    return ReactDOM.createPortal(
      <div className="ip-mega-backdrop ip-sheet" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div className="ip-tv" role="dialog" aria-label="Indicators">
          <div className="ip-tv-head">
            <span className="ip-tv-title">Indicators</span>
            <button type="button" className="ip-mega-close" onClick={close} aria-label="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
          <div className="ip-search ip-tv-search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search indicators" />
            {q && <button type="button" className="ip-search-clear" onClick={() => setQ("")} aria-label="Clear">✕</button>}
          </div>
          <div className="ip-tv-main">
            <nav className="ip-tv-side">
              <div className="ip-tv-side-label">Personal</div>
              {sideBtn("fav", "Favorites", <path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />, favs.length)}
              {sideBtn("on", "On chart", <><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></>, active.length)}
              {sideBtn("My indicators", "My indicators", CATEGORY_ICONS["My indicators"], customs.length)}
              <button
                type="button"
                className={`ip-tv-side-item ip-tv-side-ai${!query && side === "build" ? " active" : ""}`}
                onClick={() => { openBuilder(); setSide("build"); setQ(""); }}
              >
                <span className="ip-tv-side-ai-spark" aria-hidden="true">✦</span>
                <span>Build with AI</span>
              </button>
              <div className="ip-tv-side-label">Built-in</div>
              {sideBtn("all", "All indicators", <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>, items.length)}
              {cats.map((c) => sideBtn(c.key, c.key, CATEGORY_ICONS[c.key]))}
            </nav>
            <div className="ip-tv-content">
              {side === "build" && !query ? (
                <div className="ip-tv-build">{builder(() => setSide("My indicators"))}</div>
              ) : (<>
              <div className="ip-tv-toolbar">
                {([["all", "All"], ["overlay", "On price"], ["pane", "Own panel"]] as const).map(([k, l]) => (
                  <button key={k} type="button" className={`ip-tv-chip${kindFilter === k ? " active" : ""}`} onClick={() => setKindFilter(k)}>{l}</button>
                ))}
                <span className="ip-tv-heading">{query ? heading : ""}</span>
                {active.length > 0 && <button type="button" className="ip-clear" onClick={clearAll}>Clear all ({active.length})</button>}
              </div>
              <div className="ip-tv-table">
                <div className="ip-tv-row ip-tv-row--head">
                  <span>Name</span><span>Type</span><span>Category</span>
                </div>
                {listed.length === 0 && (
                  <div className="ip-empty">
                    {query ? `No indicators match “${q.trim()}”.` : side === "fav" ? "Star (★) an indicator to keep it here." : side === "on" ? "Nothing on the chart yet." : side === "My indicators" ? "No AI indicators yet — use Build with AI to make one." : "Nothing here."}
                  </div>
                )}
                {listed.map((i) => (
                  <div
                    key={i.id}
                    role="button"
                    tabIndex={0}
                    className={`ip-tv-row${i.checked ? " ip-tv-row--on" : ""}`}
                    aria-pressed={i.checked}
                    title={i.description}
                    onClick={i.onToggle}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); i.onToggle(); } }}
                  >
                    <span className="ip-tv-name">
                      <button
                        type="button"
                        className={`ip-tv-star${favs.includes(i.id) ? " on" : ""}`}
                        onClick={(e) => { e.stopPropagation(); toggleFav(i.id); }}
                        aria-label={favs.includes(i.id) ? "Remove from favorites" : "Add to favorites"}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill={favs.includes(i.id) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" /></svg>
                      </button>
                      {i.color && <span className="ip-dot" style={{ background: i.color }} />}
                      <span className="ip-tv-name-text">{i.name}</span>
                      {i.pro && !isPaid && <span className="interval-sheet-item-pro">PRO</span>}
                      {aiActions(i.id)}
                      {i.checked && <svg className="ip-tv-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
                    </span>
                    <span className="ip-tv-muted">{(i.kind ?? "overlay") === "pane" ? "Own panel" : "On price"}</span>
                    <span className="ip-tv-muted">{i.category}</span>
                  </div>
                ))}
                  {(() => {
                    if (query) return null;
                    const info = side === "all"
                      ? { title: "How do indicators work?", about: "Every indicator available on this chart. Click a row to add it, click again to remove it. Overlays draw on top of the price; panel indicators get their own space under the chart. Star the ones you use most to find them under Favorites." }
                      : side === "fav"
                      ? { title: "What are Favorites?", about: "Your starred indicators, kept here for quick access. Click the ☆ next to any indicator to add it." }
                      : side === "on"
                      ? { title: "What's on your chart?", about: "Everything currently drawn on this chart. Click a row to remove it, or use Clear all." }
                      : side === "My indicators"
                      ? MINE_ABOUT
                      : { title: IND_CATEGORIES.find((c) => c.key === side)?.question ?? side, about: IND_CATEGORIES.find((c) => c.key === side)?.about ?? "" };
                    const icon = side !== "all" && side !== "fav" && side !== "on" && side !== "build" ? CATEGORY_ICONS[side] : null;
                    return (
                      <div className="ip-tv-about">
                        <div className="ip-tv-about-title">
                          {icon && (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
                          )}
                          {info.title}
                        </div>
                        <p className="ip-tv-about-text">{info.about}</p>
                      </div>
                    );
                  })()}
              </div>
              </>)}
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  const title = cat ? (
    <span className="ip-title">
      <button type="button" className="ip-back" onClick={() => setCat(null)} aria-label="Back">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
      </button>
      {cat === "__build" ? "Build with AI" : cat}
    </span>
  ) : <>Indicators</>;

  return (
    <BottomSheet open={open} onClose={close} title={title} className="ip-sheet" ariaLabel="Indicators">
      {!cat && (
        <div className="ip-search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search indicators" />
          {q && <button type="button" className="ip-search-clear" onClick={() => setQ("")} aria-label="Clear">✕</button>}
        </div>
      )}

      {cat === "__build" ? (
        <div className="ip-build-mobile">{builder(() => setCat("My indicators"))}</div>
      ) : cat ? (
        <>
          {cat === "My indicators" ? (
            <p className="ip-cat-about"><strong>{MINE_ABOUT.title}</strong> {MINE_ABOUT.about}</p>
          ) : (
            <p className="ip-cat-about"><strong>{IND_CATEGORIES.find((c) => c.key === cat)?.question}</strong> {IND_CATEGORIES.find((c) => c.key === cat)?.about}</p>
          )}
          {cat === "My indicators" && (
            <button type="button" className="ip-ai-new" onClick={() => { openBuilder(); setCat("__build"); }}>✦ Build a new one with AI</button>
          )}
          <div className="ip-list">{items.filter((i) => i.category === cat).map(row)}</div>
        </>
      ) : query ? (
        <div className="ip-list">
          {results.length ? results.map(row) : <div className="ip-empty">No indicators match “{q}”.</div>}
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <>
              <div className="ip-section ip-section--row">
                <span>On chart · {active.length}</span>
                <button type="button" className="ip-clear" onClick={clearAll}>Clear all</button>
              </div>
              <div className="ip-list">{active.map(row)}</div>
            </>
          )}
          <div className="ip-section">Your indicators</div>
          <div className="ip-list">
            <button type="button" className="ip-cat ip-cat--ai" onClick={() => { openBuilder(); setCat("__build"); }}>
              <span className="ip-cat-ai-spark" aria-hidden="true">✦</span>
              <span className="ip-row-text">
                <span className="ip-row-name">Build with AI</span>
                <span className="ip-row-sub">Describe an indicator — the AI builds it for your chart</span>
              </span>
              <svg className="ip-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
            {customs.length > 0 && (
              <button type="button" className="ip-cat" onClick={() => setCat("My indicators")}>
                <svg className="ip-cat-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{CATEGORY_ICONS["My indicators"]}</svg>
                <span className="ip-row-text">
                  <span className="ip-row-name">My indicators</span>
                  <span className="ip-row-sub">{customs.length} saved</span>
                </span>
                <svg className="ip-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
              </button>
            )}
          </div>
          <div className="ip-section">Built-in</div>
          <div className="ip-list">
            {cats.map((c) => {
              const on = items.filter((i) => i.category === c.key && i.checked).length;
              const total = items.filter((i) => i.category === c.key).length;
              return (
                <button key={c.key} type="button" className="ip-cat" onClick={() => setCat(c.key)}>
                  <svg className="ip-cat-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{CATEGORY_ICONS[c.key]}</svg>
                  <span className="ip-row-text">
                    <span className="ip-row-name">{c.key}</span>
                    <span className="ip-row-sub">{on ? `${on} on · ` : ""}{total} indicators</span>
                  </span>
                  <svg className="ip-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                </button>
              );
            })}
          </div>
        </>
      )}
    </BottomSheet>
  );
}
