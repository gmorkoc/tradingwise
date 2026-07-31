import { useCallback, useRef, useState, type ReactNode } from "react";
import ReactDOM from "react-dom";
import "../styles/HoverTip.css";

interface Props {
  text: string;
  children: ReactNode;
  className?: string;
}

// Native `title` tooltips only appear after ~1s of the cursor sitting still,
// and the timer resets on every mouse move — so scanning across a row of
// stats made it feel like tooltips only fired near the edge where the
// cursor happened to land first. This shows instantly, via a portal so it's
// never clipped by an ancestor's overflow (the stats row scrolls, so a
// CSS-only absolutely-positioned tooltip would get cut off).
export function HoverTip({ text, children, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, 90),
      window.innerWidth - 90,
    );
    setPos({ top: rect.bottom + 8, left });
  }, []);

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
          <div className="hovertip-bubble" style={{ top: pos.top, left: pos.left }}>
            {text}
          </div>,
          document.body,
        )}
    </div>
  );
}
