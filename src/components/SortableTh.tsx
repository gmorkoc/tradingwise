import { useMemo, useState } from "react";
import "../styles/SortableTh.css";

// Click-to-sort table headers, shared by the Trade page's bottom-panel
// tables (Top Cryptocurrencies, Top Traders, Positions, History).
// First click on a column sorts high→low (A→Z for text), the next click
// flips it, a third click goes back to the table's default order.

export type SortDir = "asc" | "desc";
type Value = number | string | null | undefined;

export interface SortState {
  key: string | null;
  dir: SortDir;
  toggle: (key: string) => void;
}

export function useSort<T>(rows: T[], accessors: Record<string, (r: T) => Value>) {
  const [key, setKey] = useState<string | null>(null);
  const [dir, setDir] = useState<SortDir>("desc");

  const toggle = (k: string) => {
    if (key !== k) { setKey(k); setDir("desc"); return; }
    if (dir === "desc") { setDir("asc"); return; }
    setKey(null); setDir("desc");
  };

  const sorted = useMemo(() => {
    if (!key || !accessors[key]) return rows;
    const get = accessors[key];
    const mult = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a), vb = get(b);
      // Missing values always sink to the bottom, either direction.
      const na = va === null || va === undefined || (typeof va === "number" && !Number.isFinite(va));
      const nb = vb === null || vb === undefined || (typeof vb === "number" && !Number.isFinite(vb));
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb)) * -mult;
      return ((va as number) - (vb as number)) * mult;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, key, dir]);

  const state: SortState = { key, dir, toggle };
  return { sorted, sort: state };
}

export function SortTh({
  label, k, sort, className = "gm-th", title,
}: {
  label: React.ReactNode;
  k: string;
  sort: SortState;
  className?: string;
  title?: string;
}) {
  const active = sort.key === k;
  return (
    <th
      className={`${className} sort-th${active ? " sort-th--active" : ""}`}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      title={title}
    >
      <button type="button" className="sort-th-btn" onClick={() => sort.toggle(k)}>
        {label}
        <span className={`sort-th-arrows${active ? ` sort-th-arrows--${sort.dir}` : ""}`} aria-hidden="true">
          <svg width="7" height="10" viewBox="0 0 7 10"><path d="M3.5 0L7 4H0z" className="up" /><path d="M3.5 10L0 6h7z" className="down" /></svg>
        </span>
      </button>
    </th>
  );
}
