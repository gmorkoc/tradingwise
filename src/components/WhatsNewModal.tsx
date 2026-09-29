import { useEffect, useState } from "react";
import "../styles/WhatsNewModal.css";

interface Slide {
  icon: string;
  gradient: string;
  // Real screenshot from the app (Frans/simulator) — falls back to the
  // gradient + icon placeholder above until one's wired in.
  screenshot?: string;
  title: string;
  desc: string;
  ctaLabel: string;
  section: string;
}

// Cache-bust suffix — these exact filenames under public/whats-new/ have
// been overwritten in place multiple times while iterating on the crops,
// and browsers cache images more aggressively than a page reload
// reliably busts. Bump this whenever the files change again.
const IMG_V = "4";

const SLIDES: Slide[] = [
  {
    icon: "▮",
    gradient: "linear-gradient(135deg, #7c3aed, #a855f7)",
    screenshot: `/whats-new/inside-the-candle.png?v=${IMG_V}`,
    title: "Institutional-grade chart reading",
    desc: "Elliott Wave with invalidation levels, ICT smart money concepts, Wyckoff phases, and Volume Profile — all in one AI-powered read.",
    ctaLabel: "Open Inside the Candle",
    section: "candleai",
  },
  {
    icon: "◈",
    gradient: "linear-gradient(135deg, #0891b2, #0ea5e9)",
    screenshot: `/whats-new/analyze-chart.png?v=${IMG_V}`,
    title: "Any chart, any platform, one AI read",
    desc: "Snap or upload a chart from TradingView, your broker, anywhere — get a full technical breakdown: patterns, levels, and a real take.",
    ctaLabel: "Analyze a Chart",
    section: "analyze-chart",
  },
  {
    icon: "▦",
    gradient: "linear-gradient(135deg, #4f46e5, #7c3aed)",
    screenshot: `/whats-new/market-heatmap.png?v=${IMG_V}`,
    title: "See the whole market at a glance",
    desc: "120 coins sized by market cap, colored by 24h change — spot the movers instantly on the new Market Heatmap.",
    ctaLabel: "View Market Heatmap",
    section: "marketheatmap",
  },
  {
    icon: "▶",
    gradient: "linear-gradient(135deg, #dc2626, #ea580c)",
    screenshot: `/whats-new/daily-brief.png?v=${IMG_V}`,
    title: "Watch the story, not just read it",
    desc: "Your Daily Brief now finds and plays a video for the lead headline — no more guessing what actually happened.",
    ctaLabel: "Open Daily Brief",
    section: "chart",
  },
];

const LS_KEY = "whats_new_seen_v1";
const AUTO_ADVANCE_MS = 6000;

interface Props {
  onClose: () => void;
  onNavigate: (section: string) => void;
}

export function WhatsNewModal({ onClose, onNavigate }: Props) {
  const [idx, setIdx] = useState(0);
  const [neverShow, setNeverShow] = useState(false);
  const [paused, setPaused] = useState(false);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const slide = SLIDES[idx];
  const isFirst = idx === 0;
  const isLast = idx === SLIDES.length - 1;

  // Auto-advances on its own like the reference — loops back to the first
  // slide rather than closing itself, since this isn't a blocking modal;
  // it just sits there until the user dismisses it.
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % SLIDES.length);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(id);
  }, [paused]);

  const dismiss = () => {
    if (neverShow) localStorage.setItem(LS_KEY, "1");
    onClose();
  };

  const goTo = (i: number) => {
    setPaused(true);
    setIdx(i);
  };

  const back = () => goTo(idx - 1);

  const next = () => {
    if (isLast) { dismiss(); return; }
    goTo(idx + 1);
  };

  const tryIt = () => {
    if (neverShow) localStorage.setItem(LS_KEY, "1");
    onNavigate(slide.section);
    onClose();
  };

  const content = (
    <>
      <div className="wn-header">
        <span className="wn-badge">New</span>
        <span className="wn-header-title">
          <span className="top-nav-logo">
            coinhint<span className="top-nav-logo-accent">z</span>
          </span>{" "}
          just updated!
        </span>
        <button
          className="wn-icon-btn"
          onClick={() => setShowFullscreen((v) => !v)}
          aria-label={showFullscreen ? "Collapse" : "Expand"}
          title={showFullscreen ? "Collapse" : "Expand"}
        >
          <span className={`wn-icon-glyph${showFullscreen ? " wn-icon-glyph--collapse" : ""}`}>⤢</span>
        </button>
        <button className="wn-icon-btn" onClick={dismiss} aria-label="Close" title="Close">
          <span className="wn-icon-glyph">✕</span>
        </button>
      </div>

      <div className="wn-hero" style={slide.screenshot ? undefined : { background: slide.gradient }}>
        {slide.screenshot ? (
          <img className="wn-hero-img" src={slide.screenshot} alt={slide.title} />
        ) : (
          <span className="wn-hero-icon">{slide.icon}</span>
        )}
      </div>

      <div className="wn-body">
        <h2 className="wn-title">{slide.title}</h2>
        <p className="wn-desc">{slide.desc}</p>

        <div className="wn-dots">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              className={`wn-dot${i === idx ? " active" : ""}`}
              onClick={() => goTo(i)}
              aria-label={`Slide ${i + 1}`}
            />
          ))}
        </div>

        <div className="wn-footer">
          {isFirst ? (
            <label className="wn-checkbox">
              <input type="checkbox" checked={neverShow} onChange={(e) => setNeverShow(e.target.checked)} />
              Do not show this again
            </label>
          ) : (
            <button className="wn-btn wn-btn--plain" onClick={back}>Back</button>
          )}
          <div className="wn-actions">
            <button className="wn-btn wn-btn--ghost" onClick={tryIt}>{slide.ctaLabel}</button>
            <button className="wn-btn wn-btn--primary" onClick={next}>{isLast ? "Done" : "Next"}</button>
          </div>
        </div>
      </div>
    </>
  );

  // Expand swaps the corner toast for a real centered modal (with a
  // backdrop) instead of just resizing in place — collapsing it goes right
  // back to the docked corner card, same slide/position preserved.
  if (showFullscreen) {
    return (
      <div className="wn-fs-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowFullscreen(false); }}>
        <div className="wn-card wn-card--fullscreen">{content}</div>
      </div>
    );
  }

  return (
    <div
      className="wn-card"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {content}
    </div>
  );
}
