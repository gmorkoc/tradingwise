// Ignores "taps" that weren't meant as taps on touch screens:
//  • the finger moved more than a few px (a short drag/scroll), or
//  • the touch started while the page was still scrolling (momentum) —
//    on iOS the tap that stops a gliding list also fires a click on the
//    row under the finger.
// One set of global listeners; call isRealTap() at the start of a handler.

const MOVE_PX = 10;          // finger travel that turns a tap into a drag
const MOMENTUM_MS = 140;     // scroll this recently before touchstart = still gliding

let lastScrollAt = 0;
let startX = 0, startY = 0;
let moved = false;
let startedWhileScrolling = false;
let lastTouchAt = 0;

if (typeof window !== "undefined") {
  window.addEventListener("scroll", () => { lastScrollAt = performance.now(); }, { capture: true, passive: true });
  window.addEventListener("touchstart", (e) => {
    const p = e.touches[0];
    if (!p) return;
    startX = p.clientX; startY = p.clientY;
    moved = false;
    startedWhileScrolling = performance.now() - lastScrollAt < MOMENTUM_MS;
    lastTouchAt = performance.now();
  }, { capture: true, passive: true });
  window.addEventListener("touchmove", (e) => {
    const p = e.touches[0];
    if (!p || moved) return;
    if (Math.abs(p.clientX - startX) > MOVE_PX || Math.abs(p.clientY - startY) > MOVE_PX) moved = true;
  }, { capture: true, passive: true });
}

/** True for a deliberate tap (and always for mouse/keyboard clicks). */
export function isRealTap(): boolean {
  // Not from a recent touch (mouse, keyboard) → always real.
  if (performance.now() - lastTouchAt > 1000) return true;
  return !moved && !startedWhileScrolling;
}
