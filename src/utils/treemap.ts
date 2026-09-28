// Squarified treemap layout (Bruls, Huizing, van Wijk) — lays out a set of
// weighted items into a rectangle so each item's area is proportional to
// its value, while keeping aspect ratios close to square for readability.
// No dependency needed for this; the algorithm is short and doesn't change.
export interface TreemapInput<T> { value: number; item: T }
export interface TreemapRect<T> { x: number; y: number; width: number; height: number; value: number; item: T }

interface Areaed<T> extends TreemapInput<T> { area: number }

function worstRatio<T>(row: Areaed<T>[], side: number): number {
  if (side <= 0 || row.length === 0) return Infinity;
  const sum = row.reduce((s, r) => s + r.area, 0);
  if (sum <= 0) return Infinity;
  const rMax = Math.max(...row.map(r => r.area));
  const rMin = Math.min(...row.map(r => r.area));
  const side2 = side * side;
  const sum2 = sum * sum;
  return Math.max((side2 * rMax) / sum2, sum2 / (side2 * rMin));
}

export function squarify<T>(
  inputs: TreemapInput<T>[],
  x: number, y: number, width: number, height: number,
): TreemapRect<T>[] {
  const results: TreemapRect<T>[] = [];
  const sorted = inputs.filter(i => i.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || width <= 1 || height <= 1 || sorted.length === 0) return results;

  const scale = (width * height) / total;
  let remaining: Areaed<T>[] = sorted.map(i => ({ ...i, area: i.value * scale }));
  let rx = x, ry = y, rw = width, rh = height;

  while (remaining.length > 0) {
    const side = Math.min(rw, rh);
    let row: Areaed<T>[] = [remaining[0]];
    let idx = 1;
    // Grow the current row as long as adding the next item improves (or at
    // least doesn't worsen) the row's worst aspect ratio.
    while (idx < remaining.length) {
      const next = [...row, remaining[idx]];
      if (worstRatio(next, side) <= worstRatio(row, side)) {
        row = next;
        idx++;
      } else {
        break;
      }
    }
    remaining = remaining.slice(row.length);

    const rowSum = row.reduce((s, r) => s + r.area, 0);
    if (rw <= rh) {
      // Shorter side is the width — lay the row as a horizontal strip
      // across the top, full width, then shrink the remaining rect down.
      const stripH = rowSum / rw;
      let offsetX = rx;
      for (const r of row) {
        const w = r.area / stripH;
        results.push({ x: offsetX, y: ry, width: w, height: stripH, value: r.value, item: r.item });
        offsetX += w;
      }
      ry += stripH;
      rh -= stripH;
    } else {
      // Shorter side is the height — lay the row as a vertical strip down
      // the left, full height, then shrink the remaining rect rightward.
      const stripW = rowSum / rh;
      let offsetY = ry;
      for (const r of row) {
        const h = r.area / stripW;
        results.push({ x: rx, y: offsetY, width: stripW, height: h, value: r.value, item: r.item });
        offsetY += h;
      }
      rx += stripW;
      rw -= stripW;
    }
  }

  return results;
}
