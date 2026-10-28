import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";

// iPhone app: every external link (an <a href> to another site, or a
// window.open of an http(s) URL) opens in the in-app browser
// (SFSafariViewController — slides up over the app, "Done" returns)
// instead of throwing the user out to Safari. Web is untouched.
//
// Exceptions that must leave the app: mailto:/tel:/sms: and App Store links.

const isExternalHttp = (url: string) => {
  try {
    const u = new URL(url, window.location.href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.origin === window.location.origin) return false;
    if (/(^|\.)apps\.apple\.com$/.test(u.hostname)) return false; // let iOS open the App Store
    return true;
  } catch {
    return false;
  }
};

const openInApp = (url: string) => {
  Browser.open({ url: new URL(url, window.location.href).toString(), presentationStyle: "popover" }).catch(() => {
    window.location.href = url;
  });
};

let installed = false;
export function installInAppLinks() {
  if (installed || !Capacitor.isNativePlatform()) return;
  installed = true;

  // Plain links.
  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (!isExternalHttp(href)) return;
      e.preventDefault();
      openInApp(a.href);
    },
    true,
  );

  // Scripted window.open(...) of external pages.
  const nativeOpen = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const u = url ? url.toString() : "";
    if (u && isExternalHttp(u)) {
      openInApp(u);
      return null;
    }
    return nativeOpen(url as string, target, features);
  }) as typeof window.open;
}
