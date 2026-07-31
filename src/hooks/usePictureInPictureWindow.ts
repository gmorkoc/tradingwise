import { useCallback, useEffect, useRef, useState } from "react";

// Document Picture-in-Picture — Chrome/Edge only, not yet in TS's lib.dom.
declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
      window: Window | null;
    };
  }
}

// PiP windows start with an empty document — copy every stylesheet over so
// the portaled content actually looks like the app instead of unstyled HTML.
function copyStyles(sourceDoc: Document, targetDoc: Document) {
  Array.from(sourceDoc.styleSheets).forEach((sheet) => {
    try {
      const cssText = Array.from(sheet.cssRules).map(r => r.cssText).join("\n");
      const style = targetDoc.createElement("style");
      style.textContent = cssText;
      targetDoc.head.appendChild(style);
    } catch {
      // Cross-origin stylesheet — cssRules throws; link it instead.
      if (sheet.href) {
        const link = targetDoc.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        targetDoc.head.appendChild(link);
      }
    }
  });
}

export function usePictureInPictureWindow() {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const isSupported = typeof window !== "undefined" && !!window.documentPictureInPicture;

  const closePip = useCallback(() => {
    pipWindowRef.current?.close();
  }, []);

  const requestPip = useCallback(async (width = 340, height = 280) => {
    if (!window.documentPictureInPicture) return null;
    const win = await window.documentPictureInPicture.requestWindow({ width, height });

    copyStyles(document, win.document);
    win.document.title = document.title;
    win.document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? "";
    win.document.body.style.margin = "0";

    pipWindowRef.current = win;
    setPipWindow(win);

    win.addEventListener(
      "pagehide",
      () => {
        pipWindowRef.current = null;
        setPipWindow(null);
      },
      { once: true },
    );

    return win;
  }, []);

  useEffect(() => () => { pipWindowRef.current?.close(); }, []);

  return { pipWindow, isSupported, requestPip, closePip };
}
