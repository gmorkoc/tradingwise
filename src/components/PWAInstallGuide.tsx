import { useState } from "react";
import "../styles/PWAInstallGuide.css";

function detectPlatform(): "ios" | "android" | "other" {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "other";
}

const STEPS = {
  ios: [
    { icon: "🌐", text: "Open coinhintz.io in Safari (must be Safari, not Chrome)" },
    { icon: "⬆️", text: 'Tap the Share button at the bottom of the screen' },
    { icon: "➕", text: 'Scroll down and tap "Add to Home Screen"' },
    { icon: "✅", text: 'Tap "Add" — the app icon appears on your home screen!' },
  ],
  android: [
    { icon: "🌐", text: "Open coinhintz.io in Chrome" },
    { icon: "⋮", text: "Tap the three-dot menu in the top-right corner" },
    { icon: "➕", text: 'Tap "Add to Home screen" or "Install app"' },
    { icon: "✅", text: 'Tap "Install" — the app appears on your home screen!' },
  ],
  other: [
    { icon: "📱", text: "Open coinhintz.io on your phone's browser" },
    { icon: "📤", text: "On iOS Safari: tap Share → Add to Home Screen" },
    { icon: "⋮",  text: "On Android Chrome: tap ⋮ → Add to Home screen" },
    { icon: "✅", text: "Tap Install / Add — done!" },
  ],
};

const PLATFORM_LABEL = {
  ios: "iPhone / iPad",
  android: "Android",
  other: "iOS & Android",
};

interface Props {
  onClose: () => void;
}

export function PWAInstallGuide({ onClose }: Props) {
  const platform = detectPlatform();
  const steps = STEPS[platform];

  return (
    <div className="pwa-backdrop" onClick={onClose}>
      <div className="pwa-sheet" onClick={e => e.stopPropagation()}>
        <div className="pwa-handle" />

        <div className="pwa-header">
          <div className="pwa-app-icon">📈</div>
          <div>
            <h2 className="pwa-title">Add to Home Screen</h2>
            <p className="pwa-sub">{PLATFORM_LABEL[platform]} · Works offline · No app store needed</p>
          </div>
          <button className="pwa-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="pwa-steps">
          {steps.map((step, i) => (
            <div className="pwa-step" key={i}>
              <div className="pwa-step-num">{i + 1}</div>
              <div className="pwa-step-icon">{step.icon}</div>
              <p className="pwa-step-text">{step.text}</p>
            </div>
          ))}
        </div>

        <div className="pwa-footer">
          <span className="pwa-badge">⚡ Full-screen · Fast · Always up-to-date</span>
        </div>
      </div>
    </div>
  );
}

export function PWAInstallButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-strip-btn pwa-install-btn" onClick={() => setOpen(true)} title="Add to Home Screen">
        <span className="nav-icon-wrap">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v13M8 11l4 4 4-4" />
            <path d="M20 16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2" />
          </svg>
        </span>
        <span className="icon-strip-label">Install App</span>
      </button>
      {open && <PWAInstallGuide onClose={() => setOpen(false)} />}
    </>
  );
}
