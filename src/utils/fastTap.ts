// Taps that always register on iOS — app-wide, for every button and link.
//
// iOS drops the browser's synthetic "click" when the finger drifts a few
// px, the press lasts a bit long, the keyboard is up (the first tap just
// dismisses it), or the page changes under the finger (glass, glint and
// spinner animations run right then) — so a tap sometimes did nothing.
// Here a touch that starts and ends on the same control, moving less than
// 24px and without anything scrolling in between, clicks it on finger-up;
// the browser's own click that may follow is swallowed so nothing fires
// twice. Touch only: mouse, pen and keyboard clicks are untouched.
//
// Left alone (native behaviour): text fields, selects, checkboxes, sliders,
// labels (they forward to their input), the floating nav (has its own
// version), anything draggable, and anything marked data-no-fasttap.

import { hapticTap } from "./haptics";

const TARGETS ='button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="link"], [role="switch"]';
const SKIP = 'input, textarea, select, label, [contenteditable="true"], [draggable="true"], .fnb-bar, [data-no-fasttap]';
const SLOP = 24;
// These buzz on every tap (iOS app only), like the floating nav.
const HAPTIC_ZONES = ".icon-strip, .drawer";

function controlFor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(SKIP)) return null;
  const el = target.closest<HTMLElement>(TARGETS);
  if (!el) return null;
  if (el.matches(":disabled, [aria-disabled='true']")) return null;
  return el;
}

export function installFastTap(): void {
  let down: { el: HTMLElement; x: number; y: number } | null = null;
  let fired: { at: number } | null = null;

  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") { down = null; return; }
    const el = controlFor(e.target);
    down = el ? { el, x: e.clientX, y: e.clientY } : null;
  }, true);

  // Anything scrolling during the touch means it was a swipe, not a tap.
  document.addEventListener("scroll", () => { down = null; }, true);
  document.addEventListener("pointercancel", () => { down = null; }, true);

  document.addEventListener("pointerup", (e) => {
    const d = down;
    down = null;
    if (!d || e.pointerType !== "touch") return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > SLOP) return;
    if (!d.el.isConnected) return;
    const upEl = controlFor(e.target);
    if (upEl !== d.el && !d.el.contains(e.target as Node)) return;
    fired = { at: Date.now() };
    if (d.el.closest(HAPTIC_ZONES)) hapticTap();
    d.el.click();
  }, true);

  // Swallow the browser's own click that follows our tap — whatever it
  // lands on: if our tap opened something (a menu, a sheet), that late
  // click would otherwise hit what's now under the finger.
  document.addEventListener("click", (e) => {
    const f = fired;
    if (!f || !e.isTrusted || Date.now() - f.at > 600) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    fired = null;
  }, true);
}
