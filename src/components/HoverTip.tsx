import { useCallback, useRef, useState, type ReactNode } from "react";
import ReactDOM from "react-dom";
import "../styles/HoverTip.css";

interface Props {
  text: string;
  children: ReactNode;
  className?: string;
  // "bottom" (default): centered under the element, same as this always
  // did. "left": vertically centered, to the left of the element — for a
  // row of icon buttons near the screen's right edge (top-nav-icons),
  // where a below-centered bubble reads as floating in open space below
  // whichever icon instead of clearly labeling it.
  placement?: "bottom" | "left";
}

// Native `title` tooltips only appear after ~1s of the cursor sitting still,
// and the timer resets on every mouse move — so scanning across a row of
// stats made it feel like tooltips only fired near the edge where the
// cursor happened to land first. This shows instantly, via a portal so it's
// never clipped by an ancestor's overflow (the stats row scrolls, so a
// CSS-only absolutely-positioned tooltip would get cut off).
export function HoverTip({ text, children, className, placement = "bottom" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    if (placement === "left") {
      setPos({ top: rect.top + rect.height / 2, left: rect.left - 8 });
      return;
    }
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, 90),
      window.innerWidth - 90,
    );
    setPos({ top: rect.bottom + 8, left });
  }, [placement]);

  const hide = useCallback(() => setPos(null), []);

  return (
    <div
      ref={ref}
      className={className}
      onMouseEnter={show}
      onMouseLeave={hide}
      onTouchStart={show}
      onTouchEnd={hide}
    >
      {children}
      {pos &&
        ReactDOM.createPortal(
          <div
            className={`hovertip-bubble${placement === "left" ? " hovertip-bubble--left" : ""}`}
            style={{ top: pos.top, left: pos.left }}
          >
            {text}
          </div>,
          document.body,
        )}
    </div>
  );
}
