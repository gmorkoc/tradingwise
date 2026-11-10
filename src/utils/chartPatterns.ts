// Classic chart patterns: Head & Shoulders (+ inverse), Double Top/Bottom,
// Ascending / Descending / Symmetrical Triangles, Rising / Falling Wedges,
// Bull / Bear Flags.
//
// Everything is detected in "up is up" form; the bearish/bullish twin is
// found by running the same code on a mirrored copy of the candles (prices
// negated), then flipping the prices back. So "double top" code also finds
// double bottoms, "rising wedge" finds falling wedges, and so on.
//
// Rules of thumb used (standard textbook guidelines, no success-rate claims):
// - Every pattern needs a trend going into it (reversal patterns) or a pole
//   (flags), a minimum size in ATRs, and clean swings that fit its lines.
// - "breakout" = a candle CLOSED past the trigger line; "forming" = not yet.
// - Patterns that already hit their target or failed are dropped, so what's
//   shown is always still live.

export interface PBar { time: number; open: number; high: number; low: number; close: number }
export interface CPPoint { time: number; price: number }
export type CPKind =
  | "head-shoulders" | "inv-head-shoulders" | "double-top" | "double-bottom"
  | "asc-triangle" | "desc-triangle" | "sym-triangle"
  | "rising-wedge" | "falling-wedge" | "bull-flag" | "bear-flag";

export interface ChartPattern {
  kind: CPKind;
  name: string;
  bias: "bullish" | "bearish";
  status: "forming" | "breakout";
  /** shape = zig-zag through the swings; trigger = the line to break; boundary = triangle/flag edges; pole = flagpole */
  lines: Array<{ role: "shape" | "trigger" | "boundary" | "pole"; points: CPPoint[] }>;
  labels: Array<CPPoint & { text: string; above: boolean }>;
  trigger: number;
  target: number;
  invalidation: number;
  startTime: number;
  /** Plain-language explanation (what the shape is) and what usually comes next. */
  what: string;
  next: string;
}

type Swing = { idx: number; price: number; type: "high" | "low" };
type Line = (i: number) => number;

const fmt = (p: number) => "$" + p.toLocaleString("en-US", { maximumFractionDigits: Math.abs(p) < 10 ? 4 : Math.abs(p) < 1000 ? 2 : 0 });

function atr(b: PBar[], n = 14): number {
  const trs: number[] = [];
  for (let i = Math.max(1, b.length - n); i < b.length; i++)
    trs.push(Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)));
  return trs.length ? trs.reduce((a, c) => a + c, 0) / trs.length : 0;
}

/** Alternating swing highs/lows (3 bars each side), ignoring swings under minMove. */
function swings(b: PBar[], minMove: number, lb = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = lb; i < b.length - lb; i++) {
    let isH = true, isL = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (b[j].high >= b[i].high) isH = false;
      if (b[j].low <= b[i].low) isL = false;
    }
    const found: Swing[] = [];
    if (isH) found.push({ idx: i, price: b[i].high, type: "high" });
    if (isL) found.push({ idx: i, price: b[i].low, type: "low" });
    for (const p of found) {
      const last = out[out.length - 1];
      if (!last) { out.push(p); continue; }
      if (last.type === p.type) {                 // same side twice: keep the more extreme one
        if ((p.type === "high") === (p.price > last.price)) out[out.length - 1] = p;
        continue;
      }
      if (Math.abs(p.price - last.price) >= minMove) out.push(p);
    }
  }
  return out;
}

const through = (a: { idx: number; price: number }, c: { idx: number; price: number }): Line =>
  i => a.price + (c.price - a.price) * (i - a.idx) / (c.idx - a.idx || 1);

/** Least-squares line through points (index → price). */
function fit(ps: Array<{ idx: number; price: number }>): Line {
  if (ps.length === 2) return through(ps[0], ps[1]);
  const n = ps.length;
  const mx = ps.reduce((a, p) => a + p.idx, 0) / n, my = ps.reduce((a, p) => a + p.price, 0) / n;
  const sxx = ps.reduce((a, p) => a + (p.idx - mx) ** 2, 0) || 1;
  const k = ps.reduce((a, p) => a + (p.idx - mx) * (p.price - my), 0) / sxx;
  return i => my + k * (i - mx);
}

const mirror = (b: PBar[]): PBar[] => b.map(x => ({ time: x.time, open: -x.open, high: -x.low, low: -x.high, close: -x.close }));

/** Helpers for building a result in mirrored space (s = 1 normal, -1 mirrored). */
function builder(b: PBar[], s: 1 | -1) {
  const pt = (idx: number, v: number): CPPoint => ({ time: b[idx].time, price: v * s });
  const line = (f: Line, i0: number, i1: number): CPPoint[] => [pt(i0, f(i0)), pt(i1, f(i1))];
  return { pt, line, real: (v: number) => v * s };
}

function nextText(bull: boolean, status: ChartPattern["status"], trigger: number, target: number, inv: number, size: string): string {
  const way = bull ? "above" : "below";
  const cancel = `${bull ? "A drop back below" : "A climb back above"} ${fmt(inv)}`;
  return status === "breakout"
    ? `Price already closed ${way} ${fmt(trigger)} — the pattern is confirmed. The usual move is about ${size}, toward ${fmt(target)}. ${cancel} would mean it failed.`
    : `The signal is a candle closing ${way} ${fmt(trigger)}. After that, the usual move is about ${size} — toward ${fmt(target)}. ${cancel} cancels it.`;
}

// ── Head & Shoulders ─────────────────────────────────────────────────────────
function headShoulders(b: PBar[], sw: Swing[], A: number, s: 1 | -1): ChartPattern | null {
  const n = b.length, { pt, line, real } = builder(b, s);
  for (const off of [0, 1]) {
    const end = sw.length - off;
    if (end < 6) continue;
    const [pre, LS, N1, HD, N2, RS] = sw.slice(end - 6, end);
    if (LS.type !== "high" || HD.type !== "high" || RS.type !== "high") continue;
    const neck = through(N1, N2);
    const h = HD.price - (N1.price + N2.price) / 2;
    if (h < 2.5 * A) continue;
    if (HD.price - Math.max(LS.price, RS.price) < 0.15 * h) continue;           // head clearly highest
    if (Math.abs(LS.price - RS.price) > 0.3 * h) continue;                      // shoulders about level
    if (Math.min(LS.price, RS.price) - Math.max(N1.price, N2.price) < 0.3 * h) continue;
    if (Math.abs(N1.price - N2.price) > 0.35 * h) continue;                     // neckline not too steep
    if (pre.price >= Math.min(N1.price, N2.price)) continue;                    // trend came in from below
    const r = (RS.idx - HD.idx) / (HD.idx - LS.idx || 1);
    if (r < 0.4 || r > 2.5) continue;                                           // roughly balanced in time

    let bi = -1, broken = false;
    for (let i = RS.idx + 1; i < n; i++) {
      if (b[i].close < neck(i)) { bi = i; break; }
      if (b[i].high > RS.price) { broken = true; break; }                      // RS wasn't the last top
    }
    if (broken) continue;
    const iEnd = bi >= 0 ? bi : n - 1;
    const trig = neck(iEnd), tgt = trig - h;
    if (bi >= 0) {
      if (n - 1 - bi > 20) continue;                                            // old news
      const after = b.slice(bi + 1);
      if (after.some(x => x.low <= tgt) || after.some(x => x.close > RS.price)) continue; // played out / failed
    }
    const bull = s === -1;
    return {
      kind: bull ? "inv-head-shoulders" : "head-shoulders",
      name: bull ? "Inverse Head & Shoulders" : "Head & Shoulders",
      bias: bull ? "bullish" : "bearish",
      status: bi >= 0 ? "breakout" : "forming",
      lines: [
        { role: "shape", points: [pre, LS, N1, HD, N2, RS].map(p => pt(p.idx, p.price)) },
        { role: "trigger", points: line(neck, N1.idx, iEnd) },
      ],
      labels: [
        { ...pt(LS.idx, LS.price), text: "Left shoulder", above: !bull },
        { ...pt(HD.idx, HD.price), text: "Head", above: !bull },
        { ...pt(RS.idx, RS.price), text: "Right shoulder", above: !bull },
      ],
      trigger: real(trig), target: real(tgt), invalidation: real(RS.price), startTime: b[LS.idx].time,
      what: bull
        ? "Three dips in a row, and the middle one is the deepest (the \"head\"). Sellers pushed down three times, but the last push was weaker — buyers are taking over."
        : "Three hills in a row, and the middle one is the tallest (the \"head\"). Buyers pushed up three times, but the last push was weaker — sellers are taking over.",
      next: nextText(bull, bi >= 0 ? "breakout" : "forming", real(trig), real(tgt), real(RS.price), "as far as the head is tall"),
    };
  }
  return null;
}

// ── Double Top / Bottom ──────────────────────────────────────────────────────
function doubleTop(b: PBar[], sw: Swing[], A: number, s: 1 | -1): ChartPattern | null {
  const n = b.length, { pt, real } = builder(b, s);
  for (const off of [0, 1]) {
    const end = sw.length - off;
    if (end < 4) continue;
    const [pre, T1, L1, T2] = sw.slice(end - 4, end);
    if (T1.type !== "high" || T2.type !== "high") continue;
    const top = Math.max(T1.price, T2.price);
    const height = (T1.price + T2.price) / 2 - L1.price;
    if (height < 2.5 * A) continue;
    if (Math.abs(T1.price - T2.price) > 0.25 * height) continue;               // same ceiling, roughly
    if (T2.idx - T1.idx < 8) continue;                                          // two separate tests
    if (pre.price >= L1.price) continue;                                        // trend came in from below

    let bi = -1, broken = false;
    for (let i = T2.idx + 1; i < n; i++) {
      if (b[i].close < L1.price) { bi = i; break; }
      if (b[i].close > top) { broken = true; break; }
    }
    if (broken) continue;
    const tgt = L1.price - height;
    if (bi >= 0) {
      if (n - 1 - bi > 20) continue;
      const after = b.slice(bi + 1);
      if (after.some(x => x.low <= tgt) || after.some(x => x.close > top)) continue;
    }
    const bull = s === -1, iEnd = bi >= 0 ? bi : n - 1;
    return {
      kind: bull ? "double-bottom" : "double-top",
      name: bull ? "Double Bottom" : "Double Top",
      bias: bull ? "bullish" : "bearish",
      status: bi >= 0 ? "breakout" : "forming",
      lines: [
        { role: "shape", points: [pre, T1, L1, T2].map(p => pt(p.idx, p.price)) },
        { role: "trigger", points: [pt(T1.idx, L1.price), pt(iEnd, L1.price)] },
      ],
      labels: [
        { ...pt(T1.idx, T1.price), text: bull ? "Bottom 1" : "Top 1", above: !bull },
        { ...pt(T2.idx, T2.price), text: bull ? "Bottom 2" : "Top 2", above: !bull },
      ],
      trigger: real(L1.price), target: real(tgt), invalidation: real(top), startTime: b[T1.idx].time,
      what: bull
        ? `Price fell to about the same low (${fmt(real(T1.price))}) twice and bounced both times — like hitting a floor it can't break.`
        : `Price rose to about the same high (${fmt(real(T1.price))}) twice and got pushed back both times — like hitting a ceiling it can't break.`,
      next: nextText(bull, bi >= 0 ? "breakout" : "forming", real(L1.price), real(tgt), real(top), "as far as the pattern is tall"),
    };
  }
  return null;
}

// ── Triangles & wedges ───────────────────────────────────────────────────────
function converging(b: PBar[], sw: Swing[], A: number, s: 1 | -1): ChartPattern | null {
  const n = b.length, { pt, line, real } = builder(b, s);
  for (let k = 7; k >= 5; k--) {                     // prefer the longest clean window
    if (sw.length < k) continue;
    const win = sw.slice(sw.length - k);
    const H = win.filter(p => p.type === "high"), L = win.filter(p => p.type === "low");
    if (H.length < 2 || L.length < 2) continue;
    const up = fit(H), lo = fit(L);
    if (H.some(p => Math.abs(p.price - up(p.idx)) > 0.6 * A) || L.some(p => Math.abs(p.price - lo(p.idx)) > 0.6 * A)) continue;
    const i0 = win[0].idx, iLast = win[k - 1].idx;
    let messy = false;
    for (let i = i0; i <= iLast; i++) if (b[i].close > up(i) + 0.5 * A || b[i].close < lo(i) - 0.5 * A) { messy = true; break; }
    if (messy) continue;

    let bi = -1, dir = 0;
    for (let i = iLast + 1; i < n; i++) {
      if (b[i].close > up(i)) { bi = i; dir = 1; break; }
      if (b[i].close < lo(i)) { bi = i; dir = -1; break; }
    }
    const iEnd = bi >= 0 ? bi : n - 1;
    const w0 = up(i0) - lo(i0), w1 = up(iEnd) - lo(iEnd);
    if (w0 < 3 * A || w1 <= 0 || w1 > 0.75 * w0) continue;                     // must be narrowing
    const su = (up(iEnd) - up(i0)) / w0, sl = (lo(iEnd) - lo(i0)) / w0;
    const flat = (x: number) => Math.abs(x) < 0.15;

    let kind: "asc" | "sym" | "wedge";
    if (flat(su) && sl > 0.15) kind = "asc";          // flat ceiling, rising floor
    else if (su < -0.15 && sl > 0.15) kind = "sym";   // lower highs, higher lows
    else if (su > 0.15 && sl > su) kind = "wedge";    // both rising, floor rising faster
    else continue;
    if (kind === "sym" && s === -1) continue;         // symmetrical is its own mirror

    // Expected break: ascending → up, rising wedge → down, symmetrical → the
    // way the trend came in.
    const pre = sw[sw.length - k - 1];
    const trendIn = pre ? (pre.price < lo(i0) ? 1 : pre.price > up(i0) ? -1 : 0) : 0;
    const want = kind === "asc" ? 1 : kind === "wedge" ? -1 : (dir || trendIn || 1);
    if (bi >= 0 && dir !== want) continue;            // broke the "wrong" way = failed pattern
    if (bi >= 0 && n - 1 - bi > 15) continue;

    const trig = want === 1 ? up(iEnd) : lo(iEnd);
    const tgt = kind === "wedge" ? lo(i0) : want === 1 ? up(iEnd) + w0 : lo(iEnd) - w0;
    const inv = want === 1 ? lo(iEnd) : up(iEnd);
    if (bi >= 0) {
      const after = b.slice(bi + 1);
      if (after.some(x => (want === 1 ? x.high >= tgt : x.low <= tgt))) continue;      // played out
      if (after.some(x => (want === 1 ? x.close < inv : x.close > inv))) continue;     // fell back through = failed
    }

    const bull = (want === 1) === (s === 1);
    const R = { trig: real(trig), tgt: real(tgt), inv: real(inv) };
    let kindOut: CPKind, name: string, what: string, size: string;
    if (kind === "asc") {
      kindOut = s === 1 ? "asc-triangle" : "desc-triangle";
      name = s === 1 ? "Ascending Triangle" : "Descending Triangle";
      what = s === 1
        ? `Sellers keep defending the same ceiling (about ${fmt(R.trig)}), but buyers step in higher every time — the floor keeps rising. The squeeze usually ends with a break up through the ceiling.`
        : `Buyers keep defending the same floor (about ${fmt(R.trig)}), but sellers push in lower every time — the ceiling keeps falling. The squeeze usually ends with a break down through the floor.`;
      size = "as big as the triangle's widest part";
    } else if (kind === "sym") {
      kindOut = "sym-triangle"; name = "Symmetrical Triangle";
      what = `Highs keep getting lower and lows keep getting higher — price is coiling tighter and tighter. It can break either way; ${bi >= 0 ? `it broke ${bull ? "up" : "down"}.` : trendIn ? `the trend before it was ${trendIn === 1 ? "up" : "down"}, so that's the more common way out.` : "watch which line breaks first."}`;
      size = "as big as the triangle's widest part";
    } else {
      kindOut = s === 1 ? "rising-wedge" : "falling-wedge";
      name = s === 1 ? "Rising Wedge" : "Falling Wedge";
      what = s === 1
        ? "Price is climbing, but each push up is smaller — both lines slope up and squeeze together. Buyers are getting tired, and rising wedges usually break down."
        : "Price is falling, but each push down is smaller — both lines slope down and squeeze together. Sellers are getting tired, and falling wedges usually break up.";
      size = "back to where the wedge started";
    }
    let next = nextText(bull, bi >= 0 ? "breakout" : "forming", R.trig, R.tgt, R.inv, size);
    if (kind === "sym" && bi < 0)
      next += ` (A close ${bull ? "below" : "above"} ${fmt(R.inv)} would point the other way instead.)`;
    return {
      kind: kindOut, name, bias: bull ? "bullish" : "bearish",
      status: bi >= 0 ? "breakout" : "forming",
      lines: [
        { role: "shape", points: win.map(p => pt(p.idx, p.price)) },
        { role: want === 1 ? "trigger" : "boundary", points: line(up, i0, iEnd) },
        { role: want === 1 ? "boundary" : "trigger", points: line(lo, i0, iEnd) },
      ],
      labels: [],
      trigger: R.trig, target: R.tgt, invalidation: R.inv, startTime: b[i0].time,
      what, next,
    };
  }
  return null;
}

// ── Flags ────────────────────────────────────────────────────────────────────
function flag(b: PBar[], A: number, s: 1 | -1): ChartPattern | null {
  const n = b.length, { pt, line, real } = builder(b, s);
  if (n < 30) return null;
  // Pole top: highest high of the last 25 bars, leaving at least 4 bars of flag.
  let f = -1;
  for (let i = n - 25; i <= n - 5; i++) if (f < 0 || b[i].high > b[f].high) f = i;
  let p0 = -1;
  for (let i = Math.max(0, f - 15); i <= f - 3; i++) if (p0 < 0 || b[i].low < b[p0].low) p0 = i;
  if (p0 < 0) return null;
  const pole = b[f].high - b[p0].low;
  if (pole < 5 * A) return null;                                   // a real, fast move

  const fitEnd = n - 3;                                            // last 2 bars may be the breakout
  if (fitEnd - f < 4) return null;
  const seg = b.slice(f, fitEnd + 1).map((x, j) => ({ idx: f + j, x }));
  const up = fit(seg.map(o => ({ idx: o.idx, price: o.x.high })));
  const lo = fit(seg.map(o => ({ idx: o.idx, price: o.x.low })));
  const wS = up(f) - lo(f), wE = up(fitEnd) - lo(fitEnd);
  if (wS <= 0 || wE <= 0 || wE / wS < 0.5 || wE / wS > 1.6) return null;      // roughly parallel
  if (Math.max(wS, wE) > 0.5 * pole) return null;                             // small vs the pole
  const su = (up(fitEnd) - up(f)) / pole, sl = (lo(fitEnd) - lo(f)) / pole;
  if (su > 0.05 || sl > 0.05 || su < -0.5 || sl < -0.5) return null;          // drifts sideways/against the pole
  const flagLow = Math.min(...b.slice(f, n).map(x => x.low));
  if ((b[f].high - flagLow) / pole > 0.5) return null;                        // gave back too much
  if (seg.some(o => o.x.close > up(o.idx) + 0.3 * A || o.x.close < lo(o.idx) - 0.3 * A)) return null;

  let bi = -1;
  for (let i = fitEnd + 1; i < n; i++) if (b[i].close > up(i)) { bi = i; break; }
  if (b.slice(fitEnd + 1).some(x => x.close < lo(n - 1) - 0.3 * A)) return null; // broke the wrong way
  const iEnd = bi >= 0 ? bi : n - 1;
  const trig = up(iEnd), tgt = trig + pole;
  if (bi >= 0 && b.slice(bi + 1).some(x => x.close < flagLow || x.high >= tgt)) return null; // failed / played out
  const bull = s === 1;
  return {
    kind: bull ? "bull-flag" : "bear-flag",
    name: bull ? "Bull Flag" : "Bear Flag",
    bias: bull ? "bullish" : "bearish",
    status: bi >= 0 ? "breakout" : "forming",
    lines: [
      { role: "pole", points: [pt(p0, b[p0].low), pt(f, b[f].high)] },
      { role: "trigger", points: line(up, f, iEnd) },
      { role: "boundary", points: line(lo, f, iEnd) },
    ],
    labels: [{ ...pt(f, b[f].high), text: "Flagpole", above: bull }],
    trigger: real(trig), target: real(tgt), invalidation: real(flagLow), startTime: b[p0].time,
    what: bull
      ? "Price shot up fast (the flagpole), then drifted sideways in a small, tidy channel (the flag) — like catching its breath. Flags usually continue the move that came before."
      : "Price dropped fast (the flagpole), then drifted sideways in a small, tidy channel (the flag) — like catching its breath. Flags usually continue the move that came before.",
    next: nextText(bull, bi >= 0 ? "breakout" : "forming", real(trig), real(tgt), real(flagLow), "as big as the flagpole"),
  };
}

/**
 * Finds live classic chart patterns on closed candles. Best match first:
 * Head & Shoulders → Triangle/Wedge → Double Top/Bottom → Flag.
 */
export function detectChartPatterns(closed: PBar[]): ChartPattern[] {
  if (closed.length < 40) return [];
  const A = atr(closed);
  if (!A) return [];
  const mb = mirror(closed);
  const sw = swings(closed, 1.2 * A), msw = swings(mb, 1.2 * A);
  // Triangles/wedges before double tops and flags: a triangle's last swings
  // can also read as a double top, and a wedge's last leg as a flag — the
  // multi-touch shape is the more specific (and correct) name.
  const found = [
    headShoulders(closed, sw, A, 1), headShoulders(mb, msw, A, -1),
    converging(closed, sw, A, 1), converging(mb, msw, A, -1),
    doubleTop(closed, sw, A, 1), doubleTop(mb, msw, A, -1),
    flag(closed, A, 1), flag(mb, A, -1),
  ];
  return found.filter((p): p is ChartPattern => !!p);
}
