import { useRef, type ReactNode } from "react";
import ReactDOM from "react-dom";
import "../styles/BottomSheet.css";

// The app's one bottom sheet. Same look and behavior as MobileSymbolSheet:
// dimmed backdrop, slides up from the screen bottom (above the floating
// nav), rounded top, sticky header with grab handle + title + ✕, content
// scrolls inside. Close by tapping the backdrop, the ✕, or dragging the
// header down. Every sheet in the app uses this — don't hand-roll new ones.
interface Props {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Extra class on the sheet (e.g. a tone modifier). */
  className?: string;
  /** Extra class on the scrolling content area. */
  bodyClassName?: string;
  ariaLabel?: string;
}

export function BottomSheet({ open, onClose, title, children, className, bodyClassName, ariaLabel }: Props) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number } | null>(null);
  if (!open) return null;

  // Drag the header down to dismiss — follows the finger 1:1 downward (a
  // small rubber-band upward), closes past 90px. Only once the content is
  // scrolled to the top, so it never fights the content's own scroll.
  const onTouchStart = (e: React.TouchEvent) => {
    dragRef.current = { startY: e.touches[0].clientY };
    if (sheetRef.current) sheetRef.current.style.transition = "none";
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const drag = dragRef.current;
    const sheet = sheetRef.current;
    if (!drag || !sheet) return;
    const dy = e.touches[0].clientY - drag.startY;
    if (dy > 0 && (scrollRef.current?.scrollTop ?? 0) > 0) return;
    sheet.style.transform = `translateY(${dy > 0 ? dy : Math.max(dy / 3, -40)}px)`;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const sheet = sheetRef.current;
    if (!drag || !sheet) return;
    const dy = e.changedTouches[0].clientY - drag.startY;
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (dy > 90) onClose();
  };

  return ReactDOM.createPortal(
    <div className="bs-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className={`bs-sheet${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
        onClick={(e) => e.stopPropagation()}
      >
        <div ref={scrollRef} className="bs-scroll">
          <div className="bs-header" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
            <span className="bs-handle" aria-hidden="true" />
            <div className="bs-header-row">
              <div className="bs-title">{title}</div>
              <button type="button" className="bs-close" onClick={onClose} aria-label="Close">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
          <div className={`bs-body${bodyClassName ? ` ${bodyClassName}` : ""}`}>{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
