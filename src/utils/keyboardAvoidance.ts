import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";

// The Keyboard plugin is configured with resize: 'none' (capacitor.config.ts)
// so iOS never auto-resizes/scrolls the WebView for a focused input — that
// was the fix for the coin-picker popover getting stuck shifted after the
// keyboard dismissed. The tradeoff: nothing now scrolls a focused input
// clear of the keyboard for ANY form, so a field near the bottom of a
// scrollable modal (auth, upgrade, contact, etc.) becomes unreachable. This
// replaces that lost OS behavior globally, for every form, in one place.

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function isTextInput(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

export function initKeyboardAvoidance(): void {
  if (!Capacitor.isNativePlatform()) return;

  let adjustedEl: HTMLElement | null = null;
  let previousPaddingBottom = "";

  Keyboard.addListener("keyboardWillShow", (info) => {
    const active = document.activeElement;
    if (!isTextInput(active)) return;
    const scrollParent = findScrollParent(active);
    if (!scrollParent) return;

    adjustedEl = scrollParent;
    previousPaddingBottom = scrollParent.style.paddingBottom;
    scrollParent.style.paddingBottom = `${info.keyboardHeight}px`;

    // Let the padding change land before asking the browser to scroll —
    // scrollIntoView's math needs the new (larger) scrollHeight in place.
    requestAnimationFrame(() => {
      active.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  });

  Keyboard.addListener("keyboardDidHide", () => {
    if (adjustedEl) {
      adjustedEl.style.paddingBottom = previousPaddingBottom;
      adjustedEl = null;
    }
  });
}
